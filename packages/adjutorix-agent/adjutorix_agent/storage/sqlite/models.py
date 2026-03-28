"""
ADJUTORIX AGENT — SQLITE MODELS

Canonical schema representation layer.

Properties:
- Exact structural mirror of DB schema
- No business logic here
- Strict typing for all persisted entities
- Serialization / deserialization helpers only
- Immutable dataclasses for safety

This layer is the ONLY mapping between rows ↔ domain objects.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional


# ---------------------------------------------------------------------------
# LEDGER
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class LedgerTransaction:
    id: int
    tx_id: str
    seq: int
    status: str
    created_at: int


@dataclass(frozen=True)
class LedgerArtifact:
    id: int
    artifact_id: str
    kind: str
    size_bytes: int
    created_at: int


@dataclass(frozen=True)
class LedgerEdge:
    id: int
    from_artifact: str
    to_artifact: str
    edge_type: str


# ---------------------------------------------------------------------------
# TRANSACTION STORE
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Transaction:
    id: int
    tx_id: str
    state: str
    error: Optional[str]
    created_at: int
    updated_at: int


@dataclass(frozen=True)
class Snapshot:
    id: int
    snapshot_id: str
    root_path: str
    file_count: int
    size_bytes: int
    created_at: int


# ---------------------------------------------------------------------------
# MAPPERS
# ---------------------------------------------------------------------------


def map_ledger_transaction(row) -> LedgerTransaction:
    return LedgerTransaction(
        id=row["id"],
        tx_id=row["tx_id"],
        seq=row["seq"],
        status=row["status"],
        created_at=row["created_at"],
    )


def map_ledger_artifact(row) -> LedgerArtifact:
    return LedgerArtifact(
        id=row["id"],
        artifact_id=row["artifact_id"],
        kind=row["kind"],
        size_bytes=row["size_bytes"],
        created_at=row["created_at"],
    )


def map_ledger_edge(row) -> LedgerEdge:
    return LedgerEdge(
        id=row["id"],
        from_artifact=row["from_artifact"],
        to_artifact=row["to_artifact"],
        edge_type=row["edge_type"],
    )


def map_transaction(row) -> Transaction:
    return Transaction(
        id=row["id"],
        tx_id=row["tx_id"],
        state=row["state"],
        error=row["error"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


def map_snapshot(row) -> Snapshot:
    return Snapshot(
        id=row["id"],
        snapshot_id=row["snapshot_id"],
        root_path=row["root_path"],
        file_count=row["file_count"],
        size_bytes=row["size_bytes"],
        created_at=row["created_at"],
    )


__all__ = [
    "LedgerTransaction",
    "LedgerArtifact",
    "LedgerEdge",
    "Transaction",
    "Snapshot",
    "map_ledger_transaction",
    "map_ledger_artifact",
    "map_ledger_edge",
    "map_transaction",
    "map_snapshot",
]
