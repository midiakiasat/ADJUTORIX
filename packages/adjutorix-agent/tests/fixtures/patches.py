"""
ADJUTORIX AGENT — TEST FIXTURES / PATCHES

Deterministic, content-addressed patch builders and verifiers.

Purpose:
- Provide canonical patch representations independent of runtime builders
- Enable hash-stable expectations across tests
- Model preview → verify → apply lifecycle in pure form

Design constraints:
- Pure functions only (no IO)
- Content-addressed (hash derived from canonical content)
- Stable ordering + normalization
- Explicit lifecycle states

Patch schema (canonical):
{
  "patch_id": str,
  "intent": dict,
  "diff": str,
  "hash": str,
  "status": "preview" | "verified" | "applied",
  "meta": { ... }
}

NO PLACEHOLDERS.
"""

from __future__ import annotations

from typing import Dict, Any, Optional, List
import hashlib
import json
import copy


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _norm(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("fixture_patches:invalid_float")
        return 0.0 if obj == 0.0 else obj
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    if isinstance(obj, set):
        return [_norm(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"fixture_patches:unsupported_type:{type(obj).__name__}")


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def compute_patch_hash(intent: Dict[str, Any], diff: str) -> str:
    payload = {
        "intent": _norm(intent),
        "diff": diff,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def build_patch(
    *,
    patch_id: str,
    intent: Dict[str, Any],
    diff: str,
    status: str = "preview",
    meta: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    intent_n = _norm(intent)
    h = compute_patch_hash(intent_n, diff)

    patch = {
        "patch_id": patch_id,
        "intent": intent_n,
        "diff": diff,
        "hash": h,
        "status": status,
        "meta": _norm(meta or {}),
    }

    return _norm(patch)


# ---------------------------------------------------------------------------
# LIFECYCLE TRANSITIONS
# ---------------------------------------------------------------------------


def mark_verified(patch: Dict[str, Any]) -> Dict[str, Any]:
    p = copy.deepcopy(patch)
    if p["status"] != "preview":
        raise ValueError("invalid_transition:verify")
    p["status"] = "verified"
    return _norm(p)


def mark_applied(patch: Dict[str, Any]) -> Dict[str, Any]:
    p = copy.deepcopy(patch)
    if p["status"] not in {"verified", "preview"}:
        raise ValueError("invalid_transition:apply")
    p["status"] = "applied"
    return _norm(p)


# ---------------------------------------------------------------------------
# DIFF GENERATORS
# ---------------------------------------------------------------------------


def simple_diff(path: str, content: str) -> str:
    return f"--- {path}\n+++ {path}\n+{content}\n"


def append_diff(path: str, content: str) -> str:
    return f"--- {path}\n+++ {path}\n@@ append @@\n+{content}\n"


# ---------------------------------------------------------------------------
# BATCH
# ---------------------------------------------------------------------------


def batch_patches(intents: List[Dict[str, Any]], prefix: str = "p") -> List[Dict[str, Any]]:
    out: List[Dict[str, Any]] = []
    for i, intent in enumerate(intents):
        pid = f"{prefix}_{i:06d}"
        diff = simple_diff(intent.get("target", "unknown"), json.dumps(intent.get("params", {})))
        out.append(build_patch(patch_id=pid, intent=intent, diff=diff))
    return out


# ---------------------------------------------------------------------------
# ASSERTIONS
# ---------------------------------------------------------------------------


def assert_patch_equal(a: Dict[str, Any], b: Dict[str, Any]) -> None:
    na = _norm(a)
    nb = _norm(b)
    if na != nb:
        raise AssertionError(_diff(na, nb))


def assert_hash_stable(intent: Dict[str, Any], diff: str) -> None:
    h1 = compute_patch_hash(intent, diff)
    h2 = compute_patch_hash(intent, diff)
    if h1 != h2:
        raise AssertionError("hash_instability")


# ---------------------------------------------------------------------------
# DIFF HELPER
# ---------------------------------------------------------------------------


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
    "compute_patch_hash",
    "build_patch",
    "mark_verified",
    "mark_applied",
    "simple_diff",
    "append_diff",
    "batch_patches",
    "assert_patch_equal",
    "assert_hash_stable",
]
