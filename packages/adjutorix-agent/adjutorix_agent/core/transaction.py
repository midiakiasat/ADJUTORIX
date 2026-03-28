"""
ADJUTORIX AGENT — CORE / TRANSACTION

Deterministic transaction orchestration around the StateMachine.

Responsibilities:
- Owns TxContext lifecycle
- Applies validated transitions via StateMachine
- Emits ordered artifacts/events (no side effects here)
- Integrates with ConcurrencyGuard and JobQueue (by contract, not import cycles)
- Provides idempotent command handlers

Design:
- Pure core with pluggable ports (store, clock, ids)
- No filesystem/network calls here
- All effects are returned as structured intents for outer layers to execute
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from adjutorix_agent.core.state_machine import (
    TxState,
    TxEvent,
    TxContext,
    apply as sm_apply,
    can as sm_can,
)

try:
    from adjutorix_agent.core.clock import now_ns, next_seq
except Exception:
    import time

    def now_ns() -> int:
        return int(time.time() * 1e9)

    _SEQ = 0

    def next_seq() -> int:
        global _SEQ
        _SEQ += 1
        return _SEQ


# ---------------------------------------------------------------------------
# ARTIFACTS / EVENTS
# ---------------------------------------------------------------------------


@dataclass
class TxEventRecord:
    tx_id: str
    seq: int
    ts_ns: int
    state_from: TxState
    event: TxEvent
    state_to: TxState
    payload: Dict[str, Any] = field(default_factory=dict)


@dataclass
class TxArtifact:
    kind: str
    data: Dict[str, Any]


# ---------------------------------------------------------------------------
# PORTS (to be implemented by adapters)
# ---------------------------------------------------------------------------


class TransactionStorePort:
    def create(self, tx_id: str, ctx: TxContext, state: TxState) -> None: ...
    def load(self, tx_id: str) -> Tuple[TxContext, TxState]: ...
    def append_event(self, rec: TxEventRecord) -> None: ...
    def save(self, tx_id: str, ctx: TxContext, state: TxState) -> None: ...


# ---------------------------------------------------------------------------
# COMMANDS
# ---------------------------------------------------------------------------


@dataclass
class Cmd:
    name: str
    params: Dict[str, Any]
    idempotency_key: Optional[str] = None


# ---------------------------------------------------------------------------
# TRANSACTION
# ---------------------------------------------------------------------------


class Transaction:
    """
    High-level API used by scheduler/handlers.

    Invariants:
    - Only valid transitions via StateMachine
    - Monotonic event sequence per tx
    - Idempotent command handling when key provided
    """

    def __init__(self, store: TransactionStorePort) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # CREATE / LOAD
    # ------------------------------------------------------------------

    def create(self, tx_id: str, *, metadata: Optional[Dict[str, Any]] = None) -> None:
        ctx = TxContext(tx_id=tx_id, metadata=metadata or {})
        state = TxState.CREATED
        self._store.create(tx_id, ctx, state)

    def load(self, tx_id: str) -> Tuple[TxContext, TxState]:
        return self._store.load(tx_id)

    # ------------------------------------------------------------------
    # APPLY EVENT (core)
    # ------------------------------------------------------------------

    def _apply(self, tx_id: str, event: TxEvent) -> Tuple[TxState, TxEventRecord, List[TxArtifact]]:
        ctx, state = self._store.load(tx_id)

        if not sm_can(state, event, ctx):
            raise RuntimeError(f"transition_not_allowed: {state} -> {event}")

        new_state, effect_payload = sm_apply(state, event, ctx)

        rec = TxEventRecord(
            tx_id=tx_id,
            seq=next_seq(),
            ts_ns=now_ns(),
            state_from=state,
            event=event,
            state_to=new_state,
            payload=effect_payload,
        )

        artifacts = self._derive_artifacts(event, ctx, effect_payload)

        # persist
        self._store.append_event(rec)
        self._store.save(tx_id, ctx, new_state)

        return new_state, rec, artifacts

    # ------------------------------------------------------------------
    # COMMAND HANDLERS (idempotent)
    # ------------------------------------------------------------------

    def handle(self, tx_id: str, cmd: Cmd) -> Tuple[TxState, TxEventRecord, List[TxArtifact]]:
        # NOTE: idempotency is expected to be enforced at the store layer (by key)
        if cmd.name == "enqueue":
            return self._apply(tx_id, TxEvent.ENQUEUE)
        if cmd.name == "schedule":
            return self._apply(tx_id, TxEvent.SCHEDULE)
        if cmd.name == "prepare_snapshot":
            return self._apply(tx_id, TxEvent.PREPARE_SNAPSHOT)
        if cmd.name == "build_patch":
            return self._apply(tx_id, TxEvent.BUILD_PATCH)
        if cmd.name == "start_verify":
            return self._apply(tx_id, TxEvent.START_VERIFY)
        if cmd.name == "verify_ok":
            return self._apply(tx_id, TxEvent.VERIFY_OK)
        if cmd.name == "verify_err":
            return self._apply(tx_id, TxEvent.VERIFY_ERR)
        if cmd.name == "mark_apply_ready":
            # external governance should set ctx.apply_authorized prior to this
            return self._apply(tx_id, TxEvent.MARK_APPLY_READY)
        if cmd.name == "start_apply":
            return self._apply(tx_id, TxEvent.START_APPLY)
        if cmd.name == "commit":
            return self._apply(tx_id, TxEvent.COMMIT)
        if cmd.name == "reject":
            return self._apply(tx_id, TxEvent.REJECT)
        if cmd.name == "fail":
            return self._apply(tx_id, TxEvent.FAIL)
        if cmd.name == "rollback":
            return self._apply(tx_id, TxEvent.ROLLBACK)

        raise ValueError(f"unknown_command: {cmd.name}")

    # ------------------------------------------------------------------
    # ARTIFACT DERIVATION
    # ------------------------------------------------------------------

    def _derive_artifacts(self, event: TxEvent, ctx: TxContext, payload: Dict[str, Any]) -> List[TxArtifact]:
        out: List[TxArtifact] = []

        if event == TxEvent.PREPARE_SNAPSHOT:
            out.append(TxArtifact(kind="snapshot.prepared", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.BUILD_PATCH:
            out.append(TxArtifact(kind="patch.built", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.START_VERIFY:
            out.append(TxArtifact(kind="verify.started", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.VERIFY_OK:
            out.append(TxArtifact(kind="verify.passed", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.VERIFY_ERR:
            out.append(TxArtifact(kind="verify.failed", data={"tx_id": ctx.tx_id, "reason": ctx.failure_reason}))

        elif event == TxEvent.START_APPLY:
            out.append(TxArtifact(kind="apply.started", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.COMMIT:
            out.append(TxArtifact(kind="commit", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.REJECT:
            out.append(TxArtifact(kind="rejected", data={"tx_id": ctx.tx_id}))

        elif event == TxEvent.FAIL:
            out.append(TxArtifact(kind="failed", data={"tx_id": ctx.tx_id, "reason": ctx.failure_reason}))

        elif event == TxEvent.ROLLBACK:
            out.append(TxArtifact(kind="rollback", data={"tx_id": ctx.tx_id}))

        # always include a generic event artifact
        out.append(TxArtifact(kind="event", data={"event": event.value, **payload}))
        return out


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def create_tx(store: TransactionStorePort, tx_id: str, metadata: Optional[Dict[str, Any]] = None) -> None:
    Transaction(store).create(tx_id, metadata=metadata)


def dispatch(store: TransactionStorePort, tx_id: str, cmd: Cmd) -> Tuple[TxState, TxEventRecord, List[TxArtifact]]:
    return Transaction(store).handle(tx_id, cmd)
