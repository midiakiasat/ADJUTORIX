"""
ADJUTORIX AGENT — OBSERVABILITY / METRICS

High-fidelity, lock-safe metrics subsystem with:
- Monotonic counters (per label-set)
- Histograms with fixed buckets (deterministic aggregation)
- Gauges with last-write-wins + timestamp
- Derived rates (EWMA) without time-skew leakage
- Snapshot/export (stable ordering, JSON-safe)
- Cardinality guard (prevents unbounded label explosion)

Invariants:
- All updates are atomic within process
- No dynamic bucket mutation
- Label keys are normalized + sorted
- Export is deterministic (sorted keys, stable structure)
"""

from __future__ import annotations

import json
import math
import threading
import time
from collections import defaultdict
from dataclasses import dataclass
from typing import Dict, Tuple, Iterable, Optional


# ---------------------------------------------------------------------------
# UTIL
# ---------------------------------------------------------------------------


def _now_ns() -> int:
    return time.time_ns()


def _norm_labels(labels: Optional[Dict[str, str]]) -> Tuple[Tuple[str, str], ...]:
    if not labels:
        return tuple()
    # stable ordering + string coercion
    return tuple(sorted((str(k), str(v)) for k, v in labels.items()))


# ---------------------------------------------------------------------------
# CARDINALITY GUARD
# ---------------------------------------------------------------------------


class CardinalityGuard:
    def __init__(self, limit: int = 10_000) -> None:
        self._limit = int(limit)
        self._seen: set[Tuple[str, Tuple[Tuple[str, str], ...]]] = set()
        self._lock = threading.Lock()

    def allow(self, name: str, labels: Tuple[Tuple[str, str], ...]) -> bool:
        key = (name, labels)
        with self._lock:
            if key in self._seen:
                return True
            if len(self._seen) >= self._limit:
                return False
            self._seen.add(key)
            return True


# ---------------------------------------------------------------------------
# COUNTER
# ---------------------------------------------------------------------------


class Counter:
    def __init__(self, name: str, guard: CardinalityGuard) -> None:
        self.name = name
        self._guard = guard
        self._values: Dict[Tuple[Tuple[str, str], ...], int] = defaultdict(int)
        self._lock = threading.Lock()

    def inc(self, amount: int = 1, *, labels: Optional[Dict[str, str]] = None) -> None:
        if amount < 0:
            raise ValueError("counter increment must be non-negative")
        key = _norm_labels(labels)
        if not self._guard.allow(self.name, key):
            return
        with self._lock:
            self._values[key] += int(amount)

    def snapshot(self) -> Dict[str, int]:
        with self._lock:
            # stable ordering
            return {
                json.dumps(dict(k), sort_keys=True): v
                for k, v in sorted(self._values.items(), key=lambda kv: kv[0])
            }


# ---------------------------------------------------------------------------
# GAUGE
# ---------------------------------------------------------------------------


@dataclass
class _GaugeValue:
    value: float
    ts_ns: int


class Gauge:
    def __init__(self, name: str, guard: CardinalityGuard) -> None:
        self.name = name
        self._guard = guard
        self._values: Dict[Tuple[Tuple[str, str], ...], _GaugeValue] = {}
        self._lock = threading.Lock()

    def set(self, value: float, *, labels: Optional[Dict[str, str]] = None) -> None:
        key = _norm_labels(labels)
        if not self._guard.allow(self.name, key):
            return
        with self._lock:
            self._values[key] = _GaugeValue(float(value), _now_ns())

    def snapshot(self) -> Dict[str, Dict[str, float]]:
        with self._lock:
            return {
                json.dumps(dict(k), sort_keys=True): {
                    "value": gv.value,
                    "ts_ns": gv.ts_ns,
                }
                for k, gv in sorted(self._values.items(), key=lambda kv: kv[0])
            }


# ---------------------------------------------------------------------------
# HISTOGRAM
# ---------------------------------------------------------------------------


class Histogram:
    def __init__(self, name: str, buckets: Iterable[float], guard: CardinalityGuard) -> None:
        self.name = name
        # enforce sorted, finite buckets
        bs = sorted(float(b) for b in buckets if math.isfinite(b))
        if not bs or bs[0] <= 0.0:
            raise ValueError("histogram buckets must be positive, finite, non-empty")
        self._buckets = tuple(bs)
        self._guard = guard
        self._counts: Dict[Tuple[Tuple[str, str], ...], list[int]] = defaultdict(lambda: [0] * (len(self._buckets) + 1))
        self._sums: Dict[Tuple[Tuple[str, str], ...], float] = defaultdict(float)
        self._lock = threading.Lock()

    def observe(self, value: float, *, labels: Optional[Dict[str, str]] = None) -> None:
        if value < 0:
            # allow zero but reject negatives to avoid undefined semantics
            raise ValueError("histogram observe must be >= 0")
        key = _norm_labels(labels)
        if not self._guard.allow(self.name, key):
            return
        idx = 0
        # linear scan is deterministic; bucket count is small by design
        while idx < len(self._buckets) and value > self._buckets[idx]:
            idx += 1
        with self._lock:
            self._counts[key][idx] += 1
            self._sums[key] += float(value)

    def snapshot(self) -> Dict[str, Dict[str, object]]:
        with self._lock:
            out: Dict[str, Dict[str, object]] = {}
            for k in sorted(self._counts.keys()):
                label_key = json.dumps(dict(k), sort_keys=True)
                out[label_key] = {
                    "buckets": list(self._buckets),
                    "counts": list(self._counts[k]),
                    "sum": self._sums[k],
                }
            return out


