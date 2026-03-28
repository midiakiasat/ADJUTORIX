"""
ADJUTORIX AGENT — INDEXING / REFERENCES

High-precision reference resolution, reverse lookup, and cross-index linkage.

This module operates on SymbolIndex and DependencyGraph to provide:
- Exact and fuzzy reference resolution
- Reverse reference queries (who uses X)
- Scope-aware resolution (lexical + file + module)
- Impact analysis (what breaks if X changes)

Design constraints:
- Pure computation (no IO)
- Deterministic ordering and hashing
- No implicit heuristics beyond defined resolution strategy
- Works even with partial/unresolved graphs

Hard invariants:
- All outputs are stable for identical inputs
- Resolution never mutates input indices
- Ambiguity is explicit (multiple candidates returned, not hidden)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, List, Iterable, Optional, Set, Any

import hashlib
import json

from adjutorix_agent.indexing.symbol_index import SymbolIndex, Symbol, Reference
from adjutorix_agent.indexing.dependency_graph import DependencyGraph


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedReference:
    ref: Reference
    candidates: Tuple[Symbol, ...]
    resolved: Optional[Symbol]


@dataclass(frozen=True)
class ReferenceIndex:
    resolved: Tuple[ResolvedReference, ...]
    by_symbol: Tuple[Tuple[str, Tuple[int, ...]], ...]  # symbol_id -> ref indices
    index_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# RESOLVER
# ---------------------------------------------------------------------------


class ReferenceResolver:
    def __init__(self, symbols: SymbolIndex) -> None:
        self._symbols = symbols

        self._defs_by_name: Dict[str, List[Symbol]] = {}
        for d in symbols.defs:
            self._defs_by_name.setdefault(d.name, []).append(d)

    # ------------------------------------------------------------------

    def resolve_all(self) -> ReferenceIndex:
        resolved_list: List[ResolvedReference] = []

        for ref in self._symbols.refs:
            candidates = tuple(self._defs_by_name.get(ref.name, []))
            chosen = self._resolve_one(ref, candidates)

            resolved_list.append(
                ResolvedReference(ref=ref, candidates=candidates, resolved=chosen)
            )

        # build reverse index
        by_symbol: Dict[str, List[int]] = {}
        for idx, rr in enumerate(resolved_list):
            if rr.resolved:
                by_symbol.setdefault(rr.resolved.symbol_id, []).append(idx)

        by_symbol_tuple = tuple(
            (sid, tuple(sorted(idxs)))
            for sid, idxs in sorted(by_symbol.items())
        )

        index_hash = _hash({
            "resolved": [
                (rr.ref.name, rr.resolved.symbol_id if rr.resolved else None)
                for rr in resolved_list
            ],
            "by_symbol": by_symbol_tuple,
        })

        return ReferenceIndex(
            resolved=tuple(resolved_list),
            by_symbol=by_symbol_tuple,
            index_hash=index_hash,
        )

    # ------------------------------------------------------------------

    def _resolve_one(self, ref: Reference, candidates: Tuple[Symbol, ...]) -> Optional[Symbol]:
        if not candidates:
            return None

        # 1. same file preference
        same_file = [c for c in candidates if c.rel_path == ref.rel_path]
        pool = same_file or list(candidates)

        # 2. scope proximity
        def score(c: Symbol):
            common = 0
            for a, b in zip(c.scope, ref.scope):
                if a == b:
                    common += 1
                else:
                    break
            return (-common, abs(c.span.start - ref.span.start))

        return sorted(pool, key=score)[0]


# ---------------------------------------------------------------------------
# QUERIES
# ---------------------------------------------------------------------------


class ReferenceQueries:
    def __init__(self, ref_index: ReferenceIndex, symbols: SymbolIndex, graph: Optional[DependencyGraph] = None) -> None:
        self._idx = ref_index
        self._symbols = symbols
        self._graph = graph

    # ------------------------------------------------------------------

    def find_references(self, symbol_id: str) -> Tuple[Reference, ...]:
        for sid, idxs in self._idx.by_symbol:
            if sid == symbol_id:
                return tuple(self._idx.resolved[i].ref for i in idxs)
        return ()

    def find_definitions(self, name: str) -> Tuple[Symbol, ...]:
        return tuple(sorted(
            [d for d in self._symbols.defs if d.name == name],
            key=lambda d: (d.rel_path, d.span.start)
        ))

    def unresolved(self) -> Tuple[Reference, ...]:
        return tuple(rr.ref for rr in self._idx.resolved if rr.resolved is None)

    def impact(self, symbol_id: str) -> Tuple[str, ...]:
        """
        Returns affected file paths if symbol changes.
        """
        refs = self.find_references(symbol_id)
        affected = sorted({r.rel_path for r in refs})
        return tuple(affected)

    def transitive_impact(self, symbol_id: str) -> Tuple[str, ...]:
        """
        Uses dependency graph if available.
        """
        if not self._graph:
            return self.impact(symbol_id)

        # find node
        node_id = None
        for n in self._graph.nodes:
            if n.kind == "symbol" and n.key == symbol_id:
                node_id = n.node_id
                break

        if not node_id:
            return ()

        visited: Set[str] = set()
        stack = [node_id]

        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)

            for e in self._graph.edges:
                if e.src == cur:
                    stack.append(e.dst)

        # map back to files
        affected_files: Set[str] = set()
        for n in self._graph.nodes:
            if n.node_id in visited and n.kind == "file":
                affected_files.add(n.key)

        return tuple(sorted(affected_files))


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_reference_index(symbols: SymbolIndex) -> ReferenceIndex:
    return ReferenceResolver(symbols).resolve_all()


def query_references(ref_index: ReferenceIndex, symbols: SymbolIndex, graph: Optional[DependencyGraph] = None) -> ReferenceQueries:
    return ReferenceQueries(ref_index, symbols, graph)
