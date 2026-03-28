from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from adjutorix_cli.transaction_graph import (
    GraphQueryError,
    GraphValidationError,
    TransactionGraph,
    build_transaction_graph,
    selected_transaction_context,
    summarize_transaction_graph,
)


class ReplayError(Exception):
    """Base replay error for ADJUTORIX CLI replay orchestration."""


class ReplayValidationError(ReplayError):
    """Raised when replay inputs or contracts are invalid."""


class ReplayExecutionError(ReplayError):
    """Raised when replay execution cannot be completed coherently."""


class ReplayStatus(str, Enum):
    pending = "pending"
    running = "running"
    passed = "passed"
    failed = "failed"
    diverged = "diverged"
    blocked = "blocked"
    rolled_back = "rolled-back"


class ReplayDeterminism(str, Enum):
    deterministic = "deterministic"
    non_deterministic = "non-deterministic"
    unknown = "unknown"


class ReplayScope(str, Enum):
    selected = "selected"
    ancestry = "ancestry"
    descendants = "descendants"
    lineage = "lineage"
    full_graph = "full-graph"


class EnvironmentMatch(str, Enum):
    exact = "exact"
    compatible = "compatible"
    drifted = "drifted"
    unknown = "unknown"


class ReplayExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    expected_status: ReplayStatus = ReplayStatus.passed
    expected_determinism: ReplayDeterminism = ReplayDeterminism.deterministic
    require_replayable_lineage: bool = True
    allow_environment_drift: bool = False
    require_exact_selected_seq: bool = True
    require_exact_head_seq: bool = False
    require_zero_failures: bool = True


class ReplayEnvironmentSnapshot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fingerprint: str | None = None
    platform: str | None = None
    toolchain: dict[str, str] = Field(default_factory=dict)
    workspace_root: str | None = None
    trust_level: str | None = None
    readonly_media: bool | None = None
    offline: bool | None = None
    degraded: bool | None = None


