// Realtime presence client. Streams the local avatar's state to the room's
// WebSocket relay and applies peers' state to the Game. This is cosmetic: if the
// socket never opens (relay disabled, Redis down, old server) the room simply
// falls back to the static seated peers driven by the 1.5s roster poll.

import { serverHost } from "./c20.js";

const TICK_MS = 80; // ~12 position updates a second while moving
const HEARTBEAT_MS = 15000; // resend while idle so the relay's TTL never lapses
const RECONNECT_MS = 2000;

export class Net {
  constructor(game) {
    this.game = game; // the Game instance: local avatar state in, peers out
    this.uid = null;
    this.room = null; // the room name we want to be in, or null
    this.ws = null;
    this.tick = null;
    this._reconnect = null;
    this._last = null; // last state object sent, for diffing
    this._lastSentAt = 0;
    this._closing = false;
    // Set by the owner to render a peer's live speech bubble / whisper tell.
    this.onSay = null;
    this.onWhisper = null;
  }

  setIdentity(uid) {
    this.uid = uid;
  }

  // A line the local player spoke / a whisper they sent: relayed so peers see
  // the bubble at once instead of on the next 1.5s poll. The durable copy still
  // goes through the service separately.
  say(text) {
    this._send({ t: "say", text: String(text).slice(0, 512) });
  }

  whisper() {
    this._send({ t: "whisper" });
  }

  // Enter a room (campaign name or the guild hall), leaving any previous one.
  join(room) {
    if (!room) return;
    if (this.room === room && this.ws) return;
    this.leave();
    this.room = room;
    this._closing = false;
    this.game.clearPeers?.();
    this._open();
  }

  leave() {
    this._closing = true;
    clearTimeout(this._reconnect);
    this._reconnect = null;
    clearInterval(this.tick);
    this.tick = null;
    const ws = this.ws;
    this.ws = null;
    this._last = null;
    this.room = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    }
  }

  _open() {
    if (!this.room || !this.uid) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let ws;
    try {
      ws = new WebSocket(`${proto}://${serverHost()}/ws/${encodeURIComponent(this.room)}`);
    } catch {
      this._scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this._send({ t: "hello", uid: this.uid, selection: this.game.selection });
      this._last = null;
      this._flush(true);
      this.tick = setInterval(() => this._flush(false), TICK_MS);
    };
    ws.onmessage = (event) => this._onMessage(event.data);
    ws.onclose = () => {
      if (this.ws !== ws) return; // superseded by a newer socket
      this.ws = null;
      clearInterval(this.tick);
      this.tick = null;
      this._scheduleReconnect();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* onclose handles the retry */
      }
    };
  }

  _scheduleReconnect() {
    if (this._closing || !this.room) return;
    clearTimeout(this._reconnect);
    this._reconnect = setTimeout(() => this._open(), RECONNECT_MS);
  }

  _send(obj) {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      /* dropped frame; the next tick resends */
    }
  }

  _flush(force) {
    const g = this.game;
    const state = {
      px: Math.round(g.px * 10) / 10,
      py: Math.round(g.py * 10) / 10,
      dir: g.dir,
      moving: !!g.moving,
      pose: g.pose,
      name: g.localName,
      z: g.seat ? g.seat.z : null,
      flat: !!g.seat?.flat,
      action: g.action,
      actionSeq: g.actionSeq | 0,
      act: g.act,
      actSeq: g.actSeq | 0,
    };
    const now = Date.now();
    const prev = this._last;
    const changed =
      force ||
      !prev ||
      state.px !== prev.px ||
      state.py !== prev.py ||
      state.dir !== prev.dir ||
      state.moving !== prev.moving ||
      state.pose !== prev.pose ||
      state.name !== prev.name ||
      state.z !== prev.z ||
      state.flat !== prev.flat ||
      state.actionSeq !== prev.actionSeq ||
      state.actSeq !== prev.actSeq;
    if (!changed && now - this._lastSentAt < HEARTBEAT_MS) return;
    this._send({ t: "state", selection: g.selection, ...state });
    this._last = state;
    this._lastSentAt = now;
  }

  _onMessage(data) {
    let msg;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }
    if (msg.t === "snapshot") {
      for (const [uid, peerState] of Object.entries(msg.peers || {})) {
        if (uid !== this.uid) this.game.setPeerState(uid, peerState);
      }
    } else if (msg.t === "state") {
      if (msg.uid && msg.uid !== this.uid) this.game.setPeerState(msg.uid, msg);
    } else if (msg.t === "leave") {
      if (msg.uid) this.game.removePeer(msg.uid);
    } else if (msg.t === "say") {
      if (msg.uid && msg.uid !== this.uid) this.onSay?.(msg.uid, msg.text || "");
    } else if (msg.t === "whisper") {
      if (msg.uid && msg.uid !== this.uid) this.onWhisper?.(msg.uid);
    }
  }
}
