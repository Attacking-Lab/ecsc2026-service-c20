"""Realtime presence relay: a native-ASGI WebSocket hub with Redis fan-out.

This carries only ephemeral, cosmetic presence between players in a room —
position, the character appearance they chose, and one-shot actions. It is
deliberately independent of the scored service: it imports nothing from
``.app``/``.database``/``.fhe``, lives outside the ``/c20`` surface the checker
drives, and persists nothing beyond a short Redis TTL.

It runs on Uvicorn's event loop, so it never consumes the Flask thread pool that
serves scored requests. Redis is the bus across the worker processes: each
worker relays only to its own sockets and publishes/subscribes room events so a
message received on one worker reaches clients on the others. If Redis is
unavailable the relay simply disables itself — the scored service is unaffected
and clients fall back to the static seated view.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re

import redis.asyncio as redis
from redis.exceptions import RedisError

logger = logging.getLogger(__name__)

PATH_PREFIX = "/ws/"
REDIS_URL = os.environ.get("REDIS_URL", "redis://redis:6379/0")
STATE_TTL = 60  # seconds; a silent client's avatar self-expires
MAX_FRAME = 4096  # cap a single inbound client frame
SEND_QUEUE = 128  # per-connection outbound backlog before dropping
_ROOM_RE = re.compile(r"[^A-Za-z0-9_.-]")

_CHANNEL = "rt:{room}"
_STATE = "rtstate:{room}"

# Per-worker registry: room -> {uid -> Conn}. Only this worker's sockets.
_local: dict[str, dict[str, Conn]] = {}
_redis: redis.Redis | None = None
_sub_task: asyncio.Task | None = None


class Conn:
    """One WebSocket connection with a serialized outbound queue.

    Fan-out and the connection's own handler both enqueue; a single writer task
    drains to ``send`` so a socket is never written from two tasks at once.
    """

    def __init__(self, send):
        self._send = send
        self._queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=SEND_QUEUE)
        self.uid: str | None = None
        self.room: str | None = None
        self.selection = None

    def enqueue(self, text: str) -> None:
        try:
            self._queue.put_nowait(text)
        except asyncio.QueueFull:
            # State is last-write-wins; dropping a stale frame is harmless.
            pass

    async def writer(self) -> None:
        while True:
            text = await self._queue.get()
            if text is None:
                return
            await self._send({"type": "websocket.send", "text": text})


def _sanitize_state(msg: dict) -> dict:
    """Keep only the render fields, coerced to safe primitives."""
    out: dict = {}
    for key in ("px", "py"):
        try:
            out[key] = float(msg[key])
        except (KeyError, TypeError, ValueError):
            out[key] = 0.0
    out["dir"] = str(msg.get("dir", "down"))[:8]
    out["moving"] = bool(msg.get("moving"))
    out["pose"] = str(msg.get("pose", "idle"))[:32]
    # The adventurer name the player typed, shown to the others on their
    # nameplate and chat lines. Printable characters only, trimmed and capped.
    name = msg.get("name")
    name = "".join(c for c in name if c.isprintable()) if isinstance(name, str) else ""
    out["name"] = name.strip()[:24]
    action = msg.get("action")
    out["action"] = str(action)[:32] if action else None
    try:
        out["actionSeq"] = int(msg.get("actionSeq", 0))
    except (TypeError, ValueError):
        out["actionSeq"] = 0
    # Seat layering (a chair sits the player a layer off the default) and the
    # last map activation, replayed by peers once per actSeq.
    z = msg.get("z")
    out["z"] = (
        z if isinstance(z, int) and not isinstance(z, bool) and 0 <= z <= 64 else None
    )
    out["flat"] = msg.get("flat") is True
    act = msg.get("act")
    out["act"] = str(act)[:32] if act else None
    try:
        out["actSeq"] = int(msg.get("actSeq", 0))
    except (TypeError, ValueError):
        out["actSeq"] = 0
    sel = _clean_selection(msg.get("selection"))
    if sel is not None:
        out["selection"] = sel
    return out


def _clean_selection(sel) -> dict | None:
    if not isinstance(sel, dict):
        return None
    out = {}
    for key, value in sel.items():
        if isinstance(key, str) and isinstance(value, str) and len(out) < 12:
            out[str(key)[:24]] = value[:48]
    return out or None


async def _hello(conn: Conn, room: str, msg: dict) -> None:
    uid = str(msg.get("uid") or "")[:32]
    if not uid:
        return
    conn.uid = uid
    conn.room = room
    conn.selection = _clean_selection(msg.get("selection"))
    _local.setdefault(room, {})[uid] = conn

    peers: dict = {}
    if _redis is not None:
        raw = await _redis.hgetall(_STATE.format(room=room))
        for key, value in raw.items():
            other = key.decode() if isinstance(key, bytes) else key
            if other == uid:
                continue
            try:
                peers[other] = json.loads(value)
            except (ValueError, TypeError):
                pass
    conn.enqueue(json.dumps({"t": "snapshot", "peers": peers}))


async def _state(conn: Conn, room: str, msg: dict) -> None:
    if conn.uid is None or _redis is None:
        return
    state = _sanitize_state(msg)
    if "selection" not in state and conn.selection:
        state["selection"] = conn.selection
    elif "selection" in state:
        conn.selection = state["selection"]
    key = _STATE.format(room=room)
    await _redis.hset(key, conn.uid, json.dumps(state))
    await _redis.expire(key, STATE_TTL)
    await _redis.publish(
        _CHANNEL.format(room=room),
        json.dumps({"t": "state", "uid": conn.uid, **state}),
    )


async def _relay(conn: Conn, room: str, kind: str, msg: dict) -> None:
    if conn.uid is None or _redis is None:
        return
    out = {"t": kind, "uid": conn.uid}
    if kind == "say":
        out["text"] = str(msg.get("text", ""))[:512]
    await _redis.publish(_CHANNEL.format(room=room), json.dumps(out))


async def _leave(conn: Conn) -> None:
    if conn.uid is None or conn.room is None:
        return
    _local.get(conn.room, {}).pop(conn.uid, None)
    if not _local.get(conn.room):
        _local.pop(conn.room, None)
    if _redis is None:
        return
    try:
        await _redis.hdel(_STATE.format(room=conn.room), conn.uid)
        await _redis.publish(
            _CHANNEL.format(room=conn.room),
            json.dumps({"t": "leave", "uid": conn.uid}),
        )
    except (OSError, RedisError):
        logger.debug("leave cleanup failed", exc_info=True)


async def _serve(conn: Conn, room: str, receive) -> None:
    while True:
        event = await receive()
        etype = event["type"]
        if etype == "websocket.disconnect":
            return
        if etype != "websocket.receive":
            continue
        text = event.get("text")
        if text is None or len(text) > MAX_FRAME:
            continue
        try:
            msg = json.loads(text)
        except ValueError:
            continue
        kind = msg.get("t")
        if kind == "hello":
            await _hello(conn, room, msg)
        elif conn.uid is None:
            continue
        elif kind == "state":
            await _state(conn, room, msg)
        elif kind in ("say", "whisper"):
            await _relay(conn, room, kind, msg)


async def ws_app(scope, receive, send) -> None:
    room = _ROOM_RE.sub("", scope["path"][len(PATH_PREFIX):].strip("/"))[:64]
    event = await receive()
    if event["type"] != "websocket.connect":
        return
    if not room or _redis is None:
        await send({"type": "websocket.close", "code": 1013})
        return
    await send({"type": "websocket.accept"})
    conn = Conn(send)
    writer = asyncio.create_task(conn.writer())
    try:
        await _serve(conn, room, receive)
    finally:
        await _leave(conn)
        try:
            conn._queue.put_nowait(None)
        except asyncio.QueueFull:
            pass
        writer.cancel()


async def _subscriber() -> None:
    assert _redis is not None
    while True:
        try:
            pubsub = _redis.pubsub()
            await pubsub.psubscribe(_CHANNEL.format(room="*"))
            async for message in pubsub.listen():
                if message.get("type") != "pmessage":
                    continue
                channel = message["channel"]
                channel = channel.decode() if isinstance(channel, bytes) else channel
                room = channel[len("rt:"):]
                conns = _local.get(room)
                if not conns:
                    continue
                data = message["data"]
                text = data.decode() if isinstance(data, bytes) else data
                try:
                    origin = json.loads(text).get("uid")
                except (ValueError, TypeError):
                    origin = None
                for uid, conn in list(conns.items()):
                    if uid == origin:
                        continue
                    conn.enqueue(text)
        except asyncio.CancelledError:
            return
        except (OSError, RedisError):
            logger.warning("realtime subscriber lost Redis; retrying", exc_info=True)
            await asyncio.sleep(1)


async def lifespan(scope, receive, send) -> None:
    global _redis, _sub_task
    while True:
        event = await receive()
        if event["type"] == "lifespan.startup":
            try:
                client = redis.from_url(REDIS_URL)
                await client.ping()
                _redis = client
                _sub_task = asyncio.create_task(_subscriber())
                logger.info("realtime relay ready (%s)", REDIS_URL)
            except (OSError, RedisError):
                _redis = None
                logger.warning(
                    "realtime relay disabled: Redis unavailable at %s", REDIS_URL
                )
            # Always complete: a cosmetic relay must never block the service.
            await send({"type": "lifespan.startup.complete"})
        elif event["type"] == "lifespan.shutdown":
            if _sub_task is not None:
                _sub_task.cancel()
            if _redis is not None:
                await _redis.aclose()
            await send({"type": "lifespan.shutdown.complete"})
            return
