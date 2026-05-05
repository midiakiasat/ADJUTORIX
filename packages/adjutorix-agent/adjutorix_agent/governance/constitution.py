"""ADJUTORIX agent-side repository constitution classifier.

This module gives Python governance code the same executable surface truth used
by CI and shell guards. It intentionally mirrors the repository constitution
glob semantics instead of reintroducing ad hoc path classes inside agent code.
"""

from __future__ import annotations

from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

import json
import re


@dataclass(frozen=True)
class ConstitutionStratum:
    id: str
    patterns: tuple[str, ...]


def _normalize_rel_path(rel_path: str) -> str:
    return rel_path.replace("\\", "/").lstrip("./")


@lru_cache(maxsize=2048)
def _glob_to_regex(glob: str) -> re.Pattern[str]:
    out = "^"
    i = 0

    while i < len(glob):
        ch = glob[i]
        nxt = glob[i + 1] if i + 1 < len(glob) else ""
        after = glob[i + 2] if i + 2 < len(glob) else ""

        if ch == "*" and nxt == "*":
            if after == "/":
                out += r"(?:.*/)?"
                i += 3
            else:
                out += r".*"
                i += 2
            continue

        if ch == "*":
            out += r"[^/]*"
            i += 1
            continue

        if ch == "?":
            out += r"[^/]"
            i += 1
            continue

        out += re.escape(ch)
        i += 1

    out += "$"
    return re.compile(out)


@lru_cache(maxsize=32)
def load_constitution_strata(repo_root: str) -> tuple[ConstitutionStratum, ...]:
    constitution_path = Path(repo_root) / "configs" / "adjutorix" / "constitution.json"
    if not constitution_path.exists():
        return ()

    raw: dict[str, Any] = json.loads(constitution_path.read_text(encoding="utf-8"))
    strata: list[ConstitutionStratum] = []

    for item in raw.get("strata", []):
        stratum_id = str(item.get("id", ""))
        patterns = tuple(str(pattern) for pattern in item.get("patterns", []))
        if stratum_id and patterns:
            strata.append(ConstitutionStratum(id=stratum_id, patterns=patterns))

    return tuple(strata)


def classify_constitution_path(repo_root: str, rel_path: str) -> str:
    normalized = _normalize_rel_path(rel_path)

    for stratum in load_constitution_strata(repo_root):
        for pattern in stratum.patterns:
            if _glob_to_regex(pattern).match(normalized):
                return stratum.id

    return "unclassified"
