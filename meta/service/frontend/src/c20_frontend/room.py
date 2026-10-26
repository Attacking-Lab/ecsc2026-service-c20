"""The rooms: the Guild Hall and the campaign rooms, one per room style.

Each room is generated below. Rooms edited in the map editor and
committed to rooms.json replace their generated version. The editor POSTs an
edited room (see flask_app.py) to the override file, which wins over rooms.json; the
dev compose points the override at rooms.json itself so edits land in the repo.

Every tile and sprite is referenced by its original vendor identity: 16x16
tiles as `/tile/<sheet>/<col>/<row>` slices of the LimeZu sheets (original sheet
filenames), and furniture as the original "Singles" filenames under
vendor/modern-interiors/room/singles. Tile-grid cells store the drawable URL directly.
Coordinates are in tiles (TILE px each); furniture sprites are bottom-anchored.

Layers (z): floor 0, rug 1, walls/table/furniture 10 (the player layer), the
table's baize mat 11, and props on the mat 12. Collision is per tile: a tile
blocks by its opaque-pixel bounding box when its optional `solid` flag says so,
and an unflagged tile is solid exactly when it sits on PLAYER_Z, so the mat,
props and rug are walk-through/overlay-only. A room may also carry an "npcs"
list of configured characters ({tx, ty, dir, anim, z, clip?, selection}) the
frontend draws as static NPCs; nothing here generates them, but saved rooms and
the editor round-trip them. The party seats around the table live in the frontend
(game.js SEATS); keep them in step with TABLE below.
"""

from __future__ import annotations

import errno
import fcntl
import json
import os
from pathlib import Path

from .paths import ROOM_OVERRIDE, ROOMS_FILE

TILE = 16
WIDTH = 16
HEIGHT = 12
PLAYER_Z = 10  # blocking tiles live on this layer (matches the frontend)
RUG_Z = 1
MAT_Z = 11
PROP_Z = 12

_FLOORS = "Room_Builder_Floors_16x16.png"
_CONF = "13_Conference_Hall_16x16.png"
_LIVING = "2_LivingRoom_16x16.png"
_GENERIC = "1_Generic_16x16.png"
_LIBRARY = "5_Classroom_and_library_16x16.png"
_JAPAN = "20_Japanese_interiors.png"

FLOOR = f"/tile/{_JAPAN}/0/2"  # seamless tatami weave
# A flat, seamless stone fill for the walls. The Walls sheet's runs are drawn as
# a two-course cap + baseboard, so stacking them down the full-height side walls
# bands every tile; this mottled tile has no directional gradient and tiles
# cleanly in both directions, so the side walls read as one flat surface.
WALL = f"/tile/{_FLOORS}/12/18"

# The campaign table's footprint. The frontend seats the party around it
# (game.js SEATS), so every style's table fills it.
TABLE = {"x0": 5, "y0": 5, "w": 6, "h": 3}

SPAWN = {"tx": 8, "ty": 9}


# --- the lobby: the Guild Hall you pass through before sitting down --------
#
# A wider hall whose art is edited in the map editor (rooms.json); the builder
# below is only its fallback. Spots in the hall are "markers": the frontend
# (lobby.js) floats a label over each and acts when a player walks up and presses
# Enter. The anchors ride along in the room payload under "markers".
LOBBY_WIDTH = 20
LOBBY_HEIGHT = 14
LOBBY_SPAWN = {"tx": 10, "ty": 12}

# Fallback hall: two rows of three tables with a clear aisle down the middle.
_TABLE_COLS = (2, 8, 14)
_TABLE_ROWS = (4, 9)
# The campaign table, 3 wide x 2 tall, drawn from the museum sheet. Cells map
# (dx, dy) -> (col, row); the columns are not contiguous because that is the
# table's footprint on the sheet.
_MUSEUM = "22_Museum.png"
_LOBBY_TABLE = {
    (0, 0): (10, 89),
    (1, 0): (12, 89),
    (2, 0): (13, 89),
    (0, 1): (10, 91),
    (1, 1): (11, 91),
    (2, 1): (13, 91),
}


