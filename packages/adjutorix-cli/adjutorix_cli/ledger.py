from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from adjutorix_cli.transaction_graph import (
    GraphQueryError,
    GraphValidationError,
    TransactionEdge,
    TransactionGraph,
    TransactionNode,
    build_transaction_graph,
    render_ascii_transaction_graph,
    selected_transaction_context,
    summarize_transaction_graph,
)


class LedgerError(Exception):
    """Base ledger error for ADJUTORIX CLI ledger orchestration."""


class LedgerValidationError(LedgerError):
    """Raised when ledger payloads violate structural or semantic invariants."""


class LedgerQueryError(LedgerError):
    """Raised when a ledger query cannot be resolved coherently."""


class LedgerContinuity(str, Enum):
    intact = "intact"
    degraded = "degraded"
    broken = "broken"
    unknown = "unknown"


class LedgerHealthLevel(str, Enum):
    healthy = "healthy"
    degraded = "degraded"
    unhealthy = "unhealthy"
    unknown = "unknown"


class LedgerApplyImpact(str, Enum):
    ready = "ready"
    pending = "pending"
    blocked = "blocked"
    unknown = "unknown"


class LedgerMetricSummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_entries: int = Field(alias="totalEntries", ge=0)
    total_edges: int = Field(alias="totalEdges", ge=0)
    pending_entries: int = Field(alias="pendingEntries", ge=0)
    failed_entries: int = Field(alias="failedEntries", ge=0)
    replay_edges: int = Field(alias="replayEdges", ge=0)
    rollback_edges: int = Field(alias="rollbackEdges", ge=0)


class LedgerSelectedEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=0)
    entry_id: str = Field(alias="id", min_length=1)
    title: str = Field(min_length=1)
    phase: str | None = None
    replayable: bool | None = None
    verify_impact: str | None = None
    apply_impact: str | None = None
    evidence: list[dict[str, Any]] = Field(default_factory=list)

    @property
    def id(self) -> str:
        return self.entry_id


class LedgerPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ledger_id: str = Field(alias="ledgerId", min_length=1)
    head_seq: int | None = Field(default=None, alias="headSeq", ge=0)
    selected_seq: int | None = Field(default=None, alias="selectedSeq", ge=0)
    replayable: bool | None = None
    continuity: LedgerContinuity = LedgerContinuity.unknown
    apply_impact: LedgerApplyImpact = Field(default=LedgerApplyImpact.unknown, alias="applyImpact")
    entries: list[TransactionNode] = Field(default_factory=list)
    edges: list[TransactionEdge] = Field(default_factory=list)
    selected_entry: LedgerSelectedEntry | None = Field(default=None, alias="selectedEntry")
    metrics: LedgerMetricSummary
    health: dict[str, Any] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_selected_entry_alignment(self) -> "LedgerPayload":
        seqs = {entry.seq for entry in self.entries}
        if self.head_seq is not None and self.head_seq not in seqs:
            raise ValueError(f"headSeq={self.head_seq} does not exist in entries")
        if self.selected_seq is not None and self.selected_seq not in seqs:
            raise ValueError(f"selectedSeq={self.selected_seq} does not exist in entries")
        if self.selected_entry is not None:
            if self.selected_entry.seq not in seqs:
                raise ValueError(
                    f"selectedEntry.seq={self.selected_entry.seq} does not exist in entries"
                )
            if self.selected_seq is not None and self.selected_entry.seq != self.selected_seq:
                raise ValueError(
                    "selectedEntry.seq contradicts selectedSeq"
                )
        if self.metrics.total_entries < len(self.entries):
            raise ValueError("metrics.totalEntries is smaller than the explicit entries payload")
        if self.metrics.total_edges < len(self.edges):
            raise ValueError("metrics.totalEdges is smaller than the explicit edges payload")
        return self


@dataclass(slots=True)
class LedgerIssue:
    code: str
    message: str
    blocking: bool = False
    seq: int | None = None