# ---------------------------------------------------------------------------
# EWMA RATE (DERIVED)
# ---------------------------------------------------------------------------


class EwmaRate:
    """Exponential weighted moving average of event rate (events/sec)."""

    def __init__(self, name: str, alpha: float = 0.2) -> None:
        if not (0.0 < alpha <= 1.0):
            raise ValueError("alpha must be in (0,1]")
        self.name = name
        self._alpha = float(alpha)
        self._last_ts_ns: Optional[int] = None
        self._value: float = 0.0
        self._lock = threading.Lock()

    def mark(self, n: int = 1) -> None:
        if n <= 0:
            return
        now = _now_ns()
        with self._lock:
            if self._last_ts_ns is None:
                self._last_ts_ns = now
                return
            dt = max((now - self._last_ts_ns) / 1e9, 1e-9)
            inst_rate = n / dt
            self._value = self._alpha * inst_rate + (1.0 - self._alpha) * self._value
            self._last_ts_ns = now

    def snapshot(self) -> float:
        with self._lock:
            return self._value


# ---------------------------------------------------------------------------
# REGISTRY
# ---------------------------------------------------------------------------


class MetricsRegistry:
    def __init__(self, *, cardinality_limit: int = 10_000) -> None:
        self._guard = CardinalityGuard(cardinality_limit)
        self._counters: Dict[str, Counter] = {}
        self._gauges: Dict[str, Gauge] = {}
        self._hists: Dict[str, Histogram] = {}
        self._rates: Dict[str, EwmaRate] = {}
        self._lock = threading.Lock()

    # ---- create/get --------------------------------------------------------

    def counter(self, name: str) -> Counter:
        with self._lock:
            if name not in self._counters:
                self._counters[name] = Counter(name, self._guard)
            return self._counters[name]

    def gauge(self, name: str) -> Gauge:
        with self._lock:
            if name not in self._gauges:
                self._gauges[name] = Gauge(name, self._guard)
            return self._gauges[name]

    def histogram(self, name: str, buckets: Iterable[float]) -> Histogram:
        with self._lock:
            if name not in self._hists:
                self._hists[name] = Histogram(name, buckets, self._guard)
            return self._hists[name]

    def rate(self, name: str, alpha: float = 0.2) -> EwmaRate:
        with self._lock:
            if name not in self._rates:
                self._rates[name] = EwmaRate(name, alpha)
            return self._rates[name]

    # ---- export ------------------------------------------------------------

    def snapshot(self) -> Dict[str, object]:
        # no global lock: take per-metric snapshots to reduce contention
        counters = {k: v.snapshot() for k, v in sorted(self._counters.items())}
        gauges = {k: v.snapshot() for k, v in sorted(self._gauges.items())}
        hists = {k: v.snapshot() for k, v in sorted(self._hists.items())}
        rates = {k: v.snapshot() for k, v in sorted(self._rates.items())}
        return {
            "counters": counters,
            "gauges": gauges,
            "histograms": hists,
            "rates": rates,
        }

    def to_json(self) -> str:
        return json.dumps(self.snapshot(), separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# GLOBAL REGISTRY (PROCESS-SINGLETON)
# ---------------------------------------------------------------------------


_GLOBAL: Optional[MetricsRegistry] = None
_GLOBAL_LOCK = threading.Lock()


def get_registry() -> MetricsRegistry:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = MetricsRegistry()
    return _GLOBAL


# ---------------------------------------------------------------------------
# PREDEFINED METRICS (CANONICAL NAMES)
# ---------------------------------------------------------------------------


def m_tx_started():
    return get_registry().counter("tx_started_total")


def m_tx_completed():
    return get_registry().counter("tx_completed_total")


def m_tx_failed():
    return get_registry().counter("tx_failed_total")


def m_verify_latency():
    # seconds buckets
    return get_registry().histogram("verify_latency_seconds", [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10])


def m_patch_size():
    # bytes buckets
    return get_registry().histogram("patch_size_bytes", [256, 1_024, 4_096, 16_384, 65_536, 262_144, 1_048_576])


def m_agent_uptime():
    return get_registry().gauge("agent_uptime_seconds")


def m_job_rate():
    return get_registry().rate("job_rate_eps", alpha=0.3)
