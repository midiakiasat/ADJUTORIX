# packages/adjutorix-agent/adjutorix_agent/governance/policy.py

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml


DEFAULT_POLICY: Dict[str, Any] = {
    "allowlist": {
        "commands": [
            "git",
            "rg",
            "ctags",
            "python",
            "pip",
            "pytest",
            "node",
            "npm",
            "pnpm",
            "yarn",
            "tsc",
            "eslint",
            "prettier",
            "ruff",
            "mypy",
            "wrangler",
        ]
    },
    "denylist": {
        "commands": [
            "rm",
            "sudo",
            "curl",
            "sh",
            "bash",
            "zsh",
            "powershell",
        ]
    },
    "protected_files": [
        ".env",
        ".env.*",
        "**/secrets.*",
        "**/*key*",
        "**/*token*",
        ".github/workflows/**",
        "configs/ci/**",
        "configs/hooks/**",
        "runtime/**",
    ],
}


def _read_yaml(path: Path) -> Dict[str, Any]:
    if not path.exists():
        return {}
    with path.open("r", encoding="utf-8") as f:
        data = yaml.safe_load(f) or {}
    if not isinstance(data, dict):
        return {}
    return data


def _deep_merge(a: Dict[str, Any], b: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(a)
    for k, v in (b or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


@dataclass
class Policy:
    data: Dict[str, Any] = field(default_factory=lambda: dict(DEFAULT_POLICY))

    def allowlisted(self, argv: List[str]) -> bool:
        if not argv:
            return False
        cmd = argv[0]
        allow = set(self.data.get("allowlist", {}).get("commands", []))
        deny = set(self.data.get("denylist", {}).get("commands", []))
        if cmd in deny:
            return False
        return cmd in allow

    def is_command_allowed(self, command: str) -> bool:
        """Check if a shell command string is allowed (first token must be allowlisted)."""
        argv = command.strip().split()
        return self.allowlisted(argv) if argv else False

    def allowed_env_vars(self) -> List[str]:
        """Env var names allowed to be passed to commands; empty means essentials only."""
        return list(self.data.get("allowlist", {}).get("env", []))

    def protected_globs(self) -> List[str]:
        return list(self.data.get("protected_files", []))


class PolicyManager:
    """
    Minimal, stable surface expected by the rest of the agent.
    Loads:
      - ~/.agent/global.yaml (optional)
      - <repo>/.agent/policy.yaml (optional)
      - <repo>/.agent/constraints.yaml (optional)
    """

    def __init__(self, repo_root: Optional[str] = None, home: Optional[str] = None):
        self.repo_root = Path(repo_root).resolve() if repo_root else None
        self.home = Path(home).expanduser().resolve() if home else Path.home()
        self._policy = Policy()

    def load(self) -> Policy:
        merged = dict(DEFAULT_POLICY)

        global_path = self.home / ".agent" / "global.yaml"
        merged = _deep_merge(merged, _read_yaml(global_path))

        if self.repo_root:
            repo_agent = self.repo_root / ".agent"
            merged = _deep_merge(merged, _read_yaml(repo_agent / "policy.yaml"))
            merged = _deep_merge(merged, _read_yaml(repo_agent / "constraints.yaml"))

        self._policy = Policy(data=merged)
        return self._policy

    def policy(self) -> Policy:
        # lazy-load
        if not self._policy or not isinstance(self._policy, Policy):
            return self.load()
        return self._policy