@dataclass(slots=True)
class LedgerAssessment:
    ledger_id: str
    continuity: LedgerContinuity
    health_level: LedgerHealthLevel
    replayable: bool | None
    apply_impact: LedgerApplyImpact
    issues: list[LedgerIssue]
    graph: TransactionGraph
    summary: dict[str, Any]

    @property
    def ok(self) -> bool:
        return self.health_level is LedgerHealthLevel.healthy and not any(issue.blocking for issue in self.issues)

    def to_dict(self) -> dict[str, Any]:
        return {
            "ledger_id": self.ledger_id,
            "continuity": self.continuity.value,
            "health_level": self.health_level.value,
            "replayable": self.replayable,
            "apply_impact": self.apply_impact.value,
            "issues": [
                {
                    "code": issue.code,
                    "message": issue.message,
                    "blocking": issue.blocking,
                    "seq": issue.seq,
                }
                for issue in self.issues
            ],
            "summary": dict(self.summary),
            "ok": self.ok,
        }


@dataclass(slots=True)
class LedgerSelectionView:
    ledger_id: str
    selected_seq: int
    title: str
    replayable: bool | None
    verify_impact: str | None
    apply_impact: str | None
    replay_lineage: list[int]
    rollback_targets: list[int]
    ancestor_seqs: list[int]
    descendant_seqs: list[int]

    def to_dict(self) -> dict[str, Any]:
        return {
            "ledger_id": self.ledger_id,
            "selected_seq": self.selected_seq,
            "title": self.title,
            "replayable": self.replayable,
            "verify_impact": self.verify_impact,
            "apply_impact": self.apply_impact,
            "replay_lineage": list(self.replay_lineage),
            "rollback_targets": list(self.rollback_targets),
            "ancestor_seqs": list(self.ancestor_seqs),
            "descendant_seqs": list(self.descendant_seqs),
        }