def _lobby_wall_tile(x: int, y: int) -> str | None:
    if y in (0, 1) or x == 0 or x == LOBBY_WIDTH - 1 or y == LOBBY_HEIGHT - 1:
        return WALL
    return None


def lobby_room(sprite_sizes: dict[str, tuple[int, int]]) -> dict:
    tiles: list[dict] = []

    def put(tx: int, ty: int, url: str, z: int = PLAYER_Z) -> None:
        tiles.append({"tx": tx, "ty": ty, "z": z, "url": url})

    def region(tx, ty, sheet, c0, r0, w, h, z=PLAYER_Z) -> None:
        for dy in range(h):
            for dx in range(w):
                put(tx + dx, ty + dy, f"/tile/{sheet}/{c0 + dx}/{r0 + dy}", z)

    for y in range(LOBBY_HEIGHT):
        for x in range(LOBBY_WIDTH):
            wall = _lobby_wall_tile(x, y)
            if wall:
                put(x, y, wall)
            else:
                put(x, y, FLOOR, z=0)

    # Entrance runner up the central aisle from the door to the far wall.
    for ty in range(2, LOBBY_HEIGHT - 1):
        region(9, ty, _GENERIC, 9, 27, 2, 1, z=RUG_Z)

    # A quest board flanked by globes on the north wall — the hall's notice wall.
    put(9, 1, f"/tile/{_LIBRARY}/0/6")
    put(10, 1, f"/tile/{_LIBRARY}/1/6")
    region(7, 1, _LIBRARY, 13, 1, 1, 2)
    region(12, 1, _LIBRARY, 13, 1, 1, 2)

    for y0 in _TABLE_ROWS:
        for tx in _TABLE_COLS:
            for (dx, dy), (cc, rr) in _LOBBY_TABLE.items():
                put(tx + dx, y0 + dy, f"/tile/{_MUSEUM}/{cc}/{rr}")

    return {
        "tile": TILE,
        "width": LOBBY_WIDTH,
        "height": LOBBY_HEIGHT,
        "assetBase": "/room",
        "tiles": tiles,
        "furniture": [],
        "spawn": LOBBY_SPAWN,
    }


# Kept in step with the hall's art in rooms.json. "area" is the display's
# footprint in tiles (you act on it from any adjacent tile); "label" is where
# the floating label's bottom centre sits, above the display's tallest prop.
LOBBY_MARKERS = [
    {
        "action": "create",
        "style": "party",
        "area": {"tx": 2, "ty": 4, "w": 4, "h": 2},
        "label": {"x": 4, "y": 3.6},
    },
    {
        "action": "create",
        "style": "halloween",
        "area": {"tx": 2, "ty": 9, "w": 4, "h": 2},
        "label": {"x": 4, "y": 8.6},
    },
    {
        "action": "create",
        "style": "lounge",
        "area": {"tx": 14, "ty": 3, "w": 4, "h": 3},
        "label": {"x": 16, "y": 3.6},
    },
    {
        "action": "create",
        "style": "teahouse",
        "area": {"tx": 14, "ty": 9, "w": 4, "h": 2},
        "label": {"x": 16, "y": 8.6},
    },
    {
        "action": "rooms",
        "area": {"tx": 7, "ty": 3, "w": 6, "h": 2},
        "label": {"x": 10, "y": 3},
    },
]


def override_key(variant: str = "", style: str = "") -> str:
    """Which saved room a request addresses. Reading and writing must agree on
    this, or an edit lands on a room nobody is looking at."""
    if variant == "lobby":
        return "lobby"
    if style not in ROOM_STYLES:
        raise ValueError(f"unknown room style {style!r}")
    return style


def _read_rooms(path: Path, strict: bool = False) -> dict[str, dict]:
    """Saved rooms by key. An unreadable file reads as empty, unless strict: a save must not take it for "no rooms"
    and write back only its own."""
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        if strict:
            raise ValueError(
                f"saved rooms file {path.name} is unreadable: {exc}"
            ) from exc
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(v, dict) and "tiles" in v}


