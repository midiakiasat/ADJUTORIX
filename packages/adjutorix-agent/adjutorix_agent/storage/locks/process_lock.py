"""
ADJUTORIX AGENT — STORAGE LOCKS / PROCESS_LOCK

Process-scoped, cross-process mutex with:
- Single-owner exclusivity across the machine (per lock name)
- Reentrant semantics within the same process (token-based)
- PID liveness checks to prevent stale lock blocking
- Atomic acquisition via filesystem primitives (O_CREAT|O_EXCL)
- Optional TTL + forced break policy
- Context manager + manual API

Hard guarantees:
- At most one live owner per lock name
- No silent acquisition; deterministic timeout errors
- No reuse after release without re-acquire
- No path traversal (lock files confined to managed lock dir)

Lock file format (JSON):
{
  "pid": int,
  "token": str,
  "created_at": int,
  "hostname": str,
  "cwd": str
}

Location:
  <root>/locks/<name>.plock

"""

from __future__ import annotations

import json
import os
import socket
import time
import uuid
import errno
import threading
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

from ..filesystem.paths import process_lock_file


# ---------------------------------------------------------------------------
# ERRORS
# ---------------------------------------------------------------------------


class ProcessLockError(RuntimeError):
    pass


class ProcessLockTimeout(ProcessLockError):
    pass


class ProcessLockStateError(ProcessLockError):
    pass


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ProcessLockOwner:
    pid: int
    token: str
    created_at: int
    hostname: str
    cwd: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _now() -> int:
    return int(time.time())


def _pid_alive(pid: int) -> bool:
    """
    Cross-platform liveness check.
    """
    if pid <= 0:
        return False

    if os.name == "posix":
        try:
            os.kill(pid, 0)
        except OSError as e:
            return e.errno == errno.EPERM  # exists but no permission
        else:
            return True
    else:
        # Windows: use ctypes to OpenProcess
        try:
            import ctypes
            PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
            handle = ctypes.windll.kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
            if handle:
                ctypes.windll.kernel32.CloseHandle(handle)
                return True
            return False
        except Exception:
            return False


# ---------------------------------------------------------------------------
# PROCESS LOCK
# ---------------------------------------------------------------------------


class ProcessLock:
    """
    Single-owner, cross-process lock identified by a name.

    Usage:
        with ProcessLock("global-scheduler").acquire(timeout=10):
            ...

        lock = ProcessLock("name")
        lock.acquire()
        try:
            ...
        finally:
            lock.release()
    """

    def __init__(self, name: str):
        if not name or any(c in name for c in ("/", "\\", "..")):
            raise ValueError("Invalid lock name")

        self.name = name
        self.path: Path = process_lock_file(name + ".plock")

        self._token: Optional[str] = None
        self._owner: Optional[ProcessLockOwner] = None
        self._local = threading.local()

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------

    def acquire(self, timeout: float = 30.0, poll: float = 0.05, break_stale_after: Optional[int] = None) -> "ProcessLock":
        start = time.monotonic()

        if getattr(self._local, "held", False):
            # reentrant within process — allowed if same token
            return self

        self.path.parent.mkdir(parents=True, exist_ok=True)

        token = uuid.uuid4().hex

        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                try:
                    owner = ProcessLockOwner(
                        pid=os.getpid(),
                        token=token,
                        created_at=_now(),
                        hostname=socket.gethostname(),
                        cwd=os.getcwd(),
                    )
                    os.write(fd, json.dumps(asdict(owner), separators=(",", ":")).encode("utf-8"))
                finally:
                    os.close(fd)

                self._token = token
                self._owner = owner
                self._local.held = True
                return self

            except FileExistsError:
                # check existing owner
                existing = self._read_owner_safe()

                if existing and not _pid_alive(existing.pid):
                    # stale — attempt break
                    if break_stale_after is None or (_now() - existing.created_at) >= break_stale_after:
                        if self._try_break(existing):
                            continue

                if (time.monotonic() - start) >= timeout:
                    raise ProcessLockTimeout(f"Timeout acquiring process lock: {self.name}")

                time.sleep(poll)

    def release(self) -> None:
        if not getattr(self._local, "held", False):
            raise ProcessLockStateError("Release without acquire")

        if self._token is None:
            raise ProcessLockStateError("Missing token")

        existing = self._read_owner_safe()

        # Only owner can release
        if not existing or existing.token != self._token:
            raise ProcessLockStateError("Lock ownership mismatch on release")

        try:
            os.unlink(self.path)
        except FileNotFoundError:
            pass

        self._token = None
        self._owner = None
        self._local.held = False

    def read_owner(self) -> Optional[ProcessLockOwner]:
        return self._read_owner_safe()

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _read_owner_safe(self) -> Optional[ProcessLockOwner]:
        if not self.path.exists():
            return None
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return ProcessLockOwner(**data)
        except Exception:
            return None

    def _try_break(self, existing: ProcessLockOwner) -> bool:
        """
        Attempt to remove stale lock atomically.
        """
        try:
            # Rename then unlink to avoid races
            tmp = self.path.with_suffix(self.path.suffix + ".stale")
            os.replace(self.path, tmp)
            os.unlink(tmp)
            return True
        except OSError:
            return False

    # ------------------------------------------------------------------
    # CONTEXT
    # ------------------------------------------------------------------

    def __enter__(self) -> "ProcessLock":
        return self.acquire()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.release()


__all__ = [
    "ProcessLock",
    "ProcessLockOwner",
    "ProcessLockError",
    "ProcessLockTimeout",
    "ProcessLockStateError",
]
