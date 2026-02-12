from __future__ import annotations
import base64
from pathlib import Path
from typing import Any, Dict, List, Optional

from .guardrails import Guardrails, GuardViolation

def _b64decode(s: str) -> bytes:
    return base64.b64decode(s.encode("utf-8"), validate=True)

def apply_ops(
    *,
    workspace_root: Path,
    ops: List[Dict[str, Any]],
) -> Dict[str, Any]:
    """
    Apply-only. No arbitrary writes:
    - all paths are workspace-relative
    - only operations from the allowlist are executed
    """
    g = Guardrails(workspace_root=workspace_root)
    errors: List[str] = []
    applied = 0

    for op in ops:
        try:
            kind = op.get("op")
            rel = op.get("path")
            if not isinstance(kind, str) or not isinstance(rel, str):
                raise GuardViolation("op/path must be strings")

            target = g.allow_target(rel)

            if kind == "mkdir":
                target.mkdir(parents=True, exist_ok=True)

            elif kind == "delete":
                if target.is_dir():
                    # only allow removing empty dirs (safe default)
                    target.rmdir()
                elif target.exists():
                    target.unlink()

            elif kind == "write":
                content_b64 = op.get("content_b64")
                if not isinstance(content_b64, str):
                    raise GuardViolation("write requires content_b64")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(_b64decode(content_b64))

            elif kind == "rename":
                to = op.get("to")
                if not isinstance(to, str):
                    raise GuardViolation("rename requires to")
                dst = g.allow_target(to)
                dst.parent.mkdir(parents=True, exist_ok=True)
                target.rename(dst)

            elif kind == "chmod":
                mode = op.get("mode")
                if not isinstance(mode, int):
                    raise GuardViolation("chmod requires integer mode")
                target.chmod(mode)

            else:
                raise GuardViolation(f"unknown op: {kind}")

            applied += 1

        except Exception as e:
            errors.append(f"{op.get('op')} {op.get('path')}: {e}")

    return {"ok": len(errors) == 0, "applied": applied, "errors": errors}
