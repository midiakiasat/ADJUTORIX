import json
import os
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, List, Optional, Any

from adjutorix_agent.core.taxonomy import ErrorCategory
from adjutorix_agent.tools.registry import ToolRegistry
from adjutorix_agent.core.rollback import RollbackManager
from adjutorix_agent.core.context_budget import ContextBudget
from adjutorix_agent.governance.policy import PolicyManager


class ExecutionError(Exception):
    pass


class CommandResult:
    def __init__(
        self,
        command: str,
        return_code: int,
        stdout: str,
        stderr: str,
        duration: float,
    ):
        self.command = command
        self.return_code = return_code
        self.stdout = stdout
        self.stderr = stderr
        self.duration = duration

    def to_dict(self) -> Dict[str, Any]:
        return {
            "command": self.command,
            "return_code": self.return_code,
            "stdout": self.stdout,
            "stderr": self.stderr,
            "duration": self.duration,
        }


class Executor:
    """
    Executes validated plans in a sandboxed, policy-controlled environment.
    """

    def __init__(
        self,
        workspace: Path,
        tool_registry: ToolRegistry,
        rollback: RollbackManager,
        policy: PolicyManager,
        context_budget: ContextBudget,
        timeout: int = 900,
    ):
        self.workspace = workspace
        self.tools = tool_registry
        self.rollback = rollback
        self.policy = policy
        self.context_budget = context_budget
        self.timeout = timeout

        self._lock = threading.Lock()

    # ---------------------------
    # Public API
    # ---------------------------

    def run_action(
        self,
        job_name: str,
        action: str,
        allow_override: bool,
        ledger: Any = None,
    ) -> Dict[str, Any]:
        """
        Run a single action (check/fix/verify/deploy).
        Loads .adjutorix/actions.json if present; executes configured commands.
        Always returns a structured report (never leaves system ambiguous).
        """
        start_time = time.time()
        actions_path = self.workspace / ".adjutorix" / "actions.json"
        plan: Dict[str, Any] = {"commands": [], "pass_condition": ""}

        if actions_path.exists():
            try:
                cfg = json.loads(actions_path.read_text(encoding="utf-8"))
                plan = cfg.get(action) or cfg.get(action.lower()) or plan
                if isinstance(plan, list):
                    plan = {"commands": plan, "pass_condition": ""}
            except Exception as e:
                raise ExecutionError(f"Invalid {actions_path}: {e}") from e

        if not plan.get("commands"):
            raise ExecutionError(
                f"No commands configured for action '{action}'. "
                f"Add {actions_path} with a '{action}' entry."
            )

        try:
            report = self.execute_plan(plan)
        except ExecutionError as e:
            duration = time.time() - start_time
            report = {
                "status": "failed",
                "message": str(e),
                "category": self._classify_error(e),
                "duration": duration,
                "results": [],
            }
        except Exception as e:
            duration = time.time() - start_time
            report = {
                "status": "failed",
                "message": str(e),
                "category": self._classify_error(e),
                "duration": duration,
                "results": [],
            }

        try:
            if ledger is not None and getattr(ledger, "current_job", None) is not None:
                job = ledger.current_job
                for cmd in plan["commands"]:
                    ledger.append_command(job, cmd)
                ledger.append_result(job, json.dumps(report))
                ledger.update_meta(job, {"job_name": job_name, "action": action})
        except Exception:
            pass

        return report

    def execute_plan(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """
        Execute full plan lifecycle.
        Returns execution report.
        """

        with self._lock:
            self.rollback.snapshot()

            start_time = time.time()
            results: List[CommandResult] = []

            try:
                self._prepare_environment(plan)

                for command in plan["commands"]:
                    result = self._run_command(command)
                    results.append(result)

                    if result.return_code != 0:
                        raise ExecutionError(
                            f"Command failed: {command}"
                        )

                self._validate_pass_condition(plan, results)

                status = "success"
                category = ErrorCategory.NONE.value

            except Exception as exc:
                self.rollback.rollback()

                status = "failed"
                category = self._classify_error(exc)

                raise

            finally:
                duration = time.time() - start_time

            return {
                "status": status,
                "category": category,
                "duration": duration,
                "results": [r.to_dict() for r in results],
            }

    # ---------------------------
    # Internal helpers
    # ---------------------------

    def _prepare_environment(self, plan: Dict[str, Any]) -> None:
        """
        Validate workspace and environment before execution.
        """

        if not self.workspace.exists():
            raise ExecutionError("Workspace does not exist")

        if not self.workspace.is_dir():
            raise ExecutionError("Workspace is not a directory")

        for cmd in plan["commands"]:
            if not self.policy.is_command_allowed(cmd):
                raise ExecutionError(f"Command blocked by policy: {cmd}")

        self.context_budget.reset()

    def _run_command(self, command: str) -> CommandResult:
        """
        Execute single command in sandbox.
        """

        if self.tools.is_registered(command):
            return self._run_tool(command)

        return self._run_shell(command)

    def _run_tool(self, command: str) -> CommandResult:
        """
        Execute registered deterministic tool.
        """

        tool = self.tools.get(command)

        start = time.time()

        try:
            stdout, stderr, code = tool.run(self.workspace)
        except Exception as exc:
            raise ExecutionError(f"Tool failed: {command}") from exc

        duration = time.time() - start

        self.context_budget.consume_output(stdout, stderr)

        return CommandResult(
            command=command,
            return_code=code,
            stdout=stdout,
            stderr=stderr,
            duration=duration,
        )

    def _run_shell(self, command: str) -> CommandResult:
        """
        Execute shell command in restricted mode.
        """

        start = time.time()

        process = subprocess.Popen(
            command,
            cwd=self.workspace,
            shell=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=self._filtered_env(),
        )

        try:
            stdout, stderr = process.communicate(timeout=self.timeout)
        except subprocess.TimeoutExpired:
            process.kill()
            raise ExecutionError(f"Command timeout: {command}")

        duration = time.time() - start

        self.context_budget.consume_output(stdout, stderr)

        return CommandResult(
            command=command,
            return_code=process.returncode,
            stdout=stdout or "",
            stderr=stderr or "",
            duration=duration,
        )

    def _filtered_env(self) -> Dict[str, str]:
        """
        Return real environment filtered by policy; essentials (PATH, HOME, LANG) included if allowed.
        """
        allowed = set(self.policy.allowed_env_vars())
        essentials = {"PATH", "HOME", "LANG"}
        for k in essentials:
            allowed.add(k)
        base = os.environ
        return {k: v for k, v in base.items() if k in allowed}

    def _validate_pass_condition(
        self,
        plan: Dict[str, Any],
        results: List[CommandResult],
    ) -> None:
        """
        Check that expected pass condition is met.
        """

        condition = plan.get("pass_condition", "")

        if not condition:
            return

        combined_output = "\n".join(
            r.stdout + r.stderr for r in results
        )

        if condition not in combined_output:
            raise ExecutionError(
                f"Pass condition not met: {condition}"
            )

    def _classify_error(self, exc: Exception) -> str:
        """
        Map exception to taxonomy category.
        """

        msg = str(exc).lower()

        if "timeout" in msg:
            return ErrorCategory.ENV.value

        if "permission" in msg:
            return ErrorCategory.SECURITY.value

        if "test" in msg or "assert" in msg:
            return ErrorCategory.TEST.value

        if "type" in msg:
            return ErrorCategory.TYPE.value

        if "build" in msg or "compile" in msg:
            return ErrorCategory.BUILD.value

        if "deploy" in msg:
            return ErrorCategory.DEPLOY.value

        return ErrorCategory.UNKNOWN.value