def _overrides() -> dict[str, dict]:
    return {**_read_rooms(ROOMS_FILE), **_read_rooms(ROOM_OVERRIDE)}


def room_for(
    variant: str, style: str, sprite_sizes: dict[str, tuple[int, int]]
) -> dict:
    """The room a request asks for: its saved override, else freshly built."""
    key = override_key(variant, style)
    saved = _overrides().get(key)
    if key == "lobby":
        # The editor never sees markers, so they are attached here rather than
        # saved with the hall.
        return {**(saved or lobby_room(sprite_sizes)), "markers": _lobby_markers()}
    if saved:
        return saved
    return ROOM_STYLES[key][1](sprite_sizes)


def save_room(data: dict, key: str) -> None:
    """Persist an edited room under its key, leaving the other rooms alone."""
    if not isinstance(data, dict) or "tiles" not in data:
        raise ValueError("invalid room payload")
    # Only the override's own rooms are rewritten, so a later rooms.json update
    # still reaches every room this install never edited. Every worker process
    # rewrites the same file, so the read-modify-write holds an exclusive lock:
    # without it two saves interleave and one drops the other's room.
    ROOM_OVERRIDE.parent.mkdir(parents=True, exist_ok=True)
    lock_path = ROOM_OVERRIDE.with_name(ROOM_OVERRIDE.name + ".lock")
    with open(lock_path, "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        saved = _read_rooms(ROOM_OVERRIDE, strict=True)
        saved[key] = data
        _write_replacing(ROOM_OVERRIDE, json.dumps(saved, indent=1))


def _write_replacing(path: Path, text: str) -> None:
    """Swap in the new contents whole, so a reader never sees a half-written
    file. The dev compose bind-mounts rooms.json as a single file, which cannot
    be renamed over (EBUSY); there it is rewritten in place, still under the
    caller's lock."""
    tmp = path.with_name(f".{path.name}.tmp")
    tmp.write_text(text)
    try:
        os.replace(tmp, path)
    except OSError as exc:
        tmp.unlink(missing_ok=True)
        if exc.errno not in (errno.EBUSY, errno.EXDEV):
            raise
        path.write_text(text)


# --- themed rooms: the styles shown on the Guild Hall's displays -------------
#
# Each is the same 16x12 shape with its own floor, back wall, table and
# props. The table always fills TABLE, because the frontend seats the party
# around that footprint (game.js SEATS: rows 4 and 8, columns 4 and 11), so
# those cells and the spawn stay clear. Side and bottom walls reuse the Guild
# Hall's 3D frame so every room reads as part of the same building.
_WALLS = "Room_Builder_Walls_16x16.png"
_WALLS_3D = "Room_Builder_3d_walls_16x16.png"
_BIRTHDAY = "10_Birthday_party_16x16.png"
_HALLOWEEN = "11_Halloween_16x16.png"
_FISHING = "9_Fishing_16x16.png"
# frame piece -> (col, row) on the 3D walls sheet
_FRAME = {
    "top_left": ((18, 0), (18, 1)),
    "top_right": ((21, 0), (21, 1)),
    "left": (18, 2),
    "right": (21, 2),
    "bottom_left": (18, 5),
    "bottom": (19, 5),
    "bottom_right": (21, 5),
}


def _themed_room(theme: dict) -> dict:
    """Build a themed room from a theme dict:

    floor: (sheet, col, row, w, h) - a w x h patch tiled across the floor, or
        a function (x, y) -> (sheet, col, row) laying it cell by cell
    wall: (sheet, col, row) - the back wall's two courses, (col, row) over
        (col, row + 1), repeated along the top two rows
    table: (sheet, [top, mid, bottom]) - each row a (left, mid, right) of
        (col, row) cells; mid repeats to the table's width. None when the
        props build the table instead
    props: (sheet, col, row, w, h, tx, ty, z) - a sheet rectangle placed at
        (tx, ty); z defaults to the player layer
    """
    tiles: list[dict] = []

    def put(tx: int, ty: int, sheet: str, c: int, r: int, z: int = PLAYER_Z) -> None:
        tiles.append({"tx": tx, "ty": ty, "z": z, "url": f"/tile/{sheet}/{c}/{r}"})

    floor = theme["floor"]
    if not callable(floor):
        sheet, c0, r0, fw, fh = floor
        floor = lambda x, y: (sheet, c0 + x % fw, r0 + y % fh)
    for y in range(2, HEIGHT - 1):
        for x in range(1, WIDTH - 1):
            put(x, y, *floor(x, y), z=0)

    sheet, wc, wr = theme["wall"]
    for x in range(1, WIDTH - 1):
        put(x, 0, sheet, wc, wr)
        put(x, 1, sheet, wc, wr + 1)
    for side, x in (("top_left", 0), ("top_right", WIDTH - 1)):
        for y, (c, r) in enumerate(_FRAME[side]):
            put(x, y, _WALLS_3D, c, r)
    for y in range(2, HEIGHT - 1):
        put(0, y, _WALLS_3D, *_FRAME["left"])
        put(WIDTH - 1, y, _WALLS_3D, *_FRAME["right"])
    for x in range(WIDTH):
        piece = (
            "bottom_left" if x == 0 else "bottom_right" if x == WIDTH - 1 else "bottom"
        )
        put(x, HEIGHT - 1, _WALLS_3D, *_FRAME[piece])

    if theme["table"]:
        sheet, rows = theme["table"]
        x0, y0, w = TABLE["x0"], TABLE["y0"], TABLE["w"]
        for dy, (left, mid, right) in enumerate(rows):
            for dx in range(w):
                c, r = left if dx == 0 else right if dx == w - 1 else mid
                put(x0 + dx, y0 + dy, sheet, c, r)

    for sheet, c, r, pw, ph, tx, ty, *z in theme["props"]:
        for dy in range(ph):
            for dx in range(pw):
                put(tx + dx, ty + dy, sheet, c + dx, r + dy, *z)

    return {
        "tile": TILE,
        "width": WIDTH,
        "height": HEIGHT,
        "assetBase": "/room",
        "tiles": tiles,
        "furniture": [],
        "spawn": SPAWN,
    }


# game.js SEATS, for props that mark each seat
_SEATS = [(6, 4), (8, 4), (10, 4), (4, 6), (11, 6), (6, 8), (8, 8), (10, 8)]
_CONF_TABLE = (
    _CONF,
    [((7, 6), (7, 6), (7, 6)), ((7, 7), (7, 7), (7, 7)), ((5, 8), (6, 8), (8, 8))],
)

_PARTY = {
    "floor": (_FLOORS, 8, 2, 3, 2),
    "wall": (_WALLS, 23, 0),
    "table": _CONF_TABLE,
    "props": [
        # bunting strung along the back wall
        (_BIRTHDAY, 2, 4, 3, 1, 2, 1, PROP_Z),
        (_BIRTHDAY, 0, 4, 2, 1, 5, 1, PROP_Z),
        (_BIRTHDAY, 0, 4, 2, 1, 9, 1, PROP_Z),
        (_BIRTHDAY, 2, 4, 3, 1, 11, 1, PROP_Z),
        # balloons in the top corners, gifts in the bottom ones
        (_BIRTHDAY, 0, 5, 1, 2, 1, 2),
        (_BIRTHDAY, 1, 5, 1, 2, 2, 2),
        (_BIRTHDAY, 2, 5, 1, 2, 13, 2),
        (_BIRTHDAY, 3, 5, 1, 2, 14, 2),
        (_BIRTHDAY, 10, 0, 1, 2, 1, 9),
        (_BIRTHDAY, 11, 2, 1, 2, 2, 9),
        (_BIRTHDAY, 10, 2, 1, 2, 13, 9),
        (_BIRTHDAY, 11, 0, 1, 2, 14, 9),
        # tiered cakes on stands along the side walls
        (_BIRTHDAY, 5, 4, 1, 3, 1, 5),
        (_BIRTHDAY, 7, 4, 1, 3, 14, 5),
        # the spread on the table
        (_BIRTHDAY, 0, 2, 2, 2, 7, 5, PROP_Z),  # cake with candles
        (_BIRTHDAY, 5, 1, 1, 1, 5, 5, PROP_Z),  # food tray
        (_BIRTHDAY, 3, 1, 1, 1, 10, 5, PROP_Z),  # bottle
        (_BIRTHDAY, 4, 1, 1, 1, 9, 5, PROP_Z),  # bottle
        (_BIRTHDAY, 7, 2, 1, 1, 5, 6, PROP_Z),  # plates with food
        (_BIRTHDAY, 6, 2, 1, 1, 10, 6, PROP_Z),  # plates
        (_BIRTHDAY, 9, 2, 1, 1, 9, 6, PROP_Z),  # confetti
        (_BIRTHDAY, 6, 3, 1, 1, 6, 6, PROP_Z),  # small gift
    ],
}
_HALLOWEEN_ROOM = {
    "floor": (_FLOORS, 12, 16, 3, 2),
    "wall": (_WALLS, 12, 36),
    "table": (
        _HALLOWEEN,
        [
            ((5, 13), (6, 13), (8, 13)),
            ((5, 13), (6, 13), (8, 13)),
            ((5, 14), (6, 14), (8, 14)),
        ],
    ),
    "props": [
        # back wall: cobwebs in the corners, a window, a portrait and a clock
        (_HALLOWEEN, 0, 2, 2, 2, 1, 0, PROP_Z),
        (_HALLOWEEN, 2, 2, 2, 2, 13, 0, PROP_Z),
        (_HALLOWEEN, 7, 8, 2, 2, 7, 0, MAT_Z),
        (_HALLOWEEN, 8, 22, 1, 2, 4, 0, MAT_Z),
        (_HALLOWEEN, 9, 15, 1, 2, 11, 0, MAT_Z),
        # coffins up the walls, ghosts drifting by
        (_HALLOWEEN, 12, 4, 2, 3, 1, 2),
        (_HALLOWEEN, 14, 4, 2, 3, 13, 2),
        (_HALLOWEEN, 14, 10, 1, 3, 2, 6),
        (_HALLOWEEN, 15, 10, 1, 3, 13, 6),
        # cauldron, pumpkins and graves along the bottom
        (_HALLOWEEN, 2, 8, 2, 2, 1, 9),
        (_HALLOWEEN, 10, 0, 2, 2, 13, 9),
        (_HALLOWEEN, 9, 27, 1, 2, 3, 9),
        (_HALLOWEEN, 10, 27, 1, 2, 12, 9),
        # candles and jack-o-lanterns on the table
        (_HALLOWEEN, 13, 21, 1, 1, 6, 5, PROP_Z),
        (_HALLOWEEN, 13, 21, 1, 1, 9, 5, PROP_Z),
        (_HALLOWEEN, 6, 1, 1, 1, 6, 6, PROP_Z),
        (_HALLOWEEN, 8, 1, 1, 1, 9, 6, PROP_Z),
        (_HALLOWEEN, 0, 6, 2, 2, 7, 5, PROP_Z),  # skull pile
    ],
}
_LOUNGE = {
    "floor": (_FLOORS, 12, 26, 3, 2),
    "wall": (_WALLS, 12, 18),
    "table": _CONF_TABLE,
    "props": [
        # back wall: bar shelves either side of the fireplace
        (_LIVING, 10, 25, 2, 2, 1, 0),
        (_LIVING, 12, 25, 2, 2, 3, 0),
        (_LIVING, 4, 25, 2, 2, 7, 0),
        (_LIVING, 12, 28, 2, 2, 11, 0),
        (_LIVING, 14, 28, 2, 2, 13, 0),
        # plants and a floor lamp
        (_LIVING, 11, 0, 1, 2, 1, 2),
        (_LIVING, 11, 12, 1, 2, 14, 2),
        (_LIVING, 12, 0, 1, 2, 1, 6),
        (_LIVING, 12, 0, 1, 2, 14, 6),
        # sofas facing the table
        (_LIVING, 1, 28, 3, 2, 1, 9),
        (_LIVING, 7, 28, 3, 2, 12, 9),
        # fruit bowls on the table
        (_LIVING, 0, 10, 1, 1, 6, 6, PROP_Z),
        (_LIVING, 2, 10, 1, 1, 9, 6, PROP_Z),
    ],
}
# Tatami mats on the Japanese sheet; each draws its seam on its right and
# bottom edge, so neighbouring mats always show the join.
_MAT_LEFT, _MAT_RIGHT, _HALF_MAT = (2, 2), (3, 2), (3, 3)


def _tatami(x: int, y: int) -> tuple[str, int, int]:
    """Hall layout: rows of long mats, every other row offset by half a mat
    and closed with half mats, so no four mat corners ever meet."""
    i = x - 1
    if (y - 2) % 2 == 0:
        return (_JAPAN, *(_MAT_LEFT if i % 2 == 0 else _MAT_RIGHT))
    if i == 0 or x == WIDTH - 2:
        return (_JAPAN, *_HALF_MAT)
    return (_JAPAN, *(_MAT_LEFT if i % 2 == 1 else _MAT_RIGHT))


_TEAHOUSE = {
    "floor": _tatami,
    "wall": (_WALLS, 1, 6),
    "table": None,
    "props": [
        # shoji screens and hanging scrolls along the back wall
        (_JAPAN, 9, 10, 4, 2, 2, 0, MAT_Z),
        (_JAPAN, 9, 10, 4, 2, 10, 0, MAT_Z),
        (_JAPAN, 14, 0, 1, 2, 7, 0, MAT_Z),
        (_JAPAN, 15, 0, 1, 2, 8, 0, MAT_Z),
        # bonsai in the corners
        (_JAPAN, 6, 8, 1, 2, 1, 2),
        (_JAPAN, 6, 8, 1, 2, 14, 2),
        (_JAPAN, 7, 9, 1, 2, 1, 9),
        (_JAPAN, 7, 9, 1, 2, 14, 9),
        # three low tables on mats make the long table
        (_JAPAN, 0, 9, 2, 2, 5, 5),
        (_JAPAN, 0, 9, 2, 2, 7, 5),
        (_JAPAN, 0, 9, 2, 2, 9, 5),
        # tea things on top
        (_JAPAN, 4, 5, 1, 1, 6, 5, PROP_Z),
        (_JAPAN, 4, 6, 1, 1, 8, 5, PROP_Z),
        (_JAPAN, 4, 4, 1, 1, 10, 5, PROP_Z),
        # a floor cushion at every seat
        *((_JAPAN, 0, 8, 1, 1, x, y, RUG_Z) for x, y in _SEATS),
    ],
}


# The looks a player picks from at the Guild Hall's displays (LOBBY_MARKERS):
# id -> (label, builder). A game remembers its style in its service-side
# description, the only per-game field the frontend can set; the client maps a
# description that names no style (a checker's game, /create NAME) onto one of
# these by the game's name. Every style honours its own saved override.
ROOM_STYLES: dict[str, tuple[str, object]] = {
    "party": ("Birthday", lambda _sizes: _themed_room(_PARTY)),
    "halloween": ("Halloween", lambda _sizes: _themed_room(_HALLOWEEN_ROOM)),
    "lounge": ("Lounge", lambda _sizes: _themed_room(_LOUNGE)),
    "teahouse": ("Tea House", lambda _sizes: _themed_room(_TEAHOUSE)),
}


def _lobby_markers() -> list[dict]:
    return [
        {**m, "title": ROOM_STYLES[m["style"]][0] if "style" in m else "Reception"}
        for m in LOBBY_MARKERS
    ]


def room_styles() -> list[dict]:
    return [
        {"id": sid, "label": label} for sid, (label, _builder) in ROOM_STYLES.items()
    ]
