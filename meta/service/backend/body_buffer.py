"""Bound and collect HTTP request bodies before entering the WSGI pool."""

from __future__ import annotations

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any


Receive = Callable[[], Awaitable[dict[str, Any]]]


class BodyTooLarge(ValueError):
    pass


def _declared_length(scope: dict[str, Any]) -> int | None:
    for name, value in scope.get("headers", ()):
        if name.lower() != b"content-length":
            continue
        try:
            length = int(value)
        except (TypeError, ValueError):
            return None
        return length if length >= 0 else None
    return None


async def buffer_http_body(
    scope: dict[str, Any],
    receive: Receive,
    *,
    max_bytes: int,
    timeout: float,
) -> bytes | None:
    """Return a complete body, or ``None`` when the peer disconnects.

    a2wsgi otherwise starts a WSGI worker before reading the body.  A slow or
    merely bursty upload can consequently occupy every worker while Uvicorn's
    event loop is still perfectly healthy.  Reading here keeps that wait on
    the event loop and also enforces the same bound for chunked requests that
    Flask's Content-Length based check cannot reject up front.
    """

    declared_length = _declared_length(scope)
    if declared_length is not None and declared_length > max_bytes:
        raise BodyTooLarge

    chunks: list[bytes] = []
    received = 0
    async with asyncio.timeout(timeout):
        while True:
            message = await receive()
            message_type = message.get("type")
            if message_type == "http.disconnect":
                return None
            if message_type != "http.request":
                continue

            chunk = message.get("body", b"")
            received += len(chunk)
            if received > max_bytes:
                raise BodyTooLarge
            if chunk:
                chunks.append(chunk)
            if not message.get("more_body", False):
                return b"".join(chunks)


def replay_body(body: bytes) -> Receive:
    """Build a one-shot ASGI receive callable for the buffered body."""

    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if delivered:
            return {"type": "http.disconnect"}
        delivered = True
        return {"type": "http.request", "body": body, "more_body": False}

    return receive
