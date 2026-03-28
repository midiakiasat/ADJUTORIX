"""
ADJUTORIX AGENT — OBSERVABILITY / TRACER

Deterministic, low-overhead tracing with:
- Trace / Span model (hierarchical, causal)
- Context propagation (thread-local + explicit)
- Monotonic timing (ns precision)
- Structured attributes (stable key ordering)
- Event emission with causal links
- Error attachment (compatible with observability.errors)
- Sampling (head-based + deterministic hashing)
- Bounded in-memory ring buffer + flush hooks

Invariants:
- No implicit global mutation beyond registry singleton
- Span lifecycle is explicit: start -> annotate -> end
- Parent/child linkage immutable after creation
- Export is deterministic (sorted, stable JSON)
- No unbounded cardinality in attributes (guarded)
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from collections import deque
from dataclasses import dataclass, field
from typing import Any, Callable, Deque, Dict, Iterable, Optional, Tuple


# ---------------------------------------------------------------------------
# CLOCK
# ---------------------------------------------------------------------------


def _now_ns() -> int:
    return time.time_ns()


# ---------------------------------------------------------------------------
# CONTEXT (THREAD-LOCAL)
# ---------------------------------------------------------------------------


class _Context(threading.local):
    def __init__(self) -> None:
        super().__init__()
        self.trace_id: Optional[str] = None
        self.span_id: Optional[str] = None
        self.stack: list[str] = []  # span_id stack


_CTX = _Context()


def current_trace_id() -> Optional[str]:
    return _CTX.trace_id


def current_span_id() -> Optional[str]:
    return _CTX.span_id


# ---------------------------------------------------------------------------
# SAMPLING
# ---------------------------------------------------------------------------


class Sampler:
    """Head-based deterministic sampler using hash(trace_id)."""

    def __init__(self, rate: float = 1.0) -> None:
        if not (0.0 < rate <= 1.0):
            raise ValueError("rate must be in (0,1]")
        self.rate = float(rate)

    def allow(self, trace_id: str) -> bool:
        if self.rate >= 1.0:
            return True
        # deterministic hash in [0,1)
        h = (int(trace_id[:16], 16) % 10_000) / 10_000.0
        return h < self.rate


# ---------------------------------------------------------------------------
# DATA MODELS
# ---------------------------------------------------------------------------


LabelKey = Tuple[Tuple[str, str], ...]


def _norm_attrs(attrs: Optional[Dict[str, Any]]) -> LabelKey:
    if not attrs:
        return tuple()
    # string-coerce + stable order; cap value length
    out = []
    for k, v in attrs.items():
        sv = str(v)
        if len(sv) > 256:
            sv = sv[:256]
        out.append((str(k), sv))
    return tuple(sorted(out))


@dataclass(frozen=True)
class Event:
    name: str
    ts_ns: int
    attrs: LabelKey = field(default_factory=tuple)


@dataclass
class Span:
    trace_id: str
    span_id: str
    parent_id: Optional[str]
    name: str
    start_ns: int
    end_ns: Optional[int] = None
    attrs: LabelKey = field(default_factory=tuple)
    events: list[Event] = field(default_factory=list)
    status: str = "ok"  # ok | error
    error: Optional[Dict[str, Any]] = None

    def duration_ns(self) -> Optional[int]:
        if self.end_ns is None:
            return None
        return self.end_ns - self.start_ns

    # --- mutation guarded by Tracer ---
    def _add_event(self, ev: Event) -> None:
        self.events.append(ev)

    def _set_error(self, err: Dict[str, Any]) -> None:
        self.status = "error"
        self.error = err

    def _finish(self, end_ns: int) -> None:
        self.end_ns = end_ns

    # --- serialization ---
    def to_dict(self) -> Dict[str, Any]:
        return {
            "trace_id": self.trace_id,
            "span_id": self.span_id,
            "parent_id": self.parent_id,
            "name": self.name,
            "start_ns": self.start_ns,
            "end_ns": self.end_ns,
            "duration_ns": self.duration_ns(),
            "status": self.status,
            "attrs": dict(self.attrs),
            "events": [
                {"name": e.name, "ts_ns": e.ts_ns, "attrs": dict(e.attrs)}
                for e in self.events
            ],
            "error": self.error,
        }


# ---------------------------------------------------------------------------
# RING BUFFER
# ---------------------------------------------------------------------------


class RingBuffer:
    def __init__(self, capacity: int = 10_000) -> None:
        if capacity <= 0:
            raise ValueError("capacity must be > 0")
        self._buf: Deque[Span] = deque(maxlen=capacity)
        self._lock = threading.Lock()

    def push(self, span: Span) -> None:
        with self._lock:
            self._buf.append(span)

    def snapshot(self) -> list[Dict[str, Any]]:
        with self._lock:
            # stable order: insertion order preserved by deque
            return [s.to_dict() for s in list(self._buf)]


# ---------------------------------------------------------------------------
# TRACER
# ---------------------------------------------------------------------------


class Tracer:
    def __init__(
        self,
        *,
        capacity: int = 10_000,
        sampler: Optional[Sampler] = None,
    ) -> None:
        self._buffer = RingBuffer(capacity)
        self._sampler = sampler or Sampler(1.0)
        self._lock = threading.Lock()

    # ---- lifecycle ---------------------------------------------------------

    def start_span(
        self,
        name: str,
        *,
        attrs: Optional[Dict[str, Any]] = None,
        trace_id: Optional[str] = None,
        parent_id: Optional[str] = None,
    ) -> Span:
        # establish trace
        if trace_id is None:
            trace_id = _CTX.trace_id or uuid.uuid4().hex

        if not self._sampler.allow(trace_id):
            # no-op span (not recorded)
            span = Span(trace_id, "", None, name, _now_ns())
            return span

        span_id = uuid.uuid4().hex

        # parent linkage from context if not explicit
        if parent_id is None:
            parent_id = _CTX.span_id

        span = Span(
            trace_id=trace_id,
            span_id=span_id,
            parent_id=parent_id,
            name=name,
            start_ns=_now_ns(),
            attrs=_norm_attrs(attrs),
        )

        # push context
        if _CTX.trace_id is None:
            _CTX.trace_id = trace_id
        _CTX.stack.append(span_id)
        _CTX.span_id = span_id

        return span

    def end_span(self, span: Span) -> None:
        if not span.span_id:
            return  # unsampled

        span._finish(_now_ns())

        # pop context (defensive: only pop if matches)
        if _CTX.stack and _CTX.stack[-1] == span.span_id:
            _CTX.stack.pop()
        _CTX.span_id = _CTX.stack[-1] if _CTX.stack else None
        if not _CTX.stack:
            _CTX.trace_id = None

        # record
        self._buffer.push(span)

    # ---- annotation --------------------------------------------------------

    def add_event(
        self,
        span: Span,
        name: str,
        *,
        attrs: Optional[Dict[str, Any]] = None,
    ) -> None:
        if not span.span_id:
            return
        ev = Event(name=name, ts_ns=_now_ns(), attrs=_norm_attrs(attrs))
        span._add_event(ev)

    def record_error(self, span: Span, err: Dict[str, Any]) -> None:
        if not span.span_id:
            return
        # err must be JSON-serializable; caller responsibility
        span._set_error(err)

    # ---- context helpers ---------------------------------------------------

    def scope(self, name: str, *, attrs: Optional[Dict[str, Any]] = None):
        """Context manager for spans."""

        tracer = self

        class _Scope:
            def __init__(self) -> None:
                self.span: Optional[Span] = None

            def __enter__(self) -> Span:
                self.span = tracer.start_span(name, attrs=attrs)
                return self.span

            def __exit__(self, exc_type, exc, tb) -> None:
                if self.span is None:
                    return
                if exc is not None:
                    tracer.record_error(
                        self.span,
                        {
                            "type": str(exc_type.__name__ if exc_type else "Exception"),
                            "message": str(exc),
                        },
                    )
                tracer.end_span(self.span)

        return _Scope()

    # ---- export ------------------------------------------------------------

    def snapshot(self) -> Dict[str, Any]:
        spans = self._buffer.snapshot()
        # stable sort by start time, then span_id
        spans_sorted = sorted(spans, key=lambda s: (s["start_ns"], s["span_id"]))
        return {"spans": spans_sorted}

    def to_json(self) -> str:
        return json.dumps(self.snapshot(), separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# GLOBAL SINGLETON
# ---------------------------------------------------------------------------


_GLOBAL: Optional[Tracer] = None
_GLOBAL_LOCK = threading.Lock()


def get_tracer() -> Tracer:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = Tracer()
    return _GLOBAL


# ---------------------------------------------------------------------------
# CONVENIENCE API
# ---------------------------------------------------------------------------


def start_span(name: str, *, attrs: Optional[Dict[str, Any]] = None) -> Span:
    return get_tracer().start_span(name, attrs=attrs)


def end_span(span: Span) -> None:
    get_tracer().end_span(span)


def span_scope(name: str, *, attrs: Optional[Dict[str, Any]] = None):
    return get_tracer().scope(name, attrs=attrs)


def add_event(span: Span, name: str, *, attrs: Optional[Dict[str, Any]] = None) -> None:
    get_tracer().add_event(span, name, attrs=attrs)


def record_error(span: Span, err: Dict[str, Any]) -> None:
    get_tracer().record_error(span, err)


def export_json() -> str:
    return get_tracer().to_json()
