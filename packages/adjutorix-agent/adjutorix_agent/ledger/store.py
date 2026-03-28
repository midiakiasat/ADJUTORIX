"""
ADJUTORIX AGENT — LEDGER / STORE

Append-only, content-addressed ledger store with strong consistency semantics.

Responsibilities:
- Persist nodes and edges (snapshots, patches, transactions, artifacts)
- Enforce append-only constraints (no updates, no deletes)
- Maintain secondary indexes for fast queries (by tx_id, snapshot_id, patch_id)
- Provide atomic batch appends with integrity checks
- Support deterministic replay reads (ordered by monotonic sequence)

Hard invariants:
- Every write is atomic and fully ordered
- Edge and node IDs are content-addressed and immutable
- No mutation of existing records
- Sequence is strictly increasing (monotonic clock source external)
- Reads can reconstruct full graph deterministically

Storage:
- SQLite (WAL mode) for durability and concurrency
- JSON-encoded payloads for flexibility
"""

from __future__ import annotations

import json
import sqlite3
import threading
import time
from dataclasses import asdict
from typing import Iterable, List, Dict, Optional, Tuple

from adjutorix_agent.ledger.schema import (
    Edge,
    SnapshotNode,
    PatchNode,
    TransactionNode,
    ArtifactNode,
    get_ledger_validator,
)


# ---------------------------------------------------------------------------
# DB INITIALIZATION
# ---------------------------------------------------------------------------


SCHEMA_SQL = """
PRAGMA journal_mode=WAL;
PRAGMA synchronous=FULL;

CREATE TABLE IF NOT EXISTS ledger_nodes (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    node_type TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_nodes_id ON ledger_nodes(node_id);

CREATE TABLE IF NOT EXISTS ledger_edges (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    edge_id TEXT NOT NULL,
    edge_type TEXT NOT NULL,
    src TEXT NOT NULL,
    dst TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_edges_id ON ledger_edges(edge_id);
CREATE INDEX IF NOT EXISTS idx_edges_src ON ledger_edges(src);
CREATE INDEX IF NOT EXISTS idx_edges_dst ON ledger_edges(dst);

CREATE TABLE IF NOT EXISTS ledger_index (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
"""


# ---------------------------------------------------------------------------
# STORE
# ---------------------------------------------------------------------------


