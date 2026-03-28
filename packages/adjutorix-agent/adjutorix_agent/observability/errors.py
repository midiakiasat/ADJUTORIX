"""
ADJUTORIX AGENT — OBSERVABILITY / ERRORS

Canonical error system with:
- Strict error taxonomy (no ad-hoc exceptions)
- Stable error codes (machine comparable)
- Deterministic serialization
- Context preservation (tx_id, run_id, span_id)
- Causal chaining
- Redaction-safe payloads

Guarantees:
- Every error has a code, category, severity
- No raw exception leaks across boundaries
- Errors are immutable once constructed
- Serialization is stable and comparable
"""

from __future__ import annotations

import json
import traceback
import uuid
from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional


# ---------------------------------------------------------------------------
# ERROR TAXONOMY
# ---------------------------------------------------------------------------


class ErrorCategory:
    SYSTEM = "system"
    USER = "user"
    POLICY = "policy"
    VALIDATION = "validation"
    CONFLICT = "conflict"
    IO = "io"
    TIMEOUT = "timeout"
    INTERNAL = "internal"


class ErrorSeverity:
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"
    CRITICAL = "critical"


# ---------------------------------------------------------------------------
# BASE ERROR
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AdjutorixError:
    id: str
    code: str
    category: str
    severity: str
    message: str
    details: Dict[str, Any]
    cause: Optional["AdjutorixError"]
    tx_id: Optional[str]
    run_id: Optional[str]
    span_id: Optional[str]

    def to_dict(self) -> Dict[str, Any]:
        def _serialize(err: Optional["AdjutorixError"]):
            return err.to_dict() if err else None

        d = asdict(self)
        d["cause"] = _serialize(self.cause)
        return d

    def to_json(self) -> str:
        return json.dumps(self.to_dict(), separators=(",", ":"), sort_keys=True)


# ---------------------------------------------------------------------------
# FACTORY
# ---------------------------------------------------------------------------


def create_error(
    *,
    code: str,
    category: str,
    severity: str,
    message: str,
    details: Optional[Dict[str, Any]] = None,
    cause: Optional[AdjutorixError] = None,
    tx_id: Optional[str] = None,
    run_id: Optional[str] = None,
    span_id: Optional[str] = None,
) -> AdjutorixError:
    return AdjutorixError(
        id=uuid.uuid4().hex,
        code=code,
        category=category,
        severity=severity,
        message=message,
        details=details or {},
        cause=cause,
        tx_id=tx_id,
        run_id=run_id,
        span_id=span_id,
    )


# ---------------------------------------------------------------------------
# STANDARDIZED ERRORS
# ---------------------------------------------------------------------------


def validation_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="VALIDATION_FAILED",
        category=ErrorCategory.VALIDATION,
        severity=ErrorSeverity.ERROR,
        message=message,
        details=details,
    )


def conflict_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="CONFLICT_DETECTED",
        category=ErrorCategory.CONFLICT,
        severity=ErrorSeverity.ERROR,
        message=message,
        details=details,
    )


def policy_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="POLICY_VIOLATION",
        category=ErrorCategory.POLICY,
        severity=ErrorSeverity.ERROR,
        message=message,
        details=details,
    )


def io_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="IO_ERROR",
        category=ErrorCategory.IO,
        severity=ErrorSeverity.ERROR,
        message=message,
        details=details,
    )


def timeout_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="TIMEOUT",
        category=ErrorCategory.TIMEOUT,
        severity=ErrorSeverity.ERROR,
        message=message,
        details=details,
    )


def internal_error(message: str, details: Dict[str, Any]) -> AdjutorixError:
    return create_error(
        code="INTERNAL_ERROR",
        category=ErrorCategory.INTERNAL,
        severity=ErrorSeverity.CRITICAL,
        message=message,
        details=details,
    )


# ---------------------------------------------------------------------------
# EXCEPTION CAPTURE
# ---------------------------------------------------------------------------


def from_exception(
    exc: Exception,
    *,
    tx_id: Optional[str] = None,
    run_id: Optional[str] = None,
    span_id: Optional[str] = None,
) -> AdjutorixError:
    tb = traceback.format_exception(type(exc), exc, exc.__traceback__)

    return create_error(
        code="EXCEPTION_CAPTURED",
        category=ErrorCategory.INTERNAL,
        severity=ErrorSeverity.CRITICAL,
        message=str(exc),
        details={"traceback": tb},
        tx_id=tx_id,
        run_id=run_id,
        span_id=span_id,
    )


# ---------------------------------------------------------------------------
# REDACTION
# ---------------------------------------------------------------------------


REDACT_KEYS = {"password", "token", "secret", "key"}


def redact 
 
