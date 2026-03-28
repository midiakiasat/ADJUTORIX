"""
ADJUTORIX AGENT — INDEXING / RELATED_FILES

Deterministic related-files discovery over RepoIndex, SymbolIndex, DependencyGraph,
and ReferenceIndex.

Purpose:
- Given a seed set (files/symbols), compute a ranked, reproducible set of related files
- Support patch scoping, verification targeting, and UI navigation
- Combine multiple signals: imports, symbol references, co-location, naming, and history-free heuristics

Design:
- Pure function of inputs (no IO)
- Multi-signal scoring with fixed weights
- Stable ordering and hashing
- Explainable contributions per file

Hard invariants:
- Deterministic outputs for identical inputs
- No hidden randomness or time-based features
- Scores are monotonic sums of normalized features
- Explanations are complete and sufficient to recompute scores
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Tuple, List, Iterable, Optional, Set, Any

import hashlib
import json

from adjutorix_agent.indexing.repo_index import RepoIndex
from adjutorix_agent.indexing.symbol_index import SymbolIndex, Symbol
from adjutorix_agent.indexing.dependency_graph import DependencyGraph
from adjutorix_agent.indexing.references import ReferenceIndex


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Contribution:
    feature: str
    weight: float
    value: float
    score: float


@dataclass(frozen=True)
class RelatedFile:
    rel_path: str
    score: float
    contributions: Tuple[Contribution, ...]


@dataclass(frozen=True)
class RelatedFilesResult:
    seeds: Tuple[str, ...]
    related: Tuple[RelatedFile, ...]
    result_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _norm_path(p: str) -> str:
    return p.replace("\\", "/")


def _dir_of(p: str) -> str:
    return p.rsplit("/", 1)[0] if "/" in p else ""


# ---------------------------------------------------------------------------
# SCORER
# ---------------------------------------------------------------------------


class RelatedFilesScorer:
    """
    Feature-based scoring with fixed weights.

    Features:
    - import_edge: file A imports B (directed)
    - reverse_import_edge: B imports A
    - symbol_reference: A references symbols defined in B
    - co_definition: A and B define symbols with same names
    - same_directory: A and B share directory
    - filename_similarity: string similarity of basenames
    """

    W = {
        "import_edge": 3.0,
        "reverse_import_edge": 2.5,
        "symbol_reference": 3.5,
        "co_definition": 1.5,
        "same_directory": 1.0,
        "filename_similarity": 0.5,
    }

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

        self._file_nodes: Dict[str, str] = {}  # rel_path -> node_id
        for n in graph.nodes:
            if n.kind == "file":
                self._file_nodes[n.key] = n.node_id

        self._defs_by_file: Dict[str, List[Symbol]] = {}
        for s in symbols.defs:
            self._defs_by_file.setdefault(s.rel_path, []).append(s)

        self._refs_by_symbol: Dict[str, Tuple[int, ...]] = dict(refs.by_symbol)

    # ------------------------------------------------------------------

    def score(self, seeds: Tuple[str, ...]) -> Tuple[RelatedFile, ...]:
        seeds = tuple(sorted({_norm_path(s) for s in seeds}))
        candidates: Set[str] = {f.rel_path for f in self._repo.files}
        for s in seeds:
            candidates.discard(s)

        results: List[RelatedFile] = []

        for cand in sorted(candidates):
            contribs: List[Contribution] = []

            # import edges
            ie = self._count_import_edges(seeds, cand)
            if ie:
                contribs.append(self._c("import_edge", ie))

            rie = self._count_import_edges((cand,), seeds[0]) if len(seeds) == 1 else 0.0
            if rie:
                contribs.append(self._c("reverse_import_edge", rie))

            # symbol references
            sr = self._count_symbol_refs(seeds, cand)
            if sr:
                contribs.append(self._c("symbol_reference", sr))

            # co-definition
            cd = self._count_co_defs(seeds, cand)
            if cd:
                contribs.append(self._c("co_definition", cd))

            # same directory
            sd = 1.0 if any(_dir_of(s) == _dir_of(cand) for s in seeds) else 0.0
            if sd:
                contribs.append(self._c("same_directory", sd))

            # filename similarity (simple normalized LCS length ratio)
            fs = self._filename_similarity(seeds, cand)
            if fs > 0.0:
                contribs.append(self._c("filename_similarity", fs))

            if not contribs:
                continue

            score = sum(c.score for c in contribs)
            results.append(RelatedFile(rel_path=cand, score=score, contributions=tuple(contribs)))

        # deterministic ordering: score desc, path asc
        ordered = tuple(sorted(results, key=lambda r: (-r.score, r.rel_path)))
        return ordered

    # ------------------------------------------------------------------

    def _c(self, feature: str, value: float) -> Contribution:
        w = self.W[feature]
        return Contribution(feature=feature, weight=w, value=value, score=w * value)

    def _count_import_edges(self, seeds: Tuple[str, ...], cand: str) -> float:
        total = 0.0
        cand_nid = self._file_nodes.get(cand)
        if not cand_nid:
            return 0.0

        for s in seeds:
            s_nid = self._file_nodes.get(s)
            if not s_nid:
                continue
            for e in self._graph.edges:
                if e.kind == "import" and e.src == s_nid and e.dst == cand_nid:
                    total += 1.0
        return total

    def _count_symbol_refs(self, seeds: Tuple[str, ...], cand: str) -> float:
        # count refs in seeds that resolve to defs in cand
        total = 0.0
        cand_defs = {d.symbol_id for d in self._defs_by_file.get(cand, [])}
        if not cand_defs:
            return 0.0

        for sid in cand_defs:
            idxs = self._refs_by_symbol.get(sid, ())
            for i in idxs:
                rr = self._refs.resolved[i]
                if rr.ref.rel_path in seeds:
                    total += 1.0
        return total

    def _count_co_defs(self, seeds: Tuple[str, ...], cand: str) -> float:
        seed_names: Set[str] = set()
        for s in seeds:
            for d in self._defs_by_file.get(s, []):
                seed_names.add(d.name)

        cand_names = {d.name for d in self._defs_by_file.get(cand, [])}
        inter = seed_names.intersection(cand_names)
        return float(len(inter))

    def _filename_similarity(self, seeds: Tuple[str, ...], cand: str) -> float:
        def basename(p: str) -> str:
            return p.rsplit("/", 1)[-1]

        def lcs(a: str, b: str) -> int:
            # dynamic programming; small strings
            m, n = len(a), len(b)
            dp = [[0]*(n+1) for _ in range(m+1)]
            for i in range(m-1, -1, -1):
                for j in range(n-1, -1, -1):
                    if a[i] == b[j]:
                        dp[i][j] = 1 + dp[i+1][j+1]
                    else:
                        dp[i][j] = max(dp[i+1][j], dp[i][j+1])
            return dp[0][0]

        cbase = basename(cand)
        best = 0.0
        for s in seeds:
            sbase = basename(s)
            l = lcs(sbase, cbase)
            denom = max(1, max(len(sbase), len(cbase)))
            best = max(best, l / denom)
        return best


# ---------------------------------------------------------------------------
# BUILDER
# ---------------------------------------------------------------------------


class RelatedFilesBuilder:
    def __init__(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> None:
        self._scorer = RelatedFilesScorer(repo, symbols, graph, refs)

    def build(self, seeds: Iterable[str], limit: Optional[int] = None) -> RelatedFilesResult:
        seeds_t = tuple(sorted({_norm_path(s) for s in seeds}))
        related = self._scorer.score(seeds_t)

        if limit is not None:
            related = related[:max(0, int(limit))]

        result_hash = _hash({
            "seeds": seeds_t,
            "related": [
                {
                    "path": r.rel_path,
                    "score": r.score,
                    "contrib": [asdict(c) for c in r.contributions],
                }
                for r in related
            ],
        })

        return RelatedFilesResult(seeds=seeds_t, related=related, result_hash=result_hash)


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_related_files(
    repo: RepoIndex,
    symbols: SymbolIndex,
    graph: DependencyGraph,
    refs: ReferenceIndex,
    seeds: Iterable[str],
    limit: Optional[int] = None,
) -> RelatedFilesResult:
    return RelatedFilesBuilder(repo, symbols, graph, refs).build(seeds, limit)
