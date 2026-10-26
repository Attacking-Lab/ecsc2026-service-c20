"""The LimeZu animated objects, as tiles the map editor can paint with.

Each sheet under vendor/modern-interiors/room/animated is a horizontal strip of equal-sized
frames. Nothing in the PNG says how wide a frame is, so the generated
animated.json beside them records it (see tools/gen_animated_tiles.py); a sheet
covers `fw/16 x fh/16` cells and every cell is addressed as
`/anim/<sheet>/<col>/<row>`.

That URL serves the cell's *first frame* as a plain 16x16 PNG, which is what
makes the feature cheap: a room stores an animated tile exactly like a static
one, and everything that treats a tile URL as an image — the editor's
thumbnails, the collision bounding boxes, an old browser — keeps working with no
change. The browser animates it by drawing from the whole sheet instead and
stepping the frame against a clock, using the geometry it reads from
/api/animated (web/anim.js).
"""

from __future__ import annotations

import io
import json
from functools import lru_cache

from PIL import Image

from .paths import ROOM_DIR

TILE = 16
ANIMATED_DIR = ROOM_DIR / "animated"
MANIFEST_FILE = ANIMATED_DIR / "animated.json"
# The tileset id the editor groups every animated cell under. The sheets are one
# object each, so browsing 300 of them as separate tilesets would be useless;
# they are searchable by name instead.
SHEET_ID = "animated"

_manifest: dict | None = None


def manifest() -> dict:
    """{"tile": 16, "sheets": {"<file>.png": {fw, fh, frames, fps, src}}}."""
    global _manifest
    if _manifest is None:
        try:
            _manifest = json.loads(MANIFEST_FILE.read_text())
        except (OSError, ValueError):
            _manifest = {"tile": TILE, "sheets": {}}
    return _manifest


def sheets() -> dict[str, dict]:
    return manifest().get("sheets", {})


def sheet_path(sheet: str):
    """The vendored sheet, or None if it is not one we know about."""
    if sheet not in sheets():
        return None
    path = (ANIMATED_DIR / sheet).resolve()
    return path if path.parent == ANIMATED_DIR.resolve() and path.is_file() else None


@lru_cache(maxsize=4096)
def slice_cell(sheet: str, col: int, row: int, frame: int = 0) -> bytes:
    """One 16x16 cell of one frame, as PNG."""
    info = sheets().get(sheet)
    path = sheet_path(sheet)
    if info is None or path is None:
        raise FileNotFoundError(sheet)
    if not (0 <= frame < info["frames"]):
        raise ValueError("frame out of range")
    if not (0 <= col < info["fw"] // TILE and 0 <= row < info["fh"] // TILE):
        raise ValueError("cell out of range")
    x = frame * info["fw"] + col * TILE
    y = row * TILE
    with Image.open(path) as im:
        cell = im.convert("RGBA").crop((x, y, x + TILE, y + TILE))
    buf = io.BytesIO()
    cell.save(buf, format="PNG")
    return buf.getvalue()
