"""
ADJUTORIX AGENT — FILESYSTEM PATHS

Canonical path resolution and isolation layer.

This module defines ALL filesystem locations used by the agent.
NO OTHER MODULE may construct raw paths outside this layer.

Hard guarantees:
- No path traversal
- No escaping workspace boundary
- Deterministic layout
- Cross-platform normalization
- Explicit separation of:
    - canonical workspace
    - ephemeral workspaces
    - storage (snapshots, artifacts, ledger)

All paths are absolute, normalized, and validated.
"""

from __future__ import annotations

import os
import hashlib
from pathlib import Path
from dataclasses import dataclass
from typing import Final


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------

ROOT_ENV_VAR: Final[str] = "ADJUTORIX_ROOT"
DEFAULT_ROOT: Final[str] = os.path.expanduser("~/.adjutorix")

EPHEMERAL_DIR: Final[str] = "ephemeral"
SNAPSHOT_DIR: Final[str] = "snapshots"
ARTIFACT_DIR: Final[str] = "artifacts"
LEDGER_DIR: Final[str] = "ledger"
LOCK_DIR: Final[str] = "locks"
INDEX_DIR: Final[str] = "index"


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _normalize(path: Path) -> Path:
    return path.resolve(strict=False)


def _ensure_dir(path: Path) -> Path:
    path.mkdir(parents=True, exist_ok=True)
    return path


def _safe_join(base: Path, *parts: str) -> Path:
    candidate = _normalize(base.joinpath(*parts))
    if not str(candidate).startswith(str(base)):
        raise RuntimeError(f"Path escape detected: {candidate} not under {base}")
    return candidate


def _hash_id(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:32]


# ---------------------------------------------------------------------------
# ROOT RESOLUTION
# ---------------------------------------------------------------------------


def get_root() -> Path:
    root = os.environ.get(ROOT_ENV_VAR, DEFAULT_ROOT)
    path = _normalize(Path(root))
    return _ensure_dir(path)


# ---------------------------------------------------------------------------
# DOMAIN STRUCTURE
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Paths:
    root: Path
    ephemeral: Path
    snapshots: Path
    artifacts: Path
    ledger: Path
    locks: Path
    index: Path



def resolve_paths() -> Paths:
    root = get_root()

    return Paths(
        root=root,
        ephemeral=_ensure_dir(_safe_join(root, EPHEMERAL_DIR)),
        snapshots=_ensure_dir(_safe_join(root, SNAPSHOT_DIR)),
        artifacts=_ensure_dir(_safe_join(root, ARTIFACT_DIR)),
        ledger=_ensure_dir(_safe_join(root, LEDGER_DIR)),
        locks=_ensure_dir(_safe_join(root, LOCK_DIR)),
        index=_ensure_dir(_safe_join(root, INDEX_DIR)),
    )


# ---------------------------------------------------------------------------
# WORKSPACE PATHS
# ---------------------------------------------------------------------------


def workspace_id(path: Path) -> str:
    """
    Deterministic workspace identity based on absolute path.
    """
    return _hash_id(str(_normalize(path)))


def ephemeral_workspace_dir(workspace_path: Path, run_id: str) -> Path:
    """
    Each verification run gets isolated workspace.
    """
    paths = resolve_paths()
    wid = workspace_id(workspace_path)
    return _ensure_dir(_safe_join(paths.ephemeral, wid, run_id))


# ---------------------------------------------------------------------------
# SNAPSHOT PATHS
# ---------------------------------------------------------------------------


def snapshot_dir(workspace_path: Path) -> Path:
    paths = resolve_paths()
    wid = workspace_id(workspace_path)
    return _ensure_dir(_safe_join(paths.snapshots, wid))


def snapshot_file(workspace_path: Path, snapshot_id: str) -> Path:
    base = snapshot_dir(workspace_path)
    return _safe_join(base, f"{snapshot_id}.tar.zst")


# ---------------------------------------------------------------------------
# ARTIFACT PATHS
# ---------------------------------------------------------------------------


def artifact_dir(tx_id: str) -> Path:
    paths = resolve_paths()
    return _ensure_dir(_safe_join(paths.artifacts, tx_id))


def artifact_file(tx_id: str, name: str) -> Path:
    base = artifact_dir(tx_id)
    return _safe_join(base, name)


# ---------------------------------------------------------------------------
# LEDGER PATHS
# ---------------------------------------------------------------------------


def ledger_db_path() -> Path:
    paths = resolve_paths()
    return _safe_join(paths.ledger, "ledger.db")


# ---------------------------------------------------------------------------
# LOCK PATHS
# ---------------------------------------------------------------------------


def process_lock_file(name: str) -> Path:
    paths = resolve_paths()
    return _safe_join(paths.locks, f"{name}.lock")


# ---------------------------------------------------------------------------
# INDEX PATHS
# ---------------------------------------------------------------------------


def index_dir(workspace_path: Path) -> Path:
    paths = resolve_paths()
    wid = workspace_id(workspace_path)
    return _ensure_dir(_safe_join(paths.index, wid))


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


def assert_within_workspace(base: Path, target: Path) -> None:
    base = _normalize(base)
    target = _normalize(target)

    if not str(target).startswith(str(base)):
        raise RuntimeError(
            f"Workspace escape attempt: target={target} base={base}"
        )


__all__ = [
    "Paths",
    "resolve_paths",
    "workspace_id",
    "ephemeral_workspace_dir",
    "snapshot_dir",
    "snapshot_file",
    "artifact_dir",
    "artifact_file",
    "ledger_db_path",
    "process_lock_file",
    "index_dir",
    "assert_within_workspace",
]
