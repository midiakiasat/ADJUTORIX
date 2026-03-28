"""
ADJUTORIX AGENT — CORE / VERIFY_RUNNER

High-level orchestration for verification execution with strict contracts.

Responsibilities:
- Bind Transaction → Patch → Snapshot → VerifyPipeline
- Enforce snapshot_guard before execution
- Attach idempotency and correlation ids
- Stream structured logs/events (in-memory channel)
- Normalize results into VerificationArtifacts

Hard invariants:
- No mutation of canonical workspace
- Verification runs ONLY via isolated_workspace
- SnapshotGuard must pass before any execution
- Results are fully serializable and replayable
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple, Iterable

import time
import uuid

from adjutorix_agent.core.verify_pipeline import VerifyPipeline, VerifyResult
from adjutorix_agent.core.snapshot_guard import (
    SnapshotGuard,
    PatchBase,
    WorkspaceState,
)
from adjutorix_agent.core.isolated_workspace import SnapshotReader, DiffOp, ExecRequest


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerificationRequest:
    tx_id: str
    snapshot_id: str
    snapshot_hash: str
    ops: Tuple[DiffOp, ...]
    workspace: WorkspaceState
    correlation_id: str = field(default_factory=lambda: str(uuid.uuid4()))


@dataclass(frozen=True)
class LogEvent:
    ts_ns: int
    level: str
    message: str
    data: Dict[str, object] = field(default_factory=dict)


@dataclass(frozen=True)
class VerificationArtifacts:
    tx_id: str
    correlation_id: str
    success: bool
    stage_count: int
    duration_ms: int
    stage_summaries: Tuple[Dict[str, object], ...]
    logs: Tuple[LogEvent, ...]


# ---------------------------------------------------------------------------
# LOGGER (in-memory)
# ---------------------------------------------------------------------------


class _Logger:
    def __init__(self) -> None:
        self._events: List[LogEvent] = []

    def emit(self, level: str, message: str, **data: object) -> None:
        self._events.append(
            LogEvent(
                ts_ns=int(time.time() * 1e9),
                level=level,
                message=message,
                data=data,
            )
        )

    def snapshot(self) -> Tuple[LogEvent, ...]:
        return tuple(self._events)


# ---------------------------------------------------------------------------
# RUNNER
# ---------------------------------------------------------------------------


class VerifyRunner:
    """
    Facade coordinating guard + pipeline + artifacts.
    """

    def __init__(self, reader: SnapshotReader, guard: Optional[SnapshotGuard] = None) -> None:
        self._reader = reader
        self._guard = guard or SnapshotGuard()

    # ------------------------------------------------------------------
    # EXECUTION
    # ------------------------------------------------------------------

    def run(self, req: VerificationRequest, *, custom_stages: Optional[List[Tuple[str, ExecRequest]]] = None) -> VerificationArtifacts:
        log = _Logger()
        t0 = time.time()

        log.emit("info", "verify.start", tx_id=req.tx_id, corr=req.correlation_id)

        # 1) GUARD
        patch_base = PatchBase(base_snapshot_id=req.snapshot_id, base_hash=req.snapshot_hash)
        try:
            log.emit("debug", "guard.check.start")
            self._guard.validate_full(patch_base, req.workspace, {req.snapshot_id: req.snapshot_hash})
            log.emit("debug", "guard.check.ok")
        except Exception as e:
            log.emit("error", "guard.check.fail", error=str(e))
            return VerificationArtifacts(
                tx_id=req.tx_id,
                correlation_id=req.correlation_id,
                success=False,
                stage_count=0,
                duration_ms=int((time.time() - t0) * 1000),
                stage_summaries=(),
                logs=log.snapshot(),
            )

        # 2) PIPELINE
        pipeline = VerifyPipeline(self._reader)
        if custom_stages:
            for name, stage in custom_stages:
                pipeline.add_custom_stage(name, stage)

        try:
            log.emit("info", "pipeline.run.start", ops=len(req.ops))
            result: VerifyResult = pipeline.run(req.snapshot_id, req.ops)
            log.emit("info", "pipeline.run.end", success=result.success)
        except Exception as e:
            log.emit("error", "pipeline.run.exception", error=str(e))
            return VerificationArtifacts(
                tx_id=req.tx_id,
                correlation_id=req.correlation_id,
                success=False,
                stage_count=0,
                duration_ms=int((time.time() - t0) * 1000),
                stage_summaries=(),
                logs=log.snapshot(),
            )

        # 3) NORMALIZE
        summaries: List[Dict[str, object]] = []
        for s in result.stages:
            summaries.append({
                "name": s.name,
                "success": s.success,
                "duration_ms": s.duration_ms,
                "error": s.error,
                "exit_code": (s.exec_result.exit_code if s.exec_result else None),
                "timed_out": (s.exec_result.timed_out if s.exec_result else None),
                "stdout_len": (len(s.exec_result.stdout) if s.exec_result else None),
                "stderr_len": (len(s.exec_result.stderr) if s.exec_result else None),
            })

        duration_ms = int((time.time() - t0) * 1000)

        log.emit("info", "verify.end", success=result.success, duration_ms=duration_ms)

        return VerificationArtifacts(
            tx_id=req.tx_id,
            correlation_id=req.correlation_id,
            success=result.success,
            stage_count=len(result.stages),
            duration_ms=duration_ms,
            stage_summaries=tuple(summaries),
            logs=log.snapshot(),
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def run_verification(
    reader: SnapshotReader,
    tx_id: str,
    snapshot_id: str,
    snapshot_hash: str,
    ops: Tuple[DiffOp, ...],
    workspace: WorkspaceState,
    *,
    custom_stages: Optional[List[Tuple[str, ExecRequest]]] = None,
) -> VerificationArtifacts:
    runner = VerifyRunner(reader)
    req = VerificationRequest(
        tx_id=tx_id,
        snapshot_id=snapshot_id,
        snapshot_hash=snapshot_hash,
        ops=ops,
        workspace=workspace,
    )
    return runner.run(req, custom_stages=custom_stages)
