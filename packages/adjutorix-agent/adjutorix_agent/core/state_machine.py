"""
ADJUTORIX AGENT — CORE / STATE_MACHINE

Single source of truth for all valid transitions of the transaction system.

Properties:
- Total explicit transition graph (no implicit jumps)
- Deterministic: (state, event) -> next_state | error
- Guards: enforce invariants before allowing transition
- Effects: emit structured artifacts/log intents (no side-effects here)
- Replayable: pure function semantics for audit/rebuild

This module DOES NOT perform IO or mutation. It defines legality.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, List, Optional, Tuple, Any


# ---------------------------------------------------------------------------
# STATES
# ---------------------------------------------------------------------------


class TxState(str, Enum):
    CREATED = "created"
    QUEUED = "queued"
    SCHEDULED = "scheduled"

    SNAPSHOT_PREPARED = "snapshot_prepared"
    PATCH_BUILT = "patch_built"

    VERIFYING = "verifying"
    VERIFY_PASSED = "verify_passed"
    VERIFY_FAILED = "verify_failed"

    APPLY_READY = "apply_ready"
    APPLYING = "applying"

    COMMITTED = "committed"
    REJECTED = "rejected"
    FAILED = "failed"
    ROLLED_BACK = "rolled_back"


# ---------------------------------------------------------------------------
# EVENTS
# ---------------------------------------------------------------------------


class TxEvent(str, Enum):
    ENQUEUE = "enqueue"
    SCHEDULE = "schedule"

    PREPARE_SNAPSHOT = "prepare_snapshot"
    BUILD_PATCH = "build_patch"

    START_VERIFY = "start_verify"
    VERIFY_OK = "verify_ok"
    VERIFY_ERR = "verify_err"

    MARK_APPLY_READY = "mark_apply_ready"
    START_APPLY = "start_apply"

    COMMIT = "commit"
    REJECT = "reject"

    FAIL = "fail"
    ROLLBACK = "rollback"


# ---------------------------------------------------------------------------
# CONTEXT
# ---------------------------------------------------------------------------


@dataclass
class TxContext:
    tx_id: str
    has_snapshot: bool = False
    has_patch: bool = False
    verify_ok: bool = False
    apply_authorized: bool = False
    failure_reason: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# TRANSITION MODEL
# ---------------------------------------------------------------------------


Guard = Callable[[TxContext], bool]
Effect = Callable[[TxContext], Dict[str, Any]]  # structured intent


@dataclass
class Transition:
    src: TxState
    event: TxEvent
    dst: TxState
    guard: Optional[Guard] = None
    effect: Optional[Effect] = None


# ---------------------------------------------------------------------------
# GUARDS
# ---------------------------------------------------------------------------


def _has_snapshot(ctx: TxContext) -> bool:
    return ctx.has_snapshot


def _has_patch(ctx: TxContext) -> bool:
    return ctx.has_patch


def _verify_passed(ctx: TxContext) -> bool:
    return ctx.verify_ok


def _can_apply(ctx: TxContext) -> bool:
    return ctx.verify_ok and ctx.apply_authorized


# ---------------------------------------------------------------------------
# EFFECTS (pure descriptions)
# ---------------------------------------------------------------------------


def _emit(event: str) -> Effect:
    def _f(ctx: TxContext) -> Dict[str, Any]:
        return {"tx_id": ctx.tx_id, "event": event}

    return _f


# ---------------------------------------------------------------------------
# TRANSITIONS (COMPLETE GRAPH)
# ---------------------------------------------------------------------------


TRANSITIONS: List[Transition] = [
    # lifecycle
    Transition(TxState.CREATED, TxEvent.ENQUEUE, TxState.QUEUED, effect=_emit("queued")),
    Transition(TxState.QUEUED, TxEvent.SCHEDULE, TxState.SCHEDULED, effect=_emit("scheduled")),

    # preparation
    Transition(TxState.SCHEDULED, TxEvent.PREPARE_SNAPSHOT, TxState.SNAPSHOT_PREPARED, effect=_emit("snapshot_prepared")),
    Transition(TxState.SNAPSHOT_PREPARED, TxEvent.BUILD_PATCH, TxState.PATCH_BUILT, guard=_has_snapshot, effect=_emit("patch_built")),

    # verification
    Transition(TxState.PATCH_BUILT, TxEvent.START_VERIFY, TxState.VERIFYING, guard=_has_patch, effect=_emit("verify_started")),
    Transition(TxState.VERIFYING, TxEvent.VERIFY_OK, TxState.VERIFY_PASSED, effect=_emit("verify_passed")),
    Transition(TxState.VERIFYING, TxEvent.VERIFY_ERR, TxState.VERIFY_FAILED, effect=_emit("verify_failed")),

    # apply gate
    Transition(TxState.VERIFY_PASSED, TxEvent.MARK_APPLY_READY, TxState.APPLY_READY, guard=_verify_passed, effect=_emit("apply_ready")),
    Transition(TxState.APPLY_READY, TxEvent.START_APPLY, TxState.APPLYING, guard=_can_apply, effect=_emit("apply_started")),

    # commit / reject
    Transition(TxState.APPLYING, TxEvent.COMMIT, TxState.COMMITTED, effect=_emit("committed")),
    Transition(TxState.VERIFY_FAILED, TxEvent.REJECT, TxState.REJECTED, effect=_emit("rejected")),

    # failure paths
    Transition(TxState.SCHEDULED, TxEvent.FAIL, TxState.FAILED, effect=_emit("failed")),
    Transition(TxState.PATCH_BUILT, TxEvent.FAIL, TxState.FAILED, effect=_emit("failed")),
    Transition(TxState.VERIFYING, TxEvent.FAIL, TxState.FAILED, effect=_emit("failed")),
    Transition(TxState.APPLYING, TxEvent.FAIL, TxState.FAILED, effect=_emit("failed")),

    # rollback
    Transition(TxState.FAILED, TxEvent.ROLLBACK, TxState.ROLLED_BACK, effect=_emit("rolled_back")),
]


# index for fast lookup
_TRANSITION_INDEX: Dict[Tuple[TxState, TxEvent], Transition] = {
    (t.src, t.event): t for t in TRANSITIONS
}


# ---------------------------------------------------------------------------
# ENGINE
# ---------------------------------------------------------------------------


class InvalidTransition(Exception):
    pass


class GuardViolation(Exception):
    pass


class StateMachine:
    """
    Pure transition engine.
    """

    def __init__(self) -> None:
        self._index = _TRANSITION_INDEX

    def can(self, state: TxState, event: TxEvent, ctx: TxContext) -> bool:
        t = self._index.get((state, event))
        if not t:
            return False
        if t.guard and not t.guard(ctx):
            return False
        return True

    def apply(self, state: TxState, event: TxEvent, ctx: TxContext) -> Tuple[TxState, Dict[str, Any]]:
        t = self._index.get((state, event))
        if not t:
            raise InvalidTransition(f"invalid: {state} -> {event}")

        if t.guard and not t.guard(ctx):
            raise GuardViolation(f"guard_failed: {state} -> {event}")

        # derive new context flags deterministically
        self._mutate_context(ctx, state, event)

        effect_payload = t.effect(ctx) if t.effect else {}
        return t.dst, effect_payload

    # ------------------------------------------------------------------
    # CONTEXT MUTATION (DERIVED STATE ONLY)
    # ------------------------------------------------------------------

    def _mutate_context(self, ctx: TxContext, state: TxState, event: TxEvent) -> None:
        if event == TxEvent.PREPARE_SNAPSHOT:
            ctx.has_snapshot = True
        elif event == TxEvent.BUILD_PATCH:
            ctx.has_patch = True
        elif event == TxEvent.VERIFY_OK:
            ctx.verify_ok = True
        elif event == TxEvent.VERIFY_ERR:
            ctx.verify_ok = False
            ctx.failure_reason = ctx.failure_reason or "verify_failed"
        elif event == TxEvent.START_APPLY:
            # nothing new, but checkpointable
            pass
        elif event == TxEvent.COMMIT:
            pass
        elif event == TxEvent.FAIL:
            ctx.failure_reason = ctx.failure_reason or "unknown_failure"
        elif event == TxEvent.ROLLBACK:
            pass


# ---------------------------------------------------------------------------
# GLOBAL INSTANCE
# ---------------------------------------------------------------------------


_GLOBAL: Optional[StateMachine] = None


def get_state_machine() -> StateMachine:
    global _GLOBAL
    if _GLOBAL is None:
        _GLOBAL = StateMachine()
    return _GLOBAL


def can(state: TxState, event: TxEvent, ctx: TxContext) -> bool:
    return get_state_machine().can(state, event, ctx)


def apply(state: TxState, event: TxEvent, ctx: TxContext) -> Tuple[TxState, Dict[str, Any]]:
    return get_state_machine().apply(state, event, ctx)
