"""
ADJUTORIX AGENT — LEDGER / ARTIFACTS

Artifact construction, normalization, hashing, and verification.

Artifacts are immutable, content-addressed outputs of jobs:
- patch artifacts (normalized ops + base snapshot)
- verification artifacts (stage results, diagnostics, timings)
- rollback artifacts (plan + execution result)

Responsibilities:
- Canonicalize artifact payloads (ordering, schemas)
- Compute stable hashes (content addressing)
- Validate artifact integrity against schema + optional cross-checks
- Provide merge/compose utilities for multi-stage artifacts

Hard invariants:
- Artifact hash = hash(canonical_payload)
- No hidden fields; all inputs explicit
- Deterministic serialization (sorted keys, stable tuples)
- Cross-artifact references must be verifiable (e.g., patch → snapshot)
"""

from __future__ import annotations

from dataclasses import dataclass, asdict, field
from typing import Dict, Tuple, List, Optional, Any

import hashlib
import json
import time


# ---------------------------------------------------------------------------
# BASE
# ---------------------------------------------------------------------------


def _stable_json(obj: object) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def stable_hash(obj: object) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# PATCH ARTIFACT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PatchOp:
    op: str
    path: str
    value: Optional[Any] = None
    from_path: Optional[str] = None


@dataclass(frozen=True)
class PatchArtifact:
    patch_id: str
    base_snapshot_id: str
    ops: Tuple[PatchOp, ...]
    ops_hash: str
    created_at_ms: int


class PatchArtifactBuilder:
    def build(self, patch_id: str, base_snapshot_id: str, ops: Tuple[PatchOp, ...]) -> PatchArtifact:
        norm_ops = self._normalize_ops(ops)
        ops_hash = stable_hash([asdict(o) for o in norm_ops])
        return PatchArtifact(
            patch_id=patch_id,
            base_snapshot_id=base_snapshot_id,
            ops=norm_ops,
            ops_hash=ops_hash,
            created_at_ms=int(time.time() * 1000),
        )

    def _normalize_ops(self, ops: Tuple[PatchOp, ...]) -> Tuple[PatchOp, ...]:
        # deterministic ordering by (path, op, from_path, value-hash)
        def key(o: PatchOp):
            vhash = stable_hash(o.value) if o.value is not None else ""
            return (o.path, o.op, o.from_path or "", vhash)

        return tuple(sorted(ops, key=key))


# ---------------------------------------------------------------------------
# VERIFICATION ARTIFACT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class VerifyStage:
    name: str
    success: bool
    duration_ms: int
    diagnostics: Tuple[Dict[str, Any], ...] = field(default_factory=tuple)


@dataclass(frozen=True)
class VerificationArtifact:
    tx_id: str
    snapshot_id: str
    stages: Tuple[VerifyStage, ...]
    aggregate_success: bool
    summary_hash: str
    created_at_ms: int


class VerificationArtifactBuilder:
    def build(self, tx_id: str, snapshot_id: str, stages: Tuple[VerifyStage, ...]) -> VerificationArtifact:
        agg = all(s.success for s in stages)
        payload = {
            "tx_id": tx_id,
            "snapshot_id": snapshot_id,
            "stages": [
                {
                    "name": s.name,
                    "success": s.success,
                    "duration_ms": s.duration_ms,
                    "diagnostics": list(s.diagnostics),
                }
                for s in stages
            ],
            "aggregate_success": agg,
        }
        summary_hash = stable_hash(payload)
        return VerificationArtifact(
            tx_id=tx_id,
            snapshot_id=snapshot_id,
            stages=stages,
            aggregate_success=agg,
            summary_hash=summary_hash,
            created_at_ms=int(time.time() * 1000),
        )


# ---------------------------------------------------------------------------
# ROLLBACK ARTIFACT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class RollbackStepRecord:
    step_id: str
    action: str
    target: str


@dataclass(frozen=True)
class RollbackExecution:
    success: bool
    executed_steps: Tuple[str, ...]
    failed_step: Optional[str]
    duration_ms: int


@dataclass(frozen=True)
class RollbackArtifact:
    tx_id: str
    plan_hash: str
    steps: Tuple[RollbackStepRecord, ...]
    execution: RollbackExecution
    artifact_hash: str
    created_at_ms: int


class RollbackArtifactBuilder:
    def build(
        self,
        tx_id: str,
        plan_hash: str,
        steps: Tuple[RollbackStepRecord, ...],
        execution: RollbackExecution,
    ) -> RollbackArtifact:
        payload = {
            "tx_id": tx_id,
            "plan_hash": plan_hash,
            "steps": [asdict(s) for s in steps],
            "execution": asdict(execution),
        }
        artifact_hash = stable_hash(payload)
        return RollbackArtifact(
            tx_id=tx_id,
            plan_hash=plan_hash,
            steps=steps,
            execution=execution,
            artifact_hash=artifact_hash,
            created_at_ms=int(time.time() * 1000),
        )


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


class ArtifactValidationError(RuntimeError):
    pass


class ArtifactValidator:
    def validate_patch(self, art: PatchArtifact) -> None:
        if not art.patch_id or not art.base_snapshot_id:
            raise ArtifactValidationError("invalid_patch_identity")
        if not art.ops:
            raise ArtifactValidationError("empty_patch_ops")
        # recompute ops hash
        recomputed = stable_hash([asdict(o) for o in art.ops])
        if recomputed != art.ops_hash:
            raise ArtifactValidationError("ops_hash_mismatch")

    def validate_verification(self, art: VerificationArtifact) -> None:
        if not art.tx_id or not art.snapshot_id:
            raise ArtifactValidationError("invalid_verification_identity")
        payload = {
            "tx_id": art.tx_id,
            "snapshot_id": art.snapshot_id,
            "stages": [
                {
                    "name": s.name,
                    "success": s.success,
                    "duration_ms": s.duration_ms,
                    "diagnostics": list(s.diagnostics),
                }
                for s in art.stages
            ],
            "aggregate_success": art.aggregate_success,
        }
        if stable_hash(payload) != art.summary_hash:
            raise ArtifactValidationError("verification_hash_mismatch")

    def validate_rollback(self, art: RollbackArtifact) -> None:
        if not art.tx_id or not art.plan_hash:
            raise ArtifactValidationError("invalid_rollback_identity")
        payload = {
            "tx_id": art.tx_id,
            "plan_hash": art.plan_hash,
            "steps": [asdict(s) for s in art.steps],
            "execution": asdict(art.execution),
        }
        if stable_hash(payload) != art.artifact_hash:
            raise ArtifactValidationError("rollback_hash_mismatch")


# ---------------------------------------------------------------------------
# COMPOSITION UTILS
# ---------------------------------------------------------------------------


def merge_verification_stages(a: Tuple[VerifyStage, ...], b: Tuple[VerifyStage, ...]) -> Tuple[VerifyStage, ...]:
    # stable merge by stage name; later stages override earlier duplicates
    by_name: Dict[str, VerifyStage] = {s.name: s for s in a}
    for s in b:
        by_name[s.name] = s
    return tuple(sorted(by_name.values(), key=lambda s: s.name))


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


_validator_singleton: Optional[ArtifactValidator] = None


def get_artifact_validator() -> ArtifactValidator:
    global _validator_singleton
    if _validator_singleton is None:
        _validator_singleton = ArtifactValidator()
    return _validator_singleton
