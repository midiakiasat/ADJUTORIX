"""
ADJUTORIX AGENT — CORE / FAILURE_MODEL

Unified, normalized failure semantics across the entire system.

Purpose:
- Eliminate ambiguity in failure interpretation
- Provide machine-decidable failure categories
- Enable deterministic policy, retry, rollback decisions

Hard invariants:
- Every failure MUST map to a known FailureKind
- No raw exception leakage beyond this layer
- Classification must be stable (same input → same classification)
- Failure must carry enough context for replay + audit
"""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Optional, Dict, Any

import traceback


# ---------------------------------------------------------------------------
# FAILURE KIND
# ---------------------------------------------------------------------------


class FailureKind(str, Enum):
    # SYSTEM LEVEL
    INTERNAL_ERROR = "internal_error"
    INVARIANT_VIOLATION = "invariant_violation"

    # SNAPSHOT / STATE
    STALE_SNAPSHOT = "stale_snapshot"
    SNAPSHOT_MISSING = "snapshot_missing"
    SNAPSHOT_HASH_MISMATCH = "snapshot_hash_mismatch"

    # PATCH / MUTATION
    PATCH_CONFLICT = "patch_conflict"
    PATCH_INVALID = "patch_invalid"
    PATCH_BASE_MISMATCH = "patch_base_mismatch"

    # EXECUTION
    TIMEOUT = "timeout"
    PROCESS_ERROR = "process_error"
    RESOURCE_LIMIT = "resource_limit"

    # VERIFY
    STATIC_FAILURE = "static_failure"
    BUILD_FAILURE = "build_failure"
    TEST_FAILURE = "test_failure"

    # GOVERNANCE
    POLICY_VIOLATION = "policy_violation"
    COMMAND_BLOCKED = "command_blocked"
    SECRET_LEAK = "secret_leak"

    # UNKNOWN (must be last fallback)
    UNKNOWN = "unknown"


# ---------------------------------------------------------------------------
# FAILURE OBJECT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Failure:
    kind: FailureKind
    message: str
    origin: str

    # optional structured context
    data: Dict[str, Any] = field(default_factory=dict)

    # optional exception trace
    stack: Optional[str] = None


# ---------------------------------------------------------------------------
# CLASSIFIER
# ---------------------------------------------------------------------------


class FailureClassifier:
    """
    Deterministic mapping from raw signals → FailureKind
    """

    def classify_exception(self, exc: Exception) -> Failure:
        msg = str(exc)
        stack = traceback.format_exc()

        # ordered rules (first match wins)
        if "stale_snapshot" in msg:
            return self._build(FailureKind.STALE_SNAPSHOT, msg, "snapshot_guard", stack)

        if "snapshot_missing" in msg:
            return self._build(FailureKind.SNAPSHOT_MISSING, msg, "snapshot_guard", stack)

        if "snapshot_hash_mismatch" in msg:
            return self._build(FailureKind.SNAPSHOT_HASH_MISMATCH, msg, "snapshot_guard", stack)

        if "patch_base_mismatch" in msg:
            return self._build(FailureKind.PATCH_BASE_MISMATCH, msg, "snapshot_guard", stack)

        if "rebase_required" in msg:
            return self._build(FailureKind.PATCH_CONFLICT, msg, "snapshot_guard", stack)

        if "policy" in msg:
            return self._build(FailureKind.POLICY_VIOLATION, msg, "governance", stack)

        if "timeout" in msg:
            return self._build(FailureKind.TIMEOUT, msg, "execution", stack)

        return self._build(FailureKind.INTERNAL_ERROR, msg, "unknown", stack)

    def classify_stage(
        self,
        stage_name: str,
        exit_code: Optional[int],
        timed_out: Optional[bool],
        error: Optional[str],
    ) -> Optional[Failure]:

        if timed_out:
            return self._build(FailureKind.TIMEOUT, "execution timeout", stage_name)

        if exit_code is not None and exit_code != 0:
            if "lint" in stage_name.lower():
                return self._build(FailureKind.STATIC_FAILURE, "lint failed", stage_name)

            if "build" in stage_name.lower():
                return self._build(FailureKind.BUILD_FAILURE, "build failed", stage_name)

            if "test" in stage_name.lower():
                return self._build(FailureKind.TEST_FAILURE, "tests failed", stage_name)

            return self._build(FailureKind.PROCESS_ERROR, f"exit_code={exit_code}", stage_name)

        if error:
            return self._build(FailureKind.INTERNAL_ERROR, error, stage_name)

        return None

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _build(
        self,
        kind: FailureKind,
        message: str,
        origin: str,
        stack: Optional[str] = None,
        data: Optional[Dict[str, Any]] = None,
    ) -> Failure:
        return Failure(
            kind=kind,
            message=message,
            origin=origin,
            stack=stack,
            data=data or {},
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


_classifier_singleton: Optional[FailureClassifier] = None


def get_failure_classifier() -> FailureClassifier:
    global _classifier_singleton
    if _classifier_singleton is None:
        _classifier_singleton = FailureClassifier()
    return _classifier_singleton


def classify_exception(exc: Exception) -> Failure:
    return get_failure_classifier().classify_exception(exc)


def classify_stage_failure(
    stage_name: str,
    exit_code: Optional[int],
    timed_out: Optional[bool],
    error: Optional[str],
) -> Optional[Failure]:
    return get_failure_classifier().classify_stage(stage_name, exit_code, timed_out, error)
