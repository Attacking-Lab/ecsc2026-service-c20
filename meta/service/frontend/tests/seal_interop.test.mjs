// Cross-checks the browser crypto against the service's own library: loads
// fixtures produced by sealy (SEAL 4.0.0, see tools/gen_seal_fixtures.py) and
// writes artifacts back for tools/verify_seal_interop.py to load with sealy.

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { fromHex, initSeal, SLOT_COUNT, toHex } from "../web/seal.js";

const here = new URL(".", import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL("../web/seal-fixtures.json", here), "utf8"));
const secretKey = Buffer.from(fixtures.secret_key, "hex");
const publicKey = Buffer.from(fixtures.public_key, "hex");
const crypto_ = await initSeal();
const head = (values, n) => values.slice(0, n);

test("decodes a plaintext encoded by the service", () => {
  const values = crypto_.decodeValues(fromHex(fixtures.plaintext));
  assert.equal(values.length, SLOT_COUNT);
  assert.deepEqual(head(values, 3), fixtures.values);
});

test("decrypts a ciphertext encrypted by the service", () => {
  assert.deepEqual(head(crypto_.decrypt(secretKey, fromHex(fixtures.ciphertext)), 3), fixtures.values);
});

test("decrypts the result of the service's roll evaluation", () => {
  const values = crypto_.decrypt(secretKey, fromHex(fixtures.evaluated.ciphertext));
  assert.deepEqual(head(values, 3), fixtures.evaluated.expected);
});

test("round-trips its own keys, plaintexts and ciphertexts", () => {
  const keys = crypto_.generateKeypair();
  const ciphertext = crypto_.encryptText(keys.publicKey, "watch the west door");
  assert.equal(crypto_.decryptText(keys.secretKey, ciphertext), "watch the west door");
  assert.deepEqual(head(crypto_.decodeValues(crypto_.encodeValues([1, 2, 3])), 3), [1, 2, 3]);
});

test("writes artifacts for the service to verify", () => {
  const keys = crypto_.generateKeypair();
  const rolls = [[10, 20, 30], [1, 2, 3]];
  writeFileSync(new URL("seal_interop_artifacts.json", here), JSON.stringify({
    values: fixtures.values,
    rolls,
    public_key: toHex(keys.publicKey),
    secret_key: toHex(keys.secretKey),
    plaintext: toHex(crypto_.encodeValues(fixtures.values)),
    ciphertext_for_service_key: toHex(crypto_.encrypt(publicKey, fixtures.values)),
    roll_ciphertexts: rolls.map((roll) => toHex(crypto_.encrypt(keys.publicKey, roll))),
  }));
});
