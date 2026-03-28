from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator

from adjutorix_cli.ledger import LedgerAssessment, assess_ledger
from adjutorix_cli.replay import ReplayOutcome, execute_replay
from adjutorix_cli.verify import VerifyAssessment, assess_verify_result


class GovernanceError(Exception):
    """Base governance error for ADJUTORIX CLI decision logic."""


class GovernanceValidationError(GovernanceError):
    """Raised when governance inputs are malformed or semantically contradictory."""


class GovernanceDecisionError(GovernanceError):
    """Raised when a caller requests an action that governance blocks."""


class ActionKind(str, Enum):
    inspect = "inspect"
    preview = "preview"
    open_workspace = "open-workspace"
    connect_agent = "connect-agent"
    send_message = "send-message"
    verify = "verify"
    replay = "replay"
    apply = "apply"
    rollback = "rollback"
    run_shell = "run-shell"
    trust_workspace = "trust-workspace"
    write_file = "write-file"
    delete_file = "delete-file"


class ActionSeverity(str, Enum):
    harmless = "harmless"
    informative = "informative"
    consequential = "consequential"
    destructive = "destructive"


class GovernanceLevel(str, Enum):
    allow = "allow"
    warn = "warn"
    block = "block"


class GovernanceInvariant(str, Enum):
    no_invisible_action = "no-invisible-action"
    no_unverifiable_claim = "no-unverifiable-claim"
    no_irreversible_mutation_without_confirmation = "no-irreversible-mutation-without-confirmation"
    no_ambiguous_state = "no-ambiguous-state"
    no_hidden_authority = "no-hidden-authority"


class VisibilityState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action_visible: bool = True
    consequences_visible: bool = True
    authority_visible: bool = True
    evidence_visible: bool = True
    target_visible: bool = True


class ConfirmationState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    confirmed: bool = False
    confirmation_subject: str | None = None
    confirmation_scope: str | None = None
    fresh: bool = False


class AuthorityState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    may_read: bool = True
    may_write: bool = False
    may_apply: bool = False
    may_verify: bool = True
    may_replay: bool = True
    may_run_shell: bool = False
    may_trust_workspace: bool = False
    may_override: bool = False


class WorkspaceState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    workspace_id: str | None = None
    root_path: str | None = None
    trust_level: str | None = None
    trusted: bool = False
    healthy: bool = True
    mutable: bool = False


class EnvironmentState(BaseModel):
    model_config = ConfigDict(extra="forbid")

    fingerprint: str | None = None
    drifted: bool = False
    offline: bool = False
    degraded: bool = False
    readonly_media: bool = False


