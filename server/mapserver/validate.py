"""Check a map document before it is stored. Mirrors `validate()` in the editor's src/model.ts: keep them in step
(terrain types, version numbers). The server stores the document as sent once it passes; it never rewrites it."""
from __future__ import annotations

import math
import re
from typing import Any

from .errors import ApiError

VERSIONS = (1, 2, 3)
TERRAINS = frozenset({"hill", "river", "sea", "wood", "desert", "road", "wall", "bridge", "port"})
MAX_FEATURES = 5_000
MAX_POINTS_PER_FEATURE = 2_000
MAX_OBJECTIVES = 500
HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
COORD_LIMIT = 100_000.0  # mm; the sheet is 420 x 297


def _bad(msg: str) -> ApiError:
    return ApiError(422, "invalid_map", msg)


def _num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and abs(v) <= COORD_LIMIT


def validate_doc(doc: Any) -> str:
    """Raises ApiError 422 when the document is not a map we can safely keep. Returns its title (max 100 chars)."""
    if not isinstance(doc, dict) or doc.get("version") not in VERSIONS or isinstance(doc.get("version"), bool):
        raise _bad("That is not a map file (version 1, 2 or 3).")
    feats, objs = doc.get("features"), doc.get("objectives")
    if not isinstance(feats, list) or not isinstance(objs, list):
        raise _bad("The map has no feature or objective list.")
    if len(feats) > MAX_FEATURES or len(objs) > MAX_OBJECTIVES:
        raise _bad("The map has too many pieces.")
    for f in feats:
        if not isinstance(f, dict) or f.get("type") not in TERRAINS or not isinstance(f.get("points"), list):
            raise _bad("A terrain piece is malformed.")
        pts = f["points"]
        if len(pts) > MAX_POINTS_PER_FEATURE:
            raise _bad("A terrain piece has too many points.")
        for p in pts:
            if not (isinstance(p, list) and len(p) == 2 and _num(p[0]) and _num(p[1])):
                raise _bad("A terrain piece has a bad point.")
        if "width" in f and not _num(f["width"]):
            raise _bad("A terrain piece has a bad width.")
    for o in objs:
        if not isinstance(o, dict) or not _num(o.get("x")) or not _num(o.get("y")):
            raise _bad("An objective is malformed.")
        if "label" in o and (not isinstance(o["label"], str) or len(o["label"]) > 20):
            raise _bad("An objective label is too long.")
    title, rules = doc.get("title", ""), doc.get("rules", "")
    if not isinstance(title, str) or not isinstance(rules, str) or len(title) > 200 or len(rules) > 2_000:
        raise _bad("The title or rules text is too long.")
    if "grid" in doc and not isinstance(doc["grid"], bool):
        raise _bad("The grid setting must be true or false.")
    if "background" in doc and not (isinstance(doc["background"], str) and HEX.match(doc["background"])):
        raise _bad("The background colour must look like #e9dfc7.")
    if "seed" in doc and not _num(doc["seed"]):
        raise _bad("The seed must be a number.")
    return title.strip()[:100] or "Untitled"
