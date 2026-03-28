"""
ADJUTORIX AGENT — INDEXING / HEALTH

Deep health diagnostics and anomaly detection for indexing layers.

Purpose:
- Evaluate structural, statistical, and semantic health of indexes
- Detect degradation, skew, corruption, or pathological patterns
- Provide machine-actionable health reports for automation and UI

Scope:
- RepoIndex, SymbolIndex, DependencyGraph, ReferenceIndex
- Cross-layer correlations and anomalies
- Performance-related signals (size, density, fan-out, cycles)

Design:
- Pure analysis (no mutation)
- Deterministic metrics and thresholds
- Structured output with severity levels

Hard invariants:
- Health report is reproducible for identical inputs
- No probabilistic or time-based signals
- All metrics explicitly derived from inputs
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Tuple, List, Iterable, Any

import hashlib
import json

from adjutorix_agent.indexing.repo_index import RepoIndex
from adjutorix_agent.indexing.symbol_index import SymbolIndex
from adjutorix_agent.indexing.dependency_graph import DependencyGraph
from adjutorix_agent.indexing.references import ReferenceIndex


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


Severity = str  # info | warning | critical


@dataclass(frozen=True)
class HealthIssue:
    code: str
    severity: Severity
    message: str
    context: Dict[str, Any]


@dataclass(frozen=True)
class HealthMetrics:
    files: int
    symbols: int
    references: int
    edges: int
    avg_symbols_per_file: float
    avg_refs_per_symbol: float
    avg_edges_per_file: float
    scc_count: int
    max_scc_size: int


@dataclass(frozen=True)
class HealthReport:
    metrics: HealthMetrics
    issues: Tuple[HealthIssue, ...]
    report_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# ANALYZER
# ---------------------------------------------------------------------------


class IndexHealthAnalyzer:
    def analyze(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> HealthReport:
        metrics = self._compute_metrics(repo, symbols, graph, refs)
        issues = self._detect_issues(repo, symbols, graph, refs, metrics)

        report_hash = _hash({
            "metrics": asdict(metrics),
            "issues": [asdict(i) for i in issues],
        })

        return HealthReport(metrics=metrics, issues=tuple(issues), report_hash=report_hash)

    # ------------------------------------------------------------------

    def _compute_metrics(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
    ) -> HealthMetrics:
        files = len(repo.files)
        sym_count = len(symbols.defs)
        ref_count = len(symbols.refs)
        edges = len(graph.edges)

        avg_sym = sym_count / files if files else 0.0
        avg_ref = ref_count / sym_count if sym_count else 0.0
        avg_edge = edges / files if files else 0.0

        sccs = self._compute_scc(graph)
        scc_count = len(sccs)
        max_scc = max((len(c) for c in sccs), default=0)

        return HealthMetrics(
            files=files,
            symbols=sym_count,
            references=ref_count,
            edges=edges,
            avg_symbols_per_file=avg_sym,
            avg_refs_per_symbol=avg_ref,
            avg_edges_per_file=avg_edge,
            scc_count=scc_count,
            max_scc_size=max_scc,
        )

    # ------------------------------------------------------------------

    def _detect_issues(
        self,
        repo: RepoIndex,
        symbols: SymbolIndex,
        graph: DependencyGraph,
        refs: ReferenceIndex,
        m: HealthMetrics,
    ) -> List[HealthIssue]:
        issues: List[HealthIssue] = []

        # --- size anomalies
        if m.files == 0:
            issues.append(self._issue("empty_repo", "critical", "Repository has no files", {}))

        if m.symbols == 0 and m.files > 0:
            issues.append(self._issue("no_symbols", "warning", "No symbols extracted", {}))

        if m.references == 0 and m.symbols > 0:
            issues.append(self._issue("no_references", "warning", "No references detected", {}))

        # --- density anomalies
        if m.avg_symbols_per_file > 10_000:
            issues.append(self._issue("symbol_density_high", "critical", "Too many symbols per file", {"value": m.avg_symbols_per_file}))

        if m.avg_refs_per_symbol > 1000:
            issues.append(self._issue("reference_fanout_high", "critical", "Too many references per symbol", {"value": m.avg_refs_per_symbol}))

        # --- graph anomalies
        if m.max_scc_size > 1000:
            issues.append(self._issue("large_cycle", "critical", "Large strongly connected component", {"size": m.max_scc_size}))

        if m.scc_count > m.files:
            issues.append(self._issue("excessive_cycles", "warning", "Too many SCCs", {"count": m.scc_count}))

        # --- orphan detection
        symbol_files = {s.rel_path for s in symbols.defs}
        repo_files = {f.rel_path for f in repo.files}

        orphan_files = repo_files - symbol_files
        if orphan_files:
            issues.append(self._issue("orphan_files", "info", "Files without symbols", {"count": len(orphan_files)}))

        # --- unresolved references
        unresolved = [rr for rr in refs.resolved if rr.resolved is None]
        if unresolved:
            issues.append(self._issue("unresolved_references", "warning", "Unresolved references exist", {"count": len(unresolved)}))

        return issues

    # ------------------------------------------------------------------

    def _compute_scc(self, graph: DependencyGraph) -> List[Tuple[str, ...]]:
        out: Dict[str, List[str]] = {}
        rev: Dict[str, List[str]] = {}

        for e in graph.edges:
            out.setdefault(e.src, []).append(e.dst)
            rev.setdefault(e.dst, []).append(e.src)

        visited: set[str] = set()
        order: List[str] = []

        def dfs(v: str):
            visited.add(v)
            for u in out.get(v, []):
                if u not in visited:
                    dfs(u)
            order.append(v)

        for n in graph.nodes:
            if n.node_id not in visited:
                dfs(n.node_id)

        visited.clear()
        comps: List[Tuple[str, ...]] = []

        def rdfs(v: str, comp: List[str]):
            visited.add(v)
            comp.append(v)
            for u in rev.get(v, []):
                if u not in visited:
                    rdfs(u, comp)

        for v in reversed(order):
            if v not in visited:
                comp: List[str] = []
                rdfs(v, comp)
                comps.append(tuple(comp))

        return comps

    # ------------------------------------------------------------------

    def _issue(self, code: str, severity: Severity, message: str, context: Dict[str, Any]) -> HealthIssue:
        return HealthIssue(code=code, severity=severity, message=message, context=context)


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def analyze_index_health(
    repo: RepoIndex,
    symbols: SymbolIndex,
    graph: DependencyGraph,
    refs: ReferenceIndex,
) -> HealthReport:
    return IndexHealthAnalyzer().analyze(repo, symbols, graph, refs)
