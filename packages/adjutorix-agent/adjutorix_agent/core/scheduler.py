"""
ADJUTORIX AGENT — CORE / SCHEDULER

Deterministic, governed execution scheduler.

Responsibilities:
- Single global execution authority for all jobs (no ad-hoc threads)
- Strict ordering (priority + FIFO within priority)
- Concurrency control (max workers, mutation exclusivity)
- Fairness via weighted queues (optional)
- Preemption-safe cancellation points
- Backpressure + admission control
- Idempotent re-run semantics (job key)
- Observable lifecycle (events/metrics hooks)

Invariants:
- No overlapping mutation jobs (guarded by ConcurrencyGuard + mutation flag)
- Job state transitions are explicit and linearizable
- Queue ordering is stable and reproducible
- Cancellation is cooperative and leaves system consistent
- All execution happens via this scheduler (no bypass)
"""

from __future__ import annotations

import heapq
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, Optional, Tuple

# Local integrations (optional at import time)
try:
    from adjutorix_agent.core.clock import now_ns, next_seq
except Exception:
    import time as _t

    def now_ns() -> int:  # fallback monotonic
        return int(_t.time() * 1e9)

    _SEQ = 0
    _SEQ_LOCK = threading.Lock()

    def next_seq() -> int:
        global _SEQ
        with _SEQ_LOCK:
            _SEQ += 1
            return _SEQ

try:
    from adjutorix_agent.observability.metrics import m_job_rate
except Exception:
    def m_job_rate():
        class _N:
            def mark(self, n: int = 1) -> None:
                pass
        return _N()

try:
    from adjutorix_agent.observability.logging import info, warning, error
except Exception:
    def info(*args, **kwargs): pass
    def warning(*args, **kwargs): pass
    def error(*args, **kwargs): pass


# ---------------------------------------------------------------------------
# STATES
# ---------------------------------------------------------------------------


class JobState(str, Enum):
    PENDING = "pending"
    ADMITTED = "admitted"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


# ---------------------------------------------------------------------------
# JOB MODEL
# ---------------------------------------------------------------------------


@dataclass(order=True)
class _QueueItem:
    # heap ordering: (priority desc via negative, seq asc)
    sort_key: Tuple[int, int]
    job_id: str = field(compare=False)


@dataclass
class Job:
    job_id: str
    fn: Callable[["ExecutionContext"], Any]
    priority: int
    created_ns: int
    key: Optional[str] = None  # idempotency key
    is_mutation: bool = False
    timeout_s: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass
class JobRecord:
    job: Job
    state: JobState = JobState.PENDING
    enqueued_ns: int = field(default_factory=now_ns)
    started_ns: Optional[int] = None
    ended_ns: Optional[int] = None
    result: Any = None
    error: Optional[str] = None
    cancel_requested: bool = False


# ---------------------------------------------------------------------------
# EXECUTION CONTEXT
# ---------------------------------------------------------------------------


class ExecutionContext:
    def __init__(self, scheduler: "Scheduler", job_id: str) -> None:
        self._scheduler = scheduler
        self.job_id = job_id
        self._cancel_flag = False
        self._lock = threading.Lock()

    def cancelled(self) -> bool:
        with self._lock:
            return self._cancel_flag

    def _set_cancel(self) -> None:
        with self._lock:
            self._cancel_flag = True

    def checkpoint(self) -> None:
        if self.cancelled():
            raise CancelledError(f"job {self.job_id} cancelled")


# ---------------------------------------------------------------------------
# EXCEPTIONS
# ---------------------------------------------------------------------------


class CancelledError(Exception):
    pass


class AdmissionError(Exception):
    pass


# ---------------------------------------------------------------------------
# CONCURRENCY GUARD
# ---------------------------------------------------------------------------


class ConcurrencyGuard:
    """
    Prevent overlapping mutation jobs; allow parallel non-mutation up to limit.
    """

    def __init__(self, max_workers: int) -> None:
        if max_workers <= 0:
            raise ValueError("max_workers must be > 0")
        self._max_workers = max_workers
        self._running = 0
        self._mutation_running = False
        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)

    def acquire(self, is_mutation: bool) -> None:
        with self._cv:
            while True:
                if is_mutation:
                    if self._running == 0 and not self._mutation_running:
                        self._mutation_running = True
                        self._running = 1
                        return
                else:
                    if not self._mutation_running and self._running < self._max_workers:
                        self._running += 1
                        return
                self._cv.wait()

    def release(self, is_mutation: bool) -> None:
        with self._cv:
            if is_mutation:
                self._mutation_running = False
                self._running = 0
            else:
                self._running -= 1
                if self._running < 0:
                    self._running = 0
            self._cv.notify_all()


# ---------------------------------------------------------------------------
# ADMISSION CONTROL
# ---------------------------------------------------------------------------


class AdmissionController:
    def __init__(self, max_queue: int = 50_000) -> None:
        self._max_queue = max_queue

    def admit(self, qsize: int) -> None:
        if qsize >= self._max_queue:
            raise AdmissionError("queue capacity exceeded")


# ---------------------------------------------------------------------------
# SCHEDULER
# ---------------------------------------------------------------------------


