// Thin client for the C20 game service of whichever team the player connects
// to (the landing screen's Server field), not only the one serving this page.
// A cross-site page gets no cookies, so the session travels as a bearer token
// (backend/tokens.py): the service hands it out in X-C20-Token and it is kept
// per server. Cryptographic blobs use raw request bodies where possible and
// base64 only when they must be embedded in JSON.

const DEFAULT_PORT = 9000;
const TOKEN_HEADER = "X-C20-Token";

let host = location.host; // the service's host:port

// Point every call (and the relay, see net.js) at a server: "10.1.2.3",
// "team7.ctf:9000" or a pasted URL. No port means DEFAULT_PORT; blank means the
// server this page came from.
export function setServer(value) {
  const text = (value ?? "").trim().replace(/^[a-z]+:\/\//i, "").replace(/\/.*$/, "");
  if (!text) host = location.host;
  else host = /:\d+$/.test(text) ? text : `${text}:${DEFAULT_PORT}`;
  return host;
}

export const serverHost = () => host;

// A localStorage key for data that only means something on this server
// (identity, game, tokens): a uid registered on one team's service is unknown
// on the next.
export const scoped = (key) => `${key}@${host}`;

function token() {
  try {
    return localStorage.getItem(scoped("c20-token"));
  } catch {
    return null;
  }
}

function keepToken(value) {
  try {
    if (value) localStorage.setItem(scoped("c20-token"), value);
    else localStorage.removeItem(scoped("c20-token"));
  } catch {
    /* storage may be unavailable; the session then lasts this page only */
  }
}

export class ServiceError extends Error {
  constructor(message, status, payload = null) {
    super(message);
    this.status = status;
    this.payload = payload;
  }
}

function bytesToBase64(bytes) {
  let raw = "";
  for (let start = 0; start < bytes.length; start += 0x8000) {
    raw += String.fromCharCode(...bytes.subarray(start, start + 0x8000));
  }
  return btoa(raw);
}

async function call(method, path, { json, body } = {}) {
  const headers = {};
  if (json !== undefined) headers["content-type"] = "application/json";
  else if (body !== undefined) headers["content-type"] = "application/octet-stream";
  const bearer = token();
  if (bearer) headers.authorization = `Bearer ${bearer}`;

  const response = await fetch(`${location.protocol}//${host}/c20${path}`, {
    method,
    headers,
    body: json !== undefined ? JSON.stringify(json) : body,
  });
  // Login and logout change the session; the service then sends its new token
  // (empty once logged out).
  if (response.headers.has(TOKEN_HEADER)) keepToken(response.headers.get(TOKEN_HEADER));
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ServiceError(
      payload?.error ?? `${method} ${path}: ${response.status}`,
      response.status,
      payload,
    );
  }
  return payload;
}

// The service's slice parameters, Python-style (negative counts from the end).
function range(start, end) {
  const params = new URLSearchParams();
  if (start !== undefined) params.set("start", start);
  if (end !== undefined) params.set("end", end);
  const encoded = params.toString();
  return encoded ? `?${encoded}` : "";
}

export const health = () => call("GET", "/health");

export const register = (publicKey) => call("POST", "/register", { body: publicKey });

export const login = (uid, proof) =>
  call("POST", `/login?uid=${encodeURIComponent(uid)}`, { body: proof });

export const logout = () => call("POST", "/logout");
export const listGames = (start, end) => call("GET", `/games${range(start, end)}`);
// start/end slice the broadcast history by position (Python slice rules, so
// a negative start counts from the newest); omitted, it is the whole history.
export const gameInfo = (game, start, end) => call("GET", `/games/${game}${range(start, end)}`);
export const playerInfo = (uid) => call("GET", `/player/${uid}`);

export const gamePlayers = (game, start, end) =>
  call("GET", `/games/${game}/players${range(start, end)}`);

export const createGame = (name, description, ciphertext) =>
  call("POST", "/games", {
    json: { name, description, ciphertext: bytesToBase64(ciphertext) },
  });

export const joinGame = (game) => call("POST", `/games/${game}/join`);
export const postNote = (game, note) => call("POST", `/games/${game}/note`, { json: { note } });
export const broadcast = (game, text) => call("POST", `/games/${game}/broadcast`, { json: { text } });

export const whisper = (game, ciphertext, recipientUid) =>
  call("POST", `/games/${game}/whisper?recipient_uid=${encodeURIComponent(recipientUid)}`, {
    body: ciphertext,
  });

export const listenWhispers = (game, start, end) =>
  call("GET", `/games/${game}/whispers${range(start, end)}`);

export const roll = (game, ciphertext) =>
  call("POST", `/games/${game}/roll`, { body: ciphertext });

export const rollRequests = (game, includeResolved = false) =>
  call("GET", `/games/${game}/rolls?include_resolved=${includeResolved ? 1 : 0}`);

export const resolveRoll = (game, id, plaintext) =>
  call("POST", `/games/${game}/rolls/${id}/resolve`, { body: plaintext });

export function setAfk(game, enabled, { privateKey, rejoinToken } = {}) {
  const body = enabled ? privateKey : rejoinToken;
  if (!(body instanceof Uint8Array) || body.length === 0) {
    throw new TypeError(
      `AFK mode requires a non-empty ${enabled ? "private key" : "rejoin token"}`,
    );
  }
  return call("POST", `/games/${game}/afk?enabled=${enabled ? 1 : 0}`, { body });
}
