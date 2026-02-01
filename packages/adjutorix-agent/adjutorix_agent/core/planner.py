import json
from pathlib import Path
from typing import Any, Dict, List

from jsonschema import validate, ValidationError

from adjutorix_agent.core.taxonomy import ErrorCategory
from adjutorix_agent.governance.policy import PolicyManager


class PlanValidationError(Exception):
    pass


class Planner:
    """
    Validates and normalizes agent execution plans.

    Ensures every PLAN contains:
    - objective
    - files
    - commands
    - pass_condition
    - rollback
    """

    def __init__(
        self,
        plan_schema_path: Path,
        policy_manager: PolicyManager,
    ) -> None:
        self._schema = self._load_schema(plan_schema_path)
        self._policy = policy_manager

    def _load_schema(self, path: Path) -> Dict[str, Any]:
        if not path.exists():
            raise FileNotFoundError(f"Plan schema not found: {path}")

        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)

    def validate(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """
        Validate plan against schema and policy rules.
        Returns normalized plan.
        """

        try:
            validate(instance=plan, schema=self._schema)
        except ValidationError as e:
            raise PlanValidationError(
                f"Plan schema violation: {e.message}"
            ) from e

        self._validate_policy(plan)
        self._validate_commands(plan)
        self._validate_files(plan)

        return self._normalize(plan)

    def _validate_policy(self, plan: Dict[str, Any]) -> None:
        """
        Check against repo/global policy.
        """

        violations = self._policy.check_plan(plan)

        if violations:
            raise PlanValidationError(
                f"Policy violations: {', '.join(violations)}"
            )

    def _validate_commands(self, plan: Dict[str, Any]) -> None:
        commands: List[str] = plan.get("commands", [])

        if not commands:
            raise PlanValidationError("Plan must include at least one command")

        for cmd in commands:
            if not self._policy.is_command_allowed(cmd):
                raise PlanValidationError(
                    f"Command not allowed: {cmd}"
                )

    def _validate_files(self, plan: Dict[str, Any]) -> None:
        files: List[str] = plan.get("files", [])

        if not files:
            raise PlanValidationError("Plan must specify affected files")

        for path in files:
            if self._policy.is_protected_file(path):
                raise PlanValidationError(
                    f"Protected file requires OVERRIDE: {path}"
                )

    def _normalize(self, plan: Dict[str, Any]) -> Dict[str, Any]:
        """
        Apply defaults and normalization.
        """

        normalized = dict(plan)

        normalized.setdefault("risk_level", "normal")
        normalized.setdefault("category", ErrorCategory.UNKNOWN.value)

        normalized["files"] = sorted(set(normalized.get("files", [])))
        normalized["commands"] = list(normalized.get("commands", []))

        return normalized

    def build_basic_plan(
        self,
        objective: str,
        files: List[str],
        commands: List[str],
        pass_condition: str,
        rollback: str,
    ) -> Dict[str, Any]:
        """
        Helper for generating minimal valid plans.
        """

        plan = {
            "objective": objective,
            "files": files,
            "commands": commands,
            "pass_condition": pass_condition,
            "rollback": rollback,
        }

        return self.validate(plan)
