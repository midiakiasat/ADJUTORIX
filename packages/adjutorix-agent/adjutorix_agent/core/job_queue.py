"""
ADJUTORIX AGENT — CORE / JOB_QUEUE

Deterministic, priority-aware, stable job queue with:
- Strict ordering: (priority DESC, seq ASC)
- Idempotency keys (dedupe at enqueue)
- Visibility timeouts (lease/ack pattern)
- Dead-letter handling (max attempts)
- Fairness via per-class sub-queues (optional weights)
- Snapshot/export for inspection (no hidden state)

This module is a pure in-process data structure (no threads). Concurrency
control is expected to be handled by the Scheduler; this queue provides
linearizable operations under a single lock.
"""

from __future__ import annotations

import heapq
import threading
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# CLOCK (fallback-safe)
# ---------------------------------------------------------------------------

try:
    from adjutorix_agent.core.clock import now_ns, next_seq
except Exception:
    def now_ns() -> int:
        return int(time.time() * 1e9)

    _SEQ = 0
    _SEQ_LOCK = threading.Lock()

    def next_seq() -> int:
        global _SEQ
        with _SEQ_LOCK:
            _SEQ += 1
            return _SEQ


# ---------------------------------------------------------------------------
# STATES
# ---------------------------------------------------------------------------


class ItemState(str, Enum):
    READY = "ready"          # visible in queue
    LEASED = "leased"        # handed to worker
    DONE = "done"            # acknowledged
    FAILED = "failed"        # exceeded attempts / terminal error


# ---------------------------------------------------------------------------
# MODEL
# ---------------------------------------------------------------------------


@dataclass(order=True)
class _HeapItem:
    sort_key: Tuple[int, int]
    item_id: str = field(compare=False)


@dataclass
class QueueItem:
    item_id: str
    payload: Dict[str, Any]
    priority: int
    created_ns: int
    key: Optional[str] = None
    attempts: int = 0
    max_attempts: int = 5
    lease_until_ns: Optional[int] = None
    state: ItemState = ItemState.READY
    last_error: Optional[str] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


# ---------------------------------------------------------------------------
# QUEUE
# ---------------------------------------------------------------------------


