"""
ADJUTORIX AGENT — INDEXING / AFFECTED_FILES

Deterministic impact propagation engine.

Purpose:
- Given a set of changed files / symbols, compute the full affected file set
- Used by verify_pipeline, patch scoping, safety gates
- Strictly derived from dependency_graph + reference_index

Key idea:
Impact is NOT just direct references.
It is a closure over:
    file -> symbols -> references -> files -> imports -> transitive

Design:
- Multi-layer propagation (symbol + file graph)
- Stable ordering
- Explicit frontier expansion (no hidden recursion)
- Bounded by graph size (no infinite loops)

Hard invariants:
- Same input => identical output ordering and hash
- No missing propagation (monotonic expansion)
- No duplication (set semantics + stable ordering)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, List, Iterable, Set, Optional, Any

import hashlib
import json

from adjutorix_agent.indexing.repo_index import RepoIndex
from adjutorix_agent.indexing.symbol_index import SymbolIndex
from adjutorix_agent.indexing.dependency_graph import DependencyGraph
from adjutorix_agent.indexing.references import ReferenceIndex


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AffectedFilesResult:
    seeds: Tuple[str, ...]
    affected: Tuple[str, ...]
    layers: Tuple[Tuple[str, Tuple[str, ...]], ...]  # layer -> files
    result_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# ENGINE
# ---------------------------------------------------------------------------


class AffectedFilesEngine:
    def __init__(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> None:
        self._repo = repo
        self._symbols = symbols
        self._graph = graph
        self._refs = refs

        self._file_nodes: Dict[str, str] = {}
        for n in graph.nodes:
            if n.kind == "file":
                self._file_nodes[n.key] = n.node_id

        self._node_to_file: Dict[str, str] = {
            n.node_id: n.key
            for n in graph.nodes
            if n.kind == "file"
        }

        # symbol -> file
        self._symbol_to_file: Dict[str, str] = {
            s.symbol_id: s.rel_path for s in symbols.defs
        }

        # reverse reference index
        self._refs_by_symbol: Dict[str, Tuple[int, ...]] = dict(refs.by_symbol)

    # ------------------------------------------------------------------

    def compute(self, seeds: Iterable[str]) -> AffectedFilesResult:
        seed_files = tuple(sorted(set(seeds)))

        visited_files: Set[str] = set(seed_files)
        frontier: Set[str] = set(seed_files)

        layers: List[Tuple[str, Tuple[str, ...]]] = []

        step = 0

        while frontier:
            next_frontier: Set[str] = set()

            # --- LAYER: propagate via symbols (defs -> refs)
            symbol_targets = self._propagate_symbol(frontier)
            for f in symbol_targets:
                if f not in visited_files:
                    next_frontier.add(f)

            # --- LAYER: propagate via import graph
            import_targets = self._propagate_import(frontier)
            for f in import_targets:
                if f not in visited_files:
                    next_frontier.add(f)

            if not next_frontier:
                break

            layer_name = f"layer_{step}"
            layer_files = tuple(sorted(next_frontier))
            layers.append((layer_name, layer_files))

            visited_files.update(next_frontier)
            frontier = next_frontier
            step += 1

        affected = tuple(sorted(visited_files))

        result_hash = _hash({
            "seeds": seed_files,
            "affected": affected,
            "layers": layers,
        })

        return AffectedFilesResult(
            seeds=seed_files,
            affected=affected,
            layers=tuple(layers),
            result_hash=result_hash,
        )

    # ------------------------------------------------------------------

    def _propagate_symbol(self, frontier: Set[str]) -> Set[str]:
        """
        file -> defs -> refs -> files
        """
        result: Set[str] = set()

        for f in frontier:
            # defs in file
            defs = [s for s in self._symbols.defs if s.rel_path == f]

            for d in defs:
                ref_idxs = self._refs_by_symbol.get(d.symbol_id, ())
                for i in ref_idxs:
                    rr = self._refs.resolved[i]
                    result.add(rr.ref.rel_path)

        return result

    def _propagate_import(self, frontier: Set[str]) -> Set[str]:
        """
        file graph propagation (both directions)
        """
        result: Set[str] = set()

        for f in frontier:
            nid = self._file_nodes.get(f)
            if not nid:
                continue

            for e in self._graph.edges:
                if e.kind != "import":
                    continue

                # forward
                if e.src == nid:
                    dst_file = self._node_to_file.get(e.dst)
                    if dst_file:
                        result.add(dst_file)

                # reverse (who depends on me)
                if e.dst == nid:
                    src_file = self._node_to_file.get(e.src)
                    if src_file:
                        result.add(src_file)

        return result


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def compute_affected_files(
    repo: RepoIndex,
    symbols: SymbolIndex,
    graph: DependencyGraph,
    refs: ReferenceIndex,
    seeds: Iterable[str],
) -> AffectedFilesResult:
    return AffectedFilesEngine(repo, symbols, graph, refs).compute(seeds)
