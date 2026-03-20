import hashlib
import os
import time
import json
import errno
from contextlib import contextmanager
from typing import Optional


class LockError(Exception):
    pass


class WorkspaceLock:
    """
    Enforces: one active job per workspace.

    Uses filesystem lock for crash safety.
    """

    def __init__(self, lock_dir: str) -> None:
        self.lock_dir = lock_dir
        self.lock_file = os.path.join(lock_dir, "active.lock")
        self.meta_file = os.path.join(lock_dir, "active.meta")

        os.makedirs(lock_dir, exist_ok=True)

    # -------------------------
    # Public API
    # -------------------------

    def acquire(
        self,
        job_id: str,
        owner: str,
        timeout: int = 30,
        poll_interval: float = 0.5,
    ) -> None:
        """
        Acquire exclusive workspace lock.
        """

        start = time.time()

        while True:
            try:
                self._create_lock(job_id, owner)
                return
            except LockError:
                if time.time() - start > timeout:
                    raise LockError(
                        f"Timeout acquiring workspace lock ({timeout}s)"
                    )

                time.sleep(poll_interval)

    def release(self) -> None:
        """
        Release lock if owned.
        """

        self._safe_remove(self.lock_file)
        self._safe_remove(self.meta_file)

    def is_locked(self) -> bool:
        return os.path.exists(self.lock_file)

    def owner(self) -> Optional[dict]:
        """
        Return metadata of current lock owner.
        """

        if not os.path.exists(self.meta_file):
            return None

        try:
            with open(self.meta_file, "r") as f:
                return json.load(f)
        except Exception:
            return None

    @contextmanager
    def hold(
        self,
        job_id: str,
        owner: str,
        timeout: int = 30,
    ):
        """
        Context manager for automatic lock handling.
        """

        self.acquire(job_id, owner, timeout)

        try:
            yield
        finally:
            self.release()

    # -------------------------
    # Internals
    # -------------------------

    def _create_lock(self, job_id: str, owner: str) -> None:
        """
        Atomic lock creation.
        """

        flags = os.O_CREAT | os.O_EXCL | os.O_WRONLY

        try:
            fd = os.open(self.lock_file, flags)
            os.close(fd)

            self._write_meta(job_id, owner)

        except OSError as e:
            if e.errno == errno.EEXIST:
                raise LockError("Workspace already locked")
            raise

    def _write_meta(self, job_id: str, owner: str) -> None:
        meta = {
            "job_id": job_id,
            "owner": owner,
            "pid": os.getpid(),
            "timestamp": time.time(),
            "hostname": os.uname().nodename
            if hasattr(os, "uname")
            else "unknown",
        }

        tmp = self.meta_file + ".tmp"

        with open(tmp, "w") as f:
            json.dump(meta, f, indent=2)

        os.replace(tmp, self.meta_file)

    def _safe_remove(self, path: str) -> None:
        try:
            os.remove(path)
        except FileNotFoundError:
            return
        except Exception:
            pass


class LockManager:
    """
    Provides job-level locking for the agent using the workspace lock.
    One active job per repo_root at a time.
    """

    def __init__(self, repo_root: str) -> None:
        self.repo_root = repo_root
        workspace_id = hashlib.sha256(repo_root.encode()).hexdigest()[:16]
        self._workspace_lock = get_workspace_lock(workspace_id)

    @contextmanager
    def job_lock(self):
        """Context manager: acquire exclusive job lock for this repo."""
        with self._workspace_lock.hold(
            job_id="job",
            owner="adjutorix-agent",
            timeout=30,
        ):
            yield


# -------------------------
# Global Helper
# -------------------------

_DEFAULT_LOCK_DIR = os.path.expanduser("~/.agent/locks")


def get_workspace_lock(
    workspace_id: str,
) -> WorkspaceLock:
    """
    Return lock instance for workspace.
    """

    path = os.path.join(_DEFAULT_LOCK_DIR, workspace_id)
    return WorkspaceLock(path)
