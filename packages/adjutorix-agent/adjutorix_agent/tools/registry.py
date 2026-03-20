from __future__ import annotations
from dataclasses import dataclass
from typing import Any, Callable, Dict, Optional

from .permissions import ToolPermissions

ToolHandler = Callable[[Dict[str, Any]], Any]

@dataclass
class ToolSpec:
    name: str
    handler: ToolHandler
    description: str = ""
    # If True, tool is considered "mutating" (disk, network, etc.) and should be gated.
    mutating: bool = False

class ToolRegistry:
    """
    Central registry for agent-side tools.
    - Default deny unless policy allows tool name.
    - Registry returns a handler only after permission check.
    """
    def __init__(self) -> None:
        self._tools: Dict[str, ToolSpec] = {}

    def register(self, spec: ToolSpec) -> None:
        if spec.name in self._tools:
            raise ValueError(f"tool already registered: {spec.name}")
        self._tools[spec.name] = spec

    def list(self) -> Dict[str, ToolSpec]:
        return dict(self._tools)

    def resolve(self, tool_name: str) -> ToolSpec:
        spec = self._tools.get(tool_name)
        if spec is None:
            raise KeyError(f"unknown tool: {tool_name}")
        return spec

    def get_handler(self, tool_name: str, perms: ToolPermissions) -> ToolHandler:
        perms.require(tool_name)
        return self.resolve(tool_name).handler

def default_registry() -> ToolRegistry:
    """
    Create an empty registry.
    Registration should happen in one place (agent startup), not ad-hoc.
    """
    return ToolRegistry()
