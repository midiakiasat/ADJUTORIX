"""
ADJUTORIX AGENT — TEST FIXTURES / DETERMINISM

Centralized deterministic primitives and guards to eliminate nondeterminism
across tests and integration runs.

Scope:
- Time: monotonic logical clock (no wall time)
- IDs: namespace-scoped, collision-free generators
- Randomness: seeded PRNG wrappers (no global random)
- Hashing: canonical JSON encoding + stable hashing
- Ordering: canonical sort helpers
- Concurrency: deterministic schedulers for interleaving control

Hard guarantees:
- No dependency on system clock or process randomness
- Stable outputs across processes/machines
- Reproducible interleavings when required

NO PLACEHOLDERS.
"""

from __future__ import annotations

from typing import Any, Callable, Dict, Iterable, List, Optional, Tuple
import hashlib
import json
import threading


# ---------------------------------------------------------------------------
# CANONICALIZATION / HASHING
# ---------------------------------------------------------------------------


def _norm(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("determinism:invalid_float")
        return 0.0 if obj == 0.0 else obj
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    if isinstance(obj, set):
        return [_norm(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"determinism:unsupported_type:{type(obj).__name__}")


def canonical_json(obj: Any) -> str:
    return json.dumps(_norm(obj), sort_keys=True, separators=(",", ":"))


def stable_hash(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# TIME
# ---------------------------------------------------------------------------


class LogicalClock:
    """Deterministic monotonic clock."""

    def __init__(self, start: int = 1_000_000) -> None:
        self._t = start
        self._lock = threading.Lock()

    def now(self) -> int:
        with self._lock:
            self._t += 1
            return self._t

    def peek(self) -> int:
        return self._t


# ---------------------------------------------------------------------------
# ID GENERATION
# ---------------------------------------------------------------------------


class IdGen:
    """Namespace-scoped deterministic ID generator."""

    def __init__(self, prefix: str = "id") -> None:
        self._p = prefix
        self._i = 0
        self._lock = threading.Lock()

    def next(self) -> str:
        with self._lock:
            self._i += 1
            return f"{self._p}_{self._i:08d}"

    def snapshot(self) -> Tuple[str, int]:
        return self._p, self._i

    def restore(self, snap: Tuple[str, int]) -> None:
        p, i = snap
        self._p, self._i = p, i


# ---------------------------------------------------------------------------
# SEEDED PRNG (NO GLOBAL RANDOM)
# ---------------------------------------------------------------------------


class PRNG:
    """XorShift64* deterministic PRNG (no external deps)."""

    def __init__(self, seed: int = 0x9E3779B97F4A7C15) -> None:
        if seed == 0:
            seed = 0x9E3779B97F4A7C15
        self._x = seed & 0xFFFFFFFFFFFFFFFF

    def _next_u64(self) -> int:
        x = self._x
        x ^= (x >> 12) & 0xFFFFFFFFFFFFFFFF
        x ^= (x << 25) & 0xFFFFFFFFFFFFFFFF
        x ^= (x >> 27) & 0xFFFFFFFFFFFFFFFF
        self._x = x
        return (x * 0x2545F4914F6CDD1D) & 0xFFFFFFFFFFFFFFFF

    def randint(self, lo: int, hi: int) -> int:
        if hi < lo:
            raise ValueError("prng:invalid_range")
        span = hi - lo + 1
        return lo + (self._next_u64() % span)

    def choice(self, seq: List[Any]) -> Any:
        if not seq:
            raise ValueError("prng:empty_choice")
        idx = self.randint(0, len(seq) - 1)
        return seq[idx]

    def shuffle(self, seq: List[Any]) -> List[Any]:
        a = list(seq)
        for i in range(len(a) - 1, 0, -1):
            j = self.randint(0, i)
            a[i], a[j] = a[j], a[i]
        return a


# ---------------------------------------------------------------------------
# ORDERING
# ---------------------------------------------------------------------------


def canonical_sort(items: Iterable[Any]) -> List[Any]:
    return sorted((_norm(x) for x in items), key=lambda x: canonical_json(x))


# ---------------------------------------------------------------------------
# DETERMINISTIC SCHEDULER (INTERLEAVING CONTROL)
# ---------------------------------------------------------------------------


class StepScheduler:
    """
    Deterministic step scheduler to control thread interleavings.

    Usage:
        sched = StepScheduler(["t1:a", "t2:a", "t1:b", "t2:b"])
        sched.wait("t1:a")  # blocks until step reached
    """

    def __init__(self, steps: List[str]) -> None:
        self._steps = list(steps)
        self._i = 0
        self._cv = threading.Condition()

    def wait(self, label: str) -> None:
        with self._cv:
            while True:
                if self._i >= len(self._steps):
                    raise RuntimeError("scheduler:exhausted")
                if self._steps[self._i] == label:
                    self._i += 1
                    self._cv.notify_all()
                    return
                self._cv.wait()

    def remaining(self) -> List[str]:
        with self._cv:
            return self._steps[self._i:]


# ---------------------------------------------------------------------------
# SNAPSHOT / RESTORE FOR DETERMINISM STATE
# ---------------------------------------------------------------------------


class DeterminismBundle:
    """Bundle of clock, idgens, and prng with snapshot/restore."""

    def __init__(self, *, seed: int = 1) -> None:
        self.clock = LogicalClock()
        self.idgen = IdGen()
        self.prng = PRNG(seed)

    def snapshot(self) -> Dict[str, Any]:
        return {
            "clock": self.clock.peek(),
            "idgen": self.idgen.snapshot(),
            "prng": self.prng._x,  # internal state
        }

    def restore(self, snap: Dict[str, Any]) -> None:
        # restore clock by setting internal value
        self.clock._t = int(snap["clock"])  # controlled use
        self.idgen.restore(tuple(snap["idgen"]))
        self.prng._x = int(snap["prng"])  # controlled use


# ---------------------------------------------------------------------------
# ASSERTIONS
# ---------------------------------------------------------------------------


def assert_stable_hash(obj: Any) -> None:
    h1 = stable_hash(obj)
    h2 = stable_hash(obj)
    if h1 != h2:
        raise AssertionError("hash_instability")


def assert_canonical_equal(a: Any, b: Any) -> None:
    na = _norm(a)
    nb = _norm(b)
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
    "canonical_json",
    "stable_hash",
    "LogicalClock",
    "IdGen",
    "PRNG",
    "canonical_sort",
    "StepScheduler",
    "DeterminismBundle",
    "assert_stable_hash",
    "assert_canonical_equal",
]
