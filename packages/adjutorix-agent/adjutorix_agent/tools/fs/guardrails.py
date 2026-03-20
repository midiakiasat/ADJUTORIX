from __future__ import annotations
from dataclasses import dataclass
from pathlib import Path

class GuardViolation(RuntimeError):
    pass

@dataclass(frozen=True)
class Guardrails:
    workspace_root: Path

    def __post_init__(self) -> None:
        object.__setattr__(self, "workspace_root", self.workspace_root.resolve())

    def _resolve_under_root(self, rel: str) -> Path:
        # rel is expected to be workspace-relative (no leading slash).
        p = (self.workspace_root / rel).resolve()
        if p == self.workspace_root or self.workspace_root in p.parents:
            return p
        raise GuardViolation(f"path escapes workspace root: {rel}")

    def ensure_relative(self, path: str) -> str:
        if Path(path).is_absolute():
            raise GuardViolation(f"absolute paths forbidden: {path}")
        if path.startswith("..") or "/../" in path or "\\..\\" in path:
            raise GuardViolation(f"path traversal forbidden: {path}")
        return path

    def allow_target(self, rel: str) -> Path:
        rel = self.ensure_relative(rel)
        return self._resolve_under_root(rel)

    def deny_direct_write(self, reason: str = "direct write forbidden; use patch gate") -> None:
        raise GuardViolation(reason)
