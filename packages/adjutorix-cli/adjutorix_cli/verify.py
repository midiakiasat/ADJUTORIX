from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable, Mapping, Sequence

from pydantic import BaseModel, ConfigDict, Field, ValidationError, model_validator


class VerifyError(Exception):
    """Base verification error for ADJUTORIX CLI verification orchestration."""


class VerifyValidationError(VerifyError):
    """Raised when verify inputs or result contracts are malformed."""


class VerifyExecutionError(VerifyError):
    """Raised when verification cannot be executed or summarized coherently."""


class VerifyStatus(str, Enum):
    queued = "queued"
    running = "running"
    passed = "passed"
    warning = "warning"
    failed = "failed"
    blocked = "blocked"
    unknown = "unknown"


class CheckStatus(str, Enum):
    queued = "queued"
    running = "running"
    passed = "passed"
    warning = "warning"
    failed = "failed"
    skipped = "skipped"
    blocked = "blocked"
    unknown = "unknown"


class ApplyImpact(str, Enum):
    ready = "ready"
    pending = "pending"
    blocked = "blocked"
    unknown = "unknown"


class VerifySeverity(str, Enum):
    info = "info"
    warning = "warning"
    error = "error"
    fatal = "fatal"


class EvidenceKind(str, Enum):
    replay = "replay"
    policy = "policy"
    diagnostic = "diagnostic"
    command = "command"
    artifact = "artifact"
    summary = "summary"
    unknown = "unknown"


class VerifyCheckKind(str, Enum):
    replay = "replay"
    policy = "policy"
    diagnostics = "diagnostics"
    tests = "tests"
    shell = "shell"
    ledger = "ledger"
    workspace = "workspace"
    unknown = "unknown"


class VerifyEvidence(BaseModel):
    model_config = ConfigDict(extra="forbid")

    evidence_id: str = Field(min_length=1, alias="id")
    title: str = Field(min_length=1)
    kind: EvidenceKind = EvidenceKind.unknown
    summary: str | None = None
    payload: dict[str, Any] = Field(default_factory=dict)
    fresh: bool = True

    @property
    def id(self) -> str:
        return self.evidence_id


class VerifyCheck(BaseModel):
    model_config = ConfigDict(extra="forbid")

    check_id: str = Field(min_length=1, alias="id")
    title: str = Field(min_length=1)
    kind: VerifyCheckKind = VerifyCheckKind.unknown
    status: CheckStatus = CheckStatus.unknown
    severity: VerifySeverity = VerifySeverity.info
    blocking: bool = False
    summary: str | None = None
    details: list[str] = Field(default_factory=list)
    evidence: list[VerifyEvidence] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    @property
    def id(self) -> str:
        return self.check_id


class VerifySummary(BaseModel):
    model_config = ConfigDict(extra="forbid")

    total_checks: int = Field(alias="totalChecks", ge=0)
    passed_checks: int = Field(alias="passedChecks", ge=0)
    warning_checks: int = Field(alias="warningChecks", ge=0)
    failed_checks: int = Field(alias="failedChecks", ge=0)
    replay_checks: int = Field(alias="replayChecks", ge=0)
    blocked_checks: int = Field(default=0, alias="blockedChecks", ge=0)


class VerifyResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    verify_id: str = Field(min_length=1, alias="verifyId")
    patch_id: str | None = Field(default=None, alias="patchId")
    status: VerifyStatus = VerifyStatus.unknown
    phase: str | None = None
    replayable: bool | None = None
    apply_readiness_impact: ApplyImpact = Field(default=ApplyImpact.unknown, alias="applyReadinessImpact")
    checks: list[VerifyCheck] = Field(default_factory=list)
    artifacts: list[VerifyEvidence] = Field(default_factory=list)
    summary: VerifySummary
    health: dict[str, Any] = Field(default_factory=dict)
    recorded_environment_fingerprint: str | None = Field(default=None, alias="recordedEnvironmentFingerprint")
    current_environment_fingerprint: str | None = Field(default=None, alias="currentEnvironmentFingerprint")

    @model_validator(mode="after")
    def validate_summary_counts(self) -> "VerifyResult":
        total = self.summary.total_checks
        counted = (
            self.summary.passed_checks
            + self.summary.warning_checks
            + self.summary.failed_checks
            + self.summary.blocked_checks
        )
        if counted > total:
            raise ValueError(
                "Verify summary counts are contradictory: passed+warning+failed+blocked exceeds totalChecks"
            )
        if total < len(self.checks):
            raise ValueError("Verify summary totalChecks is smaller than the explicit checks payload")
        return self


