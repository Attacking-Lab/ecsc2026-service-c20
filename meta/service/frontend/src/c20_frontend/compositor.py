"""Server-side character compositing (authoritative export).

Mirrors Unity's SpriteManager.CombineTextures: the pieces are alpha-composited
in layer order, so the produced full 896x640 sheet is a drop-in game asset.
"""

from __future__ import annotations

import io

from PIL import Image

from .manifest import CATEGORIES, FRAME_H, FRAME_W, SHEET_H, SHEET_W, resolve_piece


def compose_sheet(selection: dict[str, str], scale: int = 1) -> Image.Image:
    """Composite the full spritesheet for a selection of {category_key: option_id}."""
    sheet = Image.new("RGBA", (SHEET_W, SHEET_H), (0, 0, 0, 0))
    for cat in CATEGORIES:
        option_id = selection.get(cat.key)
        if option_id in (None, "", "none", "None"):
            continue
        path = resolve_piece(cat.key, option_id)
        if path is None:
            continue
        layer = Image.open(path).convert("RGBA")
        sheet = Image.alpha_composite(sheet, layer)

    if scale > 1:
        sheet = sheet.resize((SHEET_W * scale, SHEET_H * scale), Image.NEAREST)
    return sheet


def compose_frame(
    selection: dict[str, str],
    x: int,
    y: int,
    scale: int = 1,
    eye_xy: tuple[int, int] | None = None,
) -> Image.Image:
    """Composite a single animation frame (x, y are top-left pixels in the sheet).

    If eye_xy is given, the Eyes layer is sampled from that cell instead of (x, y)
    — used to hold the eyes open (skip a blink) while every other layer animates.
    """
    frame = Image.new("RGBA", (FRAME_W, FRAME_H), (0, 0, 0, 0))
    for cat in CATEGORIES:
        option_id = selection.get(cat.key)
        if option_id in (None, "", "none", "None"):
            continue
        path = resolve_piece(cat.key, option_id)
        if path is None:
            continue
        sheet = Image.open(path).convert("RGBA")
        cx, cy = eye_xy if (cat.key == "eyes" and eye_xy is not None) else (x, y)
        cell = sheet.crop((cx, cy, cx + FRAME_W, cy + FRAME_H))
        frame = Image.alpha_composite(frame, cell)

    if scale > 1:
        frame = frame.resize((FRAME_W * scale, FRAME_H * scale), Image.NEAREST)
    return frame


def to_png_bytes(image: Image.Image) -> bytes:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return buf.getvalue()
