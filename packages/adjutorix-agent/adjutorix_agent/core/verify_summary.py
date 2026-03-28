"""
ADJUTORIX AGENT — CORE / VERIFY_SUMMARY

High-signal summarization layer over VerificationArtifacts.

Purpose:
- Collapse full verification artifacts into decision-grade summary
- Provide fast path for UI, CLI, governance decisions
- Preserve determinism (no lossy ambiguity for critical signals)

Hard invariants:
- Summary must be derivable 1:1 from VerificationArtifacts
- No hidden heuristics affecting correctness
- All decisions must be explainable via included fields

Design:
- Multi-level summary (stage-level, global, failure-root)
- Explicit failure classification
- Stability across runs (same input → same summary)
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Tuple, Optional, Dict

from adjutorix_agent.core.verification_artifacts import (
    VerificationArtifacts,
    StageArtifact,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class StageSummary:
    name: str
    success: bool
    classification: str
    duration_ms: int
    failure_reason: Optional[str]


@dataclass(frozen=True)
class VerifySummary:
    success: bool
    total_duration_ms: int

    stage_count: int
    failed_stage: Optional[str]

    failure_classification: Optional[str]
    failure_reason: Optional[str]

    stages: Tuple[StageSummary, ...]


# ---------------------------------------------------------------------------
# CLASSIFICATION
# ---------------------------------------------------------------------------


def _classify_stage(stage: StageArtifact) -> str:
    if stage.success:
        return "ok"

    if stage.timed_out:
        return "timeout"

    if stage.exit_code is not None:
        if stage.exit_code != 0:
            return "process_error"

    if stage.error:
        if "lint" in stage.name.lower():
            return "static_failure"
        if "build" in stage.name.lower():
            return "build_failure"
        if "test" in stage.name.lower():
            return "test_failure"
        return "runtime_exception"

    return "unknown_failure"


# ---------------------------------------------------------------------------
# REDUCTION
# ---------------------------------------------------------------------------


def _summarize_stage(stage: StageArtifact) -> StageSummary:
    classification = _classify_stage(stage)

    return StageSummary(
        name=stage.name,
        success=stage.success,
        classification=classification,
        duration_ms=stage.duration_ms,
        failure_reason=stage.error if not stage.success else None,
    )


# ---------------------------------------------------------------------------
# MAIN
# ---------------------------------------------------------------------------


def build_verify_summary(art: VerificationArtifacts) -> VerifySummary:
    stage_summaries = tuple(_summarize_stage(s) for s in art.stages)

    failed_stage = None
    failure_classification = None
    failure_reason = None

    for s in stage_summaries:
        if not s.success:
            failed_stage = s.name
            failure_classification = s.classification
            failure_reason = s.failure_reason
            break

    return VerifySummary(
        success=art.success,
        total_duration_ms=art.total_duration_ms,
        stage_count=len(stage_summaries),
        failed_stage=failed_stage,
        failure_classification=failure_classification,
        failure_reason=failure_reason,
        stages=stage_summaries,
    )


# ---------------------------------------------------------------------------
# COMPARISON (REGRESSION DETECTION)
# ---------------------------------------------------------------------------


def compare_summaries(a: VerifySummary, b: VerifySummary) -> Dict[str, object]:
    """
    Detect meaningful differences between two summaries.
    """

    return {
        "success_changed": a.success != b.success,
        "failed_stage_changed": a.failed_stage != b.failed_stage,
        "failure_class_changed": a.failure_classification != b.failure_classification,
        "duration_delta_ms": b.total_duration_ms - a.total_duration_ms,
    }
