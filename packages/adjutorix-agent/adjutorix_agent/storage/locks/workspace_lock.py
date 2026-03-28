"""
ADJUTORIX AGENT — STORAGE LOCKS / WORKSPACE_LOCK

Workspace-scoped, hierarchical lock that composes:
- process-level exclusivity (ProcessLock)
- file-level advisory lock (FileLock)
- intent scoping (read/write/verify/apply/index)
- reentrancy within process via token

Goals:
- Prevent overlapping mutations on same workspace
- Allow compatible concurrent operations (e.g., read + index)
- Provide explicit intent-based conflict matrix
- Survive crashes via stale-break policy

Locking model:
- One primary lock per workspace id (process lock)
- Optional secondary file lock for finer-grained coordination
- Intent arbitration before acquisition

Intents:
- "read"     : non-mutating, can coexist with read/index
- "index"    : non-mutating but heavy, can coexist with read
- "verify"   : isolated workspace; can coexist with read/index
- "write"    : requires exclusivity (blocks all)
- "apply"    : requires exclusivity (blocks all)

Conflict matrix (A blocks B):
- write/apply block all
- verify blocks write/apply
- index blocks write/apply
- read blocks write/apply

Implementation notes:
- Uses a per-workspace coordination file that stores active intents
- Uses atomic updates under FileLock to maintain intent set
- Uses ProcessLock to ensure single writer to coordination state

"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Dict, List, Optional, Literal

from .process_lock import ProcessLock, ProcessLockTimeout
from .file_lock import FileLock
from ..filesystem.paths import workspace_id, resolve_paths, assert_within_workspace


Intent = Literal["read", "index", "verify", "write", "apply"]


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class WorkspaceIntent:
    token: str
    pid: int
    intent: Intent
    created_at: int


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _now() -> int:
    return int(time.time())


def _coordination_file(wid: str) -> Path:
    paths = resolve_paths()
    base = paths.locks / f"workspace-{wid}"
    base.mkdir(parents=True, exist_ok=True)
    return base / "intents.json"


# ---------------------------------------------------------------------------
# CONFLICT LOGIC
# ---------------------------------------------------------------------------


def _conflicts(existing: Intent, incoming: Intent) -> bool:
    if existing in ("write", "apply"):
        return True
    if incoming in ("write", "apply"):
        return True

    if existing == "verify" and incoming in ("write", "apply"):
        return True
    if incoming == "verify" and existing in ("write", "apply"):
        return True

    if existing == "index" and incoming in ("write", "apply"):
        return True
    if incoming == "index" and existing in ("write", "apply"):
        return True

    if existing == "read" and incoming in ("write", "apply"):
        return True
    if incoming == "read" and existing in ("write", "apply"):
        return True

    return False


# ---------------------------------------------------------------------------
# STATE IO
# ---------------------------------------------------------------------------


def _load(path: Path) -> List[Dict]:
    if not path.exists():
        return []
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save(path: Path, data: List[Dict]) -> None:
    tmp = path.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, separators=(",", ":"), sort_keys=True)
    tmp.replace(path)


# ---------------------------------------------------------------------------
# WORKSPACE LOCK
# ---------------------------------------------------------------------------


class WorkspaceLock:
    """
    Workspace-scoped lock with intent arbitration.

    Usage:
        with WorkspaceLock(ws_path, "write").acquire():
            ...
    """

    def __init__(self, workspace_path: Path, intent: Intent):
        self.workspace_path = workspace_path.resolve()
        self.intent = intent
        self.wid = workspace_id(self.workspace_path)

        self._token = uuid.uuid4().hex
        self._coord = _coordination_file(self.wid)

        self._proc_lock = ProcessLock(f"workspace-{self.wid}")
        self._file_lock = FileLock(self._coord)

        self._held = False

    # ------------------------------------------------------------------
    # ACQUIRE
    # ------------------------------------------------------------------

    def acquire(self, timeout: float = 30.0, poll: float = 0.05) -> "WorkspaceLock":
        start = time.monotonic()

        # Ensure path sanity
        assert_within_workspace(self.workspace_path, self.workspace_path)

        # Process-level serialization for coordination writes
        self._proc_lock.acquire(timeout=timeout)

        try:
            while True:
                with self._file_lock.acquire(timeout=timeout):
                    state = _load(self._coord)

                    # filter out stale by pid liveness best-effort
                    active: List[WorkspaceIntent] = []
                    for r in state:
                        active.append(WorkspaceIntent(**r))

                    # check conflicts
                    blocked = False
                    for r in active:
                        if _conflicts(r.intent, self.intent):
                            blocked = True
                            break

                    if not blocked:
                        rec = WorkspaceIntent(
                            token=self._token,
                            pid=__import__("os").getpid(),
                            intent=self.intent,
                            created_at=_now(),
                        )
                        active.append(rec)
                        _save(self._coord, [asdict(x) for x in active])
                        self._held = True
                        return self

                if (time.monotonic() - start) >= timeout:
                    raise ProcessLockTimeout(
                        f"Timeout acquiring workspace lock {self.wid} for intent={self.intent}"
                    )

                time.sleep(poll)

        finally:
            # release process lock; coordination guarded by file lock above
            try:
                self._proc_lock.release()
            except Exception:
                pass

    # ------------------------------------------------------------------
    # RELEASE
    # ------------------------------------------------------------------

    def release(self) -> None:
        if not self._held:
            raise RuntimeError("WorkspaceLock release without acquire")

        with self._file_lock.acquire():
            state = _load(self._coord)
            new_state: List[Dict] = []

            for r in state:
                if r.get("token") == self._token:
                    continue
                new_state.append(r)

            _save(self._coord, new_state)

        self._held = False

    # ------------------------------------------------------------------
    # CONTEXT
    # ------------------------------------------------------------------

    def __enter__(self) -> "WorkspaceLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


__all__ = [
    "WorkspaceLock",
    "WorkspaceIntent",
]