class ActionIntent(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: ActionKind
    subject_id: str | None = None
    subject_label: str | None = None
    severity: ActionSeverity = ActionSeverity.informative
    mutates_workspace: bool = False
    irreversible: bool = False
    external_effect: bool = False
    requires_fresh_evidence: bool = False
    requires_trusted_workspace: bool = False
    requires_replayable_lineage: bool = False
    requires_verify_ready: bool = False
    requires_shell_ready: bool = False


class GovernancePolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")

    require_visible_action: bool = True
    require_visible_consequences: bool = True
    require_visible_authority: bool = True
    require_visible_evidence_for_claims: bool = True
    require_confirmation_for_consequential_actions: bool = True
    require_confirmation_for_destructive_actions: bool = True
    require_trusted_workspace_for_mutation: bool = True
    require_healthy_workspace_for_mutation: bool = True
    require_non_drifted_environment_for_apply: bool = True
    require_replayable_lineage_for_apply: bool = True
    require_verify_ready_for_apply: bool = True
    require_shell_authority_for_run: bool = True
    require_explicit_trust_authority: bool = True
    allow_override: bool = False


class GovernanceContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    action: ActionIntent
    visibility: VisibilityState = Field(default_factory=VisibilityState)
    confirmation: ConfirmationState = Field(default_factory=ConfirmationState)
    authority: AuthorityState = Field(default_factory=AuthorityState)
    workspace: WorkspaceState = Field(default_factory=WorkspaceState)
    environment: EnvironmentState = Field(default_factory=EnvironmentState)
    policy: GovernancePolicy = Field(default_factory=GovernancePolicy)
    verify: dict[str, Any] | None = None
    ledger: dict[str, Any] | None = None
    replay: dict[str, Any] | None = None

    @model_validator(mode="after")
    def validate_action_vs_flags(self) -> "GovernanceContext":
        if self.action.kind is ActionKind.apply and not self.action.mutates_workspace:
            raise ValueError("apply action must declare mutates_workspace=True")
        if self.action.kind is ActionKind.delete_file and not self.action.irreversible:
            raise ValueError("delete-file action must declare irreversible=True")
        if self.action.kind is ActionKind.run_shell and not self.action.external_effect:
            raise ValueError("run-shell action must declare external_effect=True")
        return self


@dataclass(slots=True)
class GovernanceIssue:
    code: str
    message: str
    level: GovernanceLevel
    invariant: GovernanceInvariant
    blocking: bool = False


@dataclass(slots=True)
class GovernanceDecision:
    action: ActionKind
    allowed: bool
    level: GovernanceLevel
    issues: list[GovernanceIssue]
    invariants_checked: list[GovernanceInvariant]
    verify_assessment: VerifyAssessment | None = None
    ledger_assessment: LedgerAssessment | None = None
    replay_outcome: ReplayOutcome | None = None
    summary: dict[str, Any] = field(default_factory=dict)

    @property
    def blocking_issue_count(self) -> int:
        return sum(1 for issue in self.issues if issue.blocking)

    def to_dict(self) -> dict[str, Any]:
        return {
            "action": self.action.value,
            "allowed": self.allowed,
            "level": self.level.value,
            "blocking_issue_count": self.blocking_issue_count,
            "issues": [
                {
                    "code": issue.code,
                    "message": issue.message,
                    "level": issue.level.value,
                    "invariant": issue.invariant.value,
                    "blocking": issue.blocking,
                }
                for issue in self.issues
            ],
            "invariants_checked": [inv.value for inv in self.invariants_checked],
            "verify_assessment": self.verify_assessment.to_dict() if self.verify_assessment else None,
            "ledger_assessment": self.ledger_assessment.to_dict() if self.ledger_assessment else None,
            "replay_outcome": self.replay_outcome.to_dict() if self.replay_outcome else None,
            "summary": dict(self.summary),
        }


class GovernanceAnalyzer:
    def __init__(self, context: GovernanceContext) -> None:
        self.context = context

    def decide(self) -> GovernanceDecision:
        issues: list[GovernanceIssue] = []
        checked = [inv for inv in GovernanceInvariant]

        verify_assessment = self._build_verify_assessment()
        ledger_assessment = self._build_ledger_assessment()
        replay_outcome = self._build_replay_outcome()

        issues.extend(self._check_visibility())
        issues.extend(self._check_confirmation())
        issues.extend(self._check_authority())
        issues.extend(self._check_workspace())
        issues.extend(self._check_environment())
        issues.extend(self._check_evidence(verify_assessment, ledger_assessment, replay_outcome))
        issues.extend(self._check_no_ambiguous_state(verify_assessment, ledger_assessment, replay_outcome))

        allowed = not any(issue.blocking for issue in issues)
        level = self._derive_level(issues)
        summary = self._build_summary(issues, level, allowed, verify_assessment, ledger_assessment, replay_outcome)

        return GovernanceDecision(
            action=self.context.action.kind,
            allowed=allowed,
            level=level,
            issues=issues,
            invariants_checked=checked,
            verify_assessment=verify_assessment,
            ledger_assessment=ledger_assessment,
            replay_outcome=replay_outcome,
            summary=summary,
        )

    def _build_verify_assessment(self) -> VerifyAssessment | None:
        if self.context.verify is None:
            return None
        return assess_verify_result(self.context.verify)

    def _build_ledger_assessment(self) -> LedgerAssessment | None:
        if self.context.ledger is None:
            return None
        return assess_ledger(self.context.ledger)

    def _build_replay_outcome(self) -> ReplayOutcome | None:
        if self.context.replay is None:
            return None
        return execute_replay(self.context.replay)

    def _check_visibility(self) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []

        if ctx.policy.require_visible_action and not ctx.visibility.action_visible:
            issues.append(
                GovernanceIssue(
                    code="ACTION_NOT_VISIBLE",
                    message="Consequential action is not visibly represented to the operator.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_invisible_action,
                    blocking=True,
                )
            )
        if ctx.policy.require_visible_consequences and ctx.action.severity in {ActionSeverity.consequential, ActionSeverity.destructive} and not ctx.visibility.consequences_visible:
            issues.append(
                GovernanceIssue(
                    code="CONSEQUENCES_NOT_VISIBLE",
                    message="Action consequences are not visible before authorization.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_invisible_action,
                    blocking=True,
                )
            )
        if ctx.policy.require_visible_authority and not ctx.visibility.authority_visible:
            issues.append(
                GovernanceIssue(
                    code="AUTHORITY_NOT_VISIBLE",
                    message="Authority boundary is hidden while actionability depends on it.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_hidden_authority,
                    blocking=True,
                )
            )
        if ctx.action.subject_id is not None and not ctx.visibility.target_visible:
            issues.append(
                GovernanceIssue(
                    code="TARGET_NOT_VISIBLE",
                    message="Target subject is not visibly bound to the requested action.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_invisible_action,
                    blocking=True,
                )
            )
        return issues

    def _check_confirmation(self) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []
        severity = ctx.action.severity
        needs_confirmation = False

        if severity is ActionSeverity.consequential and ctx.policy.require_confirmation_for_consequential_actions:
            needs_confirmation = True
        if severity is ActionSeverity.destructive and ctx.policy.require_confirmation_for_destructive_actions:
            needs_confirmation = True
        if ctx.action.irreversible:
            needs_confirmation = True

        if needs_confirmation:
            if not ctx.confirmation.confirmed or not ctx.confirmation.fresh:
                issues.append(
                    GovernanceIssue(
                        code="CONFIRMATION_REQUIRED",
                        message="Consequential action lacks fresh explicit confirmation.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_irreversible_mutation_without_confirmation,
                        blocking=True,
                    )
                )
        return issues

    def _check_authority(self) -> list[GovernanceIssue]:
        ctx = self.context
        action = ctx.action.kind
        issues: list[GovernanceIssue] = []

        if action in {ActionKind.inspect, ActionKind.preview}:
            if not ctx.authority.may_read:
                issues.append(self._authority_issue("READ_AUTHORITY_DENIED", "Read authority is denied."))
        elif action in {ActionKind.write_file, ActionKind.delete_file, ActionKind.open_workspace}:
            if not ctx.authority.may_write:
                issues.append(self._authority_issue("WRITE_AUTHORITY_DENIED", "Write authority is denied."))
        elif action is ActionKind.apply:
            if not ctx.authority.may_apply:
                issues.append(self._authority_issue("APPLY_AUTHORITY_DENIED", "Apply authority is denied."))
        elif action is ActionKind.verify:
            if not ctx.authority.may_verify:
                issues.append(self._authority_issue("VERIFY_AUTHORITY_DENIED", "Verify authority is denied."))
        elif action is ActionKind.replay:
            if not ctx.authority.may_replay:
                issues.append(self._authority_issue("REPLAY_AUTHORITY_DENIED", "Replay authority is denied."))
        elif action is ActionKind.run_shell:
            if not ctx.authority.may_run_shell:
                issues.append(self._authority_issue("SHELL_AUTHORITY_DENIED", "Shell execution authority is denied."))
        elif action is ActionKind.trust_workspace:
            if ctx.policy.require_explicit_trust_authority and not ctx.authority.may_trust_workspace:
                issues.append(self._authority_issue("TRUST_AUTHORITY_DENIED", "Workspace trust elevation authority is denied."))

        return issues

    def _authority_issue(self, code: str, message: str) -> GovernanceIssue:
        return GovernanceIssue(
            code=code,
            message=message,
            level=GovernanceLevel.block,
            invariant=GovernanceInvariant.no_hidden_authority,
            blocking=True,
        )

    def _check_workspace(self) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []
        mutates = ctx.action.mutates_workspace or ctx.action.kind in {
            ActionKind.apply,
            ActionKind.write_file,
            ActionKind.delete_file,
            ActionKind.rollback,
        }

        if mutates and ctx.policy.require_trusted_workspace_for_mutation and not ctx.workspace.trusted:
            issues.append(
                GovernanceIssue(
                    code="WORKSPACE_NOT_TRUSTED",
                    message="Workspace mutation requested while workspace trust is not established.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_hidden_authority,
                    blocking=True,
                )
            )
        if mutates and ctx.policy.require_healthy_workspace_for_mutation and not ctx.workspace.healthy:
            issues.append(
                GovernanceIssue(
                    code="WORKSPACE_NOT_HEALTHY",
                    message="Workspace mutation requested while workspace health is degraded or unhealthy.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=True,
                )
            )
        if mutates and not ctx.workspace.mutable:
            issues.append(
                GovernanceIssue(
                    code="WORKSPACE_NOT_MUTABLE",
                    message="Workspace action requests mutation but workspace is not currently mutable.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=True,
                )
            )
        return issues

    def _check_environment(self) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []

        if ctx.action.kind is ActionKind.apply and ctx.policy.require_non_drifted_environment_for_apply and ctx.environment.drifted:
            issues.append(
                GovernanceIssue(
                    code="ENVIRONMENT_DRIFTED",
                    message="Apply requested under a drifted environment fingerprint.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=True,
                )
            )
        if ctx.environment.readonly_media and ctx.action.mutates_workspace:
            issues.append(
                GovernanceIssue(
                    code="READONLY_MEDIA",
                    message="Workspace mutation requested on read-only media.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=True,
                )
            )
        if ctx.environment.degraded and ctx.action.kind in {ActionKind.apply, ActionKind.rollback, ActionKind.run_shell}:
            issues.append(
                GovernanceIssue(
                    code="ENVIRONMENT_DEGRADED",
                    message="High-consequence action requested while runtime environment is degraded.",
                    level=GovernanceLevel.warn,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=ctx.action.kind in {ActionKind.apply, ActionKind.rollback},
                )
            )
        return issues

    def _check_evidence(
        self,
        verify_assessment: VerifyAssessment | None,
        ledger_assessment: LedgerAssessment | None,
        replay_outcome: ReplayOutcome | None,
    ) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []

        if ctx.policy.require_visible_evidence_for_claims and ctx.action.requires_fresh_evidence and not ctx.visibility.evidence_visible:
            issues.append(
                GovernanceIssue(
                    code="EVIDENCE_NOT_VISIBLE",
                    message="Action depends on evidence, but evidence surface is hidden.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_unverifiable_claim,
                    blocking=True,
                )
            )

        if ctx.action.requires_verify_ready:
            if verify_assessment is None:
                issues.append(
                    GovernanceIssue(
                        code="VERIFY_ASSESSMENT_MISSING",
                        message="Action requires verification evidence, but no verify payload was provided.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_unverifiable_claim,
                        blocking=True,
                    )
                )
            else:
                if not verify_assessment.ok:
                    issues.append(
                        GovernanceIssue(
                            code="VERIFY_NOT_AUTHORITATIVE",
                            message="Verification result is not authoritative enough for the requested action.",
                            level=GovernanceLevel.block,
                            invariant=GovernanceInvariant.no_unverifiable_claim,
                            blocking=True,
                        )
                    )
                if ctx.action.requires_fresh_evidence and not verify_assessment.fresh_evidence:
                    issues.append(
                        GovernanceIssue(
                            code="VERIFY_EVIDENCE_STALE",
                            message="Verification evidence is stale for the requested action.",
                            level=GovernanceLevel.block,
                            invariant=GovernanceInvariant.no_unverifiable_claim,
                            blocking=True,
                        )
                    )

        if ctx.action.requires_replayable_lineage:
            if ledger_assessment is None:
                issues.append(
                    GovernanceIssue(
                        code="LEDGER_ASSESSMENT_MISSING",
                        message="Action requires ledger lineage, but no ledger payload was provided.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_unverifiable_claim,
                        blocking=True,
                    )
                )
            elif not ledger_assessment.ok or ledger_assessment.replayable is False:
                issues.append(
                    GovernanceIssue(
                        code="LEDGER_NOT_REPLAYABLE",
                        message="Ledger lineage is not authoritative enough for replay-sensitive action.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_unverifiable_claim,
                        blocking=True,
                    )
                )

        if ctx.action.kind is ActionKind.replay:
            if replay_outcome is None:
                issues.append(
                    GovernanceIssue(
                        code="REPLAY_OUTCOME_MISSING",
                        message="Replay action requested without replay execution payload.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_unverifiable_claim,
                        blocking=True,
                    )
                )
            elif replay_outcome.ok is False:
                issues.append(
                    GovernanceIssue(
                        code="REPLAY_NOT_SUCCESSFUL",
                        message="Replay outcome is not successful enough to support the requested claim.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_unverifiable_claim,
                        blocking=True,
                    )
                )

        return issues

    def _check_no_ambiguous_state(
        self,
        verify_assessment: VerifyAssessment | None,
        ledger_assessment: LedgerAssessment | None,
        replay_outcome: ReplayOutcome | None,
    ) -> list[GovernanceIssue]:
        ctx = self.context
        issues: list[GovernanceIssue] = []

        if ctx.action.kind is ActionKind.apply:
            if verify_assessment is not None and verify_assessment.apply_impact.value != "ready":
                issues.append(
                    GovernanceIssue(
                        code="VERIFY_APPLY_IMPACT_NOT_READY",
                        message="Apply requested while verify apply impact is not ready.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_ambiguous_state,
                        blocking=True,
                    )
                )
            if ledger_assessment is not None and ledger_assessment.apply_impact.value != "ready":
                issues.append(
                    GovernanceIssue(
                        code="LEDGER_APPLY_IMPACT_NOT_READY",
                        message="Apply requested while ledger apply impact is not ready.",
                        level=GovernanceLevel.block,
                        invariant=GovernanceInvariant.no_ambiguous_state,
                        blocking=True,
                    )
                )

        if ctx.action.kind is ActionKind.run_shell and ctx.action.requires_shell_ready:
            if ctx.environment.degraded:
                issues.append(
                    GovernanceIssue(
                        code="SHELL_ENVIRONMENT_NOT_READY",
                        message="Shell execution requested while runtime shell environment is degraded.",
                        level=GovernanceLevel.warn,
                        invariant=GovernanceInvariant.no_ambiguous_state,
                        blocking=True,
                    )
                )

        if replay_outcome is not None and replay_outcome.status.value == "rolled-back" and ctx.action.kind not in {ActionKind.rollback, ActionKind.replay}:
            issues.append(
                GovernanceIssue(
                    code="ROLLED_BACK_OUTCOME_MISMATCH",
                    message="Replay outcome reports rollback while requested action is not rollback-oriented.",
                    level=GovernanceLevel.block,
                    invariant=GovernanceInvariant.no_ambiguous_state,
                    blocking=True,
                )
            )
        return issues

    @staticmethod
    def _derive_level(issues: Sequence[GovernanceIssue]) -> GovernanceLevel:
        if any(issue.blocking for issue in issues):
            return GovernanceLevel.block
        if issues:
            return GovernanceLevel.warn
        return GovernanceLevel.allow

    def _build_summary(
        self,
        issues: Sequence[GovernanceIssue],
        level: GovernanceLevel,
        allowed: bool,
        verify_assessment: VerifyAssessment | None,
        ledger_assessment: LedgerAssessment | None,
        replay_outcome: ReplayOutcome | None,
    ) -> dict[str, Any]:
        return {
            "action": self.context.action.kind.value,
            "subject_id": self.context.action.subject_id,
            "severity": self.context.action.severity.value,
            "allowed": allowed,
            "level": level.value,
            "issue_count": len(issues),
            "blocking_issue_count": sum(1 for issue in issues if issue.blocking),
            "visibility": self.context.visibility.model_dump(mode="python"),
            "confirmation": self.context.confirmation.model_dump(mode="python"),
            "workspace": self.context.workspace.model_dump(mode="python"),
            "environment": self.context.environment.model_dump(mode="python"),
            "verify_ok": verify_assessment.ok if verify_assessment else None,
            "ledger_ok": ledger_assessment.ok if ledger_assessment else None,
            "replay_ok": replay_outcome.ok if replay_outcome else None,
        }


def parse_governance_context(raw: Mapping[str, Any] | GovernanceContext) -> GovernanceContext:
    try:
        return raw if isinstance(raw, GovernanceContext) else GovernanceContext.model_validate(raw)
    except ValidationError as exc:
        raise GovernanceValidationError(f"Invalid governance context: {exc}") from exc


def decide_governance(raw: Mapping[str, Any] | GovernanceContext) -> GovernanceDecision:
    context = parse_governance_context(raw)
    analyzer = GovernanceAnalyzer(context)
    return analyzer.decide()


def summarize_governance_decision(decision: GovernanceDecision) -> dict[str, Any]:
    severity_counts = {
        level.value: 0
        for level in GovernanceLevel
    }
    for issue in decision.issues:
        severity_counts[issue.level.value] += 1

    return {
        "action": decision.action.value,
        "allowed": decision.allowed,
        "level": decision.level.value,
        "issue_count": len(decision.issues),
        "blocking_issue_count": decision.blocking_issue_count,
        "issue_level_counts": severity_counts,
    }


def assert_governance_allows(raw: Mapping[str, Any] | GovernanceContext) -> GovernanceDecision:
    decision = decide_governance(raw)
    if not decision.allowed:
        first = decision.issues[0] if decision.issues else None
        message = first.message if first else f"Action {decision.action.value!r} was blocked by governance."
        raise GovernanceDecisionError(message)
    return decision


def render_governance_report(decision: GovernanceDecision) -> str:
    lines: list[str] = []
    lines.append(f"Governance Decision: {decision.action.value}")
    lines.append(f"Allowed: {decision.allowed}")
    lines.append(f"Level: {decision.level.value}")
    lines.append(f"Blocking issue count: {decision.blocking_issue_count}")
    lines.append(f"Invariants checked: {', '.join(inv.value for inv in decision.invariants_checked)}")

    if decision.issues:
        lines.append("Issues:")
        for issue in decision.issues:
            blocking = " BLOCKING" if issue.blocking else ""
            lines.append(
                f"  - [{issue.level.value.upper()}{blocking}] {issue.code} "
                f"<{issue.invariant.value}>: {issue.message}"
            )
    else:
        lines.append("Issues: none")

    if decision.verify_assessment is not None:
        lines.append("Verify assessment:")
        lines.append(f"  - status: {decision.verify_assessment.status.value}")
        lines.append(f"  - apply_impact: {decision.verify_assessment.apply_impact.value}")
        lines.append(f"  - fresh_evidence: {decision.verify_assessment.fresh_evidence}")
        lines.append(f"  - ok: {decision.verify_assessment.ok}")

    if decision.ledger_assessment is not None:
        lines.append("Ledger assessment:")
        lines.append(f"  - continuity: {decision.ledger_assessment.continuity.value}")
        lines.append(f"  - health_level: {decision.ledger_assessment.health_level.value}")
        lines.append(f"  - replayable: {decision.ledger_assessment.replayable}")
        lines.append(f"  - ok: {decision.ledger_assessment.ok}")

    if decision.replay_outcome is not None:
        lines.append("Replay outcome:")
        lines.append(f"  - status: {decision.replay_outcome.status.value}")
        lines.append(f"  - determinism: {decision.replay_outcome.determinism.value}")
        lines.append(f"  - environment_match: {decision.replay_outcome.environment_match.value}")
        lines.append(f"  - ok: {decision.replay_outcome.ok}")

    lines.append("Summary:")
    for key, value in decision.summary.items():
        lines.append(f"  - {key}: {value}")
    return "\n".join(lines)
