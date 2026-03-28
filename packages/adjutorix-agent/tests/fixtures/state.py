"""
ADJUTORIX AGENT — TEST FIXTURES / STATE

Canonical state constructors and mutation helpers for deterministic testing.

Principles:
- Canonical: identical semantic inputs → identical serialized state
- Closed: no external IO, no global singletons
- Explicit: all fields populated; no implicit defaults
- Immutable-by-default: builders return deep-copied structures
- Hash-stable: ordering normalized for content-addressing

The shape mirrors core State but remains decoupled from implementation to
avoid importing production side-effects into fixtures.

State model (canonical):
{
  "jobs": {job_id: {...}},
  "patches": {patch_id: {...}},
  "workflows": {wf_id: {...}},
  "authority": str,
  "environment": {"cwd": str, ...},
  "version": int,
}

Utilities include:
- builders for common states
- deterministic ID/clock injection
- normalization helpers (ordering, float guards)
- diff/assert helpers for invariant testing

NO PLACEHOLDERS.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Any, Callable, Optional, Tuple
import copy
import math


# ---------------------------------------------------------------------------
# DETERMINISM PRIMITIVES
# ---------------------------------------------------------------------------


class FixedClock:
    """Monotonic deterministic clock (integer ticks)."""

    def __init__(self, start: int = 1_000_000) -> None:
        self._t = start

    def now(self) -> int:
        self._t += 1
        return self._t


class FixedIdGen:
    """Deterministic ID generator with namespace segregation."""

    def __init__(self, prefix: str = "id") -> None:
        self._i = 0
        self._p = prefix

    def next(self) -> str:
        self._i += 1
        return f"{self._p}_{self._i:06d}"


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _norm_float(x: float) -> float:
    if math.isnan(x) or math.isinf(x):
        raise ValueError("fixture_state:invalid_float")
    return 0.0 if x == 0.0 else x


def normalize(obj: Any) -> Any:
    """Recursively normalize for canonical comparisons/hashing."""
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        return _norm_float(obj)
    if isinstance(obj, dict):
        return {str(k): normalize(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [normalize(v) for v in obj]
    if isinstance(obj, set):
        return [normalize(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"fixture_state:unsupported_type:{type(obj).__name__}")


# ---------------------------------------------------------------------------
# BASE STATE
# ---------------------------------------------------------------------------


def empty_state(*, cwd: str = "/repo", authority: str = "root") -> Dict[str, Any]:
    """Return a fully-specified empty canonical state."""
    s = {
        "jobs": {},
        "patches": {},
        "workflows": {},
        "authority": authority,
        "environment": {"cwd": cwd},
        "version": 0,
    }
    return normalize(copy.deepcopy(s))


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def with_job(
    base: Dict[str, Any],
    *,
    job_id: str,
    status: str = "queued",
    payload: Optional[Dict[str, Any]] = None,
    created_ts: Optional[int] = None,
) -> Dict[str, Any]:
    s = copy.deepcopy(base)
    s["jobs"][job_id] = normalize({
        "job_id": job_id,
        "status": status,
        "payload": payload or {},
        "created_ts": created_ts if created_ts is not None else 0,
    })
    s["version"] += 1
    return normalize(s)


def with_patch(
    base: Dict[str, Any],
    *,
    patch_id: str,
    diff: str,
    intent: Dict[str, Any],
    hash_: str,
    status: str = "preview",
) -> Dict[str, Any]:
    s = copy.deepcopy(base)
    s["patches"][patch_id] = normalize({
        "patch_id": patch_id,
        "diff": diff,
        "intent": intent,
        "hash": hash_,
        "status": status,
    })
    s["version"] += 1
    return normalize(s)


def with_workflow(
    base: Dict[str, Any],
    *,
    wf_id: str,
    steps: list,
    status: str = "created",
) -> Dict[str, Any]:
    s = copy.deepcopy(base)
    s["workflows"][wf_id] = normalize({
        "workflow_id": wf_id,
        "steps": steps,
        "status": status,
    })
    s["version"] += 1
    return normalize(s)


# ---------------------------------------------------------------------------
# COMPOSITE SCENARIOS
# ---------------------------------------------------------------------------


def state_with_single_job(clock: Optional[FixedClock] = None, ids: Optional[FixedIdGen] = None) -> Dict[str, Any]:
    clock = clock or FixedClock()
    ids = ids or FixedIdGen("job")
    s = empty_state()
    return with_job(
        s,
        job_id=ids.next(),
        status="queued",
        payload={"op": "noop"},
        created_ts=clock.now(),
    )


def state_with_patch_preview(
    *,
    intent: Dict[str, Any],
    diff: str,
    hash_: str,
    ids: Optional[FixedIdGen] = None,
) -> Dict[str, Any]:
    ids = ids or FixedIdGen("patch")
    s = empty_state()
    return with_patch(
        s,
        patch_id=ids.next(),
        diff=diff,
        intent=normalize(intent),
        hash_=hash_,
        status="preview",
    )


def state_with_applied_patch(
    *,
    intent: Dict[str, Any],
    diff: str,
    hash_: str,
    ids: Optional[FixedIdGen] = None,
) -> Dict[str, Any]:
    ids = ids or FixedIdGen("patch")
    s = empty_state()
    s = with_patch(
        s,
        patch_id=ids.next(),
        diff=diff,
        intent=normalize(intent),
        hash_=hash_,
        status="applied",
    )
    return s


# ---------------------------------------------------------------------------
# TRANSFORM HELPERS (PURE)
# ---------------------------------------------------------------------------


def bump_version(s: Dict[str, Any]) -> Dict[str, Any]:
    t = copy.deepcopy(s)
    t["version"] = int(t.get("version", 0)) + 1
    return normalize(t)


def set_env(s: Dict[str, Any], **env) -> Dict[str, Any]:
    t = copy.deepcopy(s)
    t.setdefault("environment", {})
    for k, v in env.items():
        t["environment"][k] = v
    return normalize(t)


def set_authority(s: Dict[str, Any], authority: str) -> Dict[str, Any]:
    t = copy.deepcopy(s)
    t["authority"] = authority
    return normalize(t)


# ---------------------------------------------------------------------------
# ASSERTIONS / DIFF
# ---------------------------------------------------------------------------


def assert_canonical_equal(a: Dict[str, Any], b: Dict[str, Any]) -> None:
    na = normalize(a)
    nb = normalize(b)
    if na != nb:
        raise AssertionError(_diff_str(na, nb))


def _diff_str(a: Any, b: Any, path: str = "$") -> str:
    if type(a) != type(b):
        return f"type_mismatch@{path}:{type(a).__name__}!={type(b).__name__}"
    if isinstance(a, dict):
        ak = set(a.keys())
        bk = set(b.keys())
        if ak != bk:
            return f"keys_mismatch@{path}:{sorted(ak ^ bk)}"
        for k in sorted(ak):
            d = _diff_str(a[k], b[k], f"{path}.{k}")
            if d:
                return d
        return ""
    if isinstance(a, list):
        if len(a) != len(b):
            return f"len_mismatch@{path}:{len(a)}!={len(b)}"
        for i, (x, y) in enumerate(zip(a, b)):
            d = _diff_str(x, y, f"{path}[{i}]")
            if d:
                return d
        return ""
    if a != b:
        return f"value_mismatch@{path}:{a}!={b}"
    return ""


# ---------------------------------------------------------------------------
# INJECTION ADAPTERS
# ---------------------------------------------------------------------------


def inject_determinism(
    *,
    clock: Optional[FixedClock] = None,
    idgen: Optional[FixedIdGen] = None,
) -> Tuple[Callable[[], int], Callable[[], str]]:
    """
    Provide callables compatible with core components expecting time/id providers.

    Usage:
        now, next_id = inject_determinism()
        scheduler = Scheduler(clock=now, idgen=next_id)
    """
    clock = clock or FixedClock()
    idgen = idgen or FixedIdGen()
    return clock.now, idgen.next


# ---------------------------------------------------------------------------
# SNAPSHOT-LIKE FREEZE
# ---------------------------------------------------------------------------


def freeze(s: Dict[str, Any]) -> Dict[str, Any]:
    """Return a deep-copied, normalized, read-only snapshot (by convention)."""
    return normalize(copy.deepcopy(s))


__all__ = [
    # primitives
    "FixedClock",
    "FixedIdGen",
    "normalize",
    # base
    "empty_state",
    # builders
    "with_job",
    "with_patch",
    "with_workflow",
    # scenarios
    "state_with_single_job",
    "state_with_patch_preview",
    "state_with_applied_patch",
    # transforms
    "bump_version",
    "set_env",
    "set_authority",
    # assertions
    "assert_canonical_equal",
    # injection
    "inject_determinism",
    # freeze
    "freeze",
]
