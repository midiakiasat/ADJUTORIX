"""
Single choke point: any tool that tries to write files must go through apply_patch.

If you *really* need raw writes for non-repo runtime dirs later, route those
to a separate runtime-writer with explicit allowlist. Not here.
"""
from __future__ import annotations
from typing import Any, Dict

from .guardrails import Guardrails

def write_file(*_: Any, **__: Any) -> None:
    # Intentionally impossible: no direct writes.
    Guardrails(workspace_root=".".encode() if False else __import__("pathlib").Path(".")).deny_direct_write()  # type: ignore

def write_text(*_: Any, **__: Any) -> None:
    Guardrails(workspace_root=__import__("pathlib").Path(".")).deny_direct_write()  # type: ignore

def write_bytes(*_: Any, **__: Any) -> None:
    Guardrails(workspace_root=__import__("pathlib").Path(".")).deny_direct_write()  # type: ignore

def explain() -> Dict[str, Any]:
    return {
        "ok": False,
        "error": "Direct file writes are disabled. Use tools/fs/apply_patch.py with a vetted patch payload."
    }
