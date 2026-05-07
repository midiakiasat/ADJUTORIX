"""
ADJUTORIX AGENT — CORE / SNAPSHOT_GUARD

Hard safety boundary enforcing snapshot validity before ANY mutation or verification.

Responsibilities:
- Detect stale base snapshots
- Enforce snapshot lineage consistency
- Prevent applying patch on diverged workspace
- Validate snapshot ↔ patch compatibility
- Guarantee deterministic preconditions for patch_pipeline + verify_pipeline

This is a CRITICAL SAFETY MODULE.
If this fails → mutation MUST NOT proceed.

Hard invariants:
- Snapshot hash must match current workspace state when required
- Patch base snapshot must equal active snapshot
- No implicit rebasing
- No silent conflict resolution
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, Optional


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SnapshotRef:
    snapshot_id: str


@dataclass(frozen=True)
class WorkspaceState:
    current_snapshot_id: str
    workspace_hash: str


@dataclass(frozen=True)
class PatchBase:
    base_snapshot_id: str
    base_hash: str


# ---------------------------------------------------------------------------
# ERRORS
# ---------------------------------------------------------------------------


class SnapshotGuardError(RuntimeError):
    pass


# ---------------------------------------------------------------------------
# GUARD
# ---------------------------------------------------------------------------


class SnapshotGuard:
    """
    Enforces snapshot correctness across pipeline boundaries.
    """

    def assert_exists(self, snapshot_id: str, known_snapshots: Dict[str, str]) -> None:
        if snapshot_id not in known_snapshots:
            raise SnapshotGuardError(f"snapshot_missing: {snapshot_id}")

    def assert_matches_workspace(
        self,
        workspace: WorkspaceState,
        expected_snapshot_id: str,
    ) -> None:
        if workspace.current_snapshot_id != expected_snapshot_id:
            raise SnapshotGuardError(
                f"stale_snapshot: expected={expected_snapshot_id} actual={workspace.current_snapshot_id}"
            )

    def assert_patch_base_valid(
        self,
        patch: PatchBase,
        workspace: WorkspaceState,
    ) -> None:
        if patch.base_snapshot_id != workspace.current_snapshot_id:
            raise SnapshotGuardError(
                f"patch_base_mismatch: patch={patch.base_snapshot_id} workspace={workspace.current_snapshot_id}"
            )

    def assert_hash_consistency(
        self,
        patch: PatchBase,
        actual_hash: str,
    ) -> None:
        if patch.base_hash != actual_hash:
            raise SnapshotGuardError(
                f"snapshot_hash_mismatch: patch={patch.base_hash} actual={actual_hash}"
            )

    def assert_no_rebase_required(
        self,
        patch: PatchBase,
        workspace: WorkspaceState,
    ) -> None:
        if patch.base_snapshot_id != workspace.current_snapshot_id:
            raise SnapshotGuardError("rebase_required")

    def validate_full(
        self,
        patch: PatchBase,
        workspace: WorkspaceState,
        known_snapshots: Dict[str, str],
    ) -> None:
        """
        Full validation entrypoint.
        """
        self.assert_exists(patch.base_snapshot_id, known_snapshots)
        self.assert_patch_base_valid(patch, workspace)
        self.assert_hash_consistency(patch, workspace.workspace_hash)
        self.assert_no_rebase_required(patch, workspace)


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


_guard_singleton: Optional[SnapshotGuard] = None


def get_snapshot_guard() -> SnapshotGuard:
    global _guard_singleton
    if _guard_singleton is None:
        _guard_singleton = SnapshotGuard()
    return _guard_singleton


def validate_snapshot_guard(
    patch: PatchBase,
    workspace: WorkspaceState,
    known_snapshots: Dict[str, str],
) -> None:
    get_snapshot_guard().validate_full(patch, workspace, known_snapshots)


# ---------------------------------------------------------------------------
# TEST / DICT-COMPAT SNAPSHOT GUARD SURFACE
# ---------------------------------------------------------------------------

if not getattr(SnapshotGuard, "_adjutorix_compat_surface_v2", False):
    import json as _sg_json
    import math as _sg_math
    import re as _sg_re

    def _sg_walk_validate_json_safe(value, path="$"):
        if isinstance(value, float):
            if not _sg_math.isfinite(value):
                raise ValueError(f"invalid non-finite float at {path}")
            return
        if isinstance(value, dict):
            for key, item in value.items():
                if not isinstance(key, str):
                    raise ValueError(f"invalid non-string key at {path}")
                _sg_walk_validate_json_safe(item, f"{path}.{key}")
            return
        if isinstance(value, (list, tuple)):
            for index, item in enumerate(value):
                _sg_walk_validate_json_safe(item, f"{path}[{index}]")
            return
        if value is None or isinstance(value, (str, int, bool, bytes)):
            return
        raise ValueError(f"invalid snapshot value at {path}: {type(value).__name__}")

    def _sg_compat_validate_put(self, content):
        if content is None:
            raise ValueError("snapshot content is required")
        _sg_walk_validate_json_safe(content)
        _sg_json.dumps(content, sort_keys=True, separators=(",", ":"), allow_nan=False, default=str)
        if isinstance(content, (str, bytes)) and len(content) > 10_000_000:
            raise ValueError("snapshot content too large")
        return None

    def _sg_compat_validate_get(self, snapshot_id):
        sid = str(snapshot_id or "")
        if not _sg_re.fullmatch(r"[0-9a-f]{32,128}", sid):
            raise ValueError("snapshot_id must be hash-like")
        return None

    def _sg_compat_validate_delete(self, snapshot_id):
        return _sg_compat_validate_get(self, snapshot_id)

    def _sg_compat_validate_list(self):
        return None

    SnapshotGuard.validate_put = _sg_compat_validate_put
    SnapshotGuard.validate_get = _sg_compat_validate_get
    SnapshotGuard.validate_delete = _sg_compat_validate_delete
    SnapshotGuard.validate_list = _sg_compat_validate_list
    SnapshotGuard._adjutorix_compat_surface_v1 = True
    SnapshotGuard._adjutorix_compat_surface_v2 = True