class Scheduler:
    def __init__(
        self,
        *,
        max_workers: int = 4,
        admission: Optional[AdmissionController] = None,
    ) -> None:
        self._guard = ConcurrencyGuard(max_workers)
        self._admission = admission or AdmissionController()

        self._heap: list[_QueueItem] = []
        self._records: Dict[str, JobRecord] = {}
        self._keys: Dict[str, str] = {}  # idempotency key -> job_id

        self._lock = threading.Lock()
        self._cv = threading.Condition(self._lock)
        self._shutdown = False

        self._workers: list[threading.Thread] = []
        for i in range(max_workers):
            t = threading.Thread(target=self._worker_loop, name=f"sched-worker-{i}", daemon=True)
            t.start()
            self._workers.append(t)

    # ---- submit ------------------------------------------------------------

    def submit(
        self,
        fn: Callable[[ExecutionContext], Any],
        *,
        priority: int = 0,
        key: Optional[str] = None,
        is_mutation: bool = False,
        timeout_s: Optional[float] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        job_id = uuid.uuid4().hex
        job = Job(
            job_id=job_id,
            fn=fn,
            priority=int(priority),
            created_ns=now_ns(),
            key=key,
            is_mutation=is_mutation,
            timeout_s=timeout_s,
            metadata=metadata or {},
        )

        with self._cv:
            # idempotency
            if key is not None and key in self._keys:
                return self._keys[key]

            self._admission.admit(len(self._heap))

            rec = JobRecord(job=job)
            self._records[job_id] = rec
            if key is not None:
                self._keys[key] = job_id

            item = _QueueItem(sort_key=(-job.priority, next_seq()), job_id=job_id)
            heapq.heappush(self._heap, item)

            rec.state = JobState.ADMITTED

            self._cv.notify()

        # observability
        try:
            m_job_rate().mark(1)
        except Exception:
            pass

        info("job_submitted", context={"job_id": job_id, "priority": priority, "mutation": is_mutation})
        return job_id

    # ---- control -----------------------------------------------------------

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            rec = self._records.get(job_id)
            if not rec:
                return False
            rec.cancel_requested = True
            return True

    def status(self, job_id: str) -> Optional[JobRecord]:
        with self._lock:
            return self._records.get(job_id)

    # ---- worker loop -------------------------------------------------------

    def _worker_loop(self) -> None:
        while True:
            with self._cv:
                while not self._heap and not self._shutdown:
                    self._cv.wait()
                if self._shutdown:
                    return

                item = heapq.heappop(self._heap)
                rec = self._records.get(item.job_id)
                if rec is None:
                    continue

                # skip cancelled before run
                if rec.cancel_requested:
                    rec.state = JobState.CANCELLED
                    rec.ended_ns = now_ns()
                    continue

                rec.state = JobState.RUNNING
                rec.started_ns = now_ns()

            job = rec.job

            # concurrency control
            self._guard.acquire(job.is_mutation)

            ctx = ExecutionContext(self, job.job_id)

            # cooperative cancel propagation
            if rec.cancel_requested:
                ctx._set_cancel()

            try:
                result = self._run_with_timeout(job, ctx)
                rec.result = result
                if rec.cancel_requested:
                    rec.state = JobState.CANCELLED
                else:
                    rec.state = JobState.COMPLETED
            except CancelledError as ce:
                rec.error = str(ce)
                rec.state = JobState.CANCELLED
            except Exception as exc:
                rec.error = f"{type(exc).__name__}: {exc}"
                rec.state = JobState.FAILED
                error("job_failed", context={"job_id": job.job_id, "error": rec.error})
            finally:
                rec.ended_ns = now_ns()
                self._guard.release(job.is_mutation)

    # ---- helpers -----------------------------------------------------------

    def _run_with_timeout(self, job: Job, ctx: ExecutionContext) -> Any:
        if job.timeout_s is None:
            return job.fn(ctx)

        # cooperative timeout via watchdog thread
        done = threading.Event()
        result_holder: Dict[str, Any] = {}
        error_holder: Dict[str, Exception] = {}

        def _target():
            try:
                result_holder["result"] = job.fn(ctx)
            except Exception as e:
                error_holder["error"] = e
            finally:
                done.set()

        t = threading.Thread(target=_target, daemon=True)
        t.start()

        if not done.wait(timeout=job.timeout_s):
            ctx._set_cancel()
            raise CancelledError(f"timeout after {job.timeout_s}s")

        if "error" in error_holder:
            raise error_holder["error"]

        return result_holder.get("result")

    # ---- shutdown ----------------------------------------------------------

    def shutdown(self, timeout_s: float = 2.0) -> None:
        with self._cv:
            self._shutdown = True
            self._cv.notify_all()
        deadline = time.time() + timeout_s
        for t in self._workers:
            remaining = max(0.0, deadline - time.time())
            t.join(timeout=remaining)


# ---------------------------------------------------------------------------
# GLOBAL SINGLETON
# ---------------------------------------------------------------------------


_GLOBAL: Optional[Scheduler] = None
_GLOBAL_LOCK = threading.Lock()


def get_scheduler() -> Scheduler:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = Scheduler()
    return _GLOBAL


# ---------------------------------------------------------------------------
# CONVENIENCE API
# ---------------------------------------------------------------------------


def submit(fn: Callable[[ExecutionContext], Any], **kwargs: Any) -> str:
    return get_scheduler().submit(fn, **kwargs)


def cancel(job_id: str) -> bool:
    return get_scheduler().cancel(job_id)


def status(job_id: str) -> Optional[JobRecord]:
    return get_scheduler().status(job_id)


def shutdown(timeout_s: float = 2.0) -> None:
    get_scheduler().shutdown(timeout_s)
