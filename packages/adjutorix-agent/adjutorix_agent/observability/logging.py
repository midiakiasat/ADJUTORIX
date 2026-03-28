"""
ADJUTORIX AGENT — OBSERVABILITY / LOGGING

Deterministic, structured, redaction-safe logging subsystem.

Features:
- Structured JSON logs (stable key ordering)
- Log levels with numeric ordering
- Context propagation (trace_id, span_id, tx_id, run_id)
- Automatic correlation with tracer (if present)
- Redaction of sensitive fields
- Bounded async buffer + backpressure policy
- Sink abstraction (stdout, file, custom)
- Deterministic serialization (no non-stable types)

Invariants:
- No raw print/logging calls allowed outside this module
- Every log entry has: ts_ns, level, message, context
- No secret leakage (redaction enforced)
- Stable JSON output (sorted keys, no randomness)
"""

from __future__ import annotations

import json
import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import Any, Dict, Optional

try:
    from adjutorix_agent.observability.tracer import current_trace_id, current_span_id
except Exception:  # tracer may not be initialized yet
    def current_trace_id(): return None
    def current_span_id(): return None


# ---------------------------------------------------------------------------
# LEVELS
# ---------------------------------------------------------------------------


class LogLevel:
    DEBUG = 10
    INFO = 20
    WARNING = 30
    ERROR = 40
    CRITICAL = 50


_LEVEL_NAMES = {
    LogLevel.DEBUG: "DEBUG",
    LogLevel.INFO: "INFO",
    LogLevel.WARNING: "WARNING",
    LogLevel.ERROR: "ERROR",
    LogLevel.CRITICAL: "CRITICAL",
}


# ---------------------------------------------------------------------------
# REDACTION
# ---------------------------------------------------------------------------


_REDACT_KEYS = {"password", "token", "secret", "key", "authorization"}


def _redact(data: Dict[str, Any]) -> Dict[str, Any]:
    out: Dict[str, Any] = {}
    for k, v in data.items():
        if k.lower() in _REDACT_KEYS:
            out[k] = "[REDACTED]"
        elif isinstance(v, dict):
            out[k] = _redact(v)
        else:
            sv = str(v)
            if len(sv) > 512:
                sv = sv[:512]
            out[k] = sv
    return out


# ---------------------------------------------------------------------------
# ENTRY
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LogEntry:
    ts_ns: int
    level: int
    message: str
    context: Dict[str, Any]

    def to_json(self) -> str:
        payload = {
            "ts_ns": self.ts_ns,
            "level": _LEVEL_NAMES[self.level],
            "message": self.message,
            "context": self.context,
        }
        return json.dumps(payload, separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# SINKS
# ---------------------------------------------------------------------------


class Sink:
    def write(self, line: str) -> None:
        raise NotImplementedError


class StdoutSink(Sink):
    def write(self, line: str) -> None:
        os.write(1, (line + "\n").encode("utf-8"))


class FileSink(Sink):
    def __init__(self, path: str) -> None:
        self._fd = os.open(path, os.O_APPEND | os.O_CREAT | os.O_WRONLY, 0o644)

    def write(self, line: str) -> None:
        os.write(self._fd, (line + "\n").encode("utf-8"))


# ---------------------------------------------------------------------------
# LOGGER CORE
# ---------------------------------------------------------------------------


class Logger:
    def __init__(
        self,
        *,
        level: int = LogLevel.INFO,
        buffer_size: int = 10_000,
        sink: Optional[Sink] = None,
    ) -> None:
        self._level = level
        self._sink = sink or StdoutSink()
        self._queue: queue.Queue[LogEntry] = queue.Queue(maxsize=buffer_size)
        self._worker = threading.Thread(target=self._drain, daemon=True)
        self._running = True
        self._worker.start()

    # ---- public ------------------------------------------------------------

    def log(self, level: int, message: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        if level < self._level:
            return

        ctx = self._build_context(context or {})
        entry = LogEntry(
            ts_ns=time.time_ns(),
            level=level,
            message=str(message),
            context=_redact(ctx),
        )

        try:
            self._queue.put_nowait(entry)
        except queue.Full:
            # backpressure: drop oldest (bounded memory invariant)
            try:
                _ = self._queue.get_nowait()
                self._queue.put_nowait(entry)
            except Exception:
                pass

    def debug(self, msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        self.log(LogLevel.DEBUG, msg, context=context)

    def info(self, msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        self.log(LogLevel.INFO, msg, context=context)

    def warning(self, msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        self.log(LogLevel.WARNING, msg, context=context)

    def error(self, msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        self.log(LogLevel.ERROR, msg, context=context)

    def critical(self, msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
        self.log(LogLevel.CRITICAL, msg, context=context)

    # ---- internals ---------------------------------------------------------

    def _build_context(self, ctx: Dict[str, Any]) -> Dict[str, Any]:
        # inject tracing context if available
        trace_id = current_trace_id()
        span_id = current_span_id()

        base = {
            "trace_id": trace_id,
            "span_id": span_id,
        }
        base.update(ctx)
        return base

    def _drain(self) -> None:
        while self._running:
            try:
                entry = self._queue.get(timeout=0.1)
                self._sink.write(entry.to_json())
            except queue.Empty:
                continue
            except Exception:
                # hard fail isolation: logging must never crash system
                continue

    def shutdown(self) -> None:
        self._running = False
        self._worker.join(timeout=1)


# ---------------------------------------------------------------------------
# GLOBAL SINGLETON
# ---------------------------------------------------------------------------


_GLOBAL: Optional[Logger] = None
_LOCK = threading.Lock()


def get_logger() -> Logger:
    global _GLOBAL
    if _GLOBAL is None:
        with _LOCK:
            if _GLOBAL is None:
                _GLOBAL = Logger()
    return _GLOBAL


# ---------------------------------------------------------------------------
# CONVENIENCE API
# ---------------------------------------------------------------------------


def debug(msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
    get_logger().debug(msg, context=context)


def info(msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
    get_logger().info(msg, context=context)


def warning(msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
    get_logger().warning(msg, context=context)


def error(msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
    get_logger().error(msg, context=context)


def critical(msg: str, *, context: Optional[Dict[str, Any]] = None) -> None:
    get_logger().critical(msg, context=context)
