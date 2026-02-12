"""workspace.router

Goal: make workspace resolution + locking session-aware and harden path resolution.

Key upgrades:
- open_workspace(name, session_id): session_id required
- lock is scoped to workspace root (filesystem lock), with session ownership enforced
- resolve_path enforces that configured workspace paths stay within allowlisted roots
  to reduce config-poisoning / path traversal risk

Notes:
- WorkspaceLock is filesystem-backed and keyed by workspace_id (hash of repo root).
- Session binding is enforced by router (mismatch => refuse release).
"""

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import Any, Dict, List, Optional

import yaml

from typing import TYPE_CHECKING
from adjutorix_agent.core.locks import LockError, get_workspace_lock
if TYPE_CHECKING:
    from adjutorix_agent.core.locks import WorkspaceLock
from adjutorix_agent.governance.policy import PolicyLoader


class WorkspaceNotFound(Exception):
    """Raised when a workspace cannot be resolved."""


class WorkspaceLockedError(Exception):
    """Raised when a workspace is locked by another session."""


class WorkspaceRouter:
    """Central workspace resolver.

    Maps logical repo names to physical paths and policies.

    Invariants:
    - Every open/close is bound to a session_id.
    - A lock cannot be released by a different session.
    - Workspace paths are constrained to allowlisted roots.
    """

    def __init__(
        self,
        config_path: Optional[Path] = None,
        *,
        allow_roots: Optional[List[Path]] = None,
    ) -> None:
        if config_path is None:
            config_path = Path.home() / ".agent" / "workspaces.yaml"

        self.config_path = config_path
        self._workspaces: Dict[str, Dict[str, Any]] = {}

        # Default allow_roots is conservative: user home + current working directory.
        # Tighten in production via config.
        if allow_roots is None:
            allow_roots = [Path.home(), Path.cwd()]
        self._allow_roots = [p.expanduser().resolve() for p in allow_roots]

        # Active lock is created on open (keyed by repo root hash).
        self._lock: Optional[WorkspaceLock] = None

        # Router-side ownership tracking (hard refusal on mismatch).
        self._active_session_id: Optional[str] = None
        self._active_root: Optional[Path] = None

        self._load_config()

    # ---------------------------------------------------------
    # Config loading
    # ---------------------------------------------------------

    def _load_config(self) -> None:
        """Load ~/.agent/workspaces.yaml"""
        if not self.config_path.exists():
            self._workspaces = {}
            return

        with open(self.config_path, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}

        self._workspaces = data.get("workspaces", {})

    def reload(self) -> None:
        """Reload workspace configuration."""
        self._load_config()

    # ---------------------------------------------------------
    # Resolution
    # ---------------------------------------------------------

    def list_workspaces(self) -> Dict[str, Dict[str, Any]]:
        """Return all registered workspaces."""
        return dict(self._workspaces)

    def has_workspace(self, name: str) -> bool:
        return name in self._workspaces

    def _is_under_any_allow_root(self, path: Path) -> bool:
        """Return True if path is under any allowlisted root."""
        for root in self._allow_roots:
            try:
                if path == root or root in path.parents:
                    return True
            except Exception:
                continue
        return False

    def resolve_path(self, name: str) -> Path:
        """Resolve workspace name to absolute path, with allowlist enforcement."""
        if name not in self._workspaces:
            raise WorkspaceNotFound(f"Unknown workspace: {name}")

        cfg = self._workspaces[name]
        raw = cfg.get("path")
        if not raw:
            raise WorkspaceNotFound(f"Workspace missing path: {name}")

        path = Path(raw).expanduser()

        if not path.exists():
            raise WorkspaceNotFound(f"Workspace path does not exist: {path}")

        resolved = path.resolve()

        # Defense: config poisoning (workspace points outside intended roots).
        if not self._is_under_any_allow_root(resolved):
            roots = ", ".join(str(r) for r in self._allow_roots)
            raise WorkspaceNotFound(
                f"Workspace path outside allowlisted roots: {resolved} (allowed: {roots})"
            )

        return resolved

    def detect_from_path(self, path: Path) -> Optional[str]:
        """Detect workspace name from filesystem path."""
        path = path.resolve()

        for name, cfg in self._workspaces.items():
            root = Path(cfg["path"]).expanduser().resolve()
            if path == root or root in path.parents:
                return name

        return None

    # ---------------------------------------------------------
    # Policy / Toolchain
    # ---------------------------------------------------------

    def load_policy(self, name: str) -> Dict[str, Any]:
        """Load policy for workspace."""
        root = self.resolve_path(name)
        loader = PolicyLoader(root)
        return loader.load()

    def get_toolchain(self, name: str) -> str:
        """Return declared toolchain (python/node/etc)."""
        cfg = self._workspaces.get(name)
        if not cfg:
            raise WorkspaceNotFound(name)
        return cfg.get("toolchain", "unknown")

    def get_commands(self, name: str) -> Dict[str, str]:
        """Return declared command set (check/fix/deploy/etc)."""
        cfg = self._workspaces.get(name)
        if not cfg:
            raise WorkspaceNotFound(name)
        return cfg.get("commands", {})

    # ---------------------------------------------------------
    # Locking (session-aware, filesystem-backed)
    # ---------------------------------------------------------

    def _workspace_id(self, root: Path) -> str:
        return hashlib.sha256(str(root).encode()).hexdigest()[:16]

    def acquire(self, name: str, session_id: str) -> None:
        """Lock workspace for exclusive use, bound to a session."""
        if not session_id or not isinstance(session_id, str):
            raise ValueError("session_id is required")

        root = self.resolve_path(name)

        # Router-level mismatch guard first.
        if self._active_session_id is not None and self._active_session_id != session_id:
            raise WorkspaceLockedError(
                f"Workspace already locked by another session: {self._active_session_id}"
            )

        # Create/get the filesystem lock for this workspace root.
        ws_id = self._workspace_id(root)
        lock = get_workspace_lock(ws_id)

        try:
            lock.acquire(job_id=f"session:{session_id}", owner="adjutorix-agent", timeout=30)
        except LockError as e:
            # If the lock exists, surface owner metadata for debugging.
            owner = lock.owner()
            raise WorkspaceLockedError(f"Workspace already locked: {owner or str(e)}")

        self._lock = lock
        self._active_session_id = session_id
        self._active_root = root

    def release(self, session_id: str) -> None:
        """Release workspace lock, only if session_id matches."""
        if not session_id or not isinstance(session_id, str):
            raise ValueError("session_id is required")

        if self._active_session_id is None:
            return

        if self._active_session_id != session_id:
            raise WorkspaceLockedError(
                f"Refusing to release workspace lock: active={self._active_session_id} caller={session_id}"
            )

        if self._lock is not None:
            meta = self._lock.owner() or {}
            expected_job = f"session:{session_id}"
            if meta.get("job_id") and meta.get("job_id") != expected_job:
                raise WorkspaceLockedError(
                    f"Refusing to release: lock ownership mismatch (job_id={meta.get('job_id')} expected={expected_job})"
                )

            self._lock.release()

        self._lock = None
        self._active_session_id = None
        self._active_root = None

    def is_held(self) -> bool:
        """True if THIS router instance currently holds a workspace lock."""
        return bool(self._lock and self._lock.is_locked())

    def is_locked_for(self, name: str) -> bool:
        """True if the workspace is locked on disk (any process)."""
        root = self.resolve_path(name)
        ws_id = self._workspace_id(root)
        return get_workspace_lock(ws_id).is_locked()

    # Backward compatible: keep is_locked() as alias to is_held()
    def is_locked(self) -> bool:
        return self.is_held()

    # ---------------------------------------------------------
    # Context Builder
    # ---------------------------------------------------------

    def open_workspace(self, name: str, session_id: str) -> Dict[str, Any]:
        """Prepare full execution context for workspace (session-bound)."""
        self.acquire(name, session_id)

        root = self.resolve_path(name)

        policy = self.load_policy(name)
        toolchain = self.get_toolchain(name)
        commands = self.get_commands(name)

        return {
            "name": name,
            "root": root,
            "policy": policy,
            "toolchain": toolchain,
            "commands": commands,
            "session_id": session_id,
        }

    def close_workspace(self, session_id: str) -> None:
        """Close active workspace (session-bound)."""
        self.release(session_id)

    # ---------------------------------------------------------
    # Registration (optional helper)
    # ---------------------------------------------------------

    def register(
        self,
        name: str,
        path: Path,
        toolchain: str = "unknown",
        commands: Optional[Dict[str, str]] = None,
    ) -> None:
        """Register a new workspace and persist to config."""
        path = path.expanduser().resolve()

        if not path.exists():
            raise WorkspaceNotFound(str(path))

        # Enforce allow_roots on registration too.
        if not self._is_under_any_allow_root(path):
            roots = ", ".join(str(r) for r in self._allow_roots)
            raise WorkspaceNotFound(
                f"Refusing to register workspace outside allowlisted roots: {path} (allowed: {roots})"
            )

        if commands is None:
            commands = {}

        self._workspaces[name] = {
            "path": str(path),
            "toolchain": toolchain,
            "commands": commands,
        }

        self._persist()

    def unregister(self, name: str) -> None:
        """Remove workspace."""
        if name in self._workspaces:
            del self._workspaces[name]
            self._persist()

    def _persist(self) -> None:
        """Write back to ~/.agent/workspaces.yaml"""
        self.config_path.parent.mkdir(parents=True, exist_ok=True)

        data = {"workspaces": self._workspaces}

        with open(self.config_path, "w", encoding="utf-8") as f:
            yaml.safe_dump(data, f, sort_keys=False)

    # ---------------------------------------------------------
    # Debug
    # ---------------------------------------------------------

    def describe(self, name: str) -> Dict[str, Any]:
        """Return full workspace metadata."""
        root = self.resolve_path(name)

        return {
            "name": name,
            "root": str(root),
            "toolchain": self.get_toolchain(name),
            "commands": self.get_commands(name),
            "policy_loaded": (root / ".agent").exists(),
            "locked": self.is_locked(),
            "active_session_id": self._active_session_id,
        }
