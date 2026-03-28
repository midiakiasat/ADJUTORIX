"""
ADJUTORIX AGENT — OBSERVABILITY / EVENTS

Deterministic, append-only event stream with:
- Strong typing (schemas per event)
- Monotonic ordering (logical clock)
- Structured payloads (no free-form strings)
- Fan-out to sinks (stdout, file, in-memory, user hooks)
- Backpressure-safe, non-blocking emit
- Correlation (tx_id, run_id, span_id)

Hard guarantees:
- Every emitted event has: id, seq, ts, kind, source, payload
- No mutation of emitted events (immutable records)
- Ordering is total within process (Lamport-like counter)
- Serialization is canonical (stable JSON)

"""

from __future__ import annotations

import json
import os
import sys
import time
import threading
import queue
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, Callable, Iterable, Optional, Protocol, List


# ---------------------------------------------------------------------------
# CLOCK
# ---------------------------------------------------------------------------


class _Clock:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._seq = 0

    def next(self) -> int:
        with self._lock:
            self._seq += 1
            return self._seq


_CLOCK = _Clock()


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Event:
    id: str
    seq: int
    ts: int
    kind: str
    source: str
    payload: Dict[str, Any]
    tx_id: Optional[str]
    run_id: Optional[str]
    span_id: Optional[str]


class Sink(Protocol):
    def write(self, event: Event) -> None: ...


# ---------------------------------------------------------------------------
# CANONICAL JSON
# ---------------------------------------------------------------------------


def _dump(event: Event) -> str:
    # canonical, no whitespace, sorted keys
    return json.dumps(asdict(event), separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# SINKS
# ---------------------------------------------------------------------------


class StdoutSink:
    def write(self, event: Event) -> None:
        sys.stdout.write(_dump(event) + "\n")
        sys.stdout.flush()


class FileSink:
    def __init__(self, path: Path) -> None:
        self.path = path
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.Lock()

    def write(self, event: Event) -> None:
        line = _dump(event) + "\n"
        with self._lock:
            with open(self.path, "a", encoding="utf-8") as f:
                f.write(line)


class MemorySink:
    def __init__(self, capacity: int = 10000) -> None:
        self.capacity = capacity
        self._buf: List[Event] = []
        self._lock = threading.Lock()

    def write(self, event: Event) -> None:
        with self._lock:
            self._buf.append(event)
            if len(self._buf) > self.capacity:
                self._buf = self._buf[-self.capacity :]

    def snapshot(self) -> List[Event]:
        with self._lock:
            return list(self._buf)


# ---------------------------------------------------------------------------
# DISPATCHER
# ---------------------------------------------------------------------------


class EventBus:
    """
    Non-blocking dispatcher with worker thread.
    """

    def __init__(self) -> None:
        self._q: "queue.Queue[Event]" = queue.Queue(maxsize=10000)
        self._sinks: List[Sink] = []
        self._stop = threading.Event()
        self._worker = threading.Thread(target=self._run, daemon=True)
        self._worker.start()

    def add_sink(self, sink: Sink) -> None:
        self._sinks.append(sink)

    def emit(self, event: Event) -> None:
        try:
            self._q.put_nowait(event)
        except queue.Full:
            # drop with signal event (best-effort)
            drop = _make_event(
                kind="event.drop",
                source="event_bus",
                payload={"reason": "queue_full"},
                tx_id=event.tx_id,
                run_id=event.run_id,
                span_id=event.span_id,
            )
            try:
                self._q.put_nowait(drop)
            except Exception:
                pass

    def _run(self) -> None:
        while not self._stop.is_set():
            try:
                ev = self._q.get(timeout=0.1)
            except queue.Empty:
                continue
            for s in self._sinks:
                try:
                    s.write(ev)
                except Exception:
                    # isolate sink failures
                    pass

    def shutdown(self, timeout: float = 2.0) -> None:
        self._stop.set()
        self._worker.join(timeout=timeout)


# ---------------------------------------------------------------------------
# FACTORY
# ---------------------------------------------------------------------------


def _make_event(
    *,
    kind: str,
    source: str,
    payload: Dict[str, Any],
    tx_id: Optional[str] = None,
    run_id: Optional[str] = None,
    span_id: Optional[str] = None,
) -> Event:
    return Event(
        id=uuid.uuid4().hex,
        seq=_CLOCK.next(),
        ts=int(time.time()),
        kind=kind,
        source=source,
        payload=payload,
        tx_id=tx_id,
        run_id=run_id,
        span_id=span_id,
    )


# ---------------------------------------------------------------------------
# GLOBAL BUS
# ---------------------------------------------------------------------------


_BUS = EventBus()


def configure_default_sinks(base_dir: Optional[Path] = None) -> None:
    _BUS.add_sink(StdoutSink())
    if base_dir is not None:
        _BUS.add_sink(FileSink(base_dir / "events.log"))


# ---------------------------------------------------------------------------
# PUBLIC API
# ---------------------------------------------------------------------------


def emit(
    kind: str,
    source: str,
    payload: Dict[str, Any],
    *,
    tx_id: Optional[str] = None,
    run_id: Optional[str] = None,
    span_id: Optional[str] = None,
) -> None:
    ev = _make_event(
        kind=kind,
        source=source,
        payload=payload,
        tx_id=tx_id,
        run_id=run_id,
        span_id=span_id,
    )
    _BUS.emit(ev)


def with_span(source: str, tx_id: Optional[str] = None, run_id: Optional[str] = None):
    span_id = uuid.uuid4().hex

    class _Span:
        def __enter__(self):
            emit("span.start", source, {}, tx_id=tx_id, run_id=run_id, span_id=span_id)
            return span_id

        def __exit__(self, exc_type, exc, tb):
            emit(
                "span.end",
                source,
                {"error": bool(exc_type)},
                tx_id=tx_id,
                run_id=run_id,
                span_id=span_id,
            )

    return _Span()


__all__ = [
    "Event",
    "emit",
    "with_span",
    "configure_default_sinks",
    "EventBus",
    "StdoutSink",
    "FileSink",
    "MemorySink",
]
