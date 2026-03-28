"""
ADJUTORIX AGENT — CORE / PATCH_CONTEXT

Canonical, immutable PatchContext model.

Purpose:
- Single source of truth for everything required to build, verify, and apply a patch
- Binds together: intent, snapshot, environment, invariants, and lineage
- Provides deterministic hashing + identity
- Enforces immutability once constructed

Design constraints:
- Pure data + validation (NO I/O, NO side effects)
- All derived fields are computed deterministically
- Context identity MUST change if ANY input changes

Failure model:
- Raises RuntimeError with explicit codes
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional

import hashlib
import json


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class IntentDescriptor:
    kind: str
    target: str
    payload_hash: str


@dataclass(frozen=True)
class SnapshotDescriptor:
    workspace_hash: str
    file_hashes: Tuple[Tuple[str, str], ...]  # (path, hash)


@dataclass(frozen=True)
class EnvironmentDescriptor:
    runtime_version: str
    platform: str
    feature_flags: Tuple[Tuple[str, bool], ...]


@dataclass(frozen=True)
class LineageDescriptor:
    parent_tx: Optional[str]
    parent_patch: Optional[str]
    depth: int


# ---------------------------------------------------------------------------
# CONTEXT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PatchContext:
    # core inputs
    intents: Tuple[IntentDescriptor, ...]
    snapshot: SnapshotDescriptor
    environment: EnvironmentDescriptor
    lineage: LineageDescriptor

    # derived
    context_hash: str
    intent_hash: str
    snapshot_hash: str
    environment_hash: str


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def _stable_hash(obj: object) -> str:
    encoded = json.dumps(obj, sort_keys=True, separators=(",", ":")).encode()
    return hashlib.sha256(encoded).hexdigest()


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def build_intent_hash(intents: Tuple[IntentDescriptor, ...]) -> str:
    return _stable_hash([
        {
            "kind": i.kind,
            "target": i.target,
            "payload_hash": i.payload_hash,
        }
        for i in intents
    ])


def build_snapshot_hash(snapshot: SnapshotDescriptor) -> str:
    return _stable_hash({
        "workspace_hash": snapshot.workspace_hash,
        "file_hashes": list(snapshot.file_hashes),
    })


def build_environment_hash(env: EnvironmentDescriptor) -> str:
    return _stable_hash({
        "runtime_version": env.runtime_version,
        "platform": env.platform,
        "feature_flags": list(env.feature_flags),
    })


def build_context_hash(
    intent_hash: str,
    snapshot_hash: str,
    environment_hash: str,
    lineage: LineageDescriptor,
) -> str:
    return _stable_hash({
        "intent_hash": intent_hash,
        "snapshot_hash": snapshot_hash,
        "environment_hash": environment_hash,
        "lineage": {
            "parent_tx": lineage.parent_tx,
            "parent_patch": lineage.parent_patch,
            "depth": lineage.depth,
        },
    })


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


def _validate_intents(intents: Tuple[IntentDescriptor, ...]) -> None:
    if not intents:
        raise RuntimeError("context_error: empty_intents")

    seen = set()
    for i in intents:
        key = (i.kind, i.target, i.payload_hash)
        if key in seen:
            raise RuntimeError("context_error: duplicate_intent")
        seen.add(key)


def _validate_snapshot(snapshot: SnapshotDescriptor) -> None:
    if not snapshot.workspace_hash:
        raise RuntimeError("context_error: missing_workspace_hash")

    for path, h in snapshot.file_hashes:
        if not path or not h:
            raise RuntimeError("context_error: invalid_file_hash_entry")


def _validate_environment(env: EnvironmentDescriptor) -> None:
    if not env.runtime_version:
        raise RuntimeError("context_error: missing_runtime_version")


def _validate_lineage(lineage: LineageDescriptor) -> None:
    if lineage.depth < 0:
        raise RuntimeError("context_error: invalid_lineage_depth")


# ---------------------------------------------------------------------------
# PUBLIC FACTORY
# ---------------------------------------------------------------------------


def create_patch_context(
    intents: List[IntentDescriptor],
    snapshot: SnapshotDescriptor,
    environment: EnvironmentDescriptor,
    lineage: LineageDescriptor,
) -> PatchContext:
    intents_t = tuple(intents)

    _validate_intents(intents_t)
    _validate_snapshot(snapshot)
    _validate_environment(environment)
    _validate_lineage(lineage)

    intent_hash = build_intent_hash(intents_t)
    snapshot_hash = build_snapshot_hash(snapshot)
    environment_hash = build_environment_hash(environment)

    context_hash = build_context_hash(
        intent_hash,
        snapshot_hash,
        environment_hash,
        lineage,
    )

    return PatchContext(
        intents=intents_t,
        snapshot=snapshot,
        environment=environment,
        lineage=lineage,
        context_hash=context_hash,
        intent_hash=intent_hash,
        snapshot_hash=snapshot_hash,
        environment_hash=environment_hash,
    )


# ---------------------------------------------------------------------------
# COMPARISON
# ---------------------------------------------------------------------------


def contexts_equal(a: PatchContext, b: PatchContext) -> bool:
    return a.context_hash == b.context_hash


# ---------------------------------------------------------------------------
# SERIALIZATION
# ---------------------------------------------------------------------------


def serialize_context(ctx: PatchContext) -> Dict:
    return {
        "context_hash": ctx.context_hash,
        "intent_hash": ctx.intent_hash,
        "snapshot_hash": ctx.snapshot_hash,
        "environment_hash": ctx.environment_hash,
        "lineage": {
            "parent_tx": ctx.lineage.parent_tx,
            "parent_patch": ctx.lineage.parent_patch,
            "depth": ctx.lineage.depth,
        },
        "intents": [
            {
                "kind": i.kind,
                "target": i.target,
                "payload_hash": i.payload_hash,
            }
            for i in ctx.intents
        ],
    }


def deserialize_context(data: Dict) -> PatchContext:
    intents = tuple(
        IntentDescriptor(**i) for i in data["intents"]
    )

    snapshot = SnapshotDescriptor(
        workspace_hash=data["snapshot_hash"],
        file_hashes=(),  # not reconstructable here
    )

    environment = EnvironmentDescriptor(
        runtime_version="unknown",
        platform="unknown",
        feature_flags=(),
    )

    lineage = LineageDescriptor(**data["lineage"])

    return PatchContext(
        intents=intents,
        snapshot=snapshot,
        environment=environment,
        lineage=lineage,
        context_hash=data["context_hash"],
        intent_hash=data["intent_hash"],
        snapshot_hash=data["snapshot_hash"],
        environment_hash=data["environment_hash"],
    )
