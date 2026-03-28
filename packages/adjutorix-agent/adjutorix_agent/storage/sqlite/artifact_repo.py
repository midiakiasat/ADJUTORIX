"""
ADJUTORIX AGENT — ARTIFACT REPOSITORY

Strict persistence layer for ledger artifacts and edges.

Properties:
- Idempotent writes (artifact_id UNIQUE)
- No business logic (graph semantics enforced elsewhere)
- Bulk-safe operations with explicit limits (caller-enforced)
- Deterministic ordering on reads
- No implicit upserts; conflicts are explicit

Tables (see migrations):
- ledger_artifacts(artifact_id UNIQUE, kind, size_bytes, created_at)
- ledger_edges(from_artifact, to_artifact, edge_type)
"""

from __future__ import annotations

from typing import Iterable, List, Optional, Tuple
import time

from .engine import SQLiteEngine
from .models import LedgerArtifact, LedgerEdge, map_ledger_artifact, map_ledger_edge


# ---------------------------------------------------------------------------
# REPOSITORY
# ---------------------------------------------------------------------------


class ArtifactRepository:
    def __init__(self, engine: SQLiteEngine) -> None:
        self._engine = engine

    # ---------------------------------------------------------------------
    # ARTIFACTS — CREATE
    # ---------------------------------------------------------------------

    def create(self, artifact_id: str, kind: str, size_bytes: int) -> None:
        now = int(time.time() * 1_000_000)

        with self._engine.write_tx() as conn:
            conn.execute(
                """
                INSERT INTO ledger_artifacts (artifact_id, kind, size_bytes, created_at)
                VALUES (?, ?, ?, ?)
                """,
                (artifact_id, kind, size_bytes, now),
            )

    def create_many(self, items: Iterable[Tuple[str, str, int]]) -> None:
        now = int(time.time() * 1_000_000)
        rows = [(aid, k, sz, now) for (aid, k, sz) in items]

        with self._engine.write_tx() as conn:
            conn.executemany(
                """
                INSERT INTO ledger_artifacts (artifact_id, kind, size_bytes, created_at)
                VALUES (?, ?, ?, ?)
                """,
                rows,
            )

    # ---------------------------------------------------------------------
    # ARTIFACTS — READ
    # ---------------------------------------------------------------------

    def get(self, artifact_id: str) -> Optional[LedgerArtifact]:
        row = self._engine.fetch_one(
            "SELECT * FROM ledger_artifacts WHERE artifact_id = ?",
            (artifact_id,),
        )
        return map_ledger_artifact(row) if row else None

    def list_by_kind(self, kind: str, limit: int = 1000) -> List[LedgerArtifact]:
        rows = self._engine.fetch_all(
            "SELECT * FROM ledger_artifacts WHERE kind = ? ORDER BY created_at DESC LIMIT ?",
            (kind, limit),
        )
        return [map_ledger_artifact(r) for r in rows]

    def list_recent(self, limit: int = 1000) -> List[LedgerArtifact]:
        rows = self._engine.fetch_all(
            "SELECT * FROM ledger_artifacts ORDER BY created_at DESC LIMIT ?",
            (limit,),
        )
        return [map_ledger_artifact(r) for r in rows]

    # ---------------------------------------------------------------------
    # EDGES — CREATE
    # ---------------------------------------------------------------------

    def link(self, from_artifact: str, to_artifact: str, edge_type: str) -> None:
        with self._engine.write_tx() as conn:
            conn.execute(
                """
                INSERT INTO ledger_edges (from_artifact, to_artifact, edge_type)
                VALUES (?, ?, ?)
                """,
                (from_artifact, to_artifact, edge_type),
            )

    def link_many(self, edges: Iterable[Tuple[str, str, str]]) -> None:
        with self._engine.write_tx() as conn:
            conn.executemany(
                """
                INSERT INTO ledger_edges (from_artifact, to_artifact, edge_type)
                VALUES (?, ?, ?)
                """,
                list(edges),
            )

    # ---------------------------------------------------------------------
    # EDGES — READ
    # ---------------------------------------------------------------------

    def outgoing(self, artifact_id: str) -> List[LedgerEdge]:
        rows = self._engine.fetch_all(
            "SELECT * FROM ledger_edges WHERE from_artifact = ? ORDER BY id ASC",
            (artifact_id,),
        )
        return [map_ledger_edge(r) for r in rows]

    def incoming(self, artifact_id: str) -> List[LedgerEdge]:
        rows = self._engine.fetch_all(
            "SELECT * FROM ledger_edges WHERE to_artifact = ? ORDER BY id ASC",
            (artifact_id,),
        )
        return [map_ledger_edge(r) for r in rows]

    def edges_between(self, from_artifact: str, to_artifact: str) -> List[LedgerEdge]:
        rows = self._engine.fetch_all(
            """
            SELECT * FROM ledger_edges
            WHERE from_artifact = ? AND to_artifact = ?
            ORDER BY id ASC
            """,
            (from_artifact, to_artifact),
        )
        return [map_ledger_edge(r) for r in rows]

    # ---------------------------------------------------------------------
    # INVARIANTS
    # ---------------------------------------------------------------------

    def assert_exists(self, artifact_id: str) -> None:
        if self.get(artifact_id) is None:
            raise RuntimeError(f"Invariant violation: artifact missing {artifact_id}")

    def assert_link(self, from_artifact: str, to_artifact: str, edge_type: str) -> None:
        rows = self._engine.fetch_all(
            """
            SELECT 1 FROM ledger_edges
            WHERE from_artifact = ? AND to_artifact = ? AND edge_type = ?
            LIMIT 1
            """,
            (from_artifact, to_artifact, edge_type),
        )
        if not rows:
            raise RuntimeError(
                f"Invariant violation: missing edge {from_artifact}->{to_artifact} ({edge_type})"
            )


__all__ = ["ArtifactRepository"]
