"""
ADJUTORIX AGENT — CORE / VERIFY_PIPELINE

Deterministic, staged verification pipeline executed in isolated workspace.

Responsibilities:
- Orchestrate full verification lifecycle
- Enforce strict stage ordering
- Capture artifacts, logs, and structured outcomes
- Produce canonical VerifyResult

Hard invariants:
- No mutation of canonical workspace
- All execution happens in isolated_workspace
- Every stage must emit explicit result
- Failure is terminal and fully recorded
- No implicit success

Stages:
1. PREPARE
2. APPLY_PATCH
3. STATIC_CHECK
4. BUILD
5. TEST
6. CUSTOM (optional hooks)
7. FINALIZE
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Dict, Callable, Optional, Tuple

import time

from adjutorix_agent.core.isolated_workspace import (
    execute_in_isolated_workspace,
    SnapshotReader,
    ExecRequest,
    ExecResult,
    DiffOp,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifyStageResult:
    name: str
    success: bool
    exec_result: Optional[ExecResult]
    error: Optional[str]
    duration_ms: int


@dataclass(frozen=True)
class VerifyResult:
    success: bool
    stages: Tuple[VerifyStageResult, ...]
    total_duration_ms: int


# ---------------------------------------------------------------------------
# PIPELINE
# ---------------------------------------------------------------------------


class VerifyPipeline:
    """
    Strict stage executor.
    """

    def __init__(self, reader: SnapshotReader) -> None:
        self._reader = reader
        self._custom_stages: List[Tuple[str, ExecRequest]] = []

    # ------------------------------------------------------------------
    # CONFIG
    # ------------------------------------------------------------------

    def add_custom_stage(self, name: str, req: ExecRequest) -> None:
        self._custom_stages.append((name, req))

    # ------------------------------------------------------------------
    # EXECUTION
    # ------------------------------------------------------------------

    def run(
        self,
        snapshot_id: str,
        ops: Tuple[DiffOp, ...],
    ) -> VerifyResult:
        stages: List[VerifyStageResult] = []
        start_total = time.time()

        # stage definitions
        base_stages: List[Tuple[str, Optional[ExecRequest]]] = [
            ("PREPARE", None),
            ("APPLY_PATCH", None),
            ("STATIC_CHECK", ExecRequest(cmd=["npm", "run", "lint"])),
            ("BUILD", ExecRequest(cmd=["npm", "run", "build"])),
            ("TEST", ExecRequest(cmd=["npm", "test"])),
        ]

        # append custom
        for name, req in self._custom_stages:
            base_stages.append((name, req))

        for name, req in base_stages:
            stage_start = time.time()

            try:
                if name == "PREPARE":
                    result = None

                elif name == "APPLY_PATCH":
                    # apply only (no command)
                    result = execute_in_isolated_workspace(
                        self._reader,
                        snapshot_id,
                        ops,
                        ExecRequest(cmd=["true"]),
                    )

                else:
                    result = execute_in_isolated_workspace(
                        self._reader,
                        snapshot_id,
                        ops,
                        req,
                    )

                duration = int((time.time() - stage_start) * 1000)

                success = True
                error = None

                if result and result.exit_code != 0:
                    success = False
                    error = f"non_zero_exit: {result.exit_code}"

                stages.append(
                    VerifyStageResult(
                        name=name,
                        success=success,
                        exec_result=result,
                        error=error,
                        duration_ms=duration,
                    )
                )

                if not success:
                    return VerifyResult(
                        success=False,
                        stages=tuple(stages),
                        total_duration_ms=int((time.time() - start_total) * 1000),
                    )

            except Exception as e:
                duration = int((time.time() - stage_start) * 1000)

                stages.append(
                    VerifyStageResult(
                        name=name,
                        success=False,
                        exec_result=None,
                        error=str(e),
                        duration_ms=duration,
                    )
                )

                return VerifyResult(
                    success=False,
                    stages=tuple(stages),
                    total_duration_ms=int((time.time() - start_total) * 1000),
                )

        return VerifyResult(
            success=True,
            stages=tuple(stages),
            total_duration_ms=int((time.time() - start_total) * 1000),
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def run_verify_pipeline(
    reader: SnapshotReader,
    snapshot_id: str,
    ops: Tuple[DiffOp, ...],
) -> VerifyResult:
    pipeline = VerifyPipeline(reader)
    return pipeline.run(snapshot_id, ops)
