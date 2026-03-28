"""
ADJUTORIX AGENT — LEDGER / EDGES

Canonical edge construction + validation layer.

This module is the ONLY place where ledger edges are constructed.
All higher-level systems (patch_pipeline, verify, rollback, job_runner)
must call these builders instead of creating edges manually.

Responsibilities:
- Define ALL allowed edge types and their schemas
- Enforce causal correctness (preconditions)
- Generate content-addressed edge_id
- Normalize metadata

Hard invariants:
- No edge is created without passing validation
- Edge payload must be minimal, deterministic, canonical
- All relationships must be explicit (no implicit meaning)
- Edge creation is PURE (no side effects)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Optional

import hashlib
import json
import time


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


EdgeId = str
NodeId = str


@dataclass(frozen=True)
class LedgerEdge:
    edge_id: EdgeId
    edge_type: str
    src: NodeId
    dst: NodeId
    metadata: Dict[str, str]
    created_at_ms: int


# ---------------------------------------------------------------------------
# EDGE TYPE CONSTANTS
# ---------------------------------------------------------------------------


PATCH_APPLIED = "patch_applied"
SNAPSHOT_CREATED = "snapshot_created"
TX_STATE_CHANGED = "tx_state_changed"
ARTIFACT_EMITTED = "artifact_emitted"

ALL_EDGE_TYPES = {
    PATCH_APPLIED,
    SNAPSHOT_CREATED,
    TX_STATE_CHANGED,
    ARTIFACT_EMITTED,
}


# ---------------------------------------------------------------------------
# HASH
# ---------------------------------------------------------------------------


def _stable_hash(obj: object) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


class EdgeValidationError(RuntimeError):
    pass


def _require(cond: bool, msg: str) -> None:
    if not cond:
        raise EdgeValidationError(msg)


def _validate_common(edge_type: str, src: str, dst: str) -> None:
    _require(edge_type in ALL_EDGE_TYPES, f"invalid_edge_type:{edge_type}")
    _require(bool(src), "missing_src")
    _require(bool(dst), "missing_dst")


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def build_patch_applied_edge(
    patch_id: str,
    from_snapshot_id: str,
    to_snapshot_id: str,
    tx_id: str,
    created_at_ms: Optional[int] = None,
) -> LedgerEdge:
    """
    Represents application of a patch producing a new snapshot.

    src = from_snapshot
    dst = to_snapshot
    """

    _validate_common(PATCH_APPLIED, from_snapshot_id, to_snapshot_id)

    _require(bool(patch_id), "missing_patch_id")
    _require(bool(tx_id), "missing_tx_id")

    metadata = {
        "patch_id": patch_id,
        "tx_id": tx_id,
    }

    payload = {
        "type": PATCH_APPLIED,
        "src": from_snapshot_id,
        "dst": to_snapshot_id,
        "metadata": metadata,
    }

    return LedgerEdge(
        edge_id=_stable_hash(payload),
        edge_type=PATCH_APPLIED,
        src=from_snapshot_id,
        dst=to_snapshot_id,
        metadata=metadata,
        created_at_ms=created_at_ms or int(time.time() * 1000),
    )


def build_snapshot_created_edge(
    parent_snapshot_id: Optional[str],
    snapshot_id: str,
    created_at_ms: Optional[int] = None,
) -> LedgerEdge:
    """
    Represents snapshot lineage.

    src = parent (or "genesis")
    dst = snapshot
    """

    src = parent_snapshot_id or "GENESIS"

    _validate_common(SNAPSHOT_CREATED, src, snapshot_id)

    metadata: Dict[str, str] = {}

    payload = {
        "type": SNAPSHOT_CREATED,
        "src": src,
        "dst": snapshot_id,
        "metadata": metadata,
    }

    return LedgerEdge(
        edge_id=_stable_hash(payload),
        edge_type=SNAPSHOT_CREATED,
        src=src,
        dst=snapshot_id,
        metadata=metadata,
        created_at_ms=created_at_ms or int(time.time() * 1000),
    )


def build_tx_state_changed_edge(
    tx_id: str,
    from_state: str,
    to_state: str,
    created_at_ms: Optional[int] = None,
) -> LedgerEdge:
    """
    Represents transaction lifecycle transition.

    src = tx_id
    dst = tx_id (self-edge with state transition)
    """

    _validate_common(TX_STATE_CHANGED, tx_id, tx_id)

    _require(bool(from_state), "missing_from_state")
    _require(bool(to_state), "missing_to_state")

    metadata = {
        "from": from_state,
        "to": to_state,
    }

    payload = {
        "type": TX_STATE_CHANGED,
        "src": tx_id,
        "dst": tx_id,
        "metadata": metadata,
    }

    return LedgerEdge(
        edge_id=_stable_hash(payload),
        edge_type=TX_STATE_CHANGED,
        src=tx_id,
        dst=tx_id,
        metadata=metadata,
        created_at_ms=created_at_ms or int(time.time() * 1000),
    )


def build_artifact_emitted_edge(
    tx_id: str,
    artifact_id: str,
    kind: str,
    created_at_ms: Optional[int] = None,
) -> LedgerEdge:
    """
    Represents artifact emission from a transaction.

    src = tx
    dst = artifact
    """

    _validate_common(ARTIFACT_EMITTED, tx_id, artifact_id)

    _require(bool(kind), "missing_artifact_kind")

    metadata = {
        "kind": kind,
    }

    payload = {
        "type": ARTIFACT_EMITTED,
        "src": tx_id,
        "dst": artifact_id,
        "metadata": metadata,
    }

    return LedgerEdge(
        edge_id=_stable_hash(payload),
        edge_type=ARTIFACT_EMITTED,
        src=tx_id,
        dst=artifact_id,
        metadata=metadata,
        created_at_ms=created_at_ms or int(time.time() * 1000),
    )


# ---------------------------------------------------------------------------
# DISPATCH (STRICT)
# ---------------------------------------------------------------------------


def build_edge(edge_type: str, **kwargs) -> LedgerEdge:
    """
    Strict factory — prevents unknown edge creation.
    """

    if edge_type == PATCH_APPLIED:
        return build_patch_applied_edge(**kwargs)
    if edge_type == SNAPSHOT_CREATED:
        return build_snapshot_created_edge(**kwargs)
    if edge_type == TX_STATE_CHANGED:
        return build_tx_state_changed_edge(**kwargs)
    if edge_type == ARTIFACT_EMITTED:
        return build_artifact_emitted_edge(**kwargs)

    raise EdgeValidationError(f"unsupported_edge_type:{edge_type}")
