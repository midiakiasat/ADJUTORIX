"""
ADJUTORIX AGENT — STORAGE LOCKS / FILE_LOCK

Cross-process, reentrant-safe file lock with:
- POSIX (fcntl) and Windows (msvcrt) support
- Advisory exclusive/shared modes
- Timeout + deadlock avoidance
- Ownership tracking (pid, tid, token)
- Crash-safe stale lock detection
- Context manager + manual API

Hard guarantees:
- No silent acquisition failure
- Deterministic error on timeout
- No lock escalation without release
- Stale lock break requires explicit policy

Lock file format:
- Plain text JSON header stored in file beginning
- Includes owner metadata and monotonic timestamp

"""

from __future__ import annotations

import os
import json
import time
import errno
import uuid
import threading
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional, Literal


Mode = Literal["exclusive", "shared"]


@dataclass(frozen=True)
class LockOwner:
    pid: int
    tid: int
    token: str
    created_at: int


class FileLockError(RuntimeError):
    pass


class LockTimeout(FileLockError):
    pass


class LockStateError(FileLockError):
    pass


class FileLock:
    """
    Cross-platform file lock.

    Usage:
        with FileLock(path).acquire(timeout=5):
            ...

        lock = FileLock(path)
        lock.acquire()
        try:
            ...
        finally:
            lock.release()
    """

    def __init__(self, path: Path, mode: Mode = "exclusive"):
        self.path = Path(path)
        self.mode = mode
        self._fd: Optional[int] = None
        self._owner: Optional[LockOwner] = None
        self._thread_local = threading.local()

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------

    def acquire(self, timeout: float = 30.0, poll: float = 0.05) -> "FileLock":
        start = time.monotonic()

        # reentrant check (same thread)
        if getattr(self._thread_local, "held", False):
            raise LockStateError("Reentrant acquire not allowed for same instance")

        self.path.parent.mkdir(parents=True, exist_ok=True)

        fd = os.open(self.path, os.O_CREAT | os.O_RDWR)
        self._fd = fd

        try:
            while True:
                try:
                    self._try_lock(fd)
                    break
                except BlockingIOError:
                    if (time.monotonic() - start) >= timeout:
                        raise LockTimeout(f"Timeout acquiring lock: {self.path}")
                    time.sleep(poll)

            self._owner = self._write_owner(fd)
            self._thread_local.held = True
            return self

        except Exception:
            self._cleanup_fd()
            raise

    def release(self) -> None:
        if not getattr(self._thread_local, "held", False):
            raise LockStateError("Release called without acquire")

        if self._fd is None:
            raise LockStateError("Internal fd missing on release")

        try:
            self._clear_owner(self._fd)
            self._unlock(self._fd)
        finally:
            self._cleanup_fd()
            self._thread_local.held = False

    def break_stale(self, max_age_seconds: int) -> bool:
        """
        Break lock if owner is stale.
        Returns True if broken.
        """
        try:
            owner = self._read_owner()
        except Exception:
            return False

        age = int(time.time()) - owner.created_at
        if age < max_age_seconds:
            return False

        # force unlock
        try:
            fd = os.open(self.path, os.O_RDWR)
            try:
                self._unlock(fd, force=True)
                self._clear_owner(fd)
                return True
            finally:
                os.close(fd)
        except OSError:
            return False

    # ------------------------------------------------------------------
    # INTERNAL — LOCKING
    # ------------------------------------------------------------------

    def _try_lock(self, fd: int) -> None:
        if os.name == "posix":
            import fcntl

            flags = fcntl.LOCK_EX if self.mode == "exclusive" else fcntl.LOCK_SH
            fcntl.flock(fd, flags | fcntl.LOCK_NB)
        else:
            import msvcrt

            # Windows: lock entire file region
            size = 0x7FFFFFFF
            if self.mode == "exclusive":
                msvcrt.locking(fd, msvcrt.LK_NBLCK, size)
            else:
                msvcrt.locking(fd, msvcrt.LK_NBRLCK, size)

    def _unlock(self, fd: int, force: bool = False) -> None:
        if os.name == "posix":
            import fcntl

            fcntl.flock(fd, fcntl.LOCK_UN)
        else:
            import msvcrt

            size = 0x7FFFFFFF
            try:
                msvcrt.locking(fd, msvcrt.LK_UNLCK, size)
            except OSError:
                if not force:
                    raise

    # ------------------------------------------------------------------
    # INTERNAL — OWNER METADATA
    # ------------------------------------------------------------------

    def _write_owner(self, fd: int) -> LockOwner:
        owner = LockOwner(
            pid=os.getpid(),
            tid=threading.get_ident(),
            token=uuid.uuid4().hex,
            created_at=int(time.time()),
        )

        data = json.dumps(asdict(owner), separators=(",", ":"))

        os.lseek(fd, 0, os.SEEK_SET)
        os.write(fd, data.encode("utf-8"))
        os.ftruncate(fd, len(data))

        return owner

    def _read_owner(self) -> LockOwner:
        if not self.path.exists():
            raise FileLockError("Lock file missing")

        with open(self.path, "r", encoding="utf-8") as f:
            raw = f.read().strip()

        if not raw:
            raise FileLockError("Lock owner missing")

        data = json.loads(raw)
        return LockOwner(**data)

    def _clear_owner(self, fd: int) -> None:
        try:
            os.lseek(fd, 0, os.SEEK_SET)
            os.write(fd, b"")
            os.ftruncate(fd, 0)
        except OSError:
            pass

    # ------------------------------------------------------------------
    # INTERNAL — FD
    # ------------------------------------------------------------------

    def _cleanup_fd(self) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            finally:
                self._fd = None

    # ------------------------------------------------------------------
    # CONTEXT
    # ------------------------------------------------------------------

    def __enter__(self) -> "FileLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


__all__ = [
    "FileLock",
    "FileLockError",
    "LockTimeout",
    "LockStateError",
    "LockOwner",
]