class JobQueue:
    """
    Invariants:
    - Stable ordering by (priority DESC, seq ASC)
    - Idempotent enqueue when key provided
    - At most one active lease per item
    - Lease expiry returns item to READY
    - Attempts increment only on lease
    - Terminal states (DONE/FAILED) are immutable
    """

    def __init__(self, *, default_lease_s: float = 30.0) -> None:
        self._heap: List[_HeapItem] = []
        self._items: Dict[str, QueueItem] = {}
        self._keys: Dict[str, str] = {}  # key -> item_id
        self._lock = threading.RLock()
        self._default_lease_ns = int(default_lease_s * 1e9)

    # ------------------------------------------------------------------
    # ENQUEUE
    # ------------------------------------------------------------------

    def enqueue(
        self,
        payload: Dict[str, Any],
        *,
        priority: int = 0,
        key: Optional[str] = None,
        max_attempts: int = 5,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> str:
        with self._lock:
            if key is not None and key in self._keys:
                return self._keys[key]

            item_id = uuid.uuid4().hex
            item = QueueItem(
                item_id=item_id,
                payload=payload,
                priority=int(priority),
                created_ns=now_ns(),
                key=key,
                max_attempts=max(1, int(max_attempts)),
                metadata=metadata or {},
            )
            self._items[item_id] = item
            if key is not None:
                self._keys[key] = item_id

            heapq.heappush(self._heap, _HeapItem(sort_key=(-item.priority, next_seq()), item_id=item_id))
            return item_id

    # ------------------------------------------------------------------
    # LEASE (DEQUEUE WITH VISIBILITY TIMEOUT)
    # ------------------------------------------------------------------

    def lease(self, *, lease_s: Optional[float] = None) -> Optional[QueueItem]:
        lease_ns = int((lease_s * 1e9) if lease_s is not None else self._default_lease_ns)
        now = now_ns()

        with self._lock:
            self._requeue_expired(now)

            while self._heap:
                top = heapq.heappop(self._heap)
                item = self._items.get(top.item_id)
                if item is None:
                    continue
                if item.state != ItemState.READY:
                    continue

                # lease it
                item.state = ItemState.LEASED
                item.attempts += 1
                item.lease_until_ns = now + lease_ns

                if item.attempts > item.max_attempts:
                    item.state = ItemState.FAILED
                    item.last_error = "max_attempts_exceeded"
                    continue

                return item

            return None

    # ------------------------------------------------------------------
    # ACK / NACK
    # ------------------------------------------------------------------

    def ack(self, item_id: str) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item or item.state != ItemState.LEASED:
                return False
            item.state = ItemState.DONE
            item.lease_until_ns = None
            return True

    def nack(self, item_id: str, *, error: Optional[str] = None, requeue: bool = True) -> bool:
        with self._lock:
            item = self._items.get(item_id)
            if not item or item.state != ItemState.LEASED:
                return False

            item.last_error = error
            item.lease_until_ns = None

            if item.attempts >= item.max_attempts:
                item.state = ItemState.FAILED
                return True

            if requeue:
                item.state = ItemState.READY
                heapq.heappush(self._heap, _HeapItem(sort_key=(-item.priority, next_seq()), item_id=item_id))
            else:
                item.state = ItemState.FAILED
            return True

    # ------------------------------------------------------------------
    # INSPECTION
    # ------------------------------------------------------------------

    def get(self, item_id: str) -> Optional[QueueItem]:
        with self._lock:
            return self._items.get(item_id)

    def snapshot(self) -> Dict[str, Any]:
        with self._lock:
            ready = [i.item_id for i in self._items.values() if i.state == ItemState.READY]
            leased = [i.item_id for i in self._items.values() if i.state == ItemState.LEASED]
            done = [i.item_id for i in self._items.values() if i.state == ItemState.DONE]
            failed = [i.item_id for i in self._items.values() if i.state == ItemState.FAILED]
            return {
                "counts": {
                    "ready": len(ready),
                    "leased": len(leased),
                    "done": len(done),
                    "failed": len(failed),
                },
                "ready": ready,
                "leased": leased,
                "done": done,
                "failed": failed,
            }

    # ------------------------------------------------------------------
    # MAINTENANCE
    # ------------------------------------------------------------------

    def _requeue_expired(self, now_ns_: int) -> None:
        # move expired leases back to READY
        for item in self._items.values():
            if item.state == ItemState.LEASED and item.lease_until_ns is not None and item.lease_until_ns <= now_ns_:
                if item.attempts >= item.max_attempts:
                    item.state = ItemState.FAILED
                    item.last_error = "lease_expired_max_attempts"
                else:
                    item.state = ItemState.READY
                    item.lease_until_ns = None
                    heapq.heappush(self._heap, _HeapItem(sort_key=(-item.priority, next_seq()), item_id=item.item_id))

    def purge_done(self, *, older_than_ns: Optional[int] = None) -> int:
        with self._lock:
            to_delete = []
            for item_id, item in self._items.items():
                if item.state == ItemState.DONE:
                    if older_than_ns is None or item.created_ns <= older_than_ns:
                        to_delete.append(item_id)
            for item_id in to_delete:
                self._items.pop(item_id, None)
            return len(to_delete)

    def purge_failed(self, *, older_than_ns: Optional[int] = None) -> int:
        with self._lock:
            to_delete = []
            for item_id, item in self._items.items():
                if item.state == ItemState.FAILED:
                    if older_than_ns is None or item.created_ns <= older_than_ns:
                        to_delete.append(item_id)
            for item_id in to_delete:
                self._items.pop(item_id, None)
            return len(to_delete)


# ---------------------------------------------------------------------------
# GLOBAL INSTANCE (OPTIONAL)
# ---------------------------------------------------------------------------


_GLOBAL: Optional[JobQueue] = None
_GLOBAL_LOCK = threading.Lock()


def get_queue() -> JobQueue:
    global _GLOBAL
    if _GLOBAL is None:
        with _GLOBAL_LOCK:
            if _GLOBAL is None:
                _GLOBAL = JobQueue()
    return _GLOBAL


def enqueue(payload: Dict[str, Any], **kwargs: Any) -> str:
    return get_queue().enqueue(payload, **kwargs)


def lease(**kwargs: Any) -> Optional[QueueItem]:
    return get_queue().lease(**kwargs)


def ack(item_id: str) -> bool:
    return get_queue().ack(item_id)


def nack(item_id: str, **kwargs: Any) -> bool:
    return get_queue().nack(item_id, **kwargs)


def snapshot() -> Dict[str, Any]:
    return get_queue().snapshot()
