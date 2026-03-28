"""
ADJUTORIX AGENT — CORE / PATCH_BUILDER

Deterministic patch construction engine.

Position in system:
- Called ONLY by patch_pipeline
- Receives validated intents + resolved snapshots
- Produces canonical DiffOp set with byte-accurate guarantees

Hard constraints:
- Pure function semantics (no I/O, no FS writes)
- Deterministic output
- Byte-level correctness (no lossy transforms)
- Stable ordering
- No implicit formatting, linting, or rewriting

Failure modes are explicit and typed.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import List, Tuple

import hashlib


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FileSnapshot:
    path: str
    content: str
    hash: str


@dataclass(frozen=True)
class DiffOp:
    op: str  # insert | delete | replace
    path: str
    start: int
    end: int
    content: str


@dataclass(frozen=True)
class BuildResult:
    ops: Tuple[DiffOp, ...]
    affected_files: Tuple[str, ...]
    content_hash: str


# ---------------------------------------------------------------------------
# INTERNAL VALIDATION
# ---------------------------------------------------------------------------


def _validate_range(start: int, end: int, content_len: int) -> None:
    if start < 0:
        raise RuntimeError("range_error: start < 0")
    if end < start:
        raise RuntimeError("range_error: end < start")
    if end > content_len:
        raise RuntimeError("range_error: end > content_length")


# ---------------------------------------------------------------------------
# LOW LEVEL BUILDERS
# ---------------------------------------------------------------------------


def build_replace(snapshot: FileSnapshot, start: int, end: int, new_content: str) -> DiffOp:
    _validate_range(start, end, len(snapshot.content))

    # idempotency check
    existing = snapshot.content[start:end]
    if existing == new_content:
        raise RuntimeError("no_op_replace")

    return DiffOp(
        op="replace",
        path=snapshot.path,
        start=start,
        end=end,
        content=new_content,
    )


def build_insert(snapshot: FileSnapshot, offset: int, content: str) -> DiffOp:
    _validate_range(offset, offset, len(snapshot.content))

    return DiffOp(
        op="insert",
        path=snapshot.path,
        start=offset,
        end=offset,
        content=content,
    )


def build_delete(snapshot: FileSnapshot, start: int, end: int) -> DiffOp:
    _validate_range(start, end, len(snapshot.content))

    if start == end:
        raise RuntimeError("no_op_delete")

    return DiffOp(
        op="delete",
        path=snapshot.path,
        start=start,
        end=end,
        content="",
    )


def build_create(path: str, content: str) -> DiffOp:
    return DiffOp(
        op="insert",
        path=path,
        start=0,
        end=0,
        content=content,
    )


def build_delete_file(snapshot: FileSnapshot) -> DiffOp:
    return DiffOp(
        op="delete",
        path=snapshot.path,
        start=0,
        end=len(snapshot.content),
        content="",
    )


# ---------------------------------------------------------------------------
# COMPOSITION
# ---------------------------------------------------------------------------


def _sort_ops(ops: List[DiffOp]) -> List[DiffOp]:
    return sorted(ops, key=lambda o: (o.path, o.start, o.end, o.op))


def _detect_overlap(ops: List[DiffOp]) -> None:
    by_file = {}
    for op in ops:
        by_file.setdefault(op.path, []).append(op)

    for path, items in by_file.items():
        items.sort(key=lambda x: x.start)
        for i in range(1, len(items)):
            prev = items[i - 1]
            curr = items[i]
            if curr.start < prev.end:
                raise RuntimeError(f"overlap_detected: {path}")


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _hash_ops(ops: List[DiffOp]) -> str:
    h = hashlib.sha256()
    for op in ops:
        h.update(op.path.encode())
        h.update(op.op.encode())
        h.update(str(op.start).encode())
        h.update(str(op.end).encode())
        h.update(op.content.encode())
    return h.hexdigest()


# ---------------------------------------------------------------------------
# PUBLIC BUILDER
# ---------------------------------------------------------------------------


class PatchBuilder:
    """
    Deterministic composition engine.
    """

    def build(self, ops: List[DiffOp]) -> BuildResult:
        if not ops:
            raise RuntimeError("empty_ops")

        # 1. detect overlap
        _detect_overlap(ops)

        # 2. canonical ordering
        ordered = _sort_ops(ops)

        # 3. affected files
        files = tuple(sorted({o.path for o in ordered}))

        # 4. hash
        content_hash = _hash_ops(ordered)

        return BuildResult(
            ops=tuple(ordered),
            affected_files=files,
            content_hash=content_hash,
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


_builder_singleton: PatchBuilder | None = None


def get_builder() -> PatchBuilder:
    global _builder_singleton
    if _builder_singleton is None:
        _builder_singleton = PatchBuilder()
    return _builder_singleton


def build_patch_ops(ops: List[DiffOp]) -> BuildResult:
    return get_builder().build(ops)