class ReplayEvidenceItem(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidence_id: str = Field(min_length=1, alias="id")
    title: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    payload: dict[str, Any] = Field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.evidence_id


class ReplayStep(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seq: int = Field(ge=0)
    title: str = Field(min_length=1)
    kind: str = Field(min_length=1)
    replayable: bool | None = None
    expected_status: str | None = None
    observed_status: str | None = None
    deterministic: ReplayDeterminism = ReplayDeterminism.unknown
    messages: list[str] = Field(default_factory=list)
    evidence: list[ReplayEvidenceItem] = Field(default_factory=list)
    rollback_target_seq: int | None = None


class ReplayRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    ledger: dict[str, Any]
    selected_seq: int | None = Field(default=None, alias="selectedSeq")
    scope: ReplayScope = ReplayScope.selected
    expectation: ReplayExpectation = Field(default_factory=ReplayExpectation)
    current_environment: ReplayEnvironmentSnapshot | None = Field(default=None, alias="currentEnvironment")
    recorded_environment: ReplayEnvironmentSnapshot | None = Field(default=None, alias="recordedEnvironment")
    rollback_on_failure: bool = False

    @model_validator(mode="after")
    def validate_scope_vs_selected_seq(self) -> "ReplayRequest":
        if self.scope in {ReplayScope.selected, ReplayScope.ancestry, ReplayScope.descendants, ReplayScope.lineage}:
            if self.selected_seq is None:
                raise ValueError(f"selectedSeq is required for replay scope {self.scope.value!r}")
        return self


@dataclass(slots=True)
class ReplayIssue:
    code: str
    message: str
    fatal: bool = False
    step_seq: int | None = None


@dataclass(slots=True)
class ReplayPlan:
    ledger_id: str
    scope: ReplayScope
    selected_seq: int | None
    ordered_seqs: list[int]
    rollback_target_seq: int | None
    environment_match: EnvironmentMatch
    issues: list[ReplayIssue] = field(default_factory=list)


@dataclass(slots=True)
class ReplayOutcome:
    ledger_id: str
    status: ReplayStatus
    determinism: ReplayDeterminism
    selected_seq: int | None
    replayed_seqs: list[int]
    rollback_target_seq: int | None
    environment_match: EnvironmentMatch
    issues: list[ReplayIssue]
    steps: list[ReplayStep]
    evidence: list[ReplayEvidenceItem]
    summary: dict[str, Any]

    @property
    def ok(self) -> bool:
        return self.status is ReplayStatus.passed

    def to_dict(self) -> dict[str, Any]:
        return {
            "ledger_id": self.ledger_id,
            "status": self.status.value,
            "determinism": self.determinism.value,
            "selected_seq": self.selected_seq,
            "replayed_seqs": list(self.replayed_seqs),
            "rollback_target_seq": self.rollback_target_seq,
            "environment_match": self.environment_match.value,
            "issues": [
                {
                    "code": issue.code,
                    "message": issue.message,
                    "fatal": issue.fatal,
                    "step_seq": issue.step_seq,
                }
                for issue in self.issues
            ],
            "steps": [step.model_dump(by_alias=True) for step in self.steps],
            "evidence": [item.model_dump(by_alias=True) for item in self.evidence],
            "summary": dict(self.summary),
        }


class ReplayAnalyzer:
    def __init__(self, graph: TransactionGraph) -> None:
        self.graph = graph

    def build_plan(
        self,
        *,
        scope: ReplayScope,
        selected_seq: int | None,
        expectation: ReplayExpectation,
        current_environment: ReplayEnvironmentSnapshot | None,
        recorded_environment: ReplayEnvironmentSnapshot | None,
    ) -> ReplayPlan:
        ordered_seqs = self._resolve_scope(scope=scope, selected_seq=selected_seq)
        issues: list[ReplayIssue] = []

        environment_match = compare_replay_environments(
            current=current_environment,
            recorded=recorded_environment,
        )

        if expectation.require_replayable_lineage:
            for seq in ordered_seqs:
                node = self.graph.node(seq)
                if node.replayable is False:
                    issues.append(
                        ReplayIssue(
                            code="NODE_NOT_REPLAYABLE",
                            message=f"Node seq={seq} is marked non-replayable.",
                            fatal=True,
                            step_seq=seq,
                        )
                    )

        if expectation.require_exact_selected_seq and selected_seq is not None and self.graph.selected_seq != selected_seq:
            issues.append(
                ReplayIssue(
                    code="SELECTED_SEQ_MISMATCH",
                    message=(
                        f"Replay requested selected seq={selected_seq}, "
                        f"but graph selected seq is {self.graph.selected_seq}."
                    ),
                    fatal=True,
                    step_seq=selected_seq,
                )
            )

        if expectation.require_exact_head_seq and self.graph.head_seq is None:
            issues.append(
                ReplayIssue(
                    code="HEAD_SEQ_REQUIRED",
                    message="Replay expectation requires an explicit head sequence.",
                    fatal=True,
                )
            )

        if environment_match is EnvironmentMatch.drifted and not expectation.allow_environment_drift:
            issues.append(
                ReplayIssue(
                    code="ENVIRONMENT_DRIFT_DETECTED",
                    message="Current replay environment materially differs from the recorded environment.",
                    fatal=True,
                )
            )

        rollback_target_seq = self._compute_rollback_target(ordered_seqs)

        return ReplayPlan(
            ledger_id=self.graph.ledger_id,
            scope=scope,
            selected_seq=selected_seq,
            ordered_seqs=ordered_seqs,
            rollback_target_seq=rollback_target_seq,
            environment_match=environment_match,
            issues=issues,
        )

    def execute_plan(
        self,
        plan: ReplayPlan,
        *,
        expectation: ReplayExpectation,
        rollback_on_failure: bool,
    ) -> ReplayOutcome:
        fatal_plan_issues = [issue for issue in plan.issues if issue.fatal]
        if fatal_plan_issues:
            return self._build_blocked_outcome(plan, fatal_plan_issues)

        steps: list[ReplayStep] = []
        issues: list[ReplayIssue] = list(plan.issues)
        evidence: list[ReplayEvidenceItem] = []
        overall_determinism = ReplayDeterminism.deterministic
        status = ReplayStatus.passed

        for seq in plan.ordered_seqs:
            node = self.graph.node(seq)
            step = self._replay_step(node)
            steps.append(step)
            evidence.extend(step.evidence)

            if step.deterministic is ReplayDeterminism.non_deterministic:
                overall_determinism = ReplayDeterminism.non_deterministic
                issues.append(
                    ReplayIssue(
                        code="NON_DETERMINISTIC_STEP",
                        message=f"Replay step seq={seq} is marked non-deterministic.",
                        fatal=expectation.expected_determinism is ReplayDeterminism.deterministic,
                        step_seq=seq,
                    )
                )

            if step.replayable is False:
                issues.append(
                    ReplayIssue(
                        code="NON_REPLAYABLE_STEP",
                        message=f"Replay step seq={seq} cannot be replayed authoritatively.",
                        fatal=True,
                        step_seq=seq,
                    )
                )
                status = ReplayStatus.failed

            observed_status = (step.observed_status or "").strip().lower()
            if observed_status in {"failed", "error", "blocked"}:
                issues.append(
                    ReplayIssue(
                        code="STEP_FAILED",
                        message=f"Replay step seq={seq} ended in status={step.observed_status!r}.",
                        fatal=True,
                        step_seq=seq,
                    )
                )
                status = ReplayStatus.failed

        if expectation.require_zero_failures and any(issue.code in {"STEP_FAILED", "NON_REPLAYABLE_STEP"} for issue in issues):
            status = ReplayStatus.failed

        if overall_determinism is ReplayDeterminism.non_deterministic and expectation.expected_determinism is ReplayDeterminism.deterministic:
            status = ReplayStatus.diverged

        fatal_issues = [issue for issue in issues if issue.fatal]
        rollback_target_seq = plan.rollback_target_seq
        if fatal_issues and rollback_on_failure:
            status = ReplayStatus.rolled_back
        elif fatal_issues and status is ReplayStatus.passed:
            status = ReplayStatus.failed

        summary = self._build_summary(
            status=status,
            plan=plan,
            issues=issues,
            steps=steps,
            evidence=evidence,
            determinism=overall_determinism,
        )

        return ReplayOutcome(
            ledger_id=self.graph.ledger_id,
            status=status,
            determinism=overall_determinism,
            selected_seq=plan.selected_seq,
            replayed_seqs=list(plan.ordered_seqs),
            rollback_target_seq=rollback_target_seq if status is ReplayStatus.rolled_back else None,
            environment_match=plan.environment_match,
            issues=issues,
            steps=steps,
            evidence=evidence,
            summary=summary,
        )

    def _resolve_scope(self, *, scope: ReplayScope, selected_seq: int | None) -> list[int]:
        if scope is ReplayScope.full_graph:
            try:
                return self.graph.topological_order()
            except GraphQueryError:
                return sorted(self.graph.nodes_by_seq)

        if selected_seq is None:
            raise ReplayValidationError(f"selected_seq is required for scope {scope.value!r}")
        self.graph.node(selected_seq)

        if scope is ReplayScope.selected:
            return [selected_seq]
        if scope is ReplayScope.ancestry:
            ancestry = self.graph.ancestors(selected_seq).reachable_seqs
            return self._order_subset(ancestry)
        if scope is ReplayScope.descendants:
            descendants = self.graph.descendants(selected_seq).reachable_seqs
            return self._order_subset(descendants)
        if scope is ReplayScope.lineage:
            ancestry = set(self.graph.ancestors(selected_seq).reachable_seqs)
            descendants = set(self.graph.descendants(selected_seq).reachable_seqs)
            lineage = sorted(ancestry | descendants)
            return self._order_subset(lineage)

        raise ReplayValidationError(f"Unsupported replay scope: {scope!r}")

    def _order_subset(self, seqs: Sequence[int]) -> list[int]:
        subset = set(seqs)
        try:
            return [seq for seq in self.graph.topological_order() if seq in subset]
        except GraphQueryError:
            return sorted(subset)

    def _compute_rollback_target(self, ordered_seqs: Sequence[int]) -> int | None:
        if not ordered_seqs:
            return None

        # Limiting case: explicit rollback edge from the last replayed node dominates inferred rollback target.
        last_seq = ordered_seqs[-1]
        rollback_targets = self.graph.rollback_targets_for(last_seq)
        if rollback_targets:
            return rollback_targets[0]

        # Otherwise choose the nearest replay ancestor before the selected sequence.
        selected = ordered_seqs[-1]
        lineage = self.graph.replay_lineage_for(selected)
        prior = [seq for seq in lineage if seq < selected]
        return prior[-1] if prior else None

    def _replay_step(self, node: Any) -> ReplayStep:
        deterministic = ReplayDeterminism.deterministic
        messages = [f"Replayed node seq={node.seq} title={node.title!r}."]
        evidence: list[ReplayEvidenceItem] = [
            ReplayEvidenceItem(
                id=f"replay-step-{node.seq}",
                title=f"Replay evidence for seq {node.seq}",
                kind="replay-step",
                payload={
                    "seq": node.seq,
                    "node_id": node.id,
                    "title": node.title,
                    "kind": node.kind.value,
                    "status": node.status,
                },
            )
        ]

        status = (node.status or "completed").strip().lower()
        if status in {"unknown", "pending"}:
            deterministic = ReplayDeterminism.unknown
            messages.append("Observed status is not strong enough to prove deterministic replay.")
        if node.kind.value in {"shell", "system"}:
            deterministic = ReplayDeterminism.non_deterministic
            messages.append("Runtime- or shell-coupled node treated as non-deterministic limiting case.")

        rollback_target_seq: int | None = None
        rollback_targets = self.graph.rollback_targets_for(node.seq)
        if rollback_targets:
            rollback_target_seq = rollback_targets[0]
            messages.append(f"Rollback boundary available at seq={rollback_target_seq}.")

        return ReplayStep(
            seq=node.seq,
            title=node.title,
            kind=node.kind.value,
            replayable=node.replayable,
            expected_status="passed",
            observed_status=node.status or "completed",
            deterministic=deterministic,
            messages=messages,
            evidence=evidence,
            rollback_target_seq=rollback_target_seq,
        )

    def _build_blocked_outcome(self, plan: ReplayPlan, fatal_plan_issues: Sequence[ReplayIssue]) -> ReplayOutcome:
        summary = self._build_summary(
            status=ReplayStatus.blocked,
            plan=plan,
            issues=list(fatal_plan_issues),
            steps=[],
            evidence=[],
            determinism=ReplayDeterminism.unknown,
        )
        return ReplayOutcome(
            ledger_id=self.graph.ledger_id,
            status=ReplayStatus.blocked,
            determinism=ReplayDeterminism.unknown,
            selected_seq=plan.selected_seq,
            replayed_seqs=[],
            rollback_target_seq=None,
            environment_match=plan.environment_match,
            issues=list(fatal_plan_issues),
            steps=[],
            evidence=[],
            summary=summary,
        )

    def _build_summary(
        self,
        *,
        status: ReplayStatus,
        plan: ReplayPlan,
        issues: Sequence[ReplayIssue],
        steps: Sequence[ReplayStep],
        evidence: Sequence[ReplayEvidenceItem],
        determinism: ReplayDeterminism,
    ) -> dict[str, Any]:
        graph_summary = summarize_transaction_graph(self.graph)
        selected_context: dict[str, Any] | None = None
        if self.graph.selected_seq is not None:
            try:
                selected_context = selected_transaction_context(self.graph)
            except GraphQueryError:
                selected_context = None

        return {
            "ledger": graph_summary,
            "selected_context": selected_context,
            "status": status.value,
            "scope": plan.scope.value,
            "selected_seq": plan.selected_seq,
            "replayed_count": len(plan.ordered_seqs),
            "issue_count": len(issues),
            "fatal_issue_count": sum(1 for issue in issues if issue.fatal),
            "step_count": len(steps),
            "evidence_count": len(evidence),
            "determinism": determinism.value,
            "environment_match": plan.environment_match.value,
            "rollback_target_seq": plan.rollback_target_seq,
        }


def compare_replay_environments(
    *,
    current: ReplayEnvironmentSnapshot | None,
    recorded: ReplayEnvironmentSnapshot | None,
) -> EnvironmentMatch:
    if current is None or recorded is None:
        return EnvironmentMatch.unknown

    if current.model_dump() == recorded.model_dump():
        return EnvironmentMatch.exact

    materially_different = any(
        [
            current.fingerprint and recorded.fingerprint and current.fingerprint != recorded.fingerprint,
            current.workspace_root and recorded.workspace_root and current.workspace_root != recorded.workspace_root,
            current.trust_level and recorded.trust_level and current.trust_level != recorded.trust_level,
            current.readonly_media is not None
            and recorded.readonly_media is not None
            and current.readonly_media != recorded.readonly_media,
            current.offline is not None and recorded.offline is not None and current.offline != recorded.offline,
            current.degraded is not None and recorded.degraded is not None and current.degraded != recorded.degraded,
        ]
    )
    if materially_different:
        return EnvironmentMatch.drifted

    compatible_toolchain = all(
        current.toolchain.get(key) == recorded.toolchain.get(key)
        for key in sorted(set(current.toolchain) | set(recorded.toolchain))
    )
    if current.platform == recorded.platform and compatible_toolchain:
        return EnvironmentMatch.compatible
    return EnvironmentMatch.drifted


def plan_replay(raw: Mapping[str, Any] | ReplayRequest) -> ReplayPlan:
    request = _normalize_request(raw)
    graph = build_transaction_graph(request.ledger)
    analyzer = ReplayAnalyzer(graph)
    return analyzer.build_plan(
        scope=request.scope,
        selected_seq=request.selected_seq,
        expectation=request.expectation,
        current_environment=request.current_environment,
        recorded_environment=request.recorded_environment,
    )


def execute_replay(raw: Mapping[str, Any] | ReplayRequest) -> ReplayOutcome:
    request = _normalize_request(raw)
    graph = build_transaction_graph(request.ledger)
    analyzer = ReplayAnalyzer(graph)
    plan = analyzer.build_plan(
        scope=request.scope,
        selected_seq=request.selected_seq,
        expectation=request.expectation,
        current_environment=request.current_environment,
        recorded_environment=request.recorded_environment,
    )
    return analyzer.execute_plan(
        plan,
        expectation=request.expectation,
        rollback_on_failure=request.rollback_on_failure,
    )


def summarize_replay_outcome(outcome: ReplayOutcome) -> dict[str, Any]:
    return {
        "ledger_id": outcome.ledger_id,
        "status": outcome.status.value,
        "determinism": outcome.determinism.value,
        "selected_seq": outcome.selected_seq,
        "replayed_seqs": list(outcome.replayed_seqs),
        "rollback_target_seq": outcome.rollback_target_seq,
        "environment_match": outcome.environment_match.value,
        "issue_count": len(outcome.issues),
        "fatal_issue_count": sum(1 for issue in outcome.issues if issue.fatal),
        "step_count": len(outcome.steps),
        "evidence_count": len(outcome.evidence),
        "ok": outcome.ok,
    }


def render_replay_report(outcome: ReplayOutcome) -> str:
    lines: list[str] = []
    lines.append(f"Replay Report: ledger={outcome.ledger_id}")
    lines.append(f"Status: {outcome.status.value}")
    lines.append(f"Determinism: {outcome.determinism.value}")
    lines.append(f"Environment match: {outcome.environment_match.value}")
    lines.append(f"Selected seq: {outcome.selected_seq}")
    lines.append(f"Replayed seqs: {', '.join(str(seq) for seq in outcome.replayed_seqs) if outcome.replayed_seqs else '-'}")
    if outcome.rollback_target_seq is not None:
        lines.append(f"Rollback target seq: {outcome.rollback_target_seq}")

    if outcome.issues:
        lines.append("Issues:")
        for issue in outcome.issues:
            scope = f" seq={issue.step_seq}" if issue.step_seq is not None else ""
            severity = "FATAL" if issue.fatal else "WARN"
            lines.append(f"  - [{severity}] {issue.code}{scope}: {issue.message}")
    else:
        lines.append("Issues: none")

    if outcome.steps:
        lines.append("Steps:")
        for step in outcome.steps:
            lines.append(
                f"  - seq={step.seq} kind={step.kind} observed={step.observed_status} "
                f"determinism={step.deterministic.value} replayable={step.replayable}"
            )
            for message in step.messages:
                lines.append(f"      • {message}")
    else:
        lines.append("Steps: none")

    if outcome.evidence:
        lines.append("Evidence:")
        for item in outcome.evidence:
            lines.append(f"  - {item.id}: {item.title} ({item.kind})")
    else:
        lines.append("Evidence: none")

    return "\n".join(lines)


def _normalize_request(raw: Mapping[str, Any] | ReplayRequest) -> ReplayRequest:
    try:
        return raw if isinstance(raw, ReplayRequest) else ReplayRequest.model_validate(raw)
    except ValidationError as exc:
        raise ReplayValidationError(f"Invalid replay request: {exc}") from ex