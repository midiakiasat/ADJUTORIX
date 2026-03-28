"""
ADJUTORIX AGENT — CORE / CLOCK

Deterministic time and ordering primitives.

Provides:
- Monotonic wall clock (ns) wrapper
- Logical clock (Lamport) for cross-thread/process ordering
- Hybrid Logical Clock (HLC) for combining physical time + causality
- Strict monotonic sequence generator (process-wide)
- Serialization / deserialization (stable)

Invariants:
- No time goes backwards (monotonic guards)
- Sequence strictly increases per process
- HLC respects: (t, c) ordering; if physical time regresses, counter increments
- Thread-safe, lock-minimized
"""

from __future__ import annotations

import json
import threading
import time
from dataclasses import dataclass
from typing import Tuple


# ---------------------------------------------------------------------------
# MONOTONIC WALL CLOCK
# ---------------------------------------------------------------------------


_last_ns = 0
_last_ns_lock = threading.Lock()


def now_ns() -> int:
    """Monotonic non-decreasing nanoseconds."""
    global _last_ns
    n = time.time_ns()
    with _last_ns_lock:
        if n <= _last_ns:
            _last_ns = _last_ns + 1
        else:
            _last_ns = n
        return _last_ns


# ---------------------------------------------------------------------------
# SEQUENCE (PROCESS-WIDE)
# ---------------------------------------------------------------------------


_seq = 0
_seq_lock = threading.Lock()


def next_seq() -> int:
    global _seq
    with _seq_lock:
        _seq += 1
        return _seq


# ---------------------------------------------------------------------------
# LAMPORT CLOCK
# ---------------------------------------------------------------------------


class LamportClock:
    def __init__(self, initial: int = 0) -> None:
        self._value = int(initial)
        self._lock = threading.Lock()

    def tick(self) -> int:
        with self._lock:
            self._value += 1
            return self._value

    def update(self, other: int) -> int:
        with self._lock:
            self._value = max(self._value, int(other)) + 1
            return self._value

    def value(self) -> int:
        with self._lock:
            return self._value


# ---------------------------------------------------------------------------
# HYBRID LOGICAL CLOCK (HLC)
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HLC:
    t: int  # physical time (ns)
    c: int  # logical counter

    def to_tuple(self) -> Tuple[int, int]:
        return (self.t, self.c)

    def to_json(self) -> str:
        return json.dumps({"t": self.t, "c": self.c}, separators=(",", ":"), sort_keys=True)

    @staticmethod
    def from_tuple(v: Tuple[int, int]) -> "HLC":
        return HLC(int(v[0]), int(v[1]))

    @staticmethod
    def from_json(s: str) -> "HLC":
        d = json.loads(s)
        return HLC(int(d["t"]), int(d["c"]))


class HybridLogicalClock:
    """
    HLC per process. Merge rules:
    - On local event: if now > t -> (now, 0) else (t, c+1)
    - On receive(remote):
        let now = now_ns()
        t' = max(now, local.t, remote.t)
        if t' == local.t == remote.t: c' = max(local.c, remote.c) + 1
        elif t' == local.t: c' = local.c + 1
        elif t' == remote.t: c' = remote.c + 1
        else: c' = 0
    """

    def __init__(self) -> None:
        self._hlc = HLC(now_ns(), 0)
        self._lock = threading.Lock()

    def now(self) -> HLC:
        with self._lock:
            return self._hlc

    def tick(self) -> HLC:
        with self._lock:
            n = now_ns()
            if n > self._hlc.t:
                self._hlc = HLC(n, 0)
            else:
                self._hlc = HLC(self._hlc.t, self._hlc.c + 1)
            return self._hlc

    def merge(self, remote: HLC) -> HLC:
        with self._lock:
            n = now_ns()
            t_local, c_local = self._hlc.t, self._hlc.c
            t_remote, c_remote = remote.t, remote.c

            t_prime = max(n, t_local, t_remote)

            if t_prime == t_local and t_prime == t_remote:
                c_prime = max(c_local, c_remote) + 1
            elif t_prime == t_local:
                c_prime = c_local + 1
            elif t_prime == t_remote:
                c_prime = c_remote + 1
            else:
                c_prime = 0

            self._hlc = HLC(t_prime, c_prime)
            return self._hlc


# ---------------------------------------------------------------------------
# GLOBAL SINGLETONS
# ---------------------------------------------------------------------------


_LAMPORT: LamportClock | None = None
_HLC: HybridLogicalClock | None = None
_LOCK = threading.Lock()


def lamport() -> LamportClock:
    global _LAMPORT
    if _LAMPORT is None:
        with _LOCK:
            if _LAMPORT is None:
                _LAMPORT = LamportClock()
    return _LAMPORT


def hlc() -> HybridLogicalClock:
    global _HLC
    if _HLC is None:
        with _LOCK:
            if _HLC is None:
                _HLC = HybridLogicalClock()
    return _HLC
