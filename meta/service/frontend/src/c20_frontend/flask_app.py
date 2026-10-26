"""Frontend routes mounted directly into the C20 Flask application."""

from __future__ import annotations

import os
import secrets

from flask import Blueprint, Response, jsonify, request, send_file, send_from_directory
from PIL import Image

from . import animated
from .compositor import compose_frame, compose_sheet, to_png_bytes
from .manifest import ANIMATIONS, CATEGORY_BY_KEY, build_manifest, eye_frame_index
from .paths import PIECES_DIR, ROOM_DIR, WEB_DIR
from .room import override_key, room_for, room_styles, save_room
from .tiles import list_tilesets, search_tiles, slice_tile

frontend = Blueprint("frontend", __name__)
ADMIN_PSK = os.environ.get("C20_ADMIN_PSK", "")


def _sprite_sizes():
    sizes = {}
    for png in (*ROOM_DIR.glob("*.png"), *(ROOM_DIR / "singles").glob("*.png")):
        with Image.open(png) as image:
            sizes[png.relative_to(ROOM_DIR).as_posix()] = image.size
    return sizes


def _is_admin(key):
    return bool(ADMIN_PSK) and secrets.compare_digest(key or "", ADMIN_PSK)


def _png(data):
    return Response(
        data, mimetype="image/png", headers={"Cache-Control": "max-age=86400"}
    )


@frontend.get("/api/manifest")
def manifest():
    return jsonify(build_manifest())


@frontend.get("/api/room")
def get_room():
    try:
        room = room_for(
            request.args.get("variant", ""),
            request.args.get("style", ""),
            _sprite_sizes(),
        )
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 404
    return jsonify(room)


@frontend.get("/api/room/styles")
def get_room_styles():
    return jsonify({"styles": room_styles()})


@frontend.get("/api/admin")
def admin_status():
    return jsonify(
        {
            "enabled": bool(ADMIN_PSK),
            "ok": _is_admin(request.headers.get("X-Admin-Key")),
        }
    )


@frontend.post("/api/room")
def post_room():
    if not _is_admin(request.headers.get("X-Admin-Key")):
        detail = (
            "saving is disabled: no C20_ADMIN_PSK configured"
            if not ADMIN_PSK
            else "admin key missing or wrong"
        )
        return jsonify({"detail": detail}), 403
    try:
        save_room(
            request.get_json(force=True),
            override_key(
                request.args.get("variant", ""), request.args.get("style", "")
            ),
        )
    except ValueError as exc:
        return jsonify({"detail": str(exc)}), 400
    return jsonify({"ok": True})


@frontend.get("/api/tilesets")
def tilesets():
    return jsonify(list_tilesets())


@frontend.get("/api/tiles")
def tiles():
    try:
        limit = min(2000, max(1, int(request.args.get("limit", 300))))
    except ValueError:
        return jsonify({"detail": "limit must be an integer"}), 400
    return jsonify(
        search_tiles(request.args.get("q", ""), limit, request.args.get("sheet", ""))
    )


@frontend.get("/api/animated")
def animated_sheets():
    return jsonify(animated.manifest())


@frontend.get("/anim/<sheet>/<int:col>/<int:row>")
def animated_tile(sheet, col, row):
    try:
        return _png(
            animated.slice_cell(sheet, col, row, int(request.args.get("frame", 0)))
        )
    except (FileNotFoundError, ValueError) as exc:
        return jsonify({"detail": str(exc)}), 404


@frontend.get("/tile/<sheet>/<int:col>/<int:row>")
def tile_image(sheet, col, row):
    try:
        return _png(slice_tile(sheet, col, row))
    except (FileNotFoundError, ValueError) as exc:
        return jsonify({"detail": str(exc)}), 404


@frontend.get("/api/export")
def export():
    selection = {
        key: value
        for key in CATEGORY_BY_KEY
        if (value := request.args.get(key)) not in (None, "", "none", "None")
    }
    try:
        scale = min(16, max(1, int(request.args.get("scale", 1))))
        frame = request.args.get("frame")
        if frame:
            anim_name, direction, index = (frame.split(":") + ["down", "0"])[:3]
            anim = ANIMATIONS.get(anim_name)
            if anim is None or direction not in anim["directions"]:
                raise ValueError(f"unknown frame {frame!r}")
            frames = anim["directions"][direction]
            i = int(index) % len(frames)
            x, y = frames[i]
            eye_i = eye_frame_index(anim_name, i)
            eye_xy = tuple(frames[eye_i]) if eye_i != i else None
            image = compose_frame(selection, x, y, scale=scale, eye_xy=eye_xy)
            filename = f"character_{anim_name}_{direction}.png"
        else:
            image = compose_sheet(selection, scale=scale)
            filename = "character_spritesheet.png"
    except (FileNotFoundError, ValueError, KeyError) as exc:
        return jsonify({"detail": str(exc)}), 400
    return Response(
        to_png_bytes(image),
        mimetype="image/png",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )


@frontend.get("/assets/<path:name>")
def assets(name):
    return send_from_directory(PIECES_DIR, name, max_age=86400)


@frontend.get("/room/<path:name>")
def room_assets(name):
    return send_from_directory(ROOM_DIR, name, max_age=86400)


@frontend.get("/")
def index():
    return send_file(WEB_DIR / "index.html", max_age=0)


@frontend.get("/<path:name>")
def web(name):
    response = send_from_directory(WEB_DIR, name)
    response.cache_control.no_cache = True
    return response
