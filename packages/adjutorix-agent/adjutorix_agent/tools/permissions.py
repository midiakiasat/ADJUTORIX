from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Iterable, Set

@dataclass(frozen=True)
class ToolPermissions:
    """
    Minimal permissions model:
      - tools are named strings, e.g. "fs.applyPatch", "run.command", "git.status"
      - policy chooses allowlist; anything not listed is denied by default
    """
    allow: Set[str]

    @classmethod
    def from_policy(cls, policy: Dict) -> "ToolPermissions":
        # policy shape is intentionally tolerant
        tools = policy.get("tools", {}) if isinstance(policy, dict) else {}
        allow = tools.get("allow", []) if isinstance(tools, dict) else []
        return cls(allow=set(str(x) for x in allow))

    def is_allowed(self, tool_name: str) -> bool:
        return tool_name in self.allow

    def require(self, tool_name: str) -> None:
        if not self.is_allowed(tool_name):
            raise PermissionError(f"tool not permitted: {tool_name}")
