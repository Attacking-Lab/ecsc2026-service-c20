// The other half of the round trip: what the service produced for a
// browser-generated key (tools/verify_seal_interop.py) must decrypt here.
// Skipped until that script has run — `just test-crypto-service` runs both.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, initSeal } from "../web/seal.js";

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null);
const reply = read(new URL("seal_service_reply.json", import.meta.url));
const artifacts = read(new URL("seal_interop_artifacts.json", import.meta.url));
// Keys are generated fresh on every run, so a reply left over from an earlier
// one answers a key this run no longer holds.
const stale = !reply || !artifacts || reply.for_public_key !== artifacts.public_key;
const options = { skip: stale && "run `just test-crypto-service` to generate the service reply" };

test("decrypts what the service encrypted to a browser key", options, async () => {
  const crypto_ = await initSeal();
  const secretKey = Buffer.from(artifacts.secret_key, "hex");

  assert.deepEqual(crypto_.decrypt(secretKey, fromHex(reply.ciphertext)).slice(0, 3), reply.values);
  assert.deepEqual(
    crypto_.decodeValues(fromHex(reply.plaintext_of_browser_ciphertext)).slice(0, 3),
    reply.values,
  );
  assert.deepEqual(
    crypto_.decrypt(secretKey, fromHex(reply.evaluated.ciphertext)).slice(0, 3),
    reply.evaluated.expected,
  );
});
