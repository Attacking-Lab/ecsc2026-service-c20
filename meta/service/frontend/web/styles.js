// The campaign room styles (backend ROOM_STYLES, the Guild Hall's displays). A
// game keeps its style in its service-side description; a game created
// elsewhere (the checker, another client, /create NAME) has a description that
// names none, so it gets one picked by its name: the same game always shows
// the same room, and such games spread across all the looks.

let ids = null;

async function styleIds() {
  ids ??= fetch("/api/room/styles")
    .then((r) => r.json())
    .then((body) => body.styles.map((s) => s.id))
    .catch((err) => {
      ids = null; // retry on the next call rather than caching the failure
      throw err;
    });
  return ids;
}

function hash(text) {
  let h = 0;
  for (const ch of text) h = (Math.imul(h, 31) + ch.codePointAt(0)) | 0;
  return h >>> 0;
}

export async function styleFor(name, description) {
  const known = await styleIds();
  return known.includes(description) ? description : known[hash(name) % known.length];
}
