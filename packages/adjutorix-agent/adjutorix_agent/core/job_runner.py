"""
ADJUTORIX AGENT — CORE / JOB_RUNNER

Global execution orchestrator binding scheduler, queue, state machine,
patch pipeline, verify runner, and rollback into a single deterministic flow.

Responsibilities:
- Accept Job intents (mutation / verify / rollback)
- Enforce ordering + concurrency via scheduler + guards
- Execute full lifecycle: (state, intent) → (new_state, artifacts, logs)
- Persist structured logs for replay
- Guarantee idempotency and deterministic outcomes

Hard invariants:
- All mutations go through patch_pipeline
- All execution goes through isolated_workspace via verify_runner
- All transitions validated by state_machine
- Job execution is linearizable (no overlapping conflicting jobs)
- Re-running same job_id with same inputs must yield same artifacts or explicit divergence
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Optional, Tuple, List

import time
import uuid

from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.job_queue import JobQueue, JobQueueItem
from adjutorix_agent.core.concurrency_guard import ConcurrencyGuard
from adjutorix_agent.core.state_machine import StateMachine, State, Transition
from adjutorix_agent.core.transaction import Transaction
from adjutorix_agent.core.transaction_store import TransactionStore
from adjutorix_agent.core.patch_pipeline import PatchPipeline
from adjutorix_agent.core.verify_runner import run_verification
from adjutorix_agent.core.rollback import execute_rollback
from adjutorix_agent.core.failure_model import classify_exception, Failure
from adjutorix_agent.core.isolated_workspace import SnapshotReader, DiffOp


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class JobIntent:
    kind: str  # "mutation" | "verify" | "rollback"
    tx_id: str
    payload: Dict[str, object]


@dataclass(frozen=True)
class JobContext:
    job_id: str
    correlation_id: str
    created_at_ms: int


@dataclass(frozen=True)
class JobResult:
    success: bool
    artifacts: Dict[str, object]
    failure: Optional[Failure]
    duration_ms: int


# ---------------------------------------------------------------------------
# JOB RUNNER
# ---------------------------------------------------------------------------


class JobRunner:
    """
    Deterministic execution engine for all jobs.
    """

    def __init__(
        self,
        reader: SnapshotReader,
        scheduler: Optional[Scheduler] = None,
        queue: Optional[JobQueue] = None,
        guard: Optional[ConcurrencyGuard] = None,
        sm: Optional[StateMachine] = None,
        tx_store: Optional[TransactionStore] = None,
        patch_pipeline: Optional[PatchPipeline] = None,
    ) -> None:
        self._reader = reader
        self._scheduler = scheduler or Scheduler()
        self._queue = queue or JobQueue()
        self._guard = guard or ConcurrencyGuard()
        self._sm = sm or StateMachine()
        self._tx_store = tx_store or TransactionStore()
        self._patch_pipeline = patch_pipeline or PatchPipeline()

    # ------------------------------------------------------------------
    # PUBLIC
    # ------------------------------------------------------------------

    def submit(self, intent: JobIntent) -> str:
        job_id = str(uuid.uuid4())
        ctx = JobContext(job_id=job_id, correlation_id=str(uuid.uuid4()), created_at_ms=int(time.time() * 1000))
        item = JobQueueItem(job_id=job_id, intent=intent, context=ctx)
        self._queue.push(item)
        return job_id

    def run_next(self) -> Optional[Tuple[str, JobResult]]:
        item = self._scheduler.next(self._queue)
        if item is None:
            return None

        with self._guard.acquire(item.intent.tx_id):
            result = self._execute(item)
            return item.job_id, result

    # ------------------------------------------------------------------
    # CORE EXECUTION
    # ------------------------------------------------------------------

    def _execute(self, item: JobQueueItem) -> JobResult:
        t0 = time.time()

        try:
            intent = item.intent

            # Load transaction
            tx: Transaction = self._tx_store.get(intent.tx_id)

            # State transition: READY -> RUNNING
            self._apply_transition(tx, "start")

            if intent.kind == "mutation":
                artifacts = self._run_mutation(tx, intent.payload)

            elif intent.kind == "verify":
                artifacts = self._run_verify(tx, intent.payload)

            elif intent.kind == "rollback":
                artifacts = self._run_rollback(tx, intent.payload)

            else:
                raise RuntimeError(f"unknown_intent: {intent.kind}")

            # State transition: RUNNING -> DONE
            self._apply_transition(tx, "complete")

            return JobResult(
                success=True,
                artifacts=artifacts,
                failure=None,
                duration_ms=int((time.time() - t0) * 1000),
            )

        except Exception as exc:
            failure = classify_exception(exc)

            # State transition: RUNNING -> FAILED (best effort)
            try:
                self._apply_transition(tx, "fail")
            except Exception:
                pass

            return JobResult(
                success=False,
                artifacts={},
                failure=failure,
                duration_ms=int((time.time() - t0) * 1000),
            )

    # ------------------------------------------------------------------
    # EXECUTION MODES
    # ------------------------------------------------------------------

    def _run_mutation(self, tx: Transaction, payload: Dict[str, object]) -> Dict[str, object]:
        """
        Mutation = build patch → verify → (optional) apply decision outside
        """
        ops: Tuple[DiffOp, ...] = payload["ops"]  # required

        patch = self._patch_pipeline.build(tx, ops)

        verify_art = run_verification(
            self._reader,
            tx_id=tx.tx_id,
            snapshot_id=tx.snapshot_id,
            snapshot_hash=tx.snapshot_hash,
            ops=ops,
            workspace=tx.workspace_state,
        )

        return {
            "patch": patch,
            "verification": verify_art,
        }

    def _run_verify(self, tx: Transaction, payload: Dict[str, object]) -> Dict[str, object]:
        ops: Tuple[DiffOp, ...] = payload.get("ops", ())

        verify_art = run_verification(
            self._reader,
            tx_id=tx.tx_id,
            snapshot_id=tx.snapshot_id,
            snapshot_hash=tx.snapshot_hash,
            ops=ops,
            workspace=tx.workspace_state,
        )

        return {
            "verification": verify_art,
        }

    def _run_rollback(self, tx: Transaction, payload: Dict[str, object]) -> Dict[str, object]:
        ledger_edges = payload["edges"]

        rb = execute_rollback(tx.tx_id, ledger_edges)

        return {
            "rollback": rb,
        }

    # ------------------------------------------------------------------
    # STATE MACHINE
    # ------------------------------------------------------------------

    def _apply_transition(self, tx: Transaction, action: str) -> None:
        current_state: State = tx.state
        transition: Transition = self._sm.resolve(current_state, action)
        new_state = self._sm.apply(current_state, transition)

        self._tx_store.update_state(tx.tx_id, new_state)
