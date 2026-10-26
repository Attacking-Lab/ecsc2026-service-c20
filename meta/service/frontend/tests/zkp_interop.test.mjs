// The login proof: the WebAssembly build of zkp_lib must produce exactly what
// the native library produces, and what it produces for a browser-generated key
// must verify in the service (tools/verify_seal_interop.py picks that up).

import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

import { initSeal, toHex } from "../web/seal.js";
import { initZkp } from "../web/zkp.js";

const here = new URL(".", import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL("../web/seal-fixtures.json", here), "utf8"));
const publicKey = Buffer.from(fixtures.public_key, "hex");
const secretKey = Buffer.from(fixtures.secret_key, "hex");
const zkp = await initZkp();

test("proves the service's keypair byte-identically to the native library", () => {
  assert.equal(toHex(zkp.prove(publicKey, secretKey)), fixtures.zkp_proof);
});

test("verifies a proof made by the native library", () => {
  assert.equal(zkp.verify(publicKey, Buffer.from(fixtures.zkp_proof, "hex")), true);
});

test("rejects a tampered proof", () => {
  const proof = Buffer.from(fixtures.zkp_proof, "hex");
  proof[100] ^= 1;
  assert.equal(zkp.verify(publicKey, proof), false);
});

test("proves a browser-generated keypair", async () => {
  const seal = await initSeal();
  const keys = seal.generateKeypair();
  // zkp_lib reads the key's coefficients out of a zstd container.
  assert.equal(keys.publicKey[5], 2, "public key must be zstd-compressed");
  assert.equal(keys.secretKey[5], 2, "secret key must be zstd-compressed");

  const proof = zkp.prove(keys.publicKey, keys.secretKey);
  assert.equal(zkp.verify(keys.publicKey, proof), true);
  assert.equal(zkp.verify(publicKey, proof), false, "must not verify against another key");

  writeFileSync(new URL("zkp_interop_artifacts.json", here), JSON.stringify({
    public_key: toHex(keys.publicKey),
    secret_key: toHex(keys.secretKey),
    proof: toHex(proof),
  }));
});