@dataclass(slots=True)
class VerifyIssue:
    code: str
    message: str
    severity: VerifySeverity
    blocking: bool = False
    check_id: str | None = None


@dataclass(slots=True)
class VerifyAssessment:
    verify_id: str
    patch_id: str | None
    status: VerifyStatus
    apply_impact: ApplyImpact
    replayable: bool | None
    fresh_evidence: bool
    blocking_issue_count: int
    issues: list[VerifyIssue]
    checks: list[VerifyCheck]
    artifacts: list[VerifyEvidence]
    summary: dict[str, Any]

    @property
    def ok(self) -> bool:
        return self.status in {VerifyStatus.passed, VerifyStatus.warning} and self.blocking_issue_count == 0

    def to_dict(self) -> dict[str, Any]:
        return {
            "verify_id": self.verify_id,
            "patch_id": self.patch_id,
            "status": self.status.value,
            "apply_impact": self.apply_impact.value,
            "replayable": self.replayable,
            "fresh_evidence": self.fresh_evidence,
            "blocking_issue_count": self.blocking_issue_count,
            "issues": [
                {
                    "code": issue.code,
                    "message": issue.message,
                    "severity": issue.severity.value,
                    "blocking": issue.blocking,
                    "check_id": issue.check_id,
                }
                for issue in self.issues
            ],
            "checks": [check.model_dump(by_alias=True) for check in self.checks],
            "artifacts": [artifact.model_dump(by_alias=True) for artifact in self.artifacts],
            "summary": dict(self.summary),
            "ok": self.ok,
        }


class VerifyExpectation(BaseModel):
    model_config = ConfigDict(extra="forbid")

    require_replayable: bool = True
    require_apply_ready: bool = True
    allow_warnings: bool = True
    require_fresh_evidence: bool = True
    require_environment_match: bool = False
    required_check_kinds: list[VerifyCheckKind] = Field(default_factory=list)


