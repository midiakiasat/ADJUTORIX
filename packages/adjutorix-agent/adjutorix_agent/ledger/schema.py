"""
ADJUTORIX AGENT — LEDGER / SCHEMA

Formal, immutable ledger schema defining ALL state transitions as an append-only graph.

Purpose:
- Provide a complete, replayable, auditable history of the system
- Encode every mutation as a graph edge
- Guarantee deterministic reconstruction of state from genesis

Hard invariants:
- Ledger is append-only (no mutation, no deletion)
- Every node and edge is content-addressed (hash-based identity)
- All edges must be causally valid
- Replay must be deterministic

Graph model:
- Nodes: snapshots, patches, transactions, artifacts
- Edges: causal transitions (parent → child)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Tuple, Optional

import hashlib
import json


# ---------------------------------------------------------------------------
# BASE TYPES
# ---------------------------------------------------------------------------


NodeId = str
EdgeId = str
Hash = str


# ---------------------------------------------------------------------------
# NODE TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotNode:
    snapshot_id: NodeId
    parent_snapshot_id: Optional[NodeId]
    workspace_hash: Hash
    created_at_ms: int


@dataclass(frozen=True)
class PatchNode:
    patch_id: NodeId
    base_snapshot_id: NodeId
    ops_hash: Hash
    created_at_ms: int


@dataclass(frozen=True)
class TransactionNode:
    tx_id: NodeId
    snapshot_id: NodeId
    state: str
    created_at_ms: int


@dataclass(frozen=True)
class ArtifactNode:
    artifact_id: NodeId
    tx_id: NodeId
    artifact_hash: Hash
    kind: str  # verification | rollback | patch
    created_at_ms: int


# ---------------------------------------------------------------------------
# EDGE TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Edge:
    edge_id: EdgeId
    type: str
    src: NodeId
    dst: NodeId
    metadata: Dict[str, str]
    created_at_ms: int


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _stable_hash(obj: object) -> Hash:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def build_snapshot_node(
    snapshot_id: NodeId,
    parent_snapshot_id: Optional[NodeId],
    workspace_hash: Hash,
    created_at_ms: int,
) -> SnapshotNode:
    return SnapshotNode(
        snapshot_id=snapshot_id,
        parent_snapshot_id=parent_snapshot_id,
        workspace_hash=workspace_hash,
        created_at_ms=created_at_ms,
    )


def build_patch_node(
    patch_id: NodeId,
    base_snapshot_id: NodeId,
    ops_hash: Hash,
    created_at_ms: int,
) -> PatchNode:
    return PatchNode(
        patch_id=patch_id,
        base_snapshot_id=base_snapshot_id,
        ops_hash=ops_hash,
        created_at_ms=created_at_ms,
    )


def build_transaction_node(
    tx_id: NodeId,
    snapshot_id: NodeId,
    state: str,
    created_at_ms: int,
) -> TransactionNode:
    return TransactionNode(
        tx_id=tx_id,
        snapshot_id=snapshot_id,
        state=state,
        created_at_ms=created_at_ms,
    )


def build_artifact_node(
    artifact_id: NodeId,
    tx_id: NodeId,
    artifact_hash: Hash,
    kind: str,
    created_at_ms: int,
) -> ArtifactNode:
    return ArtifactNode(
        artifact_id=artifact_id,
        tx_id=tx_id,
        artifact_hash=artifact_hash,
        kind=kind,
        created_at_ms=created_at_ms,
    )


# ---------------------------------------------------------------------------
# EDGE BUILDERS
# ---------------------------------------------------------------------------


def build_edge(
    edge_type: str,
    src: NodeId,
    dst: NodeId,
    metadata: Optional[Dict[str, str]] = None,
    created_at_ms: int = 0,
) -> Edge:

    payload = {
        "type": edge_type,
        "src": src,
        "dst": dst,
        "metadata": metadata or {},
        "created_at_ms": created_at_ms,
    }

    edge_id = _stable_hash(payload)

    return Edge(
        edge_id=edge_id,
        type=edge_type,
        src=src,
        dst=dst,
        metadata=metadata or {},
        created_at_ms=created_at_ms,
    )


# ---------------------------------------------------------------------------
# EDGE TYPES (CANONICAL)
# ---------------------------------------------------------------------------


EDGE_PATCH_APPLIED = "patch_applied"
EDGE_SNAPSHOT_CREATED = "snapshot_created"
EDGE_TX_STATE_CHANGED = "tx_state_changed"
EDGE_ARTIFACT_EMITTED = "artifact_emitted"


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


class LedgerSchemaValidator:
    """
    Validates structural correctness of nodes and edges.
    """

    def validate_edge(self, edge: Edge) -> None:
        if not edge.edge_id:
            raise RuntimeError("invalid_edge_id")

        if edge.type not in {
            EDGE_PATCH_APPLIED,
            EDGE_SNAPSHOT_CREATED,
            EDGE_TX_STATE_CHANGED,
            EDGE_ARTIFACT_EMITTED,
        }:
            raise RuntimeError(f"unknown_edge_type: {edge.type}")

        if not edge.src or not edge.dst:
            raise RuntimeError("invalid_edge_nodes")

    def validate_snapshot(self, node: SnapshotNode) -> None:
        if not node.snapshot_id:
            raise RuntimeError("invalid_snapshot_id")

        if not node.workspace_hash:
            raise RuntimeError("missing_workspace_hash")

    def validate_patch(self, node: PatchNode) -> None:
        if not node.patch_id:
            raise RuntimeError("invalid_patch_id")

        if not node.base_snapshot_id:
            raise RuntimeError("missing_base_snapshot")

    def validate_transaction(self, node: TransactionNode) -> None:
        if not node.tx_id:
            raise RuntimeError("invalid_tx_id")

        if not node.state:
            raise RuntimeError("missing_state")

    def validate_artifact(self, node: ArtifactNode) -> None:
        if not node.artifact_id:
            raise RuntimeError("invalid_artifact_id")

        if not node.artifact_hash:
            raise RuntimeError("missing_artifact_hash")


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


_validator_singleton: Optional[LedgerSchemaValidator] = None


def get_ledger_validator() -> LedgerSchemaValidator:
    global _validator_singleton
    if _validator_singleton is None:
        _validator_singleton = LedgerSchemaValidator()
    return _validator_singleton
