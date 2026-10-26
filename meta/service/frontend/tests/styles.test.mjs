import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";

const STYLES = ["party", "halloween", "lounge", "teahouse"];

globalThis.fetch = async (url) => {
  assert.equal(url, "/api/room/styles");
  return { json: async () => ({ styles: STYLES.map((id) => ({ id, label: id })) }) };
};
const { styleFor } = await import("../web/styles.js");

const hex = () => randomBytes(16).toString("hex");

test("a description naming a style is kept", async () => {
  for (const style of STYLES) assert.equal(await styleFor(hex(), style), style);
});

test("a checker game (random hex description) gets a style picked by its name", async () => {
  const name = hex();
  const style = await styleFor(name, hex());
  assert.ok(STYLES.includes(style));
  assert.equal(await styleFor(name, hex()), style);
  assert.equal(await styleFor(name, ""), style);
});

test("retired styles are not kept", async () => {
  for (const old of ["cozy", "test"]) assert.ok(STYLES.includes(await styleFor(hex(), old)));
});

test("games without a style spread across every look", async () => {
  const seen = new Set();
  for (let i = 0; i < 200; i++) seen.add(await styleFor(hex(), hex()));
  assert.deepEqual([...seen].sort(), [...STYLES].sort());
});
