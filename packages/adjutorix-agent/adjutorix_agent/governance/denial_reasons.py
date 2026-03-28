"""
ADJUTORIX AGENT — GOVERNANCE / DENIAL_REASONS

Canonical, structured denial reasons and normalization utilities.

This module defines the ONLY allowed taxonomy for denial reasons across the
system. All components (policy_engine, command_guard, governed_targets,
apply_gate, secrets_guard, etc.) MUST use these codes when denying actions.

Goals:
- Eliminate free-form denial strings (no ambiguity, no drift)
- Provide machine-actionable reasons with stable codes
- Support rich, structured metadata for diagnostics and UI
- Enable deterministic hashing and aggregation across decisions

Hard invariants:
- Every denial MUST map to a registered DenialCode
- Codes are stable and versioned (no silent mutation)
- Reasons are composable and serializable
- Textual messages are derived, not authoritative
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, Tuple, Optional, Any, Iterable

import hashlib
import json


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


DenialCode = str


@dataclass(frozen=True)
class DenialReason:
    code: DenialCode
    message: str
    context: Dict[str, Any]
    reason_hash: str


# ---------------------------------------------------------------------------
# REGISTRY
# ---------------------------------------------------------------------------


class DenialRegistry:
    """
    Central registry of all allowed denial codes.
    """

    _CODES: Dict[DenialCode, str] = {
        # policy
        "policy_denied": "Denied by policy",
        "no_matching_rule": "No policy rule matched",

        # command
        "command_forbidden_pattern": "Forbidden shell pattern detected",
        "command_not_allowed": "Command not allowed by policy",
        "command_timeout": "Command execution timed out",
        "executable_not_found": "Executable not found",
        "executable_not_allowed": "Executable not in whitelist",

        # targets
        "target_outside_workspace": "Target outside workspace",
        "target_not_found": "Target not found",
        "target_ignored": "Target ignored by rules",
        "target_drift": "Target changed between selection and execution",
        "symlink_escape": "Symlink escapes workspace root",

        # secrets
        "secret_detected": "Secret detected in output",
        "secret_leak": "Potential secret leak",

        # general
        "invalid_input": "Invalid input",
        "internal_error": "Internal error",
    }

    @classmethod
    def validate(cls, code: DenialCode) -> None:
        if code not in cls._CODES:
            raise RuntimeError(f"unknown_denial_code:{code}")

    @classmethod
    def message_for(cls, code: DenialCode) -> str:
        cls.validate(code)
        return cls._CODES[code]


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# CONSTRUCTORS
# ---------------------------------------------------------------------------


def make_denial(code: DenialCode, context: Optional[Dict[str, Any]] = None) -> DenialReason:
    DenialRegistry.validate(code)
    context = context or {}

    payload = {
        "code": code,
        "context": context,
    }

    return DenialReason(
        code=code,
        message=DenialRegistry.message_for(code),
        context=context,
        reason_hash=_hash(payload),
    )


# ---------------------------------------------------------------------------
# COMPOSITION
# ---------------------------------------------------------------------------


class DenialComposer:
    """
    Combines multiple denial reasons into a single canonical one.
    """

    @staticmethod
    def merge(reasons: Iterable[DenialReason]) -> DenialReason:
        reasons_list = list(reasons)
        if not reasons_list:
            return make_denial("internal_error")

        # deterministic order by code + hash
        ordered = sorted(reasons_list, key=lambda r: (r.code, r.reason_hash))

        merged_context: Dict[str, Any] = {}
        for r in ordered:
            merged_context.setdefault(r.code, []).append(r.context)

        primary = ordered[0]

        payload = {
            "codes": [r.code for r in ordered],
            "contexts": merged_context,
        }

        return DenialReason(
            code=primary.code,
            message=primary.message,
            context=merged_context,
            reason_hash=_hash(payload),
        )


# ---------------------------------------------------------------------------
# SERIALIZATION
# ---------------------------------------------------------------------------


def encode(reason: DenialReason) -> str:
    return _stable_json(asdict(reason))


def decode(s: str) -> DenialReason:
    payload = json.loads(s)

    r = DenialReason(
        code=payload["code"],
        message=payload["message"],
        context=payload.get("context", {}),
        reason_hash=payload.get("reason_hash", ""),
    )

    # verify hash
    recomputed = make_denial(r.code, r.context)
    if r.reason_hash and r.reason_hash != recomputed.reason_hash:
        raise RuntimeError("denial_reason_hash_mismatch")

    return recomputed


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def deny(code: DenialCode, **context: Any) -> DenialReason:
    return make_denial(code, context)


def merge_denials(*reasons: DenialReason) -> DenialReason:
    return DenialComposer.merge(reasons)
