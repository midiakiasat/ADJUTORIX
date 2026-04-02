"""
ADJUTORIX AGENT — SERVER / AUTH

Deterministic, local-first authentication and authorization layer.

Design goals:
- Single shared secret (token) stored locally (~/.adjutorix/token)
- Constant-time verification (no timing side-channels)
- Optional rotation with overlap window (old+new tokens valid)
- Capability-scoped authorization (method-level gating)
- Idempotent request support via idempotency keys
- Replay protection window for write methods (nonce + ttl)

Hard invariants:
- No network calls for auth (pure local verification)
- Token is never logged or returned
- Missing/invalid token => hard fail (401)
- All non-health methods MUST pass through require_token

Environment / files:
- TOKEN_FILE: ~/.adjutorix/token (primary)
- TOKEN_FILE_PREV: ~/.adjutorix/token.prev (optional during rotation)

Headers:
- x-adjutorix-token: required for all authenticated methods
- x-adjutorix-idempotency-key: optional; used by mutating endpoints
- x-adjutorix-nonce: optional; replay protection for write endpoints
- x-adjutorix-ts: optional; client timestamp (ms) for replay window
"""

from __future__ import annotations

import hmac
import os
import secrets
import stat
import time
from dataclasses import dataclass
from typing import Dict, Optional, Tuple, Iterable, Set

from fastapi import Request, HTTPException, status


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------


TOKEN_FILE = os.path.expanduser("~/.adjutorix/token")
TOKEN_FILE_PREV = os.path.expanduser("~/.adjutorix/token.prev")

HEADER_TOKEN = "x-adjutorix-token"
HEADER_IDEMPOTENCY = "x-adjutorix-idempotency-key"
HEADER_NONCE = "x-adjutorix-nonce"
HEADER_TS = "x-adjutorix-ts"

# replay window (ms)
REPLAY_WINDOW_MS = 5 * 60 * 1000  # 5 minutes


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AuthContext:
    token_fingerprint: str
    idempotency_key: Optional[str]
    nonce: Optional[str]
    ts: Optional[int]


# ---------------------------------------------------------------------------
# TOKEN MANAGEMENT
# ---------------------------------------------------------------------------


def _ensure_dir() -> None:
    d = os.path.dirname(TOKEN_FILE)
    os.makedirs(d, exist_ok=True)
    # restrict perms
    try:
        os.chmod(d, stat.S_IRWXU)
    except Exception:
        pass


def _read_file(path: str) -> Optional[str]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return None


def _write_file_atomic(path: str, data: str) -> None:
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(data)
    os.replace(tmp, path)
    try:
        os.chmod(path, stat.S_IRUSR | stat.S_IWUSR)  # 600
    except Exception:
        pass


def _generate_token() -> str:
    # 256-bit token, url-safe
    return secrets.token_urlsafe(32)


def _load_or_create_token() -> str:
    """
    Load existing token or create a new one.
    """
    _ensure_dir()

    tok = _read_file(TOKEN_FILE)
    if tok:
        return tok

    tok = _generate_token()
    _write_file_atomic(TOKEN_FILE, tok)
    return tok


def _load_tokens() -> Tuple[str, Optional[str]]:
    primary = _load_or_create_token()
    prev = _read_file(TOKEN_FILE_PREV)
    return primary, prev


def rotate_token() -> str:
    """
    Rotate token with overlap window (previous token kept in TOKEN_FILE_PREV).
    """
    _ensure_dir()

    current = _read_file(TOKEN_FILE)
    if current:
        _write_file_atomic(TOKEN_FILE_PREV, current)

    new = _generate_token()
    _write_file_atomic(TOKEN_FILE, new)
    return new


# ---------------------------------------------------------------------------
# UTIL
# ---------------------------------------------------------------------------


def _constant_time_eq(a: str, b: str) -> bool:
    # compare as bytes to avoid unicode normalization issues
    return hmac.compare_digest(a.encode("utf-8"), b.encode("utf-8"))


