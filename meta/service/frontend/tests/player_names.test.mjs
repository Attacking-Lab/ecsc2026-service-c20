import assert from "node:assert/strict";
import test from "node:test";

globalThis.location = { protocol: "http:", host: "service.test:9000" };
const { Multiplayer } = await import("../web/multiplayer.js");
const { Game } = await import("../web/game.js");

const ALICE = "a1".padEnd(32, "0");
const BOB = "b2".padEnd(32, "0");
const CAROL = "c3".padEnd(32, "0");

// Just enough of a Multiplayer for target lookup: members and their names.
function party(names) {
  const self = Object.create(Multiplayer.prototype);
  self.info = { players: Object.keys(names).map((uid) => ({ uid })) };
  self.room = room(names);
  return self;
}

test("a name or an ID prefix finds the member", () => {
  const mp = party({ [ALICE]: "Alice", [BOB]: "Bob the Bold" });
  assert.equal(mp._player("alice").uid, ALICE);
  assert.equal(mp._player("b2").uid, BOB);
  assert.deepEqual(mp._splitTarget("Bob the Bold hello there"), ["Bob the Bold", "hello there"]);
  assert.deepEqual(mp._splitTarget("a1 hi"), ["a1", "hi"]);
});

test("a copied name blocks the lookup instead of redirecting it", () => {
  const mp = party({ [ALICE]: "Alice", [BOB]: "Alice" });
  assert.throws(() => mp._player("Alice"), /matches .* use a longer ID/);
  assert.equal(mp._player(ALICE.slice(0, 4)).uid, ALICE);
});

test("a name that looks like someone's ID prefix is ambiguous, a full ID always wins", () => {
  const mp = party({ [ALICE]: "Alice", [CAROL]: "a1" });
  assert.throws(() => mp._player("a1"), /matches/);
  assert.equal(mp._player(ALICE).uid, ALICE);
});

test("an unknown target names no one", () => {
  assert.throws(() => party({ [ALICE]: "Alice" })._player("Mallory"), /no player/);
});

// Just enough of a Game for naming: the relay's names and the local player.
function room(names, localUid = null, localName = "") {
  const self = Object.create(Game.prototype);
  self.names = new Map(Object.entries(names));
  self.localUid = localUid;
  self.localName = localName;
  return self;
}

test("a unique name is shown alone", () => {
  const r = room({ [ALICE]: "Alice", [BOB]: "Bob" });
  assert.equal(r.nameOf(ALICE), "Alice");
  assert.equal(r.nameOf(CAROL), "c3000000");
});

test("a shared name shows the short ID on every carrier, ignoring case", () => {
  const r = room({ [BOB]: "alice" }, ALICE, "Alice");
  assert.equal(r.nameOf(ALICE), "Alice (a1000000)");
  assert.equal(r.nameOf(BOB), "alice (b2000000)");
});

test("a name shaped like a short ID shows the real one", () => {
  const r = room({ [BOB]: "c3000000" });
  assert.equal(r.nameOf(BOB), "c3000000 (b2000000)");
  assert.equal(r.nameOf(CAROL), "c3000000");
});

test("whisper lookup matches the typed name, not the shown label", () => {
  const mp = party({ [ALICE]: "Alice", [BOB]: "Alice" });
  assert.throws(() => mp._player("Alice"), /Alice \(a1000000\), Alice \(b2000000\)/);
});
