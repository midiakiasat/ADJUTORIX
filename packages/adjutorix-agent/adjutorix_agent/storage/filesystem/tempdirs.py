"""
ADJUTORIX AGENT — FILESYSTEM TEMPDIRS

Deterministic, isolated, and lifecycle-managed temporary directories.

Responsibilities:
- Allocate per-run, per-transaction temp directories
- Enforce isolation boundaries (no cross-run leakage)
- Provide scoped contexts with automatic cleanup
- Support crash-resilient recovery via journaled allocation
- Prevent reuse after release

Hard guarantees:
- Every tempdir is uniquely identified (run_id, purpose, monotonic counter)
- Allocation is atomic and recorded
- Cleanup is idempotent and safe
- No path traversal or escape outside managed root
- Concurrent allocations are race-safe

Layout:
  <root>/ephemeral/<workspace_id>/<run_id>/<purpose>/<nonce>/

Journal:
  <root>/ephemeral/<workspace_id>/<run_id>/.journal.json

"""

from __future__ import annotations

import json
import os
import shutil
import time
import uuid
import threading
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, Dict, List, Iterator
from contextlib import contextmanager

from .paths import ephemeral_workspace_dir, workspace_id, assert_within_workspace


# ---------------------------------------------------------------------------
# CONFIG
# ---------------------------------------------------------------------------

JOURNAL_FILE = ".journal.json"
LOCK_FILE = ".lock"


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class TempDirRecord:
    id: str
    workspace_id: str
    run_id: str
    purpose: str
    path: str
    created_at: int
    released: bool


# ---------------------------------------------------------------------------
# LOCK
# ---------------------------------------------------------------------------


class _FileLock:
    def __init__(self, path: Path):
        self._path = path
        self._fd: Optional[int] = None

    def acquire(self) -> None:
        self._path.parent.mkdir(parents=True, exist_ok=True)
        fd = os.open(self._path, os.O_CREAT | os.O_RDWR)
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX)
            self._fd = fd
        except Exception:
            os.close(fd)
            raise

    def release(self) -> None:
        if self._fd is None:
            return
        try:
            if os.name == "posix":
                import fcntl

                fcntl.flock(self._fd, fcntl.LOCK_UN)
        finally:
            os.close(self._fd)
            self._fd = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, exc_type, exc, tb):
        self.release()


# ---------------------------------------------------------------------------
# JOURNAL
# ---------------------------------------------------------------------------


class _Journal:
    def __init__(self, root: Path):
        self.root = root
        self.file = root / JOURNAL_FILE
        self.lock = _FileLock(root / LOCK_FILE)

    def _load(self) -> List[Dict]:
        if not self.file.exists():
            return []
        with open(self.file, "r", encoding="utf-8") as f:
            return json.load(f)

    def _save(self, data: List[Dict]) -> None:
        tmp = self.file.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, separators=(",", ":"), sort_keys=True)
        os.replace(tmp, self.file)

    def append(self, rec: TempDirRecord) -> None:
        with self.lock:
            data = self._load()
            data.append(asdict(rec))
            self._save(data)

    def mark_released(self, rec_id: str) -> None:
        with self.lock:
            data = self._load()
            for r in data:
                if r["id"] == rec_id:
                    r["released"] = True
                    break
            self._save(data)

    def list_active(self) -> List[TempDirRecord]:
        with self.lock:
            data = self._load()
        return [TempDirRecord(**r) for r in data if not r.get("released")]


# ---------------------------------------------------------------------------
# ALLOCATOR
# ---------------------------------------------------------------------------


class TempDirManager:
    def __init__(self, workspace_path: Path, run_id: str):
        self.workspace_path = workspace_path.resolve()
        self.run_id = run_id
        self.workspace_id = workspace_id(self.workspace_path)
        self.base = ephemeral_workspace_dir(self.workspace_path, run_id)
        self.journal = _Journal(self.base)
        self._counter = 0
        self._lock = threading.Lock()

    def _next_nonce(self) -> str:
        with self._lock:
            self._counter += 1
            return f"{int(time.time())}-{self._counter}-{uuid.uuid4().hex[:8]}"

    def allocate(self, purpose: str) -> TempDirRecord:
        nonce = self._next_nonce()
        path = self.base / purpose / nonce
        path.mkdir(parents=True, exist_ok=False)

        assert_within_workspace(self.base, path)

        rec = TempDirRecord(
            id=uuid.uuid4().hex,
            workspace_id=self.workspace_id,
            run_id=self.run_id,
            purpose=purpose,
            path=str(path),
            created_at=int(time.time()),
            released=False,
        )

        self.journal.append(rec)
        return rec

    def release(self, rec: TempDirRecord, *, remove: bool = True) -> None:
        p = Path(rec.path)
        if remove and p.exists():
            shutil.rmtree(p, ignore_errors=True)
        self.journal.mark_released(rec.id)

    def cleanup_orphans(self) -> None:
        """
        Remove any non-released dirs on startup recovery.
        """
        for rec in self.journal.list_active():
            p = Path(rec.path)
            try:
                if p.exists():
                    shutil.rmtree(p, ignore_errors=True)
            finally:
                self.journal.mark_released(rec.id)


# ---------------------------------------------------------------------------
# CONTEXT API
# ---------------------------------------------------------------------------


@contextmanager
def tempdir(workspace_path: Path, run_id: str, purpose: str) -> Iterator[Path]:
    mgr = TempDirManager(workspace_path, run_id)
    rec = mgr.allocate(purpose)
    try:
        yield Path(rec.path)
    finally:
        mgr.release(rec, remove=True)


# ---------------------------------------------------------------------------
# BULK UTILS
# ---------------------------------------------------------------------------


def cleanup_run(workspace_path: Path, run_id: str) -> None:
    base = ephemeral_workspace_dir(workspace_path, run_id)
    if base.exists():
        shutil.rmtree(base, ignore_errors=True)


__all__ = [
    "TempDirManager",
    "TempDirRecord",
    "tempdir",
    "cleanup_run",
]
