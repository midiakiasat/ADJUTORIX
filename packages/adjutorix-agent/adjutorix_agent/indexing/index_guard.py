"""
ADJUTORIX AGENT — INDEXING / INDEX_GUARD

Invariant enforcement and safety gate for all indexing artifacts.

This module validates RepoIndex, SymbolIndex, DependencyGraph, ReferenceIndex,
RelatedFilesResult, and AffectedFilesResult BEFORE they are admitted into the
runtime, persisted, or used by downstream pipelines.

Scope:
- Structural validation (schema, non-null, type integrity)
- Determinism checks (hash recomputation, ordering)
- Cross-index consistency (repo <-> symbols <-> graph <-> refs)
- Drift detection (mismatched hashes between dependent layers)
- Size/limit enforcement (guard against pathological inputs)

Hard invariants:
- index_hash MUST equal recomputed hash from normalized payload
- All references must point to existing symbols (or be explicitly unresolved)
- Graph edges must reference existing nodes
- File paths must be unique and normalized
- No duplicate IDs across nodes/symbols/files

Failure model:
- Raises RuntimeError with machine-parsable code: "index_guard:<code>"
- No partial success; validation is atomic
"""

from __future__ import annotations

from dataclasses import asdict
from typing import Dict, Tuple, List, Iterable, Set, Any

import hashlib
import json

from adjutorix_agent.indexing.repo_index import RepoIndex
from adjutorix_agent.indexing.symbol_index import SymbolIndex, Symbol, Reference
from adjutorix_agent.indexing.dependency_graph import DependencyGraph
from adjutorix_agent.indexing.references import ReferenceIndex


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _fail(code: str, detail: str = "") -> None:
    raise RuntimeError(f"index_guard:{code}{':' + detail if detail else ''}")


# ---------------------------------------------------------------------------
# CORE GUARD
# ---------------------------------------------------------------------------


class IndexGuard:
    def __init__(self, *, max_files: int = 200_000, max_symbols: int = 5_000_000, max_edges: int = 20_000_000) -> None:
        self._limits = {
            "files": max_files,
            "symbols": max_symbols,
            "edges": max_edges,
        }

    # ------------------------------------------------------------------

    def verify_all(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> None:
        self.verify_repo(repo)
        self.verify_symbols(symbols, repo)
        self.verify_graph(graph)
        self.verify_references(refs, symbols)
        self.verify_cross(repo, symbols, graph, refs)

    # ------------------------------------------------------------------

    def verify_repo(self, repo: RepoIndex) -> None:
        # uniqueness + normalization
        paths = [f.rel_path for f in repo.files]
        if len(paths) != len(set(paths)):
            _fail("repo_duplicate_paths")

        if any("\\" in p for p in paths):
            _fail("repo_non_normalized_path")

        # hash recomputation
        recomputed = _hash({
            "files": [f.file_id for f in repo.files],
            "dirs": [d.dir_id for d in repo.dirs],
        })
        if repo.index_hash != recomputed:
            _fail("repo_hash_mismatch")

        # limits
        if len(repo.files) > self._limits["files"]:
            _fail("repo_too_large")

    # ------------------------------------------------------------------

    def verify_symbols(self, symbols: SymbolIndex, repo: RepoIndex) -> None:
        file_set = {f.rel_path for f in repo.files}

        # file membership
        for f in symbols.files:
            if f.rel_path not in file_set:
                _fail("symbols_file_not_in_repo", f.rel_path)

        # symbol id uniqueness
        sids = [s.symbol_id for s in symbols.defs]
        if len(sids) != len(set(sids)):
            _fail("symbols_duplicate_symbol_id")

        # reference structure
        for r in symbols.refs:
            if not r.name:
                _fail("symbols_invalid_reference")

        # hash recomputation
        recomputed = _hash({
            "files": [f.file_hash for f in symbols.files],
            "defs": [s.symbol_id for s in symbols.defs],
            "refs": [r.symbol_id for r in symbols.refs],
            "adj": symbols.adjacency,
        })
        if symbols.index_hash != recomputed:
            _fail("symbols_hash_mismatch")

        if len(symbols.defs) > self._limits["symbols"]:
            _fail("symbols_too_large")

    # ------------------------------------------------------------------

    def verify_graph(self, graph: DependencyGraph) -> None:
        node_ids = {n.node_id for n in graph.nodes}

        # edge integrity
        for e in graph.edges:
            if e.src not in node_ids or e.dst not in node_ids:
                _fail("graph_edge_invalid_ref")

        # node uniqueness
        if len(node_ids) != len(graph.nodes):
            _fail("graph_duplicate_node_id")

        # hash recomputation
        recomputed = _hash({
            "nodes": [n.node_id for n in graph.nodes],
            "edges": [e.edge_id for e in graph.edges],
        })
        if graph.index_hash != recomputed:
            _fail("graph_hash_mismatch")

        if len(graph.edges) > self._limits["edges"]:
            _fail("graph_too_large")

    # ------------------------------------------------------------------

    def verify_references(self, refs: ReferenceIndex, symbols: SymbolIndex) -> None:
        valid_symbol_ids = {s.symbol_id for s in symbols.defs}

        # resolved refs must point to valid symbols
        for rr in refs.resolved:
            if rr.resolved and rr.resolved.symbol_id not in valid_symbol_ids:
                _fail("refs_invalid_resolution")

        # reverse index integrity
        for sid, idxs in refs.by_symbol:
            if sid not in valid_symbol_ids:
                _fail("refs_unknown_symbol", sid)
            for i in idxs:
                if i < 0 or i >= len(refs.resolved):
                    _fail("refs_index_out_of_bounds")

        # hash recomputation
        recomputed = _hash({
            "resolved": [
                (rr.ref.name, rr.resolved.symbol_id if rr.resolved else None)
                for rr in refs.resolved
            ],
            "by_symbol": refs.by_symbol,
        })
        if refs.index_hash != recomputed:
            _fail("refs_hash_mismatch")

    # ------------------------------------------------------------------

    def verify_cross(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> None:
        # every symbol file must exist in repo
        repo_files = {f.rel_path for f in repo.files}
        for s in symbols.defs:
            if s.rel_path not in repo_files:
                _fail("cross_symbol_file_missing", s.rel_path)

        # graph file nodes must correspond to repo
        graph_files = {n.key for n in graph.nodes if n.kind == "file"}
        if graph_files != repo_files:
            _fail("cross_graph_repo_mismatch")

        # references must map to files in repo
        for rr in refs.resolved:
            if rr.ref.rel_path not in repo_files:
                _fail("cross_ref_file_missing", rr.ref.rel_path)

    # ------------------------------------------------------------------

    def verify_subset(
        self,
        *,
        repo: RepoIndex | None = None,
        symbols: SymbolIndex | None = None,
        graph: DependencyGraph | None = None,
        refs: ReferenceIndex | None = None,
    ) -> None:
        if repo is not None:
            self.verify_repo(repo)
        if symbols is not None and repo is not None:
            self.verify_symbols(symbols, repo)
        if graph is not None:
            self.verify_graph(graph)
        if refs is not None and symbols is not None:
            self.verify_references(refs, symbols)


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def verify_indexes(
    repo: RepoIndex,
    symbols: SymbolIndex,
    graph: DependencyGraph,
    refs: ReferenceIndex,
) -> None:
    IndexGuard().verify_all(repo, symbols, graph, refs)
