"""Searchable catalog of every 16x16 tile the map editor can paint with.

Tiles come from three places, all under vendor/modern-interiors/room:
- the room's own tiles (floor.png, wall_*.png, table.png ...), served statically;
- every non-empty 16x16 cell of the vendored LimeZu sheets in `sheets/`, served
  on demand by slicing (`/tile/<sheet>/<col>/<row>`);
- every non-empty cell of the animated objects in `animated/`, which paint and
  catalog like any other tile and only differ once the browser draws them
  (`/anim/<sheet>/<col>/<row>`, see animated.py).

The catalog and each slice are built once and cached.
"""

from __future__ import annotations

import io
import json
import re
from functools import lru_cache

from PIL import Image

from . import animated
from .paths import ROOM_DIR

TILE = 16
SHEETS_DIR = ROOM_DIR / "sheets"
# Human object labels per sheet, keyed by sheet filename -> list of regions
# {"rect": [col, row, w, h], "label": str, "kw": str}. Merged into each covered
# cell's name/keywords so the editor search finds tiles by what they depict.
TAGS_FILE = ROOM_DIR / "tile_tags.json"

_catalog: list[dict] | None = None
_tags_cache: dict[str, list[dict]] | None = None


def _load_tags() -> dict[str, list[dict]]:
    global _tags_cache
    if _tags_cache is None:
        try:
            _tags_cache = json.loads(TAGS_FILE.read_text())
        except (OSError, ValueError):
            _tags_cache = {}
    return _tags_cache


def _position(dx: int, dy: int, w: int, h: int) -> str:
    """Which part of a multi-cell object a cell is, e.g. "top-left", "bottom"."""
    vp = "" if h == 1 else ("top" if dy == 0 else "bottom" if dy == h - 1 else "middle")
    hp = "" if w == 1 else ("left" if dx == 0 else "right" if dx == w - 1 else "center")
    if vp and hp:
        return "center" if vp == "middle" and hp == "center" else f"{vp}-{hp}"
    return vp or hp


def _cell_tags(regions: list[dict], c: int, r: int) -> tuple[list[str], list[str]]:
    labels: list[str] = []
    kws: list[str] = []
    for reg in regions:
        x, y, w, h = reg["rect"]
        if x <= c < x + w and y <= r < y + h:
            label = reg.get("label")
            # A single object gets a per-cell part (top-left ... bottom-right);
            # a "set" (variant row / palette) does not — its cells are independent.
            if label and reg.get("kind") == "object" and (w > 1 or h > 1):
                pos = _position(c - x, r - y, w, h)
                if pos:
                    label = f"{label} ({pos})"
            if label and label not in labels:
                labels.append(label)
            for k in reg.get("kw", "").split():
                if k not in kws:
                    kws.append(k)
    return labels, kws


def _friendly(stem: str) -> str:
    name = re.sub(r"_?16x16$", "", stem)
    name = re.sub(r"^\d+[_-]?", "", name)  # drop a leading theme number
    return name.replace("_", " ").strip() or stem


