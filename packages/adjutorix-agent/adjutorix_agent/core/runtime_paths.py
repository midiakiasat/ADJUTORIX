from __future__ import annotations
from pathlib import Path

# Canonical runtime layout (must match shared/src/constants/runtime.ts)

RUNTIME_DIR = "runtime"
SESSIONS_DIR = "sessions"
UI_DIR = "ui"
AGENT_DIR = "agent"

def repo_root() -> Path:
    """
    Assumes agent is launched from repository root
    (enforced by dev scripts / production entrypoint).
    """
    return Path.cwd().resolve()

def runtime_root() -> Path:
    return repo_root() / RUNTIME_DIR

def sessions_root() -> Path:
    return runtime_root() / SESSIONS_DIR

def session_base(session_id: str) -> Path:
    return sessions_root() / session_id

def session_ui_dir(session_id: str) -> Path:
    return session_base(session_id) / UI_DIR

def session_agent_dir(session_id: str) -> Path:
    return session_base(session_id) / AGENT_DIR

def ensure_session_dirs(session_id: str) -> None:
    """
    Create runtime/session directory structure if missing.
    """
    session_ui_dir(session_id).mkdir(parents=True, exist_ok=True)
    session_agent_dir(session_id).mkdir(parents=True, exist_ok=True)
