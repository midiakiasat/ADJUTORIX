"""
ADJUTORIX AGENT PACKAGE

This package defines the ONLY mutation authority in the ADJUTORIX system.

Non-negotiable invariants (enforced here at import time + runtime hooks):
- No mutation outside patch_pipeline
- No commit without verify
- No state transition outside state_machine
- No direct filesystem mutation outside isolated_workspace
- No ledger write outside transaction_store
- No RPC exposure outside server.rpc

This module establishes:
- Global version identity
- Capability surface declaration
- Hard invariant bootstrapping
- Structured observability root
- Import-time guardrails (fail-fast on invalid environment)
"""

from __future__ import annotations

import os
import sys
from typing import Final


# ---------------------------------------------------------------------------
# VERSION / IDENTITY
# ---------------------------------------------------------------------------

__version__: Final[str] = "0.1.0"
__system_name__: Final[str] = "ADJUTORIX_AGENT"
__protocol_version__: Final[str] = "1.0.0"


# ---------------------------------------------------------------------------
# ENVIRONMENT VALIDATION (FAIL FAST)
# ---------------------------------------------------------------------------

def _assert_python_runtime() -> None:
    if sys.version_info < (3, 11):
        raise RuntimeError("ADJUTORIX_AGENT requires Python >= 3.11")


def _assert_no_unsafe_flags() -> None:
    if os.environ.get("ADJUTORIX_ALLOW_UNSAFE") == "1":
        raise RuntimeError("Unsafe mode is forbidden in ADJUTORIX_AGENT")


_assert_python_runtime()
_assert_no_unsafe_flags()


# ---------------------------------------------------------------------------
# CAPABILITY DECLARATION (STATIC — MUST MATCH SHARED CONTRACT)
# ---------------------------------------------------------------------------

CAPABILITIES: Final[dict[str, bool]] = {
    # Core mutation pipeline
    "patch_pipeline": True,
    "verify_pipeline": True,
    "transaction_state_machine": True,

    # Ledger guarantees
    "deterministic_replay": True,
    "monotonic_sequence": True,

    # Governance
    "policy_enforcement": True,
    "command_guard": True,
    "secrets_guard": True,

    # Workspace
    "isolated_workspace": True,
    "snapshot_guard": True,

    # Indexing
    "repo_index": True,
    "symbol_index": True,
    "dependency_graph": True,

    # Observability
    "structured_events": True,
    "metrics": True,
}


# ---------------------------------------------------------------------------
# GLOBAL IMPORT GUARDS
# ---------------------------------------------------------------------------

# Prevent accidental import cycles that could bypass invariants
_IMPORT_GUARD: set[str] = set()


def _guard_import(module: str) -> None:
    if module in _IMPORT_GUARD:
        raise RuntimeError(f"Import cycle detected in agent core: {module}")
    _IMPORT_GUARD.add(module)


# ---------------------------------------------------------------------------
# OBSERVABILITY ROOT (LAZY INIT)
# ---------------------------------------------------------------------------

_logger = None


def get_logger():
    global _logger
    if _logger is None:
        try:
            import structlog

            _logger = structlog.get_logger("adjutorix.agent")
        except Exception as exc:  # hard fallback
            raise RuntimeError(f"Failed to initialize logger: {exc}") from exc
    return _logger


# ---------------------------------------------------------------------------
# INVARIANT REGISTRATION HOOK
# ---------------------------------------------------------------------------


def register_invariants() -> None:
    """
    Called exactly once during runtime bootstrap.
    Ensures all invariant modules are imported and active.
    """
    try:
        from adjutorix_agent.core.state_machine import StateMachine  # noqa: F401
        from adjutorix_agent.core.patch_pipeline import PatchPipeline  # noqa: F401
        from adjutorix_agent.core.verify_pipeline import VerifyPipeline  # noqa: F401
        from adjutorix_agent.core.snapshot_guard import SnapshotGuard  # noqa: F401
        from adjutorix_agent.core.concurrency_guard import ConcurrencyGuard  # noqa: F401
    except Exception as exc:
        raise RuntimeError(f"Invariant registration failed: {exc}") from exc


# ---------------------------------------------------------------------------
# PUBLIC SAFE EXPORT SURFACE
# ---------------------------------------------------------------------------

__all__ = [
    "__version__",
    "__system_name__",
    "__protocol_version__",
    "CAPABILITIES",
    "get_logger",
    "register_invariants",
]


# ---------------------------------------------------------------------------
# HARD FAIL IF IMPORTED FROM FORBIDDEN CONTEXT
# ---------------------------------------------------------------------------

if os.environ.get("ADJUTORIX_RENDERER_CONTEXT") == "1":
    raise RuntimeError("Agent package must never be imported in renderer context")

if os.environ.get("ADJUTORIX_PRELOAD_CONTEXT") == "1":
    raise RuntimeError("Agent package must never be imported in preload context")