def _catalog_build() -> list[dict]:
    cat: list[dict] = []

    # Standalone 16x16 tiles shipped in the room dir (e.g. the table single).
    for sub in ("", "singles"):
        for png in sorted((ROOM_DIR / sub).glob("*.png")):
            with Image.open(png) as im:
                if im.size != (TILE, TILE):
                    continue
            rel = png.relative_to(ROOM_DIR).as_posix()
            cat.append(
                {
                    "name": png.stem,
                    "url": f"/room/{rel}",
                    "sheet": "misc",
                    "kw": png.stem.lower(),
                }
            )

    # Every non-empty 16x16 cell of each vendored sheet.
    tags = _load_tags()
    for sheet in sorted(SHEETS_DIR.glob("*.png")):
        regions = tags.get(sheet.name, [])
        with Image.open(sheet) as im:
            im = im.convert("RGBA")
            w, h = im.size
            px = im.load()
            friendly = _friendly(sheet.stem)
            base_kw = friendly.lower()
            for r in range(h // TILE):
                for c in range(w // TILE):
                    if not _cell_has_content(px, c, r):
                        continue
                    labels, kws = _cell_tags(regions, c, r)
                    name = f"{friendly} {c},{r}"
                    if labels:
                        name = f"{name} · {', '.join(labels)}"
                    cat.append(
                        {
                            "name": name,
                            "url": f"/tile/{sheet.name}/{c}/{r}",
                            "sheet": sheet.name,
                            "kw": " ".join([base_kw, *kws]),
                        }
                    )

    cat.extend(_animated_cells())
    return cat


def _animated_cells() -> list[dict]:
    """Every non-empty cell of every animated sheet. A cell counts as non-empty
    if any frame draws in it, so a cell that only fills up mid-animation still
    gets catalogued."""
    cells: list[dict] = []
    for name, info in sorted(animated.sheets().items()):
        path = animated.sheet_path(name)
        if path is None:
            continue
        w, h = info["fw"] // TILE, info["fh"] // TILE
        friendly = _friendly(path.stem)
        with Image.open(path) as im:
            px = im.convert("RGBA").load()
            for r in range(h):
                for c in range(w):
                    if not any(
                        _cell_has_content(px, f * info["fw"] // TILE + c, r)
                        for f in range(info["frames"])
                    ):
                        continue
                    pos = _position(c, r, w, h)
                    cells.append(
                        {
                            "name": f"{friendly} ({pos})" if pos else friendly,
                            "url": f"/anim/{name}/{c}/{r}",
                            "sheet": animated.SHEET_ID,
                            "kw": f"{friendly.lower()} animated",
                        }
                    )
    return cells


def _cell_has_content(px, c: int, r: int) -> bool:
    for y in range(r * TILE, r * TILE + TILE, 2):
        for x in range(c * TILE, c * TILE + TILE, 2):
            if px[x, y][3] > 8:
                return True
    return False


def catalog() -> list[dict]:
    global _catalog
    if _catalog is None:
        _catalog = _catalog_build()
    return _catalog


def list_tilesets() -> dict:
    """Available tilesets (sheets) to browse, with a friendly label and count."""
    counts: dict[str, int] = {}
    for t in catalog():
        counts[t["sheet"]] = counts.get(t["sheet"], 0) + 1
    labels = {"misc": "Room tiles", animated.SHEET_ID: "Animated objects"}
    sets = []
    for name in sorted(counts):
        entry = {
            "sheet": name,
            "label": labels.get(name) or _friendly(name.removesuffix(".png")),
            "count": counts[name],
        }
        # Only a real sheet can be browsed as one image; "misc" and the animated
        # objects are collections of separate files.
        if name not in labels:
            entry["sheetUrl"] = f"/room/sheets/{name}"
        sets.append(entry)
    return {"tilesets": sets}


def search_tiles(query: str, limit: int, sheet: str = "") -> dict:
    cat = catalog()
    if sheet:
        cat = [t for t in cat if t["sheet"] == sheet]
    q = query.strip().lower()
    if q:
        terms = q.split()
        cat = [
            t
            for t in cat
            if all(term in t["name"].lower() or term in t["kw"] for term in terms)
        ]
    return {"total": len(cat), "tiles": cat[:limit]}


@lru_cache(maxsize=4096)
def slice_tile(sheet: str, col: int, row: int) -> bytes:
    path = (SHEETS_DIR / sheet).resolve()
    if path.parent != SHEETS_DIR.resolve() or not path.is_file():
        raise FileNotFoundError(sheet)
    with Image.open(path) as im:
        im = im.convert("RGBA")
        w, h = im.size
        if not (0 <= col < w // TILE and 0 <= row < h // TILE):
            raise ValueError("cell out of range")
        cell = im.crop((col * TILE, row * TILE, col * TILE + TILE, row * TILE + TILE))
    buf = io.BytesIO()
    cell.save(buf, format="PNG")
    return buf.getvalue()
