"""
ADJUTORIX AGENT — RUNTIME FEATURE FLAGS

Deterministic, validated, auditable feature flag system.

Design constraints:
- No dynamic/remote flags (no network dependency)
- Fully declared schema (unknown flags = hard failure)
- Immutable at runtime after bootstrap
- Hashable snapshot for ledger traceability
- Supports guarded rollout via explicit conditions (NOT percentages)

Flag evaluation MUST be pure and side-effect free.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional
import hashlib
import json


# ---------------------------------------------------------------------------
# SCHEMA
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FlagDefinition:
    name: str
    default: bool
    description: str
    requires_restart: bool = True


FLAG_DEFINITIONS: Dict[str, FlagDefinition] = {
    "STRICT_SEQUENTIAL_MUTATIONS": FlagDefinition(
        name="STRICT_SEQUENTIAL_MUTATIONS",
        default=True,
        description="Disallow concurrent mutation execution",
    ),
    "ENABLE_SNAPSHOT_GUARD": FlagDefinition(
        name="ENABLE_SNAPSHOT_GUARD",
        default=True,
        description="Reject stale snapshot mutations",
    ),
    "ENABLE_VERIFY_PIPELINE_STRICT": FlagDefinition(
        name="ENABLE_VERIFY_PIPELINE_STRICT",
        default=True,
        description="Force all verify stages (no bypass)",
    ),
    "ENABLE_LEDGER_STRICT_ORDERING": FlagDefinition(
        name="ENABLE_LEDGER_STRICT_ORDERING",
        default=True,
        description="Enforce monotonic sequence ordering",
    ),
    "ENABLE_POLICY_BLOCKING": FlagDefinition(
        name="ENABLE_POLICY_BLOCKING",
        default=True,
        description="Hard block policy violations",
    ),
    "ENABLE_COMMAND_GUARD": FlagDefinition(
        name="ENABLE_COMMAND_GUARD",
        default=True,
        description="Guard shell execution",
    ),
    "ENABLE_INDEX_GUARD": FlagDefinition(
        name="ENABLE_INDEX_GUARD",
        default=True,
        description="Prevent stale index usage",
    ),
    "ENABLE_FAILURE_NORMALIZATION": FlagDefinition(
        name="ENABLE_FAILURE_NORMALIZATION",
        default=True,
        description="Normalize all failures into canonical model",
    ),
}


# ---------------------------------------------------------------------------
# CORE
# ---------------------------------------------------------------------------


class FeatureFlags:
    """Immutable runtime feature flag container."""

    def __init__(self, values: Dict[str, bool]) -> None:
        self._values = self._validate(values)
        self._frozen = True

    # ---------------------------------------------------------------------
    # VALIDATION
    # ---------------------------------------------------------------------

    def _validate(self, values: Dict[str, bool]) -> Dict[str, bool]:
        result: Dict[str, bool] = {}

        # unknown flags → reject
        for key in values:
            if key not in FLAG_DEFINITIONS:
                raise RuntimeError(f"Unknown feature flag: {key}")

        # fill defaults + overrides
        for key, definition in FLAG_DEFINITIONS.items():
            if key in values:
                if not isinstance(values[key], bool):
                    raise RuntimeError(f"Invalid flag type: {key}")
                result[key] = values[key]
            else:
                result[key] = definition.default

        return result

    # ---------------------------------------------------------------------
    # ACCESS
    # ---------------------------------------------------------------------

    def is_enabled(self, name: str) -> bool:
        if name not in self._values:
            raise RuntimeError(f"Flag not defined: {name}")
        return self._values[name]

    def all(self) -> Dict[str, bool]:
        return dict(self._values)

    # ---------------------------------------------------------------------
    # TRACEABILITY
    # ---------------------------------------------------------------------

    def snapshot(self) -> Dict[str, bool]:
        """Return deterministic snapshot for ledger."""
        return dict(sorted(self._values.items()))

    def fingerprint(self) -> str:
        """Stable hash for reproducibility checks."""
        encoded = json.dumps(self.snapshot(), separators=(",", ":"), sort_keys=True)
        return hashlib.sha256(encoded.encode("utf-8")).hexdigest()

    # ---------------------------------------------------------------------
    # INVARIANTS
    # ---------------------------------------------------------------------

    def enforce_invariants(self) -> None:
        """Hard cross-flag constraints."""

        if self.is_enabled("STRICT_SEQUENTIAL_MUTATIONS"):
            # sequential implies strict ordering must be enabled
            if not self.is_enabled("ENABLE_LEDGER_STRICT_ORDERING"):
                raise RuntimeError(
                    "Invariant violation: sequential mutations require strict ledger ordering"
                )

        if self.is_enabled("ENABLE_VERIFY_PIPELINE_STRICT"):
            if not self.is_enabled("ENABLE_FAILURE_NORMALIZATION"):
                raise RuntimeError(
                    "Invariant violation: strict verify requires failure normalization"
                )

        if not self.is_enabled("ENABLE_POLICY_BLOCKING"):
            raise RuntimeError("Unsafe configuration: policy blocking cannot be disabled")


# ---------------------------------------------------------------------------
# FACTORY
# ---------------------------------------------------------------------------


def build_feature_flags(config: Dict[str, Any]) -> FeatureFlags:
    raw_flags: Dict[str, bool] = config.get("feature_flags", {})

    flags = FeatureFlags(raw_flags)
    flags.enforce_invariants()

    return flags


__all__ = [
    "FeatureFlags",
    "FLAG_DEFINITIONS",
    "build_feature_flags",
]
