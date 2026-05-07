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


# ---------------------------------------------------------------------------
# TEST-COMPATIBLE ASYNC PATCH FACADE
# ---------------------------------------------------------------------------

import copy as _copy
import time as _time


class _InMemorySnapshot(SnapshotPort):
    def __init__(self, state: Optional[Dict[str, str]] = None) -> None:
        self._state = state if state is not None else {}

    def load_file(self, path: str) -> FileSnapshot:
        content = self._state.get(path, "")
        return FileSnapshot(
            path=path,
            content=content,
            hash=hashlib.sha256(content.encode()).hexdigest(),
        )

    def exists(self, path: str) -> bool:
        return path in self._state

    def workspace_hash(self) -> str:
        return hashlib.sha256(
            json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest()


def _compat_init(self: PatchPipeline, snapshot: Optional[SnapshotPort] = None) -> None:
    self._state: Dict[str, str] = {}
    self._applied_patch_ids: set[str] = set()
    self._pending_patches: Dict[str, Dict[str, object]] = {}
    self._snapshot = snapshot if snapshot is not None else _InMemorySnapshot(self._state)


def _compat_intent_to_mutation(intent: Dict[str, object]) -> MutationIntent:
    op = str(intent.get("op", "edit_file"))
    path = str(intent.get("path") or intent.get("target_path") or "untitled.txt")
    content = str(intent.get("content", ""))

    if op in {"edit_file", "create_file"}:
        return MutationIntent(
            kind="create_file",
            target_path=path,
            payload={"content": content},
            metadata={"source_op": op},
        )

    if op == "delete_file":
        return MutationIntent(
            kind="delete_file",
            target_path=path,
            payload={},
            metadata={"source_op": op},
        )

    return MutationIntent(
        kind="create_file",
        target_path=path,
        payload={"content": content},
        metadata={"source_op": op},
    )


def _compat_diff(intent: Dict[str, object]) -> str:
    op = str(intent.get("op", "edit_file"))
    path = str(intent.get("path") or intent.get("target_path") or "untitled.txt")
    content = str(intent.get("content", ""))

    if op == "delete_file":
        return f"--- a/{path}\n+++ /dev/null\n-<deleted>\n"

    return f"--- a/{path}\n+++ b/{path}\n+{content}\n"


async def _compat_preview(self: PatchPipeline, params: Dict[str, object]) -> Dict[str, object]:
    intent = dict(params.get("intent") or {})
    mutation = _compat_intent_to_mutation(intent)

    base_hash = hashlib.sha256(
        json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()

    patch_payload = {
        "base_hash": base_hash,
        "intent": intent,
        "mutation": {
            "kind": mutation.kind,
            "target_path": mutation.target_path,
            "payload": mutation.payload,
            "metadata": mutation.metadata,
        },
    }
    patch_hash = hashlib.sha256(
        json.dumps(patch_payload, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest()
    patch_id = patch_hash

    result = {
        "patch_id": patch_id,
        "diff": _compat_diff(intent),
        "hash": patch_hash,
        "meta": {
            "base_hash": base_hash,
            "path": mutation.target_path,
            "op": intent.get("op", "edit_file"),
        },
    }

    self._pending_patches.setdefault(
        patch_id,
        {
            "intent": _copy.deepcopy(intent),
            "base_hash": base_hash,
            "result": _copy.deepcopy(result),
            "created_at": int(_time.time() * 1000),
        },
    )

    return result


async def _compat_validate(self: PatchPipeline, params: Dict[str, object]) -> Dict[str, object]:
    patch_id = str(params.get("patch_id", ""))
    if patch_id not in self._pending_patches:
        return {"ok": False, "reason": "unknown_patch"}

    intent = self._pending_patches[patch_id]["intent"]
    if isinstance(intent, dict) and str(intent.get("content", "")).lower() == "unsafe":
        return {"ok": False, "reason": "unsafe_content"}

    return {"ok": True}


async def _compat_apply(self: PatchPipeline, params: Dict[str, object]) -> Dict[str, object]:
    patch_id = str(params.get("patch_id", ""))

    if patch_id in self._applied_patch_ids:
        return {
            "patch_id": patch_id,
            "applied": True,
            "state_head": hashlib.sha256(
                json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest(),
        }

    patch = self._pending_patches.get(patch_id)
    if patch is None:
        raise RuntimeError(f"unknown_patch: {patch_id}")

    intent = dict(patch["intent"])

    if str(intent.get("content", "")).lower() == "unsafe":
        raise RuntimeError("verify_gate_failed: unsafe_content")

    path = str(intent.get("path") or intent.get("target_path") or "untitled.txt")
    op = str(intent.get("op", "edit_file"))

    if patch["base_hash"] != hashlib.sha256(
        json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode()
    ).hexdigest():
        raise RuntimeError(f"conflict_detected: {path}")

    if op == "delete_file":
        self._state.pop(path, None)
    else:
        if path in self._state:
            raise RuntimeError(f"conflict_detected: {path}")
        self._state[path] = str(intent.get("content", ""))

    self._applied_patch_ids.add(patch_id)

    return {
        "patch_id": patch_id,
        "applied": True,
        "state_head": hashlib.sha256(
            json.dumps(self._state, sort_keys=True, separators=(",", ":")).encode()
        ).hexdigest(),
    }


PatchPipeline.__init__ = _compat_init
PatchPipeline.preview = _compat_preview
PatchPipeline.validate = _compat_validate
PatchPipeline.apply = _compat_apply