class LedgerAnalyzer:
    def __init__(self, payload: LedgerPayload, graph: TransactionGraph) -> None:
        self.payload = payload
        self.graph = graph

    def assess(self) -> LedgerAssessment:
        issues: list[LedgerIssue] = []
        issues.extend(self._assess_continuity())
        issues.extend(self._assess_head_and_selection())
        issues.extend(self._assess_replayability())
        issues.extend(self._assess_metrics_consistency())
        issues.extend(self._assess_cycle_constraints())
        issues.extend(self._assess_selected_entry_projection())

        health_level = self._derive_health_level(issues)
        summary = self._build_summary(issues, health_level)
        return LedgerAssessment(
            ledger_id=self.payload.ledger_id,
            continuity=self.payload.continuity,
            health_level=health_level,
            replayable=self.payload.replayable,
            apply_impact=self.payload.apply_impact,
            issues=issues,
            graph=self.graph,
            summary=summary,
        )

    def selection_view(self) -> LedgerSelectionView:
        if self.graph.selected_seq is None:
            raise LedgerQueryError("No selected sequence is set on this ledger")
        try:
            context = selected_transaction_context(self.graph)
        except GraphQueryError as exc:
            raise LedgerQueryError(str(exc)) from exc

        return LedgerSelectionView(
            ledger_id=self.payload.ledger_id,
            selected_seq=context["selected_seq"],
            title=context["title"],
            replayable=context["replayable"],
            verify_impact=context["verify_impact"],
            apply_impact=context["apply_impact"],
            replay_lineage=list(context["replay_lineage"]),
            rollback_targets=list(context["rollback_targets"]),
            ancestor_seqs=list(context["ancestor_seqs"]),
            descendant_seqs=list(context["descendant_seqs"]),
        )

    def _assess_continuity(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        if self.payload.continuity is LedgerContinuity.broken:
            issues.append(
                LedgerIssue(
                    code="LEDGER_CONTINUITY_BROKEN",
                    message="Ledger explicitly reports broken continuity.",
                    blocking=True,
                )
            )
        elif self.payload.continuity is LedgerContinuity.degraded:
            issues.append(
                LedgerIssue(
                    code="LEDGER_CONTINUITY_DEGRADED",
                    message="Ledger continuity is degraded and may no longer be fully authoritative.",
                    blocking=False,
                )
            )

        if not self.graph.root_seqs():
            issues.append(
                LedgerIssue(
                    code="LEDGER_ROOT_MISSING",
                    message="Ledger graph has no root entries.",
                    blocking=True,
                )
            )
        return issues

    def _assess_head_and_selection(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        if self.payload.head_seq is None:
            issues.append(
                LedgerIssue(
                    code="LEDGER_HEAD_MISSING",
                    message="Ledger does not expose a head sequence.",
                    blocking=True,
                )
            )
        else:
            leafs = self.graph.leaf_seqs()
            if leafs and self.payload.head_seq not in leafs:
                issues.append(
                    LedgerIssue(
                        code="HEAD_NOT_A_LEAF",
                        message=(
                            f"Ledger head seq={self.payload.head_seq} is not a leaf in the transaction graph."
                        ),
                        blocking=True,
                        seq=self.payload.head_seq,
                    )
                )

        if self.payload.selected_seq is not None and self.payload.head_seq is not None:
            try:
                self.graph.path_between(self.payload.selected_seq, self.payload.head_seq)
            except GraphQueryError:
                try:
                    self.graph.path_between(self.payload.head_seq, self.payload.selected_seq)
                except GraphQueryError:
                    issues.append(
                        LedgerIssue(
                            code="SELECTED_DISCONNECTED_FROM_HEAD",
                            message=(
                                f"Selected seq={self.payload.selected_seq} is disconnected from head seq={self.payload.head_seq}."
                            ),
                            blocking=True,
                            seq=self.payload.selected_seq,
                        )
                    )
        return issues

    def _assess_replayability(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        replayable_nodes = [node for node in self.graph.nodes() if node.replayable is False]

        if self.payload.replayable is False and not replayable_nodes:
            issues.append(
                LedgerIssue(
                    code="LEDGER_REPLAYABILITY_CONTRADICTION",
                    message="Ledger is marked non-replayable but no explicit non-replayable node explains why.",
                    blocking=True,
                )
            )

        if self.payload.replayable is True and replayable_nodes:
            for node in replayable_nodes:
                issues.append(
                    LedgerIssue(
                        code="NON_REPLAYABLE_NODE_IN_REPLAYABLE_LEDGER",
                        message=(
                            f"Node seq={node.seq} is non-replayable while ledger is globally marked replayable."
                        ),
                        blocking=True,
                        seq=node.seq,
                    )
                )

        if self.payload.apply_impact is LedgerApplyImpact.ready and self.payload.replayable is False:
            issues.append(
                LedgerIssue(
                    code="APPLY_READY_WITH_NON_REPLAYABLE_LEDGER",
                    message="Ledger claims apply readiness while also being non-replayable.",
                    blocking=True,
                )
            )
        return issues

    def _assess_metrics_consistency(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        actual_entry_count = len(self.graph.nodes())
        actual_edge_count = len(self.graph.edges())
        actual_replay_edges = len(self.graph.replay_edges())
        actual_rollback_edges = len(self.graph.rollback_edges())
        failed_entries = sum(1 for node in self.graph.nodes() if (node.status or "").lower() in {"failed", "error"})
        pending_entries = sum(
            1 for node in self.graph.nodes() if (node.status or "").lower() in {"pending", "queued", "running"}
        )

        metric_pairs = [
            ("totalEntries", self.payload.metrics.total_entries, actual_entry_count),
            ("totalEdges", self.payload.metrics.total_edges, actual_edge_count),
            ("replayEdges", self.payload.metrics.replay_edges, actual_replay_edges),
            ("rollbackEdges", self.payload.metrics.rollback_edges, actual_rollback_edges),
            ("failedEntries", self.payload.metrics.failed_entries, failed_entries),
            ("pendingEntries", self.payload.metrics.pending_entries, pending_entries),
        ]
        for name, declared, actual in metric_pairs:
            if declared < actual:
                issues.append(
                    LedgerIssue(
                        code="LEDGER_METRIC_UNDERSTATED",
                        message=f"Metric {name}={declared} understates actual observed value {actual}.",
                        blocking=name in {"failedEntries", "totalEntries", "totalEdges"},
                    )
                )
        return issues

    def _assess_cycle_constraints(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        cycles = self.graph.cycles()
        if cycles:
            for cycle in cycles:
                issues.append(
                    LedgerIssue(
                        code="LEDGER_CYCLE_DETECTED",
                        message=f"Cycle detected in ledger graph: {' -> '.join(str(seq) for seq in cycle)}",
                        blocking=True,
                        seq=cycle[0] if cycle else None,
                    )
                )
        return issues

    def _assess_selected_entry_projection(self) -> list[LedgerIssue]:
        issues: list[LedgerIssue] = []
        if self.payload.selected_entry is None:
            if self.payload.selected_seq is not None:
                issues.append(
                    LedgerIssue(
                        code="SELECTED_ENTRY_MISSING",
                        message="Ledger exposes selectedSeq but no selectedEntry projection.",
                        blocking=False,
                        seq=self.payload.selected_seq,
                    )
                )
            return issues

        try:
            node = self.graph.node(self.payload.selected_entry.seq)
        except GraphQueryError as exc:
            raise LedgerQueryError(str(exc)) from exc

        if node.title != self.payload.selected_entry.title:
            issues.append(
                LedgerIssue(
                    code="SELECTED_ENTRY_TITLE_MISMATCH",
                    message=(
                        f"selectedEntry title {self.payload.selected_entry.title!r} does not match graph node title {node.title!r}."
                    ),
                    blocking=True,
                    seq=node.seq,
                )
            )
        if node.replayable is not None and self.payload.selected_entry.replayable is not None:
            if node.replayable != self.payload.selected_entry.replayable:
                issues.append(
                    LedgerIssue(
                        code="SELECTED_ENTRY_REPLAYABLE_MISMATCH",
                        message="selectedEntry replayable flag contradicts the graph node replayable flag.",
                        blocking=True,
                        seq=node.seq,
                    )
                )
        return issues

    def _derive_health_level(self, issues: Sequence[LedgerIssue]) -> LedgerHealthLevel:
        if any(issue.blocking for issue in issues):
            return LedgerHealthLevel.unhealthy
        if issues or self.payload.continuity is LedgerContinuity.degraded:
            return LedgerHealthLevel.degraded
        return LedgerHealthLevel.healthy

    def _build_summary(
        self,
        issues: Sequence[LedgerIssue],
        health_level: LedgerHealthLevel,
    ) -> dict[str, Any]:
        graph_summary = summarize_transaction_graph(self.graph)
        selected_context: dict[str, Any] | None = None
        if self.graph.selected_seq is not None:
            try:
                selected_context = selected_transaction_context(self.graph)
            except GraphQueryError:
                selected_context = None

        return {
            "ledger_id": self.payload.ledger_id,
            "continuity": self.payload.continuity.value,
            "health_level": health_level.value,
            "replayable": self.payload.replayable,
            "apply_impact": self.payload.apply_impact.value,
            "issue_count": len(issues),
            "blocking_issue_count": sum(1 for issue in issues if issue.blocking),
            "graph": graph_summary,
            "selected_context": selected_context,
        }


def parse_ledger_payload(raw: Mapping[str, Any] | LedgerPayload) -> LedgerPayload:
    try:
        return raw if isinstance(raw, LedgerPayload) else LedgerPayload.model_validate(raw)
    except ValidationError as exc:
        raise LedgerValidationError(f"Invalid ledger payload: {exc}") from exc


def build_ledger_graph(raw: Mapping[str, Any] | LedgerPayload) -> TransactionGraph:
    payload = parse_ledger_payload(raw)
    try:
        return build_transaction_graph(
            {
                "ledger_id": payload.ledger_id,
                "entries": [entry.model_dump(by_alias=True) for entry in payload.entries],
                "edges": [edge.model_dump(by_alias=True) for edge in payload.edges],
                "headSeq": payload.head_seq,
                "selectedSeq": payload.selected_seq,
                "replayable": payload.replayable,
                "continuity": payload.continuity.value,
            }
        )
    except GraphValidationError as exc:
        raise LedgerValidationError(str(exc)) from exc


def assess_ledger(raw: Mapping[str, Any] | LedgerPayload) -> LedgerAssessment:
    payload = parse_ledger_payload(raw)
    graph = build_ledger_graph(payload)
    analyzer = LedgerAnalyzer(payload, graph)
    return analyzer.assess()


def summarize_ledger_assessment(assessment: LedgerAssessment) -> dict[str, Any]:
    return {
        "ledger_id": assessment.ledger_id,
        "continuity": assessment.continuity.value,
        "health_level": assessment.health_level.value,
        "replayable": assessment.replayable,
        "apply_impact": assessment.apply_impact.value,
        "issue_count": len(assessment.issues),
        "blocking_issue_count": sum(1 for issue in assessment.issues if issue.blocking),
        "ok": assessment.ok,
    }


def render_ledger_report(assessment: LedgerAssessment) -> str:
    lines: list[str] = []
    lines.append(f"Ledger Report: {assessment.ledger_id}")
    lines.append(f"Continuity: {assessment.continuity.value}")
    lines.append(f"Health: {assessment.health_level.value}")
    lines.append(f"Replayable: {assessment.replayable}")
    lines.append(f"Apply impact: {assessment.apply_impact.value}")

    if assessment.issues:
        lines.append("Issues:")
        for issue in assessment.issues:
            scope = f" seq={issue.seq}" if issue.seq is not None else ""
            severity = "BLOCKING" if issue.blocking else "WARN"
            lines.append(f"  - [{severity}] {issue.code}{scope}: {issue.message}")
    else:
        lines.append("Issues: none")

    lines.append("Summary:")
    for key, value in assessment.summary.items():
        if key == "selected_context" and isinstance(value, Mapping):
            lines.append("  selected_context:")
            for inner_key, inner_value in value.items():
                lines.append(f"    - {inner_key}: {inner_value}")
        else:
            lines.append(f"  - {key}: {value}")

    lines.append("Graph:")
    lines.append(render_ascii_transaction_graph(assessment.graph).to_text())
    return "\n".join(lines)


def ledger_selection_view(raw: Mapping[str, Any] | LedgerPayload) -> LedgerSelectionView:
    payload = parse_ledger_payload(raw)
    graph = build_ledger_graph(payload)
    analyzer = LedgerAnalyzer(payload, graph)
    return analyzer.selection_view()


def compare_ledgers(
    left_raw: Mapping[str, Any] | LedgerPayload,
    right_raw: Mapping[str, Any] | LedgerPayload,
) -> dict[str, Any]:
    left = assess_ledger(left_raw)
    right = assess_ledger(right_raw)

    left_graph = left.graph
    right_graph = right.graph

    left_nodes = set(left_graph.nodes_by_seq)
    right_nodes = set(right_graph.nodes_by_seq)
    left_edges = set(left_graph.edges_by_id)
    right_edges = set(right_graph.edges_by_id)

    changed_nodes: list[int] = []
    for seq in sorted(left_nodes & right_nodes):
        if left_graph.nodes_by_seq[seq].model_dump(by_alias=True) != right_graph.nodes_by_seq[seq].model_dump(by_alias=True):
            changed_nodes.append(seq)

    changed_edges: list[str] = []
    for edge_id in sorted(left_edges & right_edges):
        if left_graph.edges_by_id[edge_id].model_dump(by_alias=True) != right_graph.edges_by_id[edge_id].model_dump(by_alias=True):
            changed_edges.append(edge_id)

    return {
        "changed": bool(
            changed_nodes
            or changed_edges
            or (left_nodes - right_nodes)
            or (right_nodes - left_nodes)
            or (left_edges - right_edges)
            or (right_edges - left_edges)
            or left.continuity != right.continuity
            or left.health_level != right.health_level
            or left.replayable != right.replayable
            or left.apply_impact != right.apply_impact
        ),
        "left_ledger_id": left.ledger_id,
        "right_ledger_id": right.ledger_id,
        "added_nodes": sorted(right_nodes - left_nodes),
        "removed_nodes": sorted(left_nodes - right_nodes),
        "changed_nodes": changed_nodes,
        "added_edges": sorted(right_edges - left_edges),
        "removed_edges": sorted(left_edges - right_edges),
        "changed_edges": changed_edges,
        "continuity_changed": left.continuity != right.continuity,
        "health_changed": left.health_level != right.health_level,
        "replayable_changed": left.replayable != right.replayable,
        "apply_impact_changed": left.apply_impact != right.apply_impact,
    }
