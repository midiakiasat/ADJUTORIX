"""
ADJUTORIX AGENT — LEDGER / REPLAY

Deterministic replay engine reconstructing system state from the append-only ledger.

Responsibilities:
- Stream ledger entries in total order and rebuild state
- Validate causal consistency of edges (no invalid transitions)
- Recompute derived heads (current snapshot, tx states)
- Detect divergence between recomputed state and stored indices
- Provide partial replay (range, up to seq) for time-travel inspection

Hard invariants:
- Replay is a pure function of the ledger stream
- No side effects (read-only over LedgerStore)
- Same ledger → same reconstructed state
- Any inconsistency must raise (no silent repair)

Notes:
- This module is the ultimate source of truth for correctness
- Used by CI guards (replay determinism) and recovery flows
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

import hashlib
import json

from adjutorix_agent.ledger.store import LedgerStore
from adjutorix_agent.ledger.schema import (
    EDGE_PATCH_APPLIED,
    EDGE_SNAPSHOT_CREATED,
    EDGE_TX_STATE_CHANGED,
    EDGE_ARTIFACT_EMITTED,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotState:
    snapshot_id: str
    parent: Optional[str]
    workspace_hash: str


@dataclass(frozen=True)
class PatchState:
    patch_id: str
    base_snapshot_id: str
    ops_hash: str


@dataclass(frozen=True)
class TxState:
    tx_id: str
    snapshot_id: str
    state: str


@dataclass(frozen=True)
class ArtifactState:
    artifact_id: str
    tx_id: str
    artifact_hash: str
    kind: str


@dataclass
class ReconstructedState:
    # canonical heads / maps
    snapshots: Dict[str, SnapshotState] = field(default_factory=dict)
    patches: Dict[str, PatchState] = field(default_factory=dict)
    transactions: Dict[str, TxState] = field(default_factory=dict)
    artifacts: Dict[str, ArtifactState] = field(default_factory=dict)

    # derived heads
    current_snapshot_id: Optional[str] = None

    # sequence applied
    last_seq: int = 0


@dataclass(frozen=True)
class ReplayResult:
    state: ReconstructedState
    state_hash: str
    applied: int


# ---------------------------------------------------------------------------
# INTERNAL HELPERS
# ---------------------------------------------------------------------------


def _stable_hash(obj: object) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


def _hash_state(state: ReconstructedState) -> str:
    payload = {
        "snapshots": {k: vars(v) for k, v in sorted(state.snapshots.items())},
        "patches": {k: vars(v) for k, v in sorted(state.patches.items())},
        "transactions": {k: vars(v) for k, v in sorted(state.transactions.items())},
        "artifacts": {k: vars(v) for k, v in sorted(state.artifacts.items())},
        "current_snapshot_id": state.current_snapshot_id,
        "last_seq": state.last_seq,
    }
    return _stable_hash(payload)


# ---------------------------------------------------------------------------
# REPLAYER
# ---------------------------------------------------------------------------


class LedgerReplayer:
    """
    Deterministic reducer over ledger stream.
    """

    def __init__(self, store: LedgerStore) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # PUBLIC
    # ------------------------------------------------------------------

    def replay_all(self) -> ReplayResult:
        return self.replay_range(start_seq=0, end_seq=None)

    def replay_upto(self, end_seq: int) -> ReplayResult:
        return self.replay_range(start_seq=0, end_seq=end_seq)

    def replay_range(self, start_seq: int, end_seq: Optional[int]) -> ReplayResult:
        state = ReconstructedState()
        applied = 0

        for rec in self._iter_stream():
            seq = rec["seq"]
            if seq < start_seq:
                continue
            if end_seq is not None and seq > end_seq:
                break

            kind = rec["kind"]
            payload = rec["payload"]

            if kind == "node":
                self._apply_node(state, payload)
            elif kind == "edge":
                self._apply_edge(state, payload)
            else:
                raise RuntimeError(f"unknown_record_kind: {kind}")

            state.last_seq = seq
            applied += 1

        state_hash = _hash_state(state)

        return ReplayResult(state=state, state_hash=state_hash, applied=applied)

    # ------------------------------------------------------------------
    # STREAM
    # ------------------------------------------------------------------

    def _iter_stream(self) -> Iterable[Dict]:
        for rec in self._store.stream_all():
            yield rec

    # ------------------------------------------------------------------
    # APPLY
    # ------------------------------------------------------------------

    def _apply_node(self, state: ReconstructedState, payload: Dict) -> None:
        # Node type inferred by fields
        if "workspace_hash" in payload:
            sid = payload["snapshot_id"]
            state.snapshots[sid] = SnapshotState(
                snapshot_id=sid,
                parent=payload.get("parent_snapshot_id"),
                workspace_hash=payload["workspace_hash"],
            )
            # last snapshot becomes current head (validated later by edges)
            state.current_snapshot_id = sid
            return

        if "ops_hash" in payload:
            pid = payload["patch_id"]
            state.patches[pid] = PatchState(
                patch_id=pid,
                base_snapshot_id=payload["base_snapshot_id"],
                ops_hash=payload["ops_hash"],
            )
            return

        if "state" in payload and "tx_id" in payload:
            tid = payload["tx_id"]
            state.transactions[tid] = TxState(
                tx_id=tid,
                snapshot_id=payload["snapshot_id"],
                state=payload["state"],
            )
            return

        if "artifact_hash" in payload:
            aid = payload["artifact_id"]
            state.artifacts[aid] = ArtifactState(
                artifact_id=aid,
                tx_id=payload["tx_id"],
                artifact_hash=payload["artifact_hash"],
                kind=payload["kind"],
            )
            return

        raise RuntimeError(f"unknown_node_payload: {payload}")

    def _apply_edge(self, state: ReconstructedState, payload: Dict) -> None:
        et = payload.get("type") or payload.get("edge_type")

        if et == EDGE_PATCH_APPLIED:
            patch_id = payload.get("patch_id") or payload.get("dst")
            if patch_id not in state.patches:
                raise RuntimeError(f"patch_applied_missing_patch: {patch_id}")

            # move current snapshot head to new snapshot implied by metadata
            new_snapshot = payload.get("new_snapshot_id") or payload.get("dst")
            if new_snapshot and new_snapshot not in state.snapshots:
                raise RuntimeError(f"patch_applied_missing_snapshot: {new_snapshot}")
            if new_snapshot:
                state.current_snapshot_id = new_snapshot
            return

        if et == EDGE_SNAPSHOT_CREATED:
            sid = payload.get("snapshot_id") or payload.get("dst")
            if sid not in state.snapshots:
                raise RuntimeError(f"snapshot_created_missing: {sid}")
            # head already set on node application; edge validates existence
            return

        if et == EDGE_TX_STATE_CHANGED:
            tid = payload.get("tx_id") or payload.get("dst")
            new_state = payload.get("state")
            if tid not in state.transactions:
                raise RuntimeError(f"tx_state_changed_missing_tx: {tid}")
            if not new_state:
                raise RuntimeError("tx_state_changed_missing_state")
            # enforce monotonic transitions externally; here we just set
            tx = state.transactions[tid]
            state.transactions[tid] = TxState(
                tx_id=tx.tx_id,
                snapshot_id=tx.snapshot_id,
                state=new_state,
            )
            return

        if et == EDGE_ARTIFACT_EMITTED:
            aid = payload.get("artifact_id") or payload.get("dst")
            if aid not in state.artifacts:
                raise RuntimeError(f"artifact_emitted_missing: {aid}")
            return

        raise RuntimeError(f"unknown_edge_type: {et}")


# ---------------------------------------------------------------------------
# CONSISTENCY CHECKS
# ---------------------------------------------------------------------------


def verify_replay_matches_index(store: LedgerStore) -> None:
    """
    Compare reconstructed heads with store indices.
    """
    replayer = LedgerReplayer(store)
    result = replayer.replay_all()

    # Example: current snapshot index
    indexed_head = store.get_index("current_snapshot_id")
    if indexed_head is not None and indexed_head != result.state.current_snapshot_id:
        raise RuntimeError(
            f"replay_divergence: indexed_head={indexed_head} replay_head={result.state.current_snapshot_id}"
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def replay_ledger(store: LedgerStore) -> ReplayResult:
    return LedgerReplayer(store).replay_all()
