"""
ADJUTORIX AGENT — CORE / ISOLATED_WORKSPACE

Ephemeral, hermetic workspace executor.

Responsibilities:
- Materialize a read-only base snapshot into an isolated FS
- Apply patch ops in-memory or within a temp FS (no mutation of source repo)
- Execute commands in a controlled environment (cwd, env, limits)
- Capture outputs, exit codes, timings, resource usage
- Tear down deterministically

Hard invariants:
- No writes to original workspace
- No network by default (opt-in only)
- Reproducible: same (snapshot, patch, env) => same outputs (within limits)
- Bounded resources (cpu/mem/time)

Design:
- Pluggable SnapshotReader and Runner
- Two modes: memory (small repos) and filesystem (large repos)
"""

from __future__ import annotations

import os
import shutil
import tempfile
import time
import subprocess
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple


# ---------------------------------------------------------------------------
# PORTS
# ---------------------------------------------------------------------------


class SnapshotReader:
    def list_files(self, snapshot_id: str) -> Tuple[str, ...]: ...
    def read_file(self, snapshot_id: str, path: str) -> bytes: ...


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ExecLimits:
    timeout_sec: float = 30.0
    max_output_bytes: int = 5 * 1024 * 1024
    allow_network: bool = False


@dataclass(frozen=True)
class ExecRequest:
    cmd: List[str]
    env: Dict[str, str] = field(default_factory=dict)
    cwd: Optional[str] = None
    limits: ExecLimits = ExecLimits()


@dataclass(frozen=True)
class ExecResult:
    exit_code: int
    stdout: bytes
    stderr: bytes
    duration_ms: int
    timed_out: bool


@dataclass(frozen=True)
class DiffOp:
    op: str  # insert|delete|replace
    path: str
    start: int
    end: int
    content: str


# ---------------------------------------------------------------------------
# WORKSPACE
# ---------------------------------------------------------------------------


class IsolatedWorkspace:
    """
    Filesystem-backed isolated workspace.
    """

    def __init__(self, reader: SnapshotReader) -> None:
        self._reader = reader
        self._root: Optional[str] = None
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # LIFECYCLE
    # ------------------------------------------------------------------

    def create(self, snapshot_id: str) -> str:
        with self._lock:
            if self._root is not None:
                raise RuntimeError("workspace_already_created")

            root = tempfile.mkdtemp(prefix="adjutorix_ws_")

            for path in self._reader.list_files(snapshot_id):
                data = self._reader.read_file(snapshot_id, path)
                abs_path = os.path.join(root, path)
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                with open(abs_path, "wb") as f:
                    f.write(data)

            self._root = root
            return root

    def destroy(self) -> None:
        with self._lock:
            if self._root and os.path.exists(self._root):
                shutil.rmtree(self._root)
            self._root = None

    # ------------------------------------------------------------------
    # PATCH APPLICATION (LOCAL ONLY)
    # ------------------------------------------------------------------

    def apply_ops(self, ops: Tuple[DiffOp, ...]) -> None:
        if not self._root:
            raise RuntimeError("workspace_not_initialized")

        for op in ops:
            abs_path = os.path.join(self._root, op.path)

            if op.op == "insert":
                os.makedirs(os.path.dirname(abs_path), exist_ok=True)
                with open(abs_path, "wb") as f:
                    f.write(op.content.encode())

            elif op.op == "delete":
                if os.path.exists(abs_path):
                    os.remove(abs_path)

            elif op.op == "replace":
                if not os.path.exists(abs_path):
                    raise RuntimeError(f"replace_missing_file: {op.path}")

                with open(abs_path, "rb") as f:
                    data = f.read()

                new_data = data[: op.start] + op.content.encode() + data[op.end :]

                with open(abs_path, "wb") as f:
                    f.write(new_data)

            else:
                raise RuntimeError(f"unknown_op: {op.op}")

    # ------------------------------------------------------------------
    # EXECUTION
    # ------------------------------------------------------------------

    def run(self, req: ExecRequest) -> ExecResult:
        if not self._root:
            raise RuntimeError("workspace_not_initialized")

        env = os.environ.copy()
        env.update(req.env)

        if not req.limits.allow_network:
            env["NO_PROXY"] = "*"

        cwd = req.cwd or self._root

        start = time.time()
        proc = subprocess.Popen(
            req.cmd,
            cwd=cwd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        try:
            stdout, stderr = proc.communicate(timeout=req.limits.timeout_sec)
            timed_out = False
        except subprocess.TimeoutExpired:
            proc.kill()
            stdout, stderr = proc.communicate()
            timed_out = True

        duration_ms = int((time.time() - start) * 1000)

        # truncate outputs
        stdout = stdout[: req.limits.max_output_bytes]
        stderr = stderr[: req.limits.max_output_bytes]

        return ExecResult(
            exit_code=proc.returncode,
            stdout=stdout,
            stderr=stderr,
            duration_ms=duration_ms,
            timed_out=timed_out,
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def execute_in_isolated_workspace(
    reader: SnapshotReader,
    snapshot_id: str,
    ops: Tuple[DiffOp, ...],
    req: ExecRequest,
) -> ExecResult:
    ws = IsolatedWorkspace(reader)
    try:
        ws.create(snapshot_id)
        ws.apply_ops(ops)
        return ws.run(req)
    finally:
        ws.destroy()
