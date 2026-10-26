// Shared character helpers: turn a selection + animation state into the set of
// sprite-sheet sub-rects to draw, one per visible layer (bottom -> top).

export const NONE = "__none__";

export function buildOptionIndex(manifest) {
  const idx = {};
  for (const cat of manifest.categories) {
    idx[cat.key] = {};
    for (const o of cat.options) idx[cat.key][o.id] = o.url;
  }
  return idx;
}

export function defaultSelection(manifest) {
  const sel = {};
  for (const cat of manifest.categories) sel[cat.key] = cat.default === null ? NONE : cat.default;
  return sel;
}

// The service only tells us a player's uid, so their appearance is derived from
// it: same uid, same character, on every client.
export function selectionFromId(manifest, id) {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash = ((hash ^ id.charCodeAt(i)) * 16777619) >>> 0;
  }
  const selection = {};
  for (const cat of manifest.categories) {
    hash = ((hash * 16777619) ^ 0x9e3779b9) >>> 0;
    selection[cat.key] = cat.options[hash % cat.options.length].id;
  }
  return selection;
}

// { layers: [{url, sx, sy}], w, h, count } for the given frame. Layers are in
// draw order; the eyes layer may sample a different frame (idle/sit eye hold).
export function characterLayers(manifest, optionIndex, selection, anim, dir, frameIndex) {
  const a = manifest.animations[anim];
  const dirs = a.directions;
  const d = dirs[dir] ? dir : Object.keys(dirs)[0];
  const frames = dirs[d];
  const n = frames.length;
  const fi = ((frameIndex % n) + n) % n;
  const [fx, fy] = frames[fi];

  let eye = [fx, fy];
  const eyeMap = a.eyes;
  if (eyeMap && eyeMap[d]) eye = frames[eyeMap[d][fi]];

  const { w, h } = manifest.frame;
  const layers = [];
  for (const key of manifest.layers) {
    const id = selection[key];
    if (!id || id === NONE) continue;
    const url = optionIndex[key][id];
    if (!url) continue;
    const [sx, sy] = key === "eyes" ? eye : [fx, fy];
    layers.push({ url, sx, sy });
  }
  return { layers, w, h, count: n };
}
