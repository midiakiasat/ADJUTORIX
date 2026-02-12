from __future__ import annotations
import os
import signal
from pathlib import Path
from typing import Optional
from datetime import datetime, timezone, timedelta
import json


DEFAULT_TTL_SECONDS = 60 * 60  # 1 hour


def _is_process_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except OSError:
        return False


def _parse_iso(ts: str) -> Optional[datetime]:
    try:
        return datetime.fromisoformat(ts)
    except Exception:
        return None


def reap_if_stale(lock_file: Path, ttl_seconds: int = DEFAULT_TTL_SECONDS) -> bool:
    """
    If lock file is stale (dead pid or expired TTL), remove it.
    Returns True if removed.
    """
    if not lock_file.exists():
        return False

    try:
        data = json.loads(lock_file.read_text(encoding="utf-8"))
    except Exception:
        # Corrupted lock → remove defensively
        lock_file.unlink(missing_ok=True)
        return True

    pid = int(data.get("pid", -1))
    created_at = _parse_iso(str(data.get("created_at", "")))

    # Dead process → stale
    if not _is_process_alive(pid):
        lock_file.unlink(missing_ok=True)
        return True

    # TTL exceeded → stale
    if created_at is not None:
        age = datetime.now(timezone.utc) - created_at
        if age > timedelta(seconds=ttl_seconds):
            lock_file.unlink(missing_ok=True)
            return True

    return False
