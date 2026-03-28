"""
ADJUTORIX AGENT — CORE / PATCH_PIPELINE

Single authoritative entrypoint for patch creation.

Responsibilities:
- Accept mutation intents (structured, not free-form text)
- Resolve target workspace + snapshot base
- Build deterministic patch artifacts (file-level ops)
- Validate preconditions and conflicts
- Produce immutable PatchArtifact for verification stage

Hard invariants:
- No patch creation outside this module
- Deterministic: same (snapshot, intent) => identical patch
- No side effects (no file writes here)
- All outputs are pure artifacts

Pipeline stages:
1. Normalize intent
2. Resolve targets (files, ranges, symbols)
3. Load snapshot (read-only)
4. Compute diff operations
5. Validate preconditions
6. Detect conflicts
7. Normalize + canonicalize patch
8. Emit PatchArtifact
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

import hashlib
import json


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class MutationIntent:
    """
    Structured mutation request.
    Must be fully explicit — no ambiguity allowed.
    """

    kind: str  # e.g. "replace_range", "create_file", "delete_file"
    target_path: str
    payload: Dict[str, str]
    metadata: Dict[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class FileSnapshot:
    path: str
    content: str
    hash: str


@dataclass(frozen=True)
class DiffOp:
    op: str  # "insert" | "delete" | "replace"
    path: str
    start: int
    end: int
    content: str


@dataclass(frozen=True)
class PatchArtifact:
    patch_id: str
    base_snapshot_hash: str
    ops: Tuple[DiffOp, ...]
    metadata: Dict[str, str]


# ---------------------------------------------------------------------------
# SNAPSHOT PORT
# ---------------------------------------------------------------------------


class SnapshotPort:
    """
    Adapter must provide deterministic read access to workspace snapshot.
    """

    def load_file(self, path: str) -> FileSnapshot: ...

    def exists(self, path: str) -> bool: ...

    def workspace_hash(self) -> str: ...


# ---------------------------------------------------------------------------
# PRECONDITIONS
# ---------------------------------------------------------------------------


def _check_preconditions(intent: MutationIntent, snap: SnapshotPort) -> None:
    if intent.kind == "replace_range":
        if not snap.exists(intent.target_path):
            raise RuntimeError(f"precondition_failed: file_not_found: {intent.target_path}")

    if intent.kind == "create_file":
        if snap.exists(intent.target_path):
            raise RuntimeError(f"precondition_failed: file_exists: {intent.target_path}")

    if intent.kind == "delete_file":
        if not snap.exists(intent.target_path):
            raise RuntimeError(f"precondition_failed: file_not_found: {intent.target_path}")


# ---------------------------------------------------------------------------
# DIFF BUILDERS
# ---------------------------------------------------------------------------


def _build_replace_range(intent: MutationIntent, file: FileSnapshot) -> DiffOp:
    start = int(intent.payload["start"])
    end = int(intent.payload["end"])
    new_content = intent.payload["content"]

    if start < 0 or end < start or end > len(file.content):
        raise RuntimeError("invalid_range")

    return DiffOp(
        op="replace",
        path=file.path,
        start=start,
        end=end,
        content=new_content,
    )


def _build_create_file(intent: MutationIntent) -> DiffOp:
    return DiffOp(
        op="insert",
        path=intent.target_path,
        start=0,
        end=0,
        content=intent.payload.get("content", ""),
    )


def _build_delete_file(intent: MutationIntent, file: FileSnapshot) -> DiffOp:
    return DiffOp(
        op="delete",
        path=file.path,
        start=0,
        end=len(file.content),
        content="",
    )


# ---------------------------------------------------------------------------
# CONFLICT DETECTION
# ---------------------------------------------------------------------------


def _detect_conflicts(ops: List[DiffOp]) -> None:
    # simple overlap detection per file
    by_file: Dict[str, List[DiffOp]] = {}

    for op in ops:
        by_file.setdefault(op.path, []).append(op)

    for path, file_ops in by_file.items():
        file_ops.sort(key=lambda x: x.start)
        for i in range(1, len(file_ops)):
            prev = file_ops[i - 1]
            curr = file_ops[i]
            if curr.start < prev.end:
                raise RuntimeError(f"conflict_detected: {path}")


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _normalize_ops(ops: List[DiffOp]) -> Tuple[DiffOp, ...]:
    # canonical ordering: path, start
    ops_sorted = sorted(ops, key=lambda o: (o.path, o.start, o.end))
    return tuple(ops_sorted)


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _hash_patch(base_hash: str, ops: Tuple[DiffOp, ...]) -> str:
    h = hashlib.sha256()
    h.update(base_hash.encode())
    for op in ops:
        h.update(json.dumps(op.__dict__, sort_keys=True).encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# PIPELINE
# ---------------------------------------------------------------------------


class PatchPipeline:
    """
    Stateless deterministic builder.
    """

    def __init__(self, snapshot: SnapshotPort) -> None:
        self._snapshot = snapshot

    def build(self, intents: List[MutationIntent]) -> PatchArtifact:
        if not intents:
            raise RuntimeError("empty_intents")

        # 1. preconditions
        for intent in intents:
            _check_preconditions(intent, self._snapshot)

        # 2. build ops
        ops: List[DiffOp] = []

        for intent in intents:
            if intent.kind == "replace_range":
                file = self._snapshot.load_file(intent.target_path)
                ops.append(_build_replace_range(intent, file))

            elif intent.kind == "create_file":
                ops.append(_build_create_file(intent))

            elif intent.kind == "delete_file":
                file = self._snapshot.load_file(intent.target_path)
                ops.append(_build_delete_file(intent, file))

            else:
                raise RuntimeError(f"unsupported_intent: {intent.kind}")

        # 3. conflicts
        _detect_conflicts(ops)

        # 4. normalize
        ops_norm = _normalize_ops(ops)

        # 5. base hash
        base_hash = self._snapshot.workspace_hash()

        # 6. patch id
        patch_id = _hash_patch(base_hash, ops_norm)

        # 7. artifact
        return PatchArtifact(
            patch_id=patch_id,
            base_snapshot_hash=base_hash,
            ops=ops_norm,
            metadata={
                "intent_count": str(len(intents)),
            },
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_patch(snapshot: SnapshotPort, intents: List[MutationIntent]) -> PatchArtifact:
    return PatchPipeline(snapshot).build(intents)
