"""
ADJUTORIX AGENT — TEST FIXTURES / INTENTS

Deterministic, canonical intent constructors and generators.

Design goals:
- Canonical shape: identical semantic inputs → identical serialized intent
- Composability: higher-order generators for sequences/scenarios
- Determinism: optional injection of fixed ids/clock for embedded metadata
- Coverage: include valid, boundary, and adversarial intents
- Zero side-effects: pure data builders only

Intent schema (canonical, minimal):
{
  "op": str,                     # operation identifier
  "target": Optional[str],      # logical target (file, symbol, etc.)
  "params": dict,              # operation-specific parameters
  "meta": {
      "id": str,               # deterministic id (optional)
      "ts": int,               # deterministic timestamp (optional)
      "tags": list[str],
  }
}

Notes:
- 'target' is separate from params to stabilize hashing across ops.
- 'meta' is optional but normalized when present.
- Builders never mutate inputs; all returns are deep-copied and normalized.

NO PLACEHOLDERS.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional, Iterable, Tuple, Callable
import copy


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _norm(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        # avoid NaN/Inf; normalize -0.0
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("fixture_intents:invalid_float")
        return 0.0 if obj == 0.0 else obj
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    if isinstance(obj, set):
        return [_norm(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"fixture_intents:unsupported_type:{type(obj).__name__}")


def normalize_intent(intent: Dict[str, Any]) -> Dict[str, Any]:
    base = {
        "op": intent.get("op"),
        "target": intent.get("target"),
        "params": intent.get("params", {}),
        "meta": intent.get("meta", {}),
    }
    return _norm(base)


# ---------------------------------------------------------------------------
# DETERMINISM ADAPTERS
# ---------------------------------------------------------------------------


class FixedClock:
    def __init__(self, start: int = 1_000_000) -> None:
        self._t = start

    def now(self) -> int:
        self._t += 1
        return self._t


class FixedId:
    def __init__(self, prefix: str = "intent") -> None:
        self._i = 0
        self._p = prefix

    def next(self) -> str:
        self._i += 1
        return f"{self._p}_{self._i:06d}"


def with_meta(
    intent: Dict[str, Any],
    *,
    id_fn: Optional[Callable[[], str]] = None,
    ts_fn: Optional[Callable[[], int]] = None,
    tags: Optional[List[str]] = None,
) -> Dict[str, Any]:
    t = copy.deepcopy(intent)
    meta = dict(t.get("meta", {}))
    if id_fn is not None:
        meta["id"] = id_fn()
    if ts_fn is not None:
        meta["ts"] = ts_fn()
    if tags is not None:
        meta["tags"] = list(tags)
    t["meta"] = meta
    return normalize_intent(t)


# ---------------------------------------------------------------------------
# CORE BUILDERS
# ---------------------------------------------------------------------------


def edit_file(path: str, content: str) -> Dict[str, Any]:
    return normalize_intent({
        "op": "edit_file",
        "target": path,
        "params": {"content": content},
    })


def append_file(path: str, content: str) -> Dict[str, Any]:
    return normalize_intent({
        "op": "append_file",
        "target": path,
        "params": {"content": content},
    })


def delete_file(path: str) -> Dict[str, Any]:
    return normalize_intent({
        "op": "delete_file",
        "target": path,
        "params": {},
    })


def rename_file(src: str, dst: str) -> Dict[str, Any]:
    return normalize_intent({
        "op": "rename_file",
        "target": src,
        "params": {"dst": dst},
    })


def run_command(cmd: str, *, cwd: Optional[str] = None) -> Dict[str, Any]:
    return normalize_intent({
        "op": "run_command",
        "target": cwd,
        "params": {"cmd": cmd},
    })


# ---------------------------------------------------------------------------
# VALID / EDGE / ADVERSARIAL
# ---------------------------------------------------------------------------


def minimal_valid() -> Dict[str, Any]:
    return normalize_intent({"op": "noop", "params": {}})


def large_payload(path: str, size: int = 200_000) -> Dict[str, Any]:
    return edit_file(path, "x" * size)


def forbidden_path() -> Dict[str, Any]:
    return edit_file("/etc/passwd", "blocked")


def injection_like() -> Dict[str, Any]:
    return run_command("rm -rf /; echo pwned")


def empty_targets() -> Dict[str, Any]:
    return normalize_intent({"op": "bulk_edit", "target": None, "params": {"targets": []}})


def unicode_path() -> Dict[str, Any]:
    return edit_file("路径/файл/ملف.txt", "üñïçødé")


# ---------------------------------------------------------------------------
# SEQUENCES (DETERMINISTIC)
# ---------------------------------------------------------------------------


def sequence_edit_series(prefix: str, n: int) -> List[Dict[str, Any]]:
    return [edit_file(f"{prefix}_{i}.txt", str(i)) for i in range(n)]


def sequence_conflict_pair(path: str) -> Tuple[Dict[str, Any], Dict[str, Any]]:
    return edit_file(path, "A"), edit_file(path, "B")


def sequence_mixed(paths: Iterable[str]) -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i, p in enumerate(paths):
        if i % 3 == 0:
            out.append(edit_file(p, f"v{i}"))
        elif i % 3 == 1:
            out.append(append_file(p, f"+{i}"))
        else:
            out.append(rename_file(p, f"{p}.renamed"))
    return [normalize_intent(x) for x in out]


# ---------------------------------------------------------------------------
# BATCH / BULK
# ---------------------------------------------------------------------------


def bulk_edit(pairs: List[Tuple[str, str]]) -> Dict[str, Any]:
    return normalize_intent({
        "op": "bulk_edit",
        "target": None,
        "params": {"targets": [{"path": p, "content": c} for p, c in pairs]},
    })


def bulk_delete(paths: List[str]) -> Dict[str, Any]:
    return normalize_intent({
        "op": "bulk_delete",
        "target": None,
        "params": {"targets": list(paths)},
    })


# ---------------------------------------------------------------------------
# CANONICALIZATION HELPERS
# ---------------------------------------------------------------------------


def canonicalize_many(intents: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    return [normalize_intent(i) for i in intents]


def stable_sort(intents: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Order-independent canonical ordering for hashing comparisons."""
    normed = [normalize_intent(i) for i in intents]
    return sorted(normed, key=lambda x: (x.get("op"), str(x.get("target")), str(x.get("params"))))


