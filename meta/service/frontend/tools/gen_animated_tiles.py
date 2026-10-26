"""Vendor the LimeZu animated-object spritesheets and derive their frame geometry.

Each sheet is a horizontal strip of equally wide frames, but nothing in the PNG
says how wide a frame is: a 96x32 strip is six 16x32 frames, three 32x32 frames
or two 48x32 frames. The pack ships a GIF beside most sheets, and one GIF frame
*is* one sprite frame, so its size settles the question exactly. For the ~45
sheets with no GIF, a fallback scores every candidate frame width by how much
consecutive frames differ and takes the narrowest one that still looks like a
clean split (it agrees with the GIFs on 97% of the sheets that have both).

Run with `just vendor-animated`. The source tree is the itch.io download and is
not in the repo; the output (sheets + manifest) is committed.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

TILE = 16
# A too-wide guess is always a multiple of the true frame width and scores
# almost as well, so the narrowest width within this factor of the best score
# wins. 2.0 is the peak of the sweep against the GIF-derived ground truth.
GUESS_TOLERANCE = 2.0
DEFAULT_FPS = 8
_PROJECT_DIR = Path(__file__).resolve().parents[1]
DEFAULT_SRC = _PROJECT_DIR.parents[2] / "meta/vendor_full/3_Animated_objects/16x16"
DEST = _PROJECT_DIR / "vendor/modern-interiors/room/animated"


def frame_scores(path: Path) -> list[tuple[int, float]]:
    """(frame width, mean difference between consecutive frames) per candidate."""
    with Image.open(path) as im:
        a = np.asarray(im.convert("RGBA"), dtype=np.int16)
    h, w = a.shape[:2]
    out = []
    for fw in range(TILE, w, TILE):
        if w % fw:
            continue
        count = w // fw
        if count < 2:
            continue
        frames = a.reshape(h, count, fw, 4).transpose(1, 0, 2, 3)
        diff = float(np.abs(frames[1:] - frames[:-1]).mean())
        if diff == 0:  # identical frames: the split is finer than the real one
            continue
        out.append((fw, diff))
    return out


def guess_frame_width(path: Path) -> int | None:
    scores = frame_scores(path)
    if not scores:
        return None
    best = min(diff for _fw, diff in scores)
    return next(fw for fw, diff in scores if diff <= best * GUESS_TOLERANCE)


def gif_geometry(gif: Path) -> tuple[int, int, int]:
    """(frame width, frame height, fps) of a GIF, from its size and frame delays."""
    with Image.open(gif) as im:
        w, h = im.size
        delays = []
        for i in range(im.n_frames):
            im.seek(i)
            delays.append(im.info.get("duration") or 0)
    usable = [d for d in delays if d > 0]
    fps = round(1000 / (sum(usable) / len(usable))) if usable else DEFAULT_FPS
    return w, h, max(1, fps)


def describe(sheet: Path, gif: Path | None) -> dict | None:
    with Image.open(sheet) as im:
        sw, sh = im.size
    if gif is not None:
        fw, fh, fps = gif_geometry(gif)
        if fh == sh and fw and sw % fw == 0 and fw % TILE == 0:
            return {"fw": fw, "fh": fh, "frames": sw // fw, "fps": fps, "src": "gif"}
    fw = guess_frame_width(sheet)
    if fw is None or sh % TILE:
        return None
    return {"fw": fw, "fh": sh, "frames": sw // fw, "fps": DEFAULT_FPS, "src": "guess"}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--src", type=Path, default=DEFAULT_SRC)
    parser.add_argument("--dest", type=Path, default=DEST)
    args = parser.parse_args()

    sheets_dir, gif_dir = args.src / "spritesheets", args.src / "gif"
    if not sheets_dir.is_dir():
        print(f"no spritesheets under {args.src}", file=sys.stderr)
        return 2

    gifs = {p.stem: p for p in gif_dir.glob("*.gif")} if gif_dir.is_dir() else {}
    manifest: dict[str, dict] = {}
    skipped: list[str] = []

    args.dest.mkdir(parents=True, exist_ok=True)
    for png in sorted(sheets_dir.glob("*.png")):
        info = describe(png, gifs.get(png.stem))
        if info is None:
            skipped.append(png.name)
            continue
        manifest[png.name] = info
        shutil.copyfile(png, args.dest / png.name)

    # Sheets that lost their geometry between runs would otherwise linger as
    # files no manifest entry points at.
    for stale in args.dest.glob("*.png"):
        if stale.name not in manifest:
            stale.unlink()

    out = args.dest / "animated.json"
    out.write_text(json.dumps({"tile": TILE, "sheets": manifest}, indent=1) + "\n")

    guessed = sum(1 for v in manifest.values() if v["src"] == "guess")
    print(
        f"{len(manifest)} sheets -> {out} ({guessed} by fallback, {len(skipped)} skipped)"
    )
    for name in skipped:
        print("  skipped:", name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
