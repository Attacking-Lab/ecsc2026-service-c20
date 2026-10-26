"""Builds the character manifest by scanning the vendored 16x16 sprite pieces.

Layer order, the optional/None flags, and the animation frame map are lifted
directly from the reference Unity project (Character Generator 2.0):

- Compositing order (bottom -> top): Body, Eyes, Outfit, Hairstyle, Accessory.
  See CharacterDropdownManager.RecreateCharacter iterating CharacterPieces in
  order and SpriteManager.CombineTextures alpha-compositing them.
- Body and Eyes are required; Outfit, Hairstyle and Accessory carry an NA
  ("None") option (Adult Character.asset: IncludeNAOption).
- The 16x16 sheet is 896x640; a character frame is 16x32. The animation frame
  map (idle, walk, sit, read, gift, lift, pick up, throw, hit, hurt) lives in
  animations.py, extracted from the preview clips and sprite rects.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .animations import ANIMATIONS
from .paths import PIECES_DIR

SHEET_W, SHEET_H = 896, 640
FRAME_W, FRAME_H = 16, 32


@dataclass(frozen=True)
class Category:
    key: str
    label: str
    folder: str
    optional: bool  # whether a "None" choice is offered
    default_none: bool  # whether "None" is the default choice

    def label_for(self, stem: str) -> str:
        return _LABELLERS[self.key](stem)


def _label_body(stem: str) -> str:
    return f"Body {int(stem.split('_')[1])}"


def _label_eyes(stem: str) -> str:
    return f"Eyes {int(stem.split('_')[1])}"


def _label_two_part(prefix: str, stem: str) -> str:
    # Outfit_05_03 -> "Outfit 5.3", Hairstyle_12_02 -> "Hair 12.2"
    parts = stem.split("_")
    return f"{prefix} {int(parts[1])}.{int(parts[2])}"


def _label_outfit(stem: str) -> str:
    return _label_two_part("Outfit", stem)


def _label_hair(stem: str) -> str:
    return _label_two_part("Hair", stem)


def _label_accessory(stem: str) -> str:
    # Accessory_06_Policeman_Hat_01 -> "Policeman Hat 1"
    parts = stem.split("_")
    name = " ".join(parts[2:-1]) or f"Accessory {int(parts[1])}"
    return f"{name} {int(parts[-1])}"


_LABELLERS = {
    "body": _label_body,
    "eyes": _label_eyes,
    "outfit": _label_outfit,
    "hairstyle": _label_hair,
    "accessory": _label_accessory,
}

# Order here IS the compositing order (index 0 drawn first / at the bottom).
CATEGORIES: tuple[Category, ...] = (
    Category("body", "Body", "Bodies", optional=False, default_none=False),
    Category("eyes", "Eyes", "Eyes", optional=False, default_none=False),
    Category("outfit", "Outfit", "Outfits", optional=True, default_none=False),
    Category("hairstyle", "Hair", "Hairstyles", optional=True, default_none=False),
    Category("accessory", "Accessory", "Accessories", optional=True, default_none=True),
)

CATEGORY_BY_KEY = {c.key: c for c in CATEGORIES}

_NUM_KEY = re.compile(r"(\d+)")


def _natural_key(stem: str) -> list[int | str]:
    return [int(t) if t.isdigit() else t for t in _NUM_KEY.split(stem) if t]


def _sorted_stems(folder: Path) -> list[str]:
    stems = [p.stem for p in folder.glob("*.png")]
    stems.sort(key=lambda s: (_natural_key(s), s))
    return stems


def resolve_piece(category_key: str, option_id: str) -> Path | None:
    """Map (category, option id) to an on-disk PNG, or None for the 'None' option."""
    cat = CATEGORY_BY_KEY.get(category_key)
    if cat is None:
        raise KeyError(category_key)
    if option_id in ("", "none", "None"):
        if not cat.optional:
            raise ValueError(f"category {category_key!r} has no None option")
        return None
    path = (PIECES_DIR / cat.folder / f"{option_id}.png").resolve()
    # Guard against path traversal via a crafted option id.
    if not path.is_file() or (PIECES_DIR / cat.folder).resolve() not in path.parents:
        raise FileNotFoundError(f"{category_key}/{option_id}")
    return path


# Per-animation eye tweaks: frame indices (0-based) whose eyes should be taken
# from the first frame instead of animating. The 5th and 6th frames of idle and
# sit hold the open first-frame eyes; all other frames animate normally.
EYE_HOLD_FIRST: dict[str, frozenset[int]] = {
    "idle": frozenset({4, 5}),
    "sit": frozenset({4, 5}),
}


def eye_frame_index(name: str, i: int) -> int:
    """Which frame the eyes layer samples on animation frame `i`.

    The eyes sheet blinks naturally, so most frames sample their own cell; idle
    and sit hold the open first-frame eyes on their resting frames instead.
    """
    hold = EYE_HOLD_FIRST.get(name)
    if hold is not None and i in hold:
        return 0
    return i


# Per-animation default playback-speed multiplier applied to the extracted fps.
# Idle, sit and read play at a fifth of their native rate so the resting poses read as calm.
DEFAULT_SPEED: dict[str, float] = {"idle": 0.2, "sit": 0.2, "read": 0.2}


def _animations_with_eye_holds() -> dict:
    """ANIMATIONS augmented with an eye-frame remap for the eyes layer.

    `eyes` maps each animation frame index to the frame the eyes layer should
    sample (identity except for the idle/sit resting frames, which hold open).
    """
    out: dict[str, dict] = {}
    for name, anim in ANIMATIONS.items():
        entry = dict(anim)
        entry["fps"] = anim["fps"] * DEFAULT_SPEED.get(name, 1.0)
        eyes: dict[str, list[int]] = {}
        for direction, frames in anim["directions"].items():
            eyes[direction] = [eye_frame_index(name, i) for i in range(len(frames))]
        entry["eyes"] = eyes
        out[name] = entry
    return out


def build_manifest() -> dict:
    categories = []
    for cat in CATEGORIES:
        stems = _sorted_stems(PIECES_DIR / cat.folder)
        options = [
            {
                "id": stem,
                "label": cat.label_for(stem),
                "url": f"/assets/{cat.folder}/{stem}.png",
            }
            for stem in stems
        ]
        default = None if cat.default_none else (stems[0] if stems else None)
        categories.append(
            {
                "key": cat.key,
                "label": cat.label,
                "optional": cat.optional,
                "default": default,
                "options": options,
            }
        )

    return {
        "sheet": {"w": SHEET_W, "h": SHEET_H},
        "frame": {"w": FRAME_W, "h": FRAME_H},
        "layers": [c.key for c in CATEGORIES],
        "animations": _animations_with_eye_holds(),
        "categories": categories,
    }