class LedgerStore:
    def __init__(self, db_path: str) -> None:
        self._conn = sqlite3.connect(db_path, check_same_thread=False)
        self._conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        self._init_db()
        self._validator = get_ledger_validator()

    # ------------------------------------------------------------------
    # INIT
    # ------------------------------------------------------------------

    def _init_db(self) -> None:
        with self._conn:
            self._conn.executescript(SCHEMA_SQL)

    # ------------------------------------------------------------------
    # APPEND OPERATIONS
    # ------------------------------------------------------------------

    def append_nodes(
        self,
        snapshots: Iterable[SnapshotNode] = (),
        patches: Iterable[PatchNode] = (),
        transactions: Iterable[TransactionNode] = (),
        artifacts: Iterable[ArtifactNode] = (),
    ) -> None:
        with self._lock, self._conn:
            for s in snapshots:
                self._validator.validate_snapshot(s)
                self._insert_node("snapshot", s.snapshot_id, asdict(s), s.created_at_ms)

            for p in patches:
                self._validator.validate_patch(p)
                self._insert_node("patch", p.patch_id, asdict(p), p.created_at_ms)

            for t in transactions:
                self._validator.validate_transaction(t)
                self._insert_node("transaction", t.tx_id, asdict(t), t.created_at_ms)

            for a in artifacts:
                self._validator.validate_artifact(a)
                self._insert_node("artifact", a.artifact_id, asdict(a), a.created_at_ms)

    def append_edges(self, edges: Iterable[Edge]) -> None:
        with self._lock, self._conn:
            for e in edges:
                self._validator.validate_edge(e)
                self._insert_edge(e)

    def append_batch(
        self,
        nodes: Tuple[
            Iterable[SnapshotNode],
            Iterable[PatchNode],
            Iterable[TransactionNode],
            Iterable[ArtifactNode],
        ],
        edges: Iterable[Edge],
    ) -> None:
        """
        Atomic append of nodes + edges.
        """
        with self._lock, self._conn:
            self.append_nodes(*nodes)
            self.append_edges(edges)

    # ------------------------------------------------------------------
    # INTERNAL INSERT
    # ------------------------------------------------------------------

    def _insert_node(self, node_type: str, node_id: str, payload: Dict, ts: int) -> None:
        self._conn.execute(
            """
            INSERT INTO ledger_nodes (node_id, node_type, payload, created_at_ms)
            VALUES (?, ?, ?, ?)
            """,
            (node_id, node_type, json.dumps(payload, separators=(",", ":")), ts),
        )

    def _insert_edge(self, edge: Edge) -> None:
        self._conn.execute(
            """
            INSERT INTO ledger_edges (edge_id, edge_type, src, dst, payload, created_at_ms)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (
                edge.edge_id,
                edge.type,
                edge.src,
                edge.dst,
                json.dumps(edge.metadata, separators=(",", ":")),
                edge.created_at_ms,
            ),
        )

    # ------------------------------------------------------------------
    # QUERY
    # ------------------------------------------------------------------

    def get_node(self, node_id: str) -> Optional[Dict]:
        cur = self._conn.execute(
            "SELECT payload FROM ledger_nodes WHERE node_id = ?", (node_id,)
        )
        row = cur.fetchone()
        return json.loads(row["payload"]) if row else None

    def get_edges_from(self, src: str) -> List[Dict]:
        cur = self._conn.execute(
            "SELECT edge_type, dst, payload FROM ledger_edges WHERE src = ? ORDER BY seq",
            (src,),
        )
        return [
            {"type": r["edge_type"], "dst": r["dst"], "metadata": json.loads(r["payload"])}
            for r in cur.fetchall()
        ]

    def get_edges_to(self, dst: str) -> List[Dict]:
        cur = self._conn.execute(
            "SELECT edge_type, src, payload FROM ledger_edges WHERE dst = ? ORDER BY seq",
            (dst,),
        )
        return [
            {"type": r["edge_type"], "src": r["src"], "metadata": json.loads(r["payload"])}
            for r in cur.fetchall()
        ]

    def stream_all(self) -> Iterable[Dict]:
        """
        Deterministic replay stream (nodes + edges ordered by seq).
        """
        cur_nodes = self._conn.execute(
            "SELECT seq, 'node' as kind, node_id as id, payload FROM ledger_nodes"
        )
        cur_edges = self._conn.execute(
            "SELECT seq, 'edge' as kind, edge_id as id, payload FROM ledger_edges"
        )

        merged = sorted(
            list(cur_nodes.fetchall()) + list(cur_edges.fetchall()),
            key=lambda r: r["seq"],
        )

        for r in merged:
            yield {
                "seq": r["seq"],
                "kind": r["kind"],
                "id": r["id"],
                "payload": json.loads(r["payload"]),
            }

    # ------------------------------------------------------------------
    # INDEX (FAST LOOKUPS)
    # ------------------------------------------------------------------

    def set_index(self, key: str, value: str) -> None:
        with self._lock, self._conn:
            self._conn.execute(
                "INSERT OR REPLACE INTO ledger_index (key, value) VALUES (?, ?)",
                (key, value),
            )

    def get_index(self, key: str) -> Optional[str]:
        cur = self._conn.execute(
            "SELECT value FROM ledger_index WHERE key = ?", (key,)
        )
        row = cur.fetchone()
        return row["value"] if row else None

    # ------------------------------------------------------------------
    # CONSISTENCY CHECK
    # ------------------------------------------------------------------

    def verify_integrity(self) -> None:
        """
        Ensures no broken references in edges.
        """
        cur = self._conn.execute("SELECT src, dst FROM ledger_edges")
        for row in cur.fetchall():
            if self.get_node(row["src"]) is None:
                raise RuntimeError(f"dangling_src: {row['src']}")
            if self.get_node(row["dst"]) is None:
                raise RuntimeError(f"dangling_dst: {row['dst']}")

    # ------------------------------------------------------------------
    # CLOSE
    # ------------------------------------------------------------------

    def close(self) -> None:
        self._conn.close()
