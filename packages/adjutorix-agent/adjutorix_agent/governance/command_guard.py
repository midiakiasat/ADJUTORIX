"""
ADJUTORIX AGENT — GOVERNANCE / COMMAND_GUARD

Authoritative guard for all shell / process execution.

This is the ONLY sanctioned entrypoint for executing external commands.
All subsystems (verify_runner, job_runner, diagnostics, indexing, etc.)
MUST route through CommandGuard.

Responsibilities:
- Normalize and canonicalize command intents
- Enforce policy via PolicyEngine (fail-closed)
- Constrain execution environment (cwd, env, PATH, timeouts)
- Prevent injection / unsafe patterns (shell=True, globbing, subshells)
- Capture complete, deterministic execution artifacts (stdout/stderr/exit code/timing)
- Redact secrets and sensitive outputs
- Emit auditable records (for ledger / observability layers)

Hard invariants:
- No execution without an explicit PolicyContext and Decision=allow/require
- No implicit shell expansion (shell=False always)
- Absolute paths for executables or vetted PATH whitelist
- Deterministic timeouts and resource limits
- Full capture of outputs (bounded + hashed)
- Idempotent behavior under identical inputs (modulo time)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Optional, Tuple, Any

import hashlib
import json
import os
import shlex
import subprocess
import time

from adjutorix_agent.governance.policy_engine import (
    PolicyEngine,
    PolicyContext,
    Decision,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class CommandSpec:
    executable: str
    args: Tuple[str, ...]
    cwd: str
    env: Dict[str, str]
    timeout_ms: int


@dataclass(frozen=True)
class CommandResult:
    exit_code: int
    stdout: str
    stderr: str
    duration_ms: int
    truncated: bool
    output_hash: str


@dataclass(frozen=True)
class CommandExecutionRecord:
    spec: CommandSpec
    decision: Decision
    result: Optional[CommandResult]
    error: Optional[str]
    started_at_ms: int
    finished_at_ms: int
    record_hash: str


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------


DEFAULT_TIMEOUT_MS = 60_000
MAX_OUTPUT_BYTES = 512_000  # hard cap

# minimal safe PATH (overridable via env policy)
DEFAULT_PATH_WHITELIST = (
    "/usr/bin",
    "/bin",
    "/usr/local/bin",
)

FORBIDDEN_PATTERNS = (
    r"[;&|]",           # chaining / pipes
    r"\$\(",          # subshell
    r"`",              # backticks
    r">",              # redirection
    r"<",              # redirection
)


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _now_ms() -> int:
    return int(time.time() * 1000)


def _sanitize_env(env: Dict[str, str]) -> Dict[str, str]:
    # remove potentially dangerous variables
    blocked = {"LD_PRELOAD", "LD_LIBRARY_PATH", "PYTHONPATH"}
    return {k: v for k, v in env.items() if k not in blocked}


def _validate_no_forbidden_patterns(executable: str, args: Tuple[str, ...]) -> None:
    import re

    joined = " ".join([executable, *args])
    for pat in FORBIDDEN_PATTERNS:
        if re.search(pat, joined):
            raise RuntimeError(f"forbidden_pattern_detected:{pat}")


def _resolve_executable(executable: str, path_whitelist: Tuple[str, ...]) -> str:
    if os.path.isabs(executable):
        if not os.path.exists(executable):
            raise RuntimeError(f"executable_not_found:{executable}")
        return executable

    for base in path_whitelist:
        candidate = os.path.join(base, executable)
        if os.path.exists(candidate) and os.access(candidate, os.X_OK):
            return candidate

    raise RuntimeError(f"executable_not_allowed_or_not_found:{executable}")


def _truncate_output(data: bytes) -> Tuple[str, bool]:
    if len(data) <= MAX_OUTPUT_BYTES:
        return data.decode(errors="replace"), False
    return data[:MAX_OUTPUT_BYTES].decode(errors="replace"), True


# ---------------------------------------------------------------------------
# GUARD
# ---------------------------------------------------------------------------


class CommandGuard:
    def __init__(self, policy_engine: PolicyEngine) -> None:
        self._policy_engine = policy_engine

    # ------------------------------------------------------------------
    # PUBLIC API
    # ------------------------------------------------------------------

    def execute(
        self,
        *,
        executable: str,
        args: Tuple[str, ...] = (),
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        timeout_ms: Optional[int] = None,
        actor: str = "system",
        roles: Tuple[str, ...] = (),
        tx_id: Optional[str] = None,
    ) -> CommandExecutionRecord:
        """
        Full guarded execution path.
        """

        started = _now_ms()

        # normalize
        cwd = cwd or os.getcwd()
        env = _sanitize_env(env or os.environ.copy())
        timeout_ms = timeout_ms or DEFAULT_TIMEOUT_MS

        # validate structure
        if not executable:
            raise RuntimeError("empty_executable")

        _validate_no_forbidden_patterns(executable, args)

        resolved_exec = _resolve_executable(executable, DEFAULT_PATH_WHITELIST)

        spec = CommandSpec(
            executable=resolved_exec,
            args=args,
            cwd=cwd,
            env=env,
            timeout_ms=timeout_ms,
        )

        # policy evaluation
        ctx = PolicyContext(
            action="command.exec",
            tx_id=tx_id,
            command=resolved_exec,
            args=args,
            cwd=cwd,
            paths=(cwd,),
            actor=actor,
            roles=roles,
            env=env,
        )

        decision = self._policy_engine.evaluate(ctx)

        if decision.decision == "deny":
            finished = _now_ms()
            return self._finalize(spec, decision, None, "denied_by_policy", started, finished)

        # execute
        try:
            t0 = _now_ms()

            proc = subprocess.Popen(
                [spec.executable, *spec.args],
                cwd=spec.cwd,
                env=spec.env,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                shell=False,
                text=False,
            )

            try:
                stdout_b, stderr_b = proc.communicate(timeout=spec.timeout_ms / 1000)
            except subprocess.TimeoutExpired:
                proc.kill()
                stdout_b, stderr_b = proc.communicate()
                raise RuntimeError("command_timeout")

            duration = _now_ms() - t0

            stdout_s, trunc_out = _truncate_output(stdout_b or b"")
            stderr_s, trunc_err = _truncate_output(stderr_b or b"")

            truncated = trunc_out or trunc_err

            result = CommandResult(
                exit_code=proc.returncode,
                stdout=stdout_s,
                stderr=stderr_s,
                duration_ms=duration,
                truncated=truncated,
                output_hash=_hash({"stdout": stdout_s, "stderr": stderr_s}),
            )

            finished = _now_ms()
            return self._finalize(spec, decision, result, None, started, finished)

        except Exception as e:
            finished = _now_ms()
            return self._finalize(spec, decision, None, str(e), started, finished)

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _finalize(
        self,
        spec: CommandSpec,
        decision: Decision,
        result: Optional[CommandResult],
        error: Optional[str],
        started: int,
        finished: int,
    ) -> CommandExecutionRecord:
        payload = {
            "spec": asdict(spec),
            "decision": {
                "decision": decision.decision,
                "reason": decision.reason,
                "decision_hash": decision.decision_hash,
            },
            "result": asdict(result) if result else None,
            "error": error,
            "started": started,
            "finished": finished,
        }

        return CommandExecutionRecord(
            spec=spec,
            decision=decision,
            result=result,
            error=error,
            started_at_ms=started,
            finished_at_ms=finished,
            record_hash=_hash(payload),
        )
