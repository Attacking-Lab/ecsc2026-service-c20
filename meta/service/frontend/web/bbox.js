// Opaque-pixel bounding box for a tile/sprite image, in image pixels, cached by
// URL. Used to build pixel-accurate collision from solid tiles. Loading is
// async; getBBox returns null until the image is decoded and calls onReady when
// it becomes available.

const cache = new Map(); // url -> {x, y, w, h} | "pending"

export function getBBox(url, onReady) {
  const hit = cache.get(url);
  if (hit) return hit === "pending" ? null : hit;

  cache.set(url, "pending");
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement("canvas");
    cv.width = img.width;
    cv.height = img.height;
    const ctx = cv.getContext("2d");
    ctx.drawImage(img, 0, 0);
    let data;
    try {
      data = ctx.getImageData(0, 0, img.width, img.height).data;
    } catch {
      cache.set(url, { x: 0, y: 0, w: img.width, h: img.height });
      if (onReady) onReady();
      return;
    }
    let minX = img.width, minY = img.height, maxX = -1, maxY = -1;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        if (data[(y * img.width + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    cache.set(url, maxX < 0
      ? { x: 0, y: 0, w: 0, h: 0 }
      : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 });
    if (onReady) onReady();
  };
  img.onerror = () => { cache.set(url, { x: 0, y: 0, w: 0, h: 0 }); };
  img.src = url;
  return null;
}
