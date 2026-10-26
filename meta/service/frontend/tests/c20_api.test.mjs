import assert from "node:assert/strict";
import test from "node:test";

// c20.js reads the page's location at import time; node has none.
globalThis.location = { protocol: "http:", host: "service.test:9000" };
const c20 = await import("../web/c20.js");

const BASE = "http://service.test:9000/c20";
const UID = "0123456789abcdef0123456789abcdef";

function response(payload = {}) {
  return {
    ok: true,
    status: 200,
    headers: new Headers(),
    json: async () => payload,
  };
}

async function capture(action, payload = {}) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return response(payload);
  };
  try {
    await action();
    return request;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("login sends the proof as a raw binary body", async () => {
  const proof = new Uint8Array([1, 2, 3]);
  const request = await capture(() => c20.login(UID, proof));
  assert.equal(request.url, `${BASE}/login?uid=${UID}`);
  assert.equal(request.options.method, "POST");
  assert.equal(request.options.headers["content-type"], "application/octet-stream");
  assert.strictEqual(request.options.body, proof);
});

test("API errors preserve checker-relevant status and payload", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 401,
    headers: new Headers(),
    json: async () => ({ error: "Invalid credentials" }),
  });
  try {
    await assert.rejects(
      c20.login(UID, new Uint8Array([1])),
      (error) =>
        error instanceof c20.ServiceError &&
        error.status === 401 &&
        error.message === "Invalid credentials" &&
        error.payload?.error === "Invalid credentials",
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("game creation embeds only the initial owner ciphertext in JSON", async () => {
  const ciphertext = new Uint8Array([0, 1, 2, 255]);
  const request = await capture(() => c20.createGame("game", "description", ciphertext));
  assert.equal(request.url, `${BASE}/games`);
  assert.equal(request.options.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.options.body), {
    name: "game",
    description: "description",
    ciphertext: "AAEC/w==",
  });
});

test("whisper binds the raw ciphertext to the recipient uid", async () => {
  const ciphertext = new Uint8Array([4, 5, 6]);
  const request = await capture(() => c20.whisper("game", ciphertext, UID));
  assert.equal(request.url, `${BASE}/games/game/whisper?recipient_uid=${UID}`);
  assert.strictEqual(request.options.body, ciphertext);
});

test("whisper pagination matches the checker endpoint", async () => {
  const request = await capture(() => c20.listenWhispers("game", 2, 20), []);
  assert.equal(request.url, `${BASE}/games/game/whispers?start=2&end=20`);
  assert.equal(request.options.method, "GET");
});

test("game player pagination includes the requested timestamp-ordered slice", async () => {
  const request = await capture(() => c20.gamePlayers("game", 10, 20), []);
  assert.equal(request.url, `${BASE}/games/game/players?start=10&end=20`);
  assert.equal(request.options.method, "GET");
});

test("roll and resolution use raw binary bodies", async () => {
  const ciphertext = new Uint8Array([7, 8]);
  const roll = await capture(() => c20.roll("game", ciphertext));
  assert.equal(roll.url, `${BASE}/games/game/roll`);
  assert.strictEqual(roll.options.body, ciphertext);

  const plaintext = new Uint8Array([9, 10]);
  const resolution = await capture(() => c20.resolveRoll("game", 17, plaintext));
  assert.equal(resolution.url, `${BASE}/games/game/rolls/17/resolve`);
  assert.strictEqual(resolution.options.body, plaintext);
});

test("AFK mode keeps owner private keys and rejoin tokens in separate roles", async () => {
  const privateKey = new Uint8Array([11, 12]);
  const enabled = await capture(() => c20.setAfk("game", true, { privateKey }));
  assert.equal(enabled.url, `${BASE}/games/game/afk?enabled=1`);
  assert.strictEqual(enabled.options.body, privateKey);

  const rejoinToken = new Uint8Array([13, 14]);
  const disabled = await capture(() => c20.setAfk("game", false, { rejoinToken }));
  assert.equal(disabled.url, `${BASE}/games/game/afk?enabled=0`);
  assert.strictEqual(disabled.options.body, rejoinToken);

  assert.throws(() => c20.setAfk("game", true, { rejoinToken }), /private key/);
  assert.throws(() => c20.setAfk("game", false, { privateKey }), /rejoin token/);
});
