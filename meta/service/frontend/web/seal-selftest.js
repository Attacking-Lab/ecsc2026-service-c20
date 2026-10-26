// Browser half of the crypto tests: the node suite (tests/seal_interop.test.mjs)
// covers the same ground, this page proves it in the environment that matters.

import { fromHex, initSeal, SLOT_COUNT, toHex } from "./seal.js";
import { initZkp } from "./zkp.js";

const results = document.getElementById("results");
const summary = document.getElementById("summary");
let failures = 0;

function report(name, error, ms) {
  const row = document.createElement("li");
  row.className = error ? "fail" : "pass";
  row.textContent = `${error ? "FAIL" : "PASS"}  ${name}  (${ms | 0} ms)`;
  if (error) {
    failures++;
    const detail = document.createElement("pre");
    detail.textContent = String(error);
    row.appendChild(detail);
  }
  results.appendChild(row);
}

function check(name, fn) {
  const started = performance.now();
  try {
    fn();
    report(name, null, performance.now() - started);
  } catch (error) {
    report(name, error, performance.now() - started);
  }
}

const equal = (actual, expected, label) => {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${label}: expected ${b}, got ${a}`);
};

const fixtures = await (await fetch("./seal-fixtures.json")).json();
const started = performance.now();
const crypto_ = await initSeal();
report("load node-seal and build the service's BFV context", null, performance.now() - started);

const publicKey = fromHex(fixtures.public_key);
const secretKey = fromHex(fixtures.secret_key);
const head = (values) => values.slice(0, fixtures.values.length);

check("decode a plaintext encoded by the service", () => {
  const values = crypto_.decodeValues(fromHex(fixtures.plaintext));
  equal(values.length, SLOT_COUNT, "slot count");
  equal(head(values), fixtures.values, "values");
});

check("decrypt a ciphertext encrypted by the service", () => {
  equal(head(crypto_.decrypt(secretKey, fromHex(fixtures.ciphertext))), fixtures.values, "values");
});

check("decrypt the service's roll evaluation", () => {
  const values = crypto_.decrypt(secretKey, fromHex(fixtures.evaluated.ciphertext));
  equal(values.slice(0, 3), fixtures.evaluated.expected, "values");
});

check("generate a keypair and round-trip a whisper", () => {
  const keys = crypto_.generateKeypair();
  const note = "watch the west door";
  equal(crypto_.decryptText(keys.secretKey, crypto_.encryptText(keys.publicKey, note)), note, "text");
});

const zkpStarted = performance.now();
const zkp = await initZkp();
report("load the zkp_lib WebAssembly build", null, performance.now() - zkpStarted);

check("prove the service's keypair byte-identically to the native library", () => {
  equal(toHex(zkp.prove(publicKey, secretKey)), fixtures.zkp_proof, "proof");
});

check("prove and verify a login for a browser-generated keypair", () => {
  const keys = crypto_.generateKeypair();
  equal(zkp.verify(keys.publicKey, zkp.prove(keys.publicKey, keys.secretKey)), true, "verify");
});

summary.textContent = failures
  ? `${failures} check(s) failed`
  : "all checks passed — this browser speaks the service's crypto";
summary.className = failures ? "fail" : "pass";
