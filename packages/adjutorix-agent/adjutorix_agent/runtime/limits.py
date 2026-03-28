"""
ADJUTORIX AGENT — RUNTIME LIMITS

Hard, centrally-validated operational limits.

Properties:
- Deterministic (no env drift after bootstrap)
- Total (every limit has an explicit bound)
- Enforced at call-sites via guard helpers
- Serializable for ledger traceability

This module is the SINGLE SOURCE for all quantitative constraints.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict
import json
import hashlib


# ---------------------------------------------------------------------------
# SCHEMA
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Limits:
    # Concurrency / scheduling
    max_concurrent_jobs: int
    max_queue_size: int

    # Patch constraints
    max_patch_files: int
    max_patch_bytes: int
    max_diff_hunks_per_file: int

    # Snapshot / workspace
    max_snapshot_files: int
    max_snapshot_bytes: int

    # Verify
    verify_timeout_seconds: int
    max_verify_output_bytes: int

    # Indexing
    max_index_files: int
    max_index_bytes: int

    # Shell / command
    max_command_seconds: int
    max_command_output_bytes: int

    # Ledger
    max_ledger_tx_per_batch: int

    # Safety
    max_path_length: int


DEFAULT_LIMITS: Limits = Limits(
    max_concurrent_jobs=1,
    max_queue_size=128,

    max_patch_files=256,
    max_patch_bytes=5 * 1024 * 1024,          # 5 MB
    max_diff_hunks_per_file=2048,

    max_snapshot_files=50_000,
    max_snapshot_bytes=500 * 1024 * 1024,     # 500 MB

    verify_timeout_seconds=600,
    max_verify_output_bytes=20 * 1024 * 1024, # 20 MB

    max_index_files=200_000,
    max_index_bytes=2 * 1024 * 1024 * 1024,   # 2 GB

    max_command_seconds=300,
    max_command_output_bytes=10 * 1024 * 1024,

    max_ledger_tx_per_batch=10_000,

    max_path_length=4096,
)


# ---------------------------------------------------------------------------
# BUILD / VALIDATION
# ---------------------------------------------------------------------------


def _coerce_int(name: str, v: Any) -> int:
    if not isinstance(v, int):
        raise RuntimeError(f"Limit {name} must be int")
    if v <= 0:
        raise RuntimeError(f"Limit {name} must be > 0")
    return v


def build_limits(config: Dict[str, Any]) -> Limits:
    raw: Dict[str, Any] = config.get("limits", {})

    # start from defaults
    d = DEFAULT_LIMITS.__dict__.copy()

    # override with config
    for k, v in raw.items():
        if k not in d:
            raise RuntimeError(f"Unknown limit: {k}")
        d[k] = _coerce_int(k, v)

    limits = Limits(**d)  # type: ignore[arg-type]
    _validate_cross(limits, config)
    return limits


def _validate_cross(l: Limits, config: Dict[str, Any]) -> None:
    # sequential invariant
    if config.get("runtime", {}).get("strict_sequential_mutations", True):
        if l.max_concurrent_jobs != 1:
            raise RuntimeError("Invariant: sequential mutations require max_concurrent_jobs=1")

    # queue must dominate concurrency
    if l.max_queue_size < l.max_concurrent_jobs:
        raise RuntimeError("Invalid: queue size must be >= concurrency")

    # patch vs snapshot sanity
    if l.max_patch_files > l.max_snapshot_files:
        raise RuntimeError("Invalid: patch files cannot exceed snapshot files")

    if l.max_patch_bytes > l.max_snapshot_bytes:
        raise RuntimeError("Invalid: patch bytes cannot exceed snapshot bytes")

    # verify output should not exceed snapshot cap (avoid disk blowups)
    if l.max_verify_output_bytes > l.max_snapshot_bytes:
        raise RuntimeError("Invalid: verify output exceeds snapshot capacity")


# ---------------------------------------------------------------------------
# GUARDS (RAISE FAST)
# ---------------------------------------------------------------------------


def guard_patch(l: Limits, *, files: int, bytes_: int, hunks_per_file: int) -> None:
    if files > l.max_patch_files:
        raise RuntimeError(f"Patch files limit exceeded: {files}>{l.max_patch_files}")
    if bytes_ > l.max_patch_bytes:
        raise RuntimeError(f"Patch size limit exceeded: {bytes_}>{l.max_patch_bytes}")
    if hunks_per_file > l.max_diff_hunks_per_file:
        raise RuntimeError("Diff hunks per file limit exceeded")


def guard_snapshot(l: Limits, *, files: int, bytes_: int) -> None:
    if files > l.max_snapshot_files:
        raise RuntimeError("Snapshot file count limit exceeded")
    if bytes_ > l.max_snapshot_bytes:
        raise RuntimeError("Snapshot size limit exceeded")


def guard_verify(l: Limits, *, timeout_s: int, output_bytes: int) -> None:
    if timeout_s > l.verify_timeout_seconds:
        raise RuntimeError("Verify timeout exceeds limit")
    if output_bytes > l.max_verify_output_bytes:
        raise RuntimeError("Verify output exceeds limit")


def guard_index(l: Limits, *, files: int, bytes_: int) -> None:
    if files > l.max_index_files:
        raise RuntimeError("Index file count limit exceeded")
    if bytes_ > l.max_index_bytes:
        raise RuntimeError("Index size limit exceeded")


def guard_command(l: Limits, *, duration_s: int, output_bytes: int) -> None:
    if duration_s > l.max_command_seconds:
        raise RuntimeError("Command duration exceeds limit")
    if output_bytes > l.max_command_output_bytes:
        raise RuntimeError("Command output exceeds limit")


def guard_ledger_batch(l: Limits, *, tx_count: int) -> None:
    if tx_count > l.max_ledger_tx_per_batch:
        raise RuntimeError("Ledger batch size exceeds limit")


def guard_path(l: Limits, *, path: str) -> None:
    if len(path) > l.max_path_length:
        raise RuntimeError("Path length exceeds limit")


# ---------------------------------------------------------------------------
# TRACEABILITY
# ---------------------------------------------------------------------------


def snapshot(l: Limits) -> Dict[str, int]:
    return dict(sorted(l.__dict__.items()))


def fingerprint(l: Limits) -> str:
    encoded = json.dumps(snapshot(l), separators=(",", ":"), sort_keys=True)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


__all__ = [
    "Limits",
    "DEFAULT_LIMITS",
    "build_limits",
    "guard_patch",
    "guard_snapshot",
    "guard_verify",
    "guard_index",
    "guard_command",
    "guard_ledger_batch",
    "guard_path",
    "snapshot",
    "fingerprint",
]
