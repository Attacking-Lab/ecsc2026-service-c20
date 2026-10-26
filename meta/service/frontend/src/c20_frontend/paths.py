"""Filesystem locations, resolved relative to the repo unless overridden by env vars."""

from __future__ import annotations

import os
from pathlib import Path

# src/c20_frontend/paths.py -> parents[2] is the project dir (meta/service/frontend)
_PROJECT_DIR = Path(__file__).resolve().parents[2]
_VENDOR_DIR = _PROJECT_DIR / "vendor"
_MODERN_INTERIORS = _VENDOR_DIR / "modern-interiors"  # LimeZu, see its LICENSE.txt

WEB_DIR = Path(os.environ.get("C20_WEB_DIR", _PROJECT_DIR / "web"))
PIECES_DIR = Path(
    os.environ.get("C20_PIECES_DIR", _MODERN_INTERIORS / "character-pieces" / "16x16")
)
ROOM_DIR = Path(os.environ.get("C20_ROOM_DIR", _MODERN_INTERIORS / "room"))
# Edited rooms shipped with the repo; the editor's runtime saves layer on top.
ROOMS_FILE = Path(os.environ.get("C20_ROOMS_FILE", _PROJECT_DIR / "rooms.json"))
# Where the debug map editor persists an edited room (kept out of the asset dir).
ROOM_OVERRIDE = Path(
    os.environ.get("C20_ROOM_OVERRIDE", _PROJECT_DIR / "room_override.json")
)
