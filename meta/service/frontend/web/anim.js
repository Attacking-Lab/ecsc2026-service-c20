// Animated tiles.
//
// A room stores an animated tile exactly like a static one: a URL of the form
// /anim/<sheet>/<col>/<row>, which the server serves as a plain 16x16 PNG of
// that cell's first frame. Everything that treats a tile URL as an image — the
// editor's thumbnails, the collision bounding boxes — therefore needs no idea
// that animation exists, and a tile still draws if this module never loads.
//
// What this adds is the rest of the frames: /api/animated gives each sheet's
// frame size and count, which turns that URL into "the whole sheet, at this
// sub-rect", and the game steps the sub-rect against the clock.

const TILE = 16;
const ANIM_URL = /^\/anim\/([^/]+)\/(\d+)\/(\d+)$/;

let sheets = {}; // "<file>.png" -> { fw, fh, frames, fps }
const cache = new Map(); // tile url -> info | null

export async function loadAnimated() {
  try {
    const data = await (await fetch("/api/animated")).json();
    sheets = data.sheets || {};
  } catch {
    sheets = {}; // every tile keeps drawing as its first frame
  }
  cache.clear();
}

// { texture, cx, cy, fw, frames, fps } for an animated tile URL, else null.
export function animatedTile(url) {
  if (cache.has(url)) return cache.get(url);
  const m = ANIM_URL.exec(url);
  const info = m && sheets[decodeURIComponent(m[1])];
  const out = info
    ? {
        texture: `/room/animated/${m[1]}`,
        cx: Number(m[2]) * TILE,
        cy: Number(m[3]) * TILE,
        fw: info.fw,
        frames: info.frames,
        fps: info.fps,
      }
    : null;
  cache.set(url, out);
  return out;
}

// Which frame is due at `now` (a performance.now() timestamp, in ms). Driven by
// the clock rather than a per-tile counter, so every copy of an object stays in
// step and a tile painted mid-animation joins the others rather than restarting.
export function frameAt(info, now) {
  return Math.floor((now / 1000) * info.fps) % info.frames;
}
