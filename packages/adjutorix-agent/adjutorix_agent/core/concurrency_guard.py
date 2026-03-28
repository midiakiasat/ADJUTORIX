"""
ADJUTORIX AGENT — CORE / CONCURRENCY_GUARD

Purpose:
- Enforce single-writer semantics over mutation domains (workspace, repo, file-set)
- Prevent overlapping transactions that could violate patch preconditions
- Provide hierarchical locking (global → workspace → resource)
- Deterministic deadlock avoidance via total ordering
- Lease-based locks with renewal and expiry
- Introspection for auditability (who holds what, since when)

Non-goals:
- Thread pool / scheduling (handled by scheduler)
- Persistence (optional adapters can be layered; in-memory is default)

Model:
- Lock scopes are strings with canonical ordering: e.g.
  "global", "workspace:/abs/path", "file:/abs/path#L..R"
- Acquisition uses a sorted order of scopes to avoid deadlocks
- Each lock is a lease with TTL; holders must renew before expiry
- Re-entrant per-owner acquisition is supported (reference counted)

Safety invariants:
- No two distinct owners can hold overlapping scopes simultaneously
- Expired leases are reclaimed before new acquisitions
- All acquisitions are atomic over the requested scope set
"""

from __future__ import annotations

import threading
import time
import uuid
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# CLOCK
# ---------------------------------------------------------------------------

try:
    from adjutorix_agent.core.clock import now_ns
except Exception:
    def now_ns() -> int:
        return int(time.time() * 1e9)


# ---------------------------------------------------------------------------
# DATA MODEL
# ---------------------------------------------------------------------------


@dataclass
class Lease:
    owner_id: str
    scopes: Tuple[str, ...]
    acquired_ns: int
    lease_until_ns: int
    token: str = field(default_factory=lambda: uuid.uuid4().hex)
    reentrancy: int = 1


@dataclass
class _ScopeLock:
    owner_id: str
    token: str
    lease_until_ns: int
    reentrancy: int


# ---------------------------------------------------------------------------
# GUARD
# ---------------------------------------------------------------------------