class VerifyAnalyzer:
    def __init__(self, result: VerifyResult) -> None:
        self.result = result

    def assess(self, expectation: VerifyExpectation | None = None) -> VerifyAssessment:
        exp = expectation or VerifyExpectation()
        issues: list[VerifyIssue] = []

        for issue in self._assess_status(exp):
            issues.append(issue)
        for issue in self._assess_checks(exp):
            issues.append(issue)
        for issue in self._assess_evidence(exp):
            issues.append(issue)
        for issue in self._assess_environment(exp):
            issues.append(issue)
        for issue in self._assess_summary_consistency():
            issues.append(issue)

        blocking_issue_count = sum(1 for issue in issues if issue.blocking)
        fresh_evidence = all(item.fresh for item in self._all_evidence())

        summary = {
            "verify_id": self.result.verify_id,
            "patch_id": self.result.patch_id,
            "status": self.result.status.value,
            "phase": self.result.phase,
            "apply_impact": self.result.apply_readiness_impact.value,
            "replayable": self.result.replayable,
            "fresh_evidence": fresh_evidence,
            "blocking_issue_count": blocking_issue_count,
            "total_issue_count": len(issues),
            "total_checks": self.result.summary.total_checks,
            "passed_checks": self.result.summary.passed_checks,
            "warning_checks": self.result.summary.warning_checks,
            "failed_checks": self.result.summary.failed_checks,
            "blocked_checks": self.result.summary.blocked_checks,
            "artifact_count": len(self.result.artifacts),
        }

        return VerifyAssessment(
            verify_id=self.result.verify_id,
            patch_id=self.result.patch_id,
            status=self.result.status,
            apply_impact=self.result.apply_readiness_impact,
            replayable=self.result.replayable,
            fresh_evidence=fresh_evidence,
            blocking_issue_count=blocking_issue_count,
            issues=issues,
            checks=list(self.result.checks),
            artifacts=list(self.result.artifacts),
            summary=summary,
        )

    def _assess_status(self, expectation: VerifyExpectation) -> list[VerifyIssue]:
        issues: list[VerifyIssue] = []
        status = self.result.status

        if status in {VerifyStatus.failed, VerifyStatus.blocked}:
            issues.append(
                VerifyIssue(
                    code="VERIFY_NOT_PASSED",
                    message=f"Verification ended in status={status.value!r}.",
                    severity=VerifySeverity.fatal,
                    blocking=True,
                )
            )

        if status is VerifyStatus.warning and not expectation.allow_warnings:
            issues.append(
                VerifyIssue(
                    code="VERIFY_WARNINGS_NOT_ALLOWED",
                    message="Verification completed with warnings but warnings are not allowed by expectation.",
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )

        if expectation.require_replayable and self.result.replayable is False:
            issues.append(
                VerifyIssue(
                    code="VERIFY_NOT_REPLAYABLE",
                    message="Verification result is explicitly non-replayable.",
                    severity=VerifySeverity.fatal,
                    blocking=True,
                )
            )

        if expectation.require_apply_ready and self.result.apply_readiness_impact is not ApplyImpact.ready:
            issues.append(
                VerifyIssue(
                    code="APPLY_IMPACT_NOT_READY",
                    message=(
                        "Verification does not authorize apply readiness: "
                        f"applyReadinessImpact={self.result.apply_readiness_impact.value!r}."
                    ),
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )
        return issues

    def _assess_checks(self, expectation: VerifyExpectation) -> list[VerifyIssue]:
        issues: list[VerifyIssue] = []
        present_kinds = {check.kind for check in self.result.checks}
        for required_kind in expectation.required_check_kinds:
            if required_kind not in present_kinds:
                issues.append(
                    VerifyIssue(
                        code="REQUIRED_CHECK_KIND_MISSING",
                        message=f"Required check kind {required_kind.value!r} is absent from verification payload.",
                        severity=VerifySeverity.error,
                        blocking=True,
                    )
                )

        for check in self.result.checks:
            if check.status in {CheckStatus.failed, CheckStatus.blocked}:
                issues.append(
                    VerifyIssue(
                        code="CHECK_FAILED",
                        message=f"Check {check.id!r} ended in status={check.status.value!r}.",
                        severity=VerifySeverity.fatal if check.blocking else VerifySeverity.error,
                        blocking=check.blocking or check.status is CheckStatus.blocked,
                        check_id=check.id,
                    )
                )
            elif check.status is CheckStatus.warning and check.blocking and not expectation.allow_warnings:
                issues.append(
                    VerifyIssue(
                        code="BLOCKING_WARNING_CHECK",
                        message=f"Check {check.id!r} produced a blocking warning.",
                        severity=VerifySeverity.error,
                        blocking=True,
                        check_id=check.id,
                    )
                )

            if check.kind is VerifyCheckKind.replay and self.result.replayable is False and check.status is CheckStatus.passed:
                issues.append(
                    VerifyIssue(
                        code="REPLAY_CHECK_RESULT_CONTRADICTION",
                        message=(
                            f"Replay check {check.id!r} passed, but overall verify result is non-replayable."
                        ),
                        severity=VerifySeverity.error,
                        blocking=True,
                        check_id=check.id,
                    )
                )
        return issues

    def _assess_evidence(self, expectation: VerifyExpectation) -> list[VerifyIssue]:
        issues: list[VerifyIssue] = []
        evidence = list(self._all_evidence())
        if expectation.require_fresh_evidence:
            stale = [item for item in evidence if not item.fresh]
            if stale:
                issues.append(
                    VerifyIssue(
                        code="STALE_VERIFY_EVIDENCE",
                        message=f"{len(stale)} evidence item(s) are stale.",
                        severity=VerifySeverity.error,
                        blocking=True,
                    )
                )

        if self.result.status in {VerifyStatus.passed, VerifyStatus.warning} and not evidence:
            issues.append(
                VerifyIssue(
                    code="EVIDENCE_MISSING",
                    message="Verification reports completion but carries no inspectable evidence.",
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )
        return issues

    def _assess_environment(self, expectation: VerifyExpectation) -> list[VerifyIssue]:
        issues: list[VerifyIssue] = []
        recorded = self.result.recorded_environment_fingerprint
        current = self.result.current_environment_fingerprint
        if expectation.require_environment_match and recorded and current and recorded != current:
            issues.append(
                VerifyIssue(
                    code="ENVIRONMENT_FINGERPRINT_MISMATCH",
                    message="Recorded and current environment fingerprints differ.",
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )
        return issues

    def _assess_summary_consistency(self) -> list[VerifyIssue]:
        issues: list[VerifyIssue] = []
        counts = self._count_checks(self.result.checks)

        if self.result.summary.passed_checks < counts[CheckStatus.passed]:
            issues.append(
                VerifyIssue(
                    code="SUMMARY_PASSED_COUNT_UNDERSTATED",
                    message="Verify summary understates explicitly passed checks.",
                    severity=VerifySeverity.warning,
                    blocking=False,
                )
            )
        if self.result.summary.warning_checks < counts[CheckStatus.warning]:
            issues.append(
                VerifyIssue(
                    code="SUMMARY_WARNING_COUNT_UNDERSTATED",
                    message="Verify summary understates explicit warning checks.",
                    severity=VerifySeverity.warning,
                    blocking=False,
                )
            )
        if self.result.summary.failed_checks < counts[CheckStatus.failed]:
            issues.append(
                VerifyIssue(
                    code="SUMMARY_FAILED_COUNT_UNDERSTATED",
                    message="Verify summary understates explicit failed checks.",
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )
        if self.result.summary.blocked_checks < counts[CheckStatus.blocked]:
            issues.append(
                VerifyIssue(
                    code="SUMMARY_BLOCKED_COUNT_UNDERSTATED",
                    message="Verify summary understates explicit blocked checks.",
                    severity=VerifySeverity.error,
                    blocking=True,
                )
            )

        replay_checks = sum(1 for check in self.result.checks if check.kind is VerifyCheckKind.replay)
        if self.result.summary.replay_checks < replay_checks:
            issues.append(
                VerifyIssue(
                    code="SUMMARY_REPLAY_COUNT_UNDERSTATED",
                    message="Verify summary understates explicit replay checks.",
                    severity=VerifySeverity.warning,
                    blocking=False,
                )
            )

        return issues

    def _all_evidence(self) -> Iterable[VerifyEvidence]:
        for artifact in self.result.artifacts:
            yield artifact
        for check in self.result.checks:
            for item in check.evidence:
                yield item

    @staticmethod
    def _count_checks(checks: Sequence[VerifyCheck]) -> dict[CheckStatus, int]:
        counts = {status: 0 for status in CheckStatus}
        for check in checks:
            counts[check.status] += 1
        return counts


def parse_verify_result(raw: Mapping[str, Any] | VerifyResult) -> VerifyResult:
    try:
        return raw if isinstance(raw, VerifyResult) else VerifyResult.model_validate(raw)
    except ValidationError as exc:
        raise VerifyValidationError(f"Invalid verify result payload: {exc}") from exc


def assess_verify_result(
    raw: Mapping[str, Any] | VerifyResult,
    *,
    expectation: Mapping[str, Any] | VerifyExpectation | None = None,
) -> VerifyAssessment:
    result = parse_verify_result(raw)
    analyzer = VerifyAnalyzer(result)

    parsed_expectation: VerifyExpectation | None = None
    if expectation is not None:
        try:
            parsed_expectation = (
                expectation
                if isinstance(expectation, VerifyExpectation)
                else VerifyExpectation.model_validate(expectation)
            )
        except ValidationError as exc:
            raise VerifyValidationError(f"Invalid verify expectation payload: {exc}") from exc

    return analyzer.assess(parsed_expectation)


def summarize_verify_assessment(assessment: VerifyAssessment) -> dict[str, Any]:
    severities = {
        severity: 0
        for severity in VerifySeverity
    }
    for issue in assessment.issues:
        severities[issue.severity] += 1

    return {
        "verify_id": assessment.verify_id,
        "patch_id": assessment.patch_id,
        "status": assessment.status.value,
        "apply_impact": assessment.apply_impact.value,
        "replayable": assessment.replayable,
        "fresh_evidence": assessment.fresh_evidence,
        "blocking_issue_count": assessment.blocking_issue_count,
        "issue_count": len(assessment.issues),
        "severity_counts": {severity.value: count for severity, count in severities.items()},
        "ok": assessment.ok,
    }


def render_verify_report(assessment: VerifyAssessment) -> str:
    lines: list[str] = []
    lines.append(f"Verify Report: {assessment.verify_id}")
    if assessment.patch_id:
        lines.append(f"Patch: {assessment.patch_id}")
    lines.append(f"Status: {assessment.status.value}")
    lines.append(f"Apply impact: {assessment.apply_impact.value}")
    lines.append(f"Replayable: {assessment.replayable}")
    lines.append(f"Fresh evidence: {assessment.fresh_evidence}")
    lines.append(f"Blocking issue count: {assessment.blocking_issue_count}")

    if assessment.issues:
        lines.append("Issues:")
        for issue in assessment.issues:
            suffix = f" check={issue.check_id}" if issue.check_id else ""
            block = " BLOCKING" if issue.blocking else ""
            lines.append(
                f"  - [{issue.severity.value.upper()}{block}] {issue.code}{suffix}: {issue.message}"
            )
    else:
        lines.append("Issues: none")

    if assessment.checks:
        lines.append("Checks:")
        for check in assessment.checks:
            lines.append(
                f"  - {check.id}: {check.title} kind={check.kind.value} status={check.status.value} "
                f"severity={check.severity.value} blocking={check.blocking}"
            )
            if check.summary:
                lines.append(f"      summary: {check.summary}")
            for detail in check.details:
                lines.append(f"      • {detail}")
    else:
        lines.append("Checks: none")

    if assessment.artifacts:
        lines.append("Artifacts:")
        for artifact in assessment.artifacts:
            freshness = "fresh" if artifact.fresh else "stale"
            lines.append(f"  - {artifact.id}: {artifact.title} kind={artifact.kind.value} {freshness}")
    else:
        lines.append("Artifacts: none")

    return "\n".join(lines)


def merge_verify_results(results: Sequence[Mapping[str, Any] | VerifyResult]) -> VerifyAssessment:
    parsed = [parse_verify_result(item) for item in results]
    if not parsed:
        raise VerifyValidationError("Cannot merge zero verify results.")

    first = parsed[0]
    if any(item.verify_id != first.verify_id for item in parsed):
        raise VerifyValidationError("Cannot merge verify results with different verify_id values.")

    merged_checks: dict[str, VerifyCheck] = {}
    merged_artifacts: dict[str, VerifyEvidence] = {}

    status_order = {
        VerifyStatus.unknown: 0,
        VerifyStatus.queued: 1,
        VerifyStatus.running: 2,
        VerifyStatus.warning: 3,
        VerifyStatus.passed: 4,
        VerifyStatus.blocked: 5,
        VerifyStatus.failed: 6,
    }
    apply_order = {
        ApplyImpact.unknown: 0,
        ApplyImpact.pending: 1,
        ApplyImpact.ready: 2,
        ApplyImpact.blocked: 3,
    }

    chosen_status = max((item.status for item in parsed), key=lambda s: status_order[s])
    chosen_apply = max((item.apply_readiness_impact for item in parsed), key=lambda a: apply_order[a])
    replayable = None if any(item.replayable is None for item in parsed) else all(bool(item.replayable) for item in parsed)

    for item in parsed:
        for check in item.checks:
            existing = merged_checks.get(check.id)
            if existing is None:
                merged_checks[check.id] = check
                continue
            if _check_status_rank(check.status) > _check_status_rank(existing.status):
                merged_checks[check.id] = check

        for artifact in item.artifacts:
            existing_artifact = merged_artifacts.get(artifact.id)
            if existing_artifact is None:
                merged_artifacts[artifact.id] = artifact
                continue
            if existing_artifact.fresh is False and artifact.fresh is True:
                merged_artifacts[artifact.id] = artifact

    summary = VerifySummary(
        totalChecks=len(merged_checks),
        passedChecks=sum(1 for check in merged_checks.values() if check.status is CheckStatus.passed),
        warningChecks=sum(1 for check in merged_checks.values() if check.status is CheckStatus.warning),
        failedChecks=sum(1 for check in merged_checks.values() if check.status is CheckStatus.failed),
        blockedChecks=sum(1 for check in merged_checks.values() if check.status is CheckStatus.blocked),
        replayChecks=sum(1 for check in merged_checks.values() if check.kind is VerifyCheckKind.replay),
    )

    merged = VerifyResult(
        verifyId=first.verify_id,
        patchId=first.patch_id,
        status=chosen_status,
        phase=first.phase,
        replayable=replayable,
        applyReadinessImpact=chosen_apply,
        checks=list(merged_checks.values()),
        artifacts=list(merged_artifacts.values()),
        summary=summary,
        health=first.health,
        recordedEnvironmentFingerprint=first.recorded_environment_fingerprint,
        currentEnvironmentFingerprint=first.current_environment_fingerprint,
    )
    return VerifyAnalyzer(merged).assess()


def _check_status_rank(status: CheckStatus) -> int:
    order = {
        CheckStatus.unknown: 0,
        CheckStatus.queued: 1,
        CheckStatus.running: 2,
        CheckStatus.skipped: 3,
        CheckStatus.passed: 4,
        CheckStatus.warning: 5,
        CheckStatus.blocked: 6,
        CheckStatus.failed: 7,
    }
    return order[status]
