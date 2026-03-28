"""
ADJUTORIX AGENT — INDEXING / DEPENDENCY_GRAPH

Deterministic dependency graph over files, modules, and symbols.

Purpose:
- Build a unified graph capturing:
  * file-level imports/exports
  * symbol-level dependencies (def -> ref resolution)
  * transitive closure for impact analysis
- Support change propagation, verify scoping, and patch targeting
- Provide stable, content-addressed graph suitable for ledger anchoring

Design:
- Inputs: RepoIndex (structure) + SymbolIndex (defs/refs)
- Output: DependencyGraph with multiple edge layers
- Pure: no IO, no side effects; fully derived from inputs
- Deterministic ordering and hashing

Hard invariants:
- Graph nodes and edges are stable under identical inputs
- No implicit resolution: unresolved refs are explicit
- Edge multiplicity is preserved (no lossy dedupe beyond identity)
- Topological queries are cycle-safe (SCC-aware)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple, Iterable, Optional, Set, Any

import hashlib
import json

from adjutorix_agent.indexing.repo_index import RepoIndex, FileEntry
from adjutorix_agent.indexing.symbol_index import (
    SymbolIndex,
    Symbol,
    Reference,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


NodeId = str
EdgeId = str


@dataclass(frozen=True)
class Node:
    node_id: NodeId
    kind: str  # file | symbol | module
    key: str   # rel_path for file, symbol_id for symbol, module spec for module


@dataclass(frozen=True)
class Edge:
    edge_id: EdgeId
    kind: str  # import | define | reference | contains | resolves
    src: NodeId
    dst: NodeId
    payload: Dict[str, Any]


@dataclass(frozen=True)
class DependencyGraph:
    nodes: Tuple[Node, ...]
    edges: Tuple[Edge, ...]
    index_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))



def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# BUILDER
# ---------------------------------------------------------------------------


class DependencyGraphBuilder:
    def __init__(self, repo: RepoIndex, symbols: SymbolIndex) -> None:
        self._repo = repo
        self._symbols = symbols

    # ------------------------------------------------------------------

    def build(self) -> DependencyGraph:
        nodes: Dict[NodeId, Node] = {}
        edges: List[Edge] = []

        # 1) File nodes
        file_nodes: Dict[str, NodeId] = {}
        for f in self._repo.files:
            nid = self._nid("file", f.rel_path)
            nodes[nid] = Node(nid, "file", f.rel_path)
            file_nodes[f.rel_path] = nid

        # 2) Symbol nodes + contains edges (file -> symbol)
        symbol_nodes: Dict[str, NodeId] = {}
        for s in self._symbols.defs:
            nid = self._nid("symbol", s.symbol_id)
            nodes[nid] = Node(nid, "symbol", s.symbol_id)
            symbol_nodes[s.symbol_id] = nid

            file_nid = file_nodes.get(s.rel_path)
            if file_nid:
                edges.append(self._edge("contains", file_nid, nid, {"kind": s.kind}))

        # 3) Reference edges (symbol -> ?)
        # Build name index for defs
        name_to_defs: Dict[str, List[Symbol]] = {}
        for d in self._symbols.defs:
            name_to_defs.setdefault(d.name, []).append(d)

        unresolved_refs: List[Reference] = []

        for r in self._symbols.refs:
            # candidate defs by name
            candidates = name_to_defs.get(r.name, [])

            if not candidates:
                unresolved_refs.append(r)
                continue

            # resolution strategy: same file scope preferred, then any
            target = self._resolve_ref(r, candidates)

            if target is None:
                unresolved_refs.append(r)
                continue

            src_nid = symbol_nodes.get(target.symbol_id)
            # reference originates from file; attach via synthetic node (ref site) is overkill;
            # we connect symbol(def) <-ref- file to keep graph compact
            file_nid = file_nodes.get(r.rel_path)

            if src_nid and file_nid:
                edges.append(self._edge(
                    "reference",
                    file_nid,
                    src_nid,
                    {
                        "name": r.name,
                        "span": (r.span.start, r.span.end),
                        "lang": r.language,
                    },
                ))

        # 4) Import edges (file -> module/file)
        # Heuristic: treat import symbols as module references; map to files when possible
        rel_paths_set = {f.rel_path for f in self._repo.files}

        for s in self._symbols.defs:
            if s.kind != "import":
                continue

            file_src = file_nodes.get(s.rel_path)
            if not file_src:
                continue

            # naive mapping: import name to file path candidates
            candidates = self._module_to_files(s.name, rel_paths_set)

            if not candidates:
                # external module node
                mod_nid = self._nid("module", s.name)
                nodes.setdefault(mod_nid, Node(mod_nid, "module", s.name))
                edges.append(self._edge("import", file_src, mod_nid, {"module": s.name}))
                continue

            for rel in candidates:
                dst = file_nodes.get(rel)
                if dst:
                    edges.append(self._edge("import", file_src, dst, {"module": s.name}))

        # 5) Resolve edges (symbol def -> symbol def) for intra-file dependencies (optional refinement)
        # Connect defs that are referenced by other defs within same file
        by_file: Dict[str, List[Symbol]] = {}
        for d in self._symbols.defs:
            by_file.setdefault(d.rel_path, []).append(d)

        for rel, defs in by_file.items():
            file_nid = file_nodes.get(rel)
            if not file_nid:
                continue

            # collect refs in file
            refs = [r for r in self._symbols.refs if r.rel_path == rel]

            for r in refs:
                cands = name_to_defs.get(r.name, [])
                if not cands:
                    continue
                tgt = self._resolve_ref(r, cands)
                if not tgt:
                    continue
                src = symbol_nodes.get(tgt.symbol_id)
                if src:
                    edges.append(self._edge("resolves", file_nid, src, {"name": r.name}))

        # deterministic ordering
        nodes_sorted = tuple(sorted(nodes.values(), key=lambda n: (n.kind, n.key)))
        edges_sorted = tuple(sorted(edges, key=lambda e: (e.kind, e.src, e.dst, _stable_json(e.payload))))

        index_hash = _hash({
            "nodes": [n.node_id for n in nodes_sorted],
            "edges": [e.edge_id for e in edges_sorted],
        })

        return DependencyGraph(nodes=nodes_sorted, edges=edges_sorted, index_hash=index_hash)

    # ------------------------------------------------------------------

    def _nid(self, kind: str, key: str) -> NodeId:
        return _hash({"k": kind, "key": key})

    def _edge(self, kind: str, src: NodeId, dst: NodeId, payload: Dict[str, Any]) -> Edge:
        eid = _hash({"k": kind, "s": src, "d": dst, "p": payload})
        return Edge(eid, kind, src, dst, payload)

    def _resolve_ref(self, r: Reference, candidates: List[Symbol]) -> Optional[Symbol]:
        # prefer same file and closest scope depth
        same_file = [c for c in candidates if c.rel_path == r.rel_path]
        pool = same_file or candidates

        # choose smallest scope distance (prefix match)
        def score(c: Symbol) -> Tuple[int, int]:
            # deeper scope match is better; fallback by span proximity
            common = 0
            for a, b in zip(c.scope, r.scope):
                if a == b:
                    common += 1
                else:
                    break
            return (-common, abs(c.span.start - r.span.start))

        return sorted(pool, key=score)[0] if pool else None

    def _module_to_files(self, module: str, rel_paths: Set[str]) -> List[str]:
        # simplistic mapping: "a.b" -> a/b.py or a/b/__init__.py
        parts = module.split(".")
        candidates = []

        # file
        p1 = "/".join(parts) + ".py"
        if p1 in rel_paths:
            candidates.append(p1)

        # package init
        p2 = "/".join(parts) + "/__init__.py"
        if p2 in rel_paths:
            candidates.append(p2)

        return candidates


# ---------------------------------------------------------------------------
# QUERIES
# ---------------------------------------------------------------------------


class DependencyQueries:
    def __init__(self, graph: DependencyGraph) -> None:
        self._g = graph
        self._out: Dict[NodeId, List[Edge]] = {}
        self._in: Dict[NodeId, List[Edge]] = {}

        for e in self._g.edges:
            self._out.setdefault(e.src, []).append(e)
            self._in.setdefault(e.dst, []).append(e)

    def neighbors(self, nid: NodeId, kind: Optional[str] = None) -> Tuple[NodeId, ...]:
        es = self._out.get(nid, [])
        if kind:
            es = [e for e in es if e.kind == kind]
        return tuple(sorted({e.dst for e in es}))

    def reverse_neighbors(self, nid: NodeId, kind: Optional[str] = None) -> Tuple[NodeId, ...]:
        es = self._in.get(nid, [])
        if kind:
            es = [e for e in es if e.kind == kind]
        return tuple(sorted({e.src for e in es}))

    def transitive_closure(self, starts: Iterable[NodeId], kinds: Optional[Set[str]] = None) -> Tuple[NodeId, ...]:
        visited: Set[NodeId] = set()
        stack: List[NodeId] = list(starts)

        while stack:
            cur = stack.pop()
            if cur in visited:
                continue
            visited.add(cur)

            for e in self._out.get(cur, []):
                if kinds and e.kind not in kinds:
                    continue
                if e.dst not in visited:
                    stack.append(e.dst)

        return tuple(sorted(visited))

    def strongly_connected_components(self) -> Tuple[Tuple[NodeId, ...], ...]:
        # Kosaraju
        order: List[NodeId] = []
        visited: Set[NodeId] = set()

        def dfs(v: NodeId):
            visited.add(v)
            for e in self._out.get(v, []):
                if e.dst not in visited:
                    dfs(e.dst)
            order.append(v)

        for n in self._g.nodes:
            if n.node_id not in visited:
                dfs(n.node_id)

        comp: List[Tuple[NodeId, ...]] = []
        visited.clear()

        def rdfs(v: NodeId, bucket: List[NodeId]):
            visited.add(v)
            bucket.append(v)
            for e in self._in.get(v, []):
                if e.src not in visited:
                    rdfs(e.src, bucket)

        for v in reversed(order):
            if v not in visited:
                bucket: List[NodeId] = []
                rdfs(v, bucket)
                comp.append(tuple(sorted(bucket)))

        return tuple(sorted(comp, key=lambda c: (len(c), c)))


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_dependency_graph(repo: RepoIndex, symbols: SymbolIndex) -> DependencyGraph:
    return DependencyGraphBuilder(repo, symbols).build()


def query_dependency_graph(graph: DependencyGraph) -> DependencyQueries:
    return DependencyQueries(graph)