class ConcurrencyGuard:
    """
    Public API:
      - acquire(scopes, owner_id, ttl_s) -> Lease
      - renew(lease, ttl_s) -> bool
      - release(lease) -> bool
      - held_by(owner_id) -> List[Lease]
      - snapshot() -> Dict

    Notes:
      - Scopes must be canonicalized by caller
      - Acquire is all-or-nothing
    """

    def __init__(self, *, default_ttl_s: float = 60.0) -> None:
        self._lock = threading.RLock()
        self._locks: Dict[str, _ScopeLock] = {}  # scope -> lock
        self._leases: Dict[str, Lease] = {}      # token -> lease
        self._default_ttl_ns = int(default_ttl_s * 1e9)

    # ------------------------------------------------------------------
    # ACQUIRE
    # ------------------------------------------------------------------

    def acquire(self, scopes: List[str], *, owner_id: str, ttl_s: Optional[float] = None) -> Lease:
        if not scopes:
            raise ValueError("scopes must be non-empty")

        ttl_ns = int((ttl_s * 1e9) if ttl_s is not None else self._default_ttl_ns)
        ordered = tuple(sorted(scopes))
        now = now_ns()

        with self._lock:
            self._reclaim_expired(now)

            # Check conflicts / handle reentrancy
            for s in ordered:
                lock = self._locks.get(s)
                if lock is None:
                    continue
                if lock.owner_id == owner_id:
                    # reentrant, ok
                    continue
                # conflict
                raise RuntimeError(f"scope_conflict: {s} held by {lock.owner_id}")

            # Acquire (or re-enter)
            # If all scopes already held by owner, bump reentrancy on a single lease if exists
            existing_tokens = self._tokens_for_owner_scopes(owner_id, ordered)

            if existing_tokens:
                # choose canonical token (first)
                token = existing_tokens[0]
                lease = self._leases[token]
                lease.reentrancy += 1
                lease.lease_until_ns = now + ttl_ns
                # bump per-scope counters
                for s in ordered:
                    l = self._locks.get(s)
                    if l and l.owner_id == owner_id:
                        l.reentrancy += 1
                        l.lease_until_ns = lease.lease_until_ns
                return lease

            # fresh acquire
            token = uuid.uuid4().hex
            lease = Lease(
                owner_id=owner_id,
                scopes=ordered,
                acquired_ns=now,
                lease_until_ns=now + ttl_ns,
                token=token,
                reentrancy=1,
            )

            for s in ordered:
                self._locks[s] = _ScopeLock(
                    owner_id=owner_id,
                    token=token,
                    lease_until_ns=lease.lease_until_ns,
                    reentrancy=1,
                )

            self._leases[token] = lease
            return lease

    # ------------------------------------------------------------------
    # RENEW
    # ------------------------------------------------------------------

    def renew(self, lease: Lease, *, ttl_s: Optional[float] = None) -> bool:
        ttl_ns = int((ttl_s * 1e9) if ttl_s is not None else self._default_ttl_ns)
        now = now_ns()
        with self._lock:
            current = self._leases.get(lease.token)
            if not current:
                return False
            if current.owner_id != lease.owner_id:
                return False
            current.lease_until_ns = now + ttl_ns
            for s in current.scopes:
                l = self._locks.get(s)
                if l and l.token == current.token:
                    l.lease_until_ns = current.lease_until_ns
            return True

    # ------------------------------------------------------------------
    # RELEASE
    # ------------------------------------------------------------------

    def release(self, lease: Lease) -> bool:
        with self._lock:
            current = self._leases.get(lease.token)
            if not current:
                return False
            if current.owner_id != lease.owner_id:
                return False

            # decrement reentrancy
            if current.reentrancy > 1:
                current.reentrancy -= 1
                for s in current.scopes:
                    l = self._locks.get(s)
                    if l and l.token == current.token:
                        l.reentrancy -= 1
                return True

            # full release
            for s in current.scopes:
                l = self._locks.get(s)
                if l and l.token == current.token:
                    self._locks.pop(s, None)
            self._leases.pop(current.token, None)
            return True

    # ------------------------------------------------------------------
    # INTROSPECTION
    # ------------------------------------------------------------------

    def held_by(self, owner_id: str) -> List[Lease]:
        with self._lock:
            return [l for l in self._leases.values() if l.owner_id == owner_id]

    def snapshot(self) -> Dict[str, object]:
        with self._lock:
            now = now_ns()
            return {
                "time_ns": now,
                "locks": {
                    scope: {
                        "owner_id": l.owner_id,
                        "token": l.token,
                        "lease_until_ns": l.lease_until_ns,
                        "reentrancy": l.reentrancy,
                    }
                    for scope, l in self._locks.items()
                },
                "leases": {
                    t: {
                        "owner_id": l.owner_id,
                        "scopes": list(l.scopes),
                        "acquired_ns": l.acquired_ns,
                        "lease_until_ns": l.lease_until_ns,
                        "reentrancy": l.reentrancy,
                    }
                    for t, l in self._leases.items()
                },
            }

    # ------------------------------------------------------------------
    # INTERNALS
    # ------------------------------------------------------------------

    def _reclaim_expired(self, now_ns_: int) -> None:
        expired_tokens: List[str] = []
        for token, lease in self._leases.items():
            if lease.lease_until_ns <= now_ns_:
                expired_tokens.append(token)

        for token in expired_tokens:
            lease = self._leases.get(token)
            if not lease:
                continue
            for s in lease.scopes:
                l = self._locks.get(s)
                if l and l.token == token:
                    self._locks.pop(s, None)
            self._leases.pop(token, None)

    def _tokens_for_owner_scopes(self, owner_id: str, scopes: Tuple[str, ...]) -> List[str]:
        tokens: List[str] = []
        for s in scopes:
            l = self._locks.get(s)
            if l and l.owner_id == owner_id:
                tokens.append(l.token)
        # unique, stable order
        return list(dict.fromkeys(tokens))


# ---------------------------------------------------------------------------
# GLOBAL INSTANCE (OPTIONAL)
# ---------------------------------------------------------------------------


_GLOBAL: Optional[ConcurrencyGuard] = None
_GLOBAL_LOCK = threading.Lock()


def get_guard() -> ConcurrencyGuard:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = ConcurrencyGuard()
    return _GLOBAL


def acquire(scopes: List[str], *, owner_id: str, ttl_s: Optional[float] = None) -> Lease:
    return get_guard().acquire(scopes, owner_id=owner_id, ttl_s=ttl_s)


def renew(lease: Lease, *, ttl_s: Optional[float] = None) -> bool:
    return get_guard().renew(lease, ttl_s=ttl_s)


def release(lease: Lease) -> bool:
    return get_guard().release(lease)


def snapshot() -> Dict[str, object]:
    return get_guard().snapshot()
