"""
ADJUTORIX AGENT — SERVER / ERRORS

Authoritative error taxonomy, construction, normalization, and translation
for all server-visible failures (RPC boundary, handlers, pipelines).

Goals:
- Single, exhaustive error catalog with stable machine codes
- Deterministic, canonical error payloads (hashable)
- Lossless wrapping of lower-level exceptions (cause chains)
- Clear separation between transport (HTTP/JSON-RPC) and domain errors
- Safe redaction (no secrets), bounded payload sizes

Hard invariants:
- Every emitted error has: code, message, data, trace_id, error_id
- error_id == sha256(canonical_payload) for deduplication
- No non-deterministic fields in canonical payload (timestamps excluded)
- Translation to JSON-RPC is total and side-effect free
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Any, Dict, Optional, Tuple, Iterable

import hashlib
import json
import traceback


# ---------------------------------------------------------------------------
# CANONICALIZATION
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# TAXONOMY (CODES)
# ---------------------------------------------------------------------------


# JSON-RPC base
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603

# Auth / capability
ERR_UNAUTHORIZED = 1001
ERR_CAPABILITY = 1002
ERR_REPLAY = 1003
ERR_IDEMPOTENCY = 1004

# Domain: jobs / scheduler
ERR_JOB_NOT_FOUND = 2001
ERR_JOB_CONFLICT = 2002
ERR_JOB_INVALID = 2003
ERR_JOB_TIMEOUT = 2004

# Domain: verify
ERR_VERIFY_NOT_FOUND = 3001
ERR_VERIFY_INVALID = 3002
ERR_VERIFY_FAILED = 3003

# Domain: patch
ERR_PATCH_NOT_FOUND = 4001
ERR_PATCH_INVALID = 4002
ERR_PATCH_CONFLICT = 4003
ERR_PATCH_APPLY_FAILED = 4004

# Domain: ledger
ERR_LEDGER_NOT_FOUND = 5001
ERR_LEDGER_INVALID = 5002

# Domain: indexing
ERR_INDEX_BUILD_FAILED = 6001
ERR_INDEX_INVALID = 6002
ERR_INDEX_GUARD = 6003

# Domain: IO / env
ERR_IO = 7001
ERR_FS = 7002

# Catch-all
ERR_UNKNOWN = 9000


# ---------------------------------------------------------------------------
# ERROR TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ErrorPayload:
    code: int
    message: str
    data: Dict[str, Any]
    trace_id: str
    error_id: str


@dataclass(frozen=True)
class ErrorEnvelope:
    jsonrpc: str
    error: Dict[str, Any]
    id: Any


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def _sanitize(data: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    """
    Redact obvious sensitive keys; enforce size limits.
    """
    if not data:
        return {}

    redacted = {}
    for k, v in data.items():
        lk = str(k).lower()
        if any(s in lk for s in ("token", "secret", "password", "key")):
            redacted[k] = "<redacted>"
        else:
            redacted[k] = v

    # size guard (approx)
    s = _stable_json(redacted)
    if len(s) > 100_000:
        return {"_truncated": True}

    return redacted


def _trace_id(stack: Optional[str]) -> str:
    # deterministic trace id from stack string
    base = stack or ""
    return _hash(base)[:16]


def build_error(code: int, message: str, data: Optional[Dict[str, Any]] = None, *, stack: Optional[str] = None) -> ErrorPayload:
    data_s = _sanitize(data)

    canonical = {
        "code": code,
        "message": message,
        "data": data_s,
    }

    error_id = _hash(canonical)
    trace_id = _trace_id(stack)

    return ErrorPayload(
        code=code,
        message=message,
        data=data_s,
        trace_id=trace_id,
        error_id=error_id,
    )


# ---------------------------------------------------------------------------
# EXCEPTION ADAPTERS
# ---------------------------------------------------------------------------


class DomainError(Exception):
    def __init__(self, code: int, message: str, data: Optional[Dict[str, Any]] = None):
        self.code = code
        self.message = message
        self.data = data or {}
        super().__init__(message)


class ConflictError(DomainError):
    def __init__(self, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(ERR_JOB_CONFLICT, message, data)


class NotFoundError(DomainError):
    def __init__(self, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(ERR_JOB_NOT_FOUND, message, data)


class ValidationError(DomainError):
    def __init__(self, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(ERR_INVALID_PARAMS, message, data)


# ---------------------------------------------------------------------------
# TRANSLATION
# ---------------------------------------------------------------------------


def from_exception(exc: Exception) -> ErrorPayload:
    """
    Convert any exception into canonical ErrorPayload.
    """
    stack = traceback.format_exc()

    if isinstance(exc, DomainError):
        return build_error(exc.code, exc.message, exc.data, stack=stack)

    # known strings from guards
    msg = str(exc)
    if msg.startswith("index_guard:"):
        return build_error(ERR_INDEX_GUARD, msg, {}, stack=stack)

    # fallback
    return build_error(ERR_UNKNOWN, "unknown_error", {"exception": msg}, stack=stack)


def to_jsonrpc(err: ErrorPayload, id_: Any) -> ErrorEnvelope:
    return ErrorEnvelope(
        jsonrpc="2.0",
        error={
            "code": err.code,
            "message": err.message,
            "data": {
                **err.data,
                "trace_id": err.trace_id,
                "error_id": err.error_id,
            },
        },
        id=id_,
    )


# ---------------------------------------------------------------------------
# UTIL
# ---------------------------------------------------------------------------


def assert_condition(cond: bool, code: int, message: str, data: Optional[Dict[str, Any]] = None) -> None:
    if not cond:
        raise DomainError(code, message, data)


def wrap(fn, *args, **kwargs):
    """
    Execute fn and convert any exception to DomainError (rethrow for outer layer).
    """
    try:
        return fn(*args, **kwargs)
    except DomainError:
        raise
    except Exception as e:
        raise DomainError(ERR_INTERNAL, "internal_error", {"exception": str(e)})


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


__all__ = [
    "ErrorPayload",
    "ErrorEnvelope",
    "build_error",
    "from_exception",
    "to_jsonrpc",
    "DomainError",
    "ConflictError",
    "NotFoundError",
    "ValidationError",
    "assert_condition",
    "wrap",

    # codes
    "ERR_PARSE",
    "ERR_INVALID_REQUEST",
    "ERR_METHOD_NOT_FOUND",
    "ERR_INVALID_PARAMS",
    "ERR_INTERNAL",
    "ERR_UNAUTHORIZED",
    "ERR_CAPABILITY",
    "ERR_REPLAY",
    "ERR_IDEMPOTENCY",
    "ERR_JOB_NOT_FOUND",
    "ERR_JOB_CONFLICT",
    "ERR_JOB_INVALID",
    "ERR_JOB_TIMEOUT",
    "ERR_VERIFY_NOT_FOUND",
    "ERR_VERIFY_INVALID",
    "ERR_VERIFY_FAILED",
    "ERR_PATCH_NOT_FOUND",
    "ERR_PATCH_INVALID",
    "ERR_PATCH_CONFLICT",
    "ERR_PATCH_APPLY_FAILED",
    "ERR_LEDGER_NOT_FOUND",
    "ERR_LEDGER_INVALID",
    "ERR_INDEX_BUILD_FAILED",
    "ERR_INDEX_INVALID",
    "ERR_INDEX_GUARD",
    "ERR_IO",
    "ERR_FS",
    "ERR_UNKNOWN",
]
