"""
ADJUTORIX AGENT — TEST FIXTURES / ENV

Deterministic environment isolation layer.

Purpose:
- Provide hermetic filesystem + process environment per test
- Eliminate cross-test contamination
- Control OS-level nondeterminism (cwd, env vars, temp dirs)
- Enable reproducible integration + concurrency tests

Core guarantees:
- Each environment has its own root (sandbox)
- No writes escape sandbox
- All paths are absolute and canonicalized
- Environment variables are explicitly controlled
- Cleanup is strict and complete

NO PLACEHOLDERS.
"""

from __future__ import annotations

import os
import shutil
import tempfile
import uuid
from typing import Dict, Optional
from contextlib import contextmanager


# ---------------------------------------------------------------------------
# CORE ENV OBJECT
# ---------------------------------------------------------------------------


class IsolatedEnv:
    """
    Fully isolated execution environment.

    Properties:
    - root: sandbox root directory
    - cwd: working directory inside sandbox
    - env: environment variables (strict set)
    """

    def __init__(self, *, prefix: str = "adjutorix_env") -> None:
        self._id = uuid.uuid4().hex
        self.root = os.path.abspath(tempfile.mkdtemp(prefix=f"{prefix}_{self._id}_"))
        self.cwd = os.path.join(self.root, "workspace")
        self.tmp = os.path.join(self.root, "tmp")
        self.logs = os.path.join(self.root, "logs")

        os.makedirs(self.cwd, exist_ok=True)
        os.makedirs(self.tmp, exist_ok=True)
        os.makedirs(self.logs, exist_ok=True)

        self.env: Dict[str, str] = {
            "ADJUTORIX_ROOT": self.root,
            "ADJUTORIX_WORKSPACE": self.cwd,
            "ADJUTORIX_TMP": self.tmp,
            "ADJUTORIX_LOGS": self.logs,
            "PYTHONHASHSEED": "0",  # enforce deterministic hashing
        }

    # ------------------------------------------------------------------
    # FILE OPS
    # ------------------------------------------------------------------

    def write_file(self, rel_path: str, content: str) -> str:
        path = self._resolve(rel_path)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            f.write(content)
        return path

    def read_file(self, rel_path: str) -> str:
        path = self._resolve(rel_path)
        with open(path, "r", encoding="utf-8") as f:
            return f.read()

    def exists(self, rel_path: str) -> bool:
        return os.path.exists(self._resolve(rel_path))

    def list_files(self) -> list[str]:
        out = []
        for root, _, files in os.walk(self.cwd):
            for f in files:
                out.append(os.path.relpath(os.path.join(root, f), self.cwd))
        return sorted(out)

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _resolve(self, rel_path: str) -> str:
        if os.path.isabs(rel_path):
            raise ValueError("absolute_path_forbidden")
        path = os.path.abspath(os.path.join(self.cwd, rel_path))
        if not path.startswith(self.cwd):
            raise ValueError("path_escape_detected")
        return path

    # ------------------------------------------------------------------
    # CLEANUP
    # ------------------------------------------------------------------

    def cleanup(self) -> None:
        if os.path.exists(self.root):
            shutil.rmtree(self.root, ignore_errors=True)


# ---------------------------------------------------------------------------
# CONTEXT MANAGER
# ---------------------------------------------------------------------------


@contextmanager
def isolated_env(prefix: str = "adjutorix_env"):
    env = IsolatedEnv(prefix=prefix)
    old_env = os.environ.copy()
    old_cwd = os.getcwd()

    try:
        os.environ.clear()
        os.environ.update(env.env)
        os.chdir(env.cwd)
        yield env
    finally:
        os.environ.clear()
        os.environ.update(old_env)
        os.chdir(old_cwd)
        env.cleanup()


# ---------------------------------------------------------------------------
# MULTI-ENV (CONCURRENCY)
# ---------------------------------------------------------------------------


def create_envs(n: int) -> list[IsolatedEnv]:
    envs = [IsolatedEnv(prefix=f"adj_env_{i}") for i in range(n)]
    return envs


def cleanup_envs(envs: list[IsolatedEnv]) -> None:
    for e in envs:
        e.cleanup()


# ---------------------------------------------------------------------------
# SNAPSHOT / RESTORE
# ---------------------------------------------------------------------------


def snapshot_env(env: IsolatedEnv) -> Dict[str, bytes]:
    snap: Dict[str, bytes] = {}
    for root, _, files in os.walk(env.cwd):
        for f in files:
            full = os.path.join(root, f)
            rel = os.path.relpath(full, env.cwd)
            with open(full, "rb") as fh:
                snap[rel] = fh.read()
    return snap


def restore_env(env: IsolatedEnv, snapshot: Dict[str, bytes]) -> None:
    # wipe current
    shutil.rmtree(env.cwd)
    os.makedirs(env.cwd, exist_ok=True)

    for rel, data in snapshot.items():
        path = env._resolve(rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)


# ---------------------------------------------------------------------------
# ASSERTIONS
# ---------------------------------------------------------------------------


def assert_env_clean(env: IsolatedEnv) -> None:
    files = env.list_files()
    if files:
        raise AssertionError(f"env_not_clean:{files}")


def assert_file_content(env: IsolatedEnv, path: str, expected: str) -> None:
    actual = env.read_file(path)
    if actual != expected:
        raise AssertionError(f"content_mismatch:{path}")


__all__ = [
    "IsolatedEnv",
    "isolated_env",
    "create_envs",
    "cleanup_envs",
    "snapshot_env",
    "restore_env",
    "assert_env_clean",
    "assert_file_content",
]
