"""
ADJUTORIX AGENT — LEDGER / QUERIES

High-performance, deterministic query layer over the append-only ledger.

Responsibilities:
- Provide read-only, composable queries for nodes/edges
- Support graph traversals (ancestors, descendants, paths)
- Expose transaction-centric and snapshot-centric projections
- Offer time-travel queries (by seq range)
- Validate that results are consistent with schema expectations

Hard invariants:
- Pure read-only (no writes, no side effects)
- Deterministic ordering (always ordered by seq)
- No implicit joins; all traversals are explicit and bounded
- Fail fast on missing references or inconsistent state
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Iterable, List, Optional, Tuple, Set

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
class EdgeRecord:
    type: str
    src: str
    dst: str
    metadata: Dict[str, str]


@dataclass(frozen=True)
class Path:
    nodes: Tuple[str, ...]
    edges: Tuple[EdgeRecord, ...]


# ---------------------------------------------------------------------------
# CORE QUERY ENGINE
# ---------------------------------------------------------------------------


class LedgerQueries:
    def __init__(self, store: LedgerStore) -> None:
        self._store = store

    # ------------------------------------------------------------------
    # BASIC LOOKUPS
    # ------------------------------------------------------------------

    def get_node(self, node_id: str) -> Dict:
        node = self._store.get_node(node_id)
        if node is None:
            raise RuntimeError(f"node_not_found:{node_id}")
        return node

    def edges_from(self, src: str) -> List[EdgeRecord]:
        rows = self._store.get_edges_from(src)
        return [
            EdgeRecord(type=r["type"], src=src, dst=r["dst"], metadata=r["metadata"])
            for r in rows
        ]

    def edges_to(self, dst: str) -> List[EdgeRecord]:
        rows = self._store.get_edges_to(dst)
        return [
            EdgeRecord(type=r["type"], src=r["src"], dst=dst, metadata=r["metadata"])
            for r in rows
        ]

    # ------------------------------------------------------------------
    # SNAPSHOT GRAPH
    # ------------------------------------------------------------------

    def snapshot_lineage(self, snapshot_id: str) -> List[str]:
        """
        Walk backwards through SNAPSHOT_CREATED edges.
        """
        lineage: List[str] = [snapshot_id]
        current = snapshot_id

        while True:
            parents = [e.src for e in self.edges_to(current) if e.type == EDGE_SNAPSHOT_CREATED]
            if not parents:
                break
            parent = parents[0]
            if parent == "GENESIS":
                lineage.append(parent)
                break
            lineage.append(parent)
            current = parent

        return lineage

    def snapshot_descendants(self, snapshot_id: str, limit: int = 10_000) -> Set[str]:
        """
        BFS forward traversal.
        """
        visited: Set[str] = set()
        queue: List[str] = [snapshot_id]

        while queue:
            cur = queue.pop(0)
            for e in self.edges_from(cur):
                if e.type == EDGE_SNAPSHOT_CREATED and e.dst not in visited:
                    visited.add(e.dst)
                    queue.append(e.dst)
                    if len(visited) > limit:
                        raise RuntimeError("descendant_limit_exceeded")

        return visited

    # ------------------------------------------------------------------
    # PATCH / APPLICATION FLOW
    # ------------------------------------------------------------------

    def patches_applied_to_snapshot(self, snapshot_id: str) -> List[str]:
        """
        Returns patch_ids applied that resulted in this snapshot.
        """
        patch_ids: List[str] = []
        for e in self.edges_to(snapshot_id):
            if e.type == EDGE_PATCH_APPLIED:
                pid = e.metadata.get("patch_id")
                if not pid:
                    raise RuntimeError("missing_patch_id_in_edge")
                patch_ids.append(pid)
        return patch_ids

    def snapshot_after_patch(self, patch_id: str) -> Optional[str]:
        """
        Find resulting snapshot from a patch.
        """
        # We don't index by patch_id directly; scan edges (bounded by tx scope externally)
        for rec in self._store.stream_all():
            if rec["kind"] != "edge":
                continue
            payload = rec["payload"]
            if payload.get("type") == EDGE_PATCH_APPLIED and payload.get("metadata", {}).get("patch_id") == patch_id:
                return payload.get("dst")
        return None

    # ------------------------------------------------------------------
    # TRANSACTION VIEW
    # ------------------------------------------------------------------

    def transaction_history(self, tx_id: str) -> List[Tuple[str, str]]:
        """
        Returns ordered list of (from_state, to_state).
        """
        history: List[Tuple[str, str]] = []
        for e in self.edges_from(tx_id):
            if e.type == EDGE_TX_STATE_CHANGED:
                frm = e.metadata.get("from")
                to = e.metadata.get("to")
                if not frm or not to:
                    raise RuntimeError("invalid_tx_state_edge")
                history.append((frm, to))
        return history

    def transaction_artifacts(self, tx_id: str) -> List[str]:
        aids: List[str] = []
        for e in self.edges_from(tx_id):
            if e.type == EDGE_ARTIFACT_EMITTED:
                aids.append(e.dst)
        return aids

    # ------------------------------------------------------------------
    # PATH FINDING
    # ------------------------------------------------------------------

    def find_path(self, src: str, dst: str, max_depth: int = 100) -> Optional[Path]:
        """
        BFS path search with depth bound.
        """
        from collections import deque

        queue = deque([(src, [], [])])
        visited: Set[str] = set()

        while queue:
            node, path_nodes, path_edges = queue.popleft()

            if node == dst:
                return Path(nodes=tuple(path_nodes + [node]), edges=tuple(path_edges))

            if node in visited:
                continue
            visited.add(node)

            if len(path_nodes) > max_depth:
                raise RuntimeError("path_depth_exceeded")

            for e in self.edges_from(node):
                queue.append((
                    e.dst,
                    path_nodes + [node],
                    path_edges + [e],
                ))

        return None

    # ------------------------------------------------------------------
    # TIME TRAVEL
    # ------------------------------------------------------------------

    def edges_in_range(self, start_seq: int, end_seq: int) -> List[EdgeRecord]:
        result: List[EdgeRecord] = []
        for rec in self._store.stream_all():
            seq = rec["seq"]
            if seq < start_seq or seq > end_seq:
                continue
            if rec["kind"] != "edge":
                continue
            payload = rec["payload"]
            result.append(
                EdgeRecord(
                    type=payload.get("type"),
                    src=payload.get("src"),
                    dst=payload.get("dst"),
                    metadata=payload.get("metadata", {}),
                )
            )
        return result


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def create_queries(store: LedgerStore) -> LedgerQueries:
    return LedgerQueries(store)
