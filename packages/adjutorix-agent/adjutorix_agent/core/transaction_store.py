"""
ADJUTORIX AGENT — CORE / TRANSACTION_STORE

Durable, deterministic transaction store abstraction.

Responsibilities:
- Persist TxContext + current state
- Append-only event log (strict sequence ordering)
- Idempotency enforcement
- Atomicity guarantees for (event append + state update)
- Deterministic replay source of truth

Design constraints:
- No business logic (state machine handled elsewhere)
- No side effects beyond storage
- Must be linearizable

Reference implementation: in-memory + optional pluggable backend
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Dict, List, Optional, Tuple

from adjutorix_agent.core.state_machine import TxContext, TxState
from adjutorix_agent.core.transaction import TxEventRecord


# ---------------------------------------------------------------------------
# STORAGE MODEL
# ---------------------------------------------------------------------------


@dataclass
class _TxRow:
    ctx: TxContext
    state: TxState
    events: List[TxEventRecord]
    idempotency_keys: Dict[str, int]  # key -> seq


# ---------------------------------------------------------------------------
# STORE
# ---------------------------------------------------------------------------


class TransactionStore:
    """
    In-memory reference store.

    Guarantees:
    - Append-only events
    - Monotonic sequence per tx
    - Idempotent command handling via key
    - Atomic update under single lock
    """

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._tx: Dict[str, _TxRow] = {}

    # ------------------------------------------------------------------
    # CREATE / LOAD
    # ------------------------------------------------------------------

    def create(self, tx_id: str, ctx: TxContext, state: TxState) -> None:
        with self._lock:
            if tx_id in self._tx:
                raise RuntimeError(f"tx_exists: {tx_id}")
            self._tx[tx_id] = _TxRow(
                ctx=ctx,
                state=state,
                events=[],
                idempotency_keys={},
            )

    def load(self, tx_id: str) -> Tuple[TxContext, TxState]:
        with self._lock:
            row = self._require(tx_id)
            return row.ctx, row.state

    # ------------------------------------------------------------------
    # EVENTS
    # ------------------------------------------------------------------

    def append_event(self, rec: TxEventRecord, *, idem_key: Optional[str] = None) -> None:
        with self._lock:
            row = self._require(rec.tx_id)

            # idempotency check
            if idem_key is not None:
                existing = row.idempotency_keys.get(idem_key)
                if existing is not None:
                    # already applied, ignore duplicate
                    return

            # enforce monotonic sequence
            if row.events:
                last_seq = row.events[-1].seq
                if rec.seq <= last_seq:
                    raise RuntimeError(f"non_monotonic_seq: {rec.seq} <= {last_seq}")

            row.events.append(rec)

            if idem_key is not None:
                row.idempotency_keys[idem_key] = rec.seq

    # ------------------------------------------------------------------
    # STATE
    # ------------------------------------------------------------------

    def save(self, tx_id: str, ctx: TxContext, state: TxState) -> None:
        with self._lock:
            row = self._require(tx_id)
            row.ctx = ctx
            row.state = state

    # ------------------------------------------------------------------
    # REPLAY / INSPECTION
    # ------------------------------------------------------------------

    def events(self, tx_id: str) -> List[TxEventRecord]:
        with self._lock:
            return list(self._require(tx_id).events)

    def last_event(self, tx_id: str) -> Optional[TxEventRecord]:
        with self._lock:
            row = self._require(tx_id)
            return row.events[-1] if row.events else None

    def state(self, tx_id: str) -> TxState:
        with self._lock:
            return self._require(tx_id).state

    def context(self, tx_id: str) -> TxContext:
        with self._lock:
            return self._require(tx_id).ctx

    def snapshot(self) -> Dict[str, Dict]:
        with self._lock:
            out: Dict[str, Dict] = {}
            for tx_id, row in self._tx.items():
                out[tx_id] = {
                    "state": row.state.value,
                    "events": [e.event.value for e in row.events],
                    "event_count": len(row.events),
                }
            return out

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _require(self, tx_id: str) -> _TxRow:
        row = self._tx.get(tx_id)
        if not row:
            raise RuntimeError(f"tx_not_found: {tx_id}")
        return row


# ---------------------------------------------------------------------------
# GLOBAL INSTANCE
# ---------------------------------------------------------------------------


_GLOBAL: Optional[TransactionStore] = None
_GLOBAL_LOCK = threading.Lock()


def get_store() -> TransactionStore:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = TransactionStore()
    return _GLOBAL


def create(tx_id: str, ctx: TxContext, state: TxState) -> None:
    get_store().create(tx_id, ctx, state)


def load(tx_id: str) -> Tuple[TxContext, TxState]:
    return get_store().load(tx_id)


def append_event(rec: TxEventRecord, *, idem_key: Optional[str] = None) -> None:
    get_store().append_event(rec, idem_key=idem_key)


def save(tx_id: str, ctx: TxContext, state: TxState) -> None:
    get_store().save(tx_id, ctx, state)


def events(tx_id: str) -> List[TxEventRecord]:
    return get_store().events(tx_id)


def snapshot() -> Dict[str, Dict]:
    return get_store().snapshot()