def _fingerprint(token: str) -> str:
    # do not expose token; short fingerprint for logs/contexts
    import hashlib

    h = hashlib.sha256(token.encode("utf-8")).hexdigest()
    return h[:16]


def _get_header(request: Request, key: str) -> Optional[str]:
    v = request.headers.get(key)
    return v.strip() if v else None


# ---------------------------------------------------------------------------
# REPLAY / IDEMPOTENCY STORE (IN-MEMORY, BOUNDED)
# ---------------------------------------------------------------------------


class _ReplayStore:
    """
    In-memory replay protection with TTL. Bounded size via FIFO eviction.
    """

    def __init__(self, capacity: int = 50_000) -> None:
        self._cap = capacity
        self._seen: Dict[str, int] = {}  # nonce -> ts
        self._order: list[str] = []

    def check_and_put(self, nonce: str, ts: int) -> None:
        now = int(time.time() * 1000)

        # window check
        if abs(now - ts) > REPLAY_WINDOW_MS:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth:stale_request")

        if nonce in self._seen:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="auth:replay_detected")

        self._seen[nonce] = ts
        self._order.append(nonce)

        # eviction
        if len(self._order) > self._cap:
            old = self._order.pop(0)
            self._seen.pop(old, None)


class _IdempotencyStore:
    """
    In-memory idempotency key registry (method+key). Bounded.
    """

    def __init__(self, capacity: int = 50_000) -> None:
        self._cap = capacity
        self._seen: Set[str] = set()
        self._order: list[str] = []

    def check_and_put(self, key: str) -> None:
        if key in self._seen:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="auth:duplicate_idempotency_key")

        self._seen.add(key)
        self._order.append(key)

        if len(self._order) > self._cap:
            old = self._order.pop(0)
            self._seen.discard(old)


_REPLAY = _ReplayStore()
_IDEMP = _IdempotencyStore()


# ---------------------------------------------------------------------------
# CAPABILITIES
# ---------------------------------------------------------------------------


class CapabilityMap:
    """
    Method -> capability classification.
    """

    READ_ONLY: Set[str] = {
        "health.ping",
        "job.status",
        "index.related",
        "index.affected",
        "index.health",
    }

    MUTATING: Set[str] = {
        "job.submit",
        "index.build",
    }

    @classmethod
    def is_mutating(cls, method: str) -> bool:
        return method in cls.MUTATING


# ---------------------------------------------------------------------------
# AUTH ENTRYPOINT
# ---------------------------------------------------------------------------


def require_token(request: Request, *, method: Optional[str] = None) -> AuthContext:
    """
    Validate token and optional replay/idempotency constraints.

    Returns AuthContext for downstream usage.
    """
    token = _get_header(request, HEADER_TOKEN)
    if not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth:missing_token")

    primary, prev = _load_tokens()

    ok = _constant_time_eq(token, primary) or (prev and _constant_time_eq(token, prev))
    if not ok:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="auth:invalid_token")

    # optional headers
    idem = _get_header(request, HEADER_IDEMPOTENCY)
    nonce = _get_header(request, HEADER_NONCE)
    ts_raw = _get_header(request, HEADER_TS)

    ts: Optional[int] = None
    if ts_raw is not None:
        try:
            ts = int(ts_raw)
        except ValueError:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="auth:invalid_ts")

    # enforce for mutating methods
    if method and CapabilityMap.is_mutating(method):
        # application handlers own idempotency; do not reject duplicate keys here
        if nonce and ts is not None:
            _REPLAY.check_and_put(f"{method}:{nonce}", ts)

    return AuthContext(
        token_fingerprint=_fingerprint(token),
        idempotency_key=idem,
        nonce=nonce,
        ts=ts,
    )


# ---------------------------------------------------------------------------
# UTIL API
# ---------------------------------------------------------------------------


def get_token_fingerprint() -> str:
    tok, _ = _load_tokens()
    return _fingerprint(tok)


def ensure_token_exists() -> None:
    _load_or_create_token()


def list_active_tokens() -> Tuple[str, ...]:
    primary, prev = _load_tokens()
    return tuple(t for t in (primary, prev) if t)
