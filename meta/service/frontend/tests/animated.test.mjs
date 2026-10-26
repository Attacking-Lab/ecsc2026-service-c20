import assert from "node:assert/strict";
import test from "node:test";

import { animatedTile, frameAt, loadAnimated } from "../web/anim.js";

const SHEETS = {
  "animated_candle.png": { fw: 16, fh: 32, frames: 3, fps: 10 },
  "animated_cauldron.png": { fw: 32, fh: 32, frames: 12, fps: 8 },
};

async function withSheets(payload, action) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => payload });
  try {
    await loadAnimated();
    await action();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("an animated tile URL resolves to its sheet and cell", async () => {
  await withSheets({ tile: 16, sheets: SHEETS }, () => {
    const a = animatedTile("/anim/animated_cauldron.png/1/1");
    assert.deepEqual(a, {
      texture: "/room/animated/animated_cauldron.png",
      cx: 16,
      cy: 16,
      fw: 32,
      frames: 12,
      fps: 8,
    });
  });
});

test("a static tile URL, or an unknown sheet, is not animated", async () => {
  await withSheets({ tile: 16, sheets: SHEETS }, () => {
    assert.equal(animatedTile("/tile/1_Generic_16x16.png/0/0"), null);
    assert.equal(animatedTile("/room/floor.png"), null);
    assert.equal(animatedTile("/anim/not_vendored.png/0/0"), null);
    // Nothing may escape the animated directory by way of the sheet name.
    assert.equal(animatedTile("/anim/../sheets/1_Generic_16x16.png/0/0"), null);
  });
});

test("tiles stay animated after the manifest arrives late", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    throw new Error("offline");
  };
  try {
    await loadAnimated();
    assert.equal(animatedTile("/anim/animated_candle.png/0/0"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
  await withSheets({ tile: 16, sheets: SHEETS }, () => {
    assert.ok(animatedTile("/anim/animated_candle.png/0/0"));
  });
});

test("the frame due follows the clock and wraps", async () => {
  await withSheets({ tile: 16, sheets: SHEETS }, () => {
    const a = animatedTile("/anim/animated_candle.png/0/0"); // 3 frames at 10fps
    assert.equal(frameAt(a, 0), 0);
    assert.equal(frameAt(a, 99), 0);
    assert.equal(frameAt(a, 100), 1);
    assert.equal(frameAt(a, 200), 2);
    assert.equal(frameAt(a, 300), 0);
    assert.equal(frameAt(a, 1_000_000), 1);
  });
});