# ---------------------------------------------------------------------------
# ASSERTIONS
# ---------------------------------------------------------------------------


def assert_equal(a: Dict[str, Any], b: Dict[str, Any]) -> None:
    na = normalize_intent(a)
    nb = normalize_intent(b)
    if na != nb:
        raise AssertionError(_diff(na, nb))


def _diff(a: Any, b: Any, path: str = "$") -> str:
    if type(a) != type(b):
        return f"type_mismatch@{path}:{type(a).__name__}!={type(b).__name__}"
    if isinstance(a, dict):
        ak, bk = set(a.keys()), set(b.keys())
        if ak != bk:
            return f"keys_mismatch@{path}:{sorted(ak ^ bk)}"
        for k in sorted(ak):
            d = _diff(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return ""
    if isinstance(a, list):
        if len(a) != len(b):
            return f"len_mismatch@{path}:{len(a)}!={len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _diff(x, y, f"{path}[{i}]")
            if d:
                return d
        return ""
    if a != b:
        return f"value_mismatch@{path}:{a}!={b}"
    return ""


__all__ = [
    # normalization
    "normalize_intent",
    # determinism
    "FixedClock",
    "FixedId",
    "with_meta",
    # builders
    "edit_file",
    "append_file",
    "delete_file",
    "rename_file",
    "run_command",
    # edge/adversarial
    "minimal_valid",
    "large_payload",
    "forbidden_path",
    "injection_like",
    "empty_targets",
    "unicode_path",
    # sequences
    "sequence_edit_series",
    "sequence_conflict_pair",
    "sequence_mixed",
    # bulk
    "bulk_edit",
    "bulk_delete",
    # canonicalization
    "canonicalize_many",
    "stable_sort",
    # assertions
    "assert_equal",
]
