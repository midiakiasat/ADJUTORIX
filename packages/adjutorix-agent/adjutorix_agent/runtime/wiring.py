"""
ADJUTORIX AGENT — RUNTIME WIRING

Authoritative runtime container for live server boot.
"""

from __future__ import annotations

import os
from typing import Any, Dict

from adjutorix_agent.core.concurrency_guard import ConcurrencyGuard
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.transaction_store import TransactionStore
from adjutorix_agent.ledger.store import LedgerStore


def _agent_data_dir(config: Dict[str, Any]) -> str:
    paths = config.get("paths", {})
    for key in ("agent_data_dir", "state_dir", "data_dir"):
        value = paths.get(key)
        if isinstance(value, str) and value.strip():
            os.makedirs(value, exist_ok=True)
            return value
    fallback = os.path.join(os.path.expanduser("~"), ".adjutorix-agent")
    os.makedirs(fallback, exist_ok=True)
    return fallback


def _ledger_db_path(config: Dict[str, Any], agent_data_dir: str) -> str:
    storage = config.get("storage", {})
    for key in ("ledger_db_path", "ledger_path", "sqlite_path"):
        value = storage.get(key)
        if isinstance(value, str) and value.strip():
            parent = os.path.dirname(value) or "."
            os.makedirs(parent, exist_ok=True)
            return value
    return os.path.join(agent_data_dir, "ledger.sqlite3")


def build_container(config: Dict[str, Any]) -> Dict[str, Any]:
    runtime = config.get("runtime", {})
    max_workers = int(runtime.get("max_concurrent_jobs") or runtime.get("max_workers") or 1)

    agent_data_dir = _agent_data_dir(config)
    ledger_db_path = _ledger_db_path(config, agent_data_dir)

    scheduler = Scheduler(max_workers=max_workers)
    tx_store = TransactionStore()
    ledger = LedgerStore(ledger_db_path)
    concurrency_guard = ConcurrencyGuard()

    return {
        "config": config,
        "scheduler": scheduler,
        "tx_store": tx_store,
        "ledger": ledger,
        "verify": None,
        "patch": None,
        "concurrency_guard": concurrency_guard,
        "agent_data_dir": agent_data_dir,
        "ledger_db_path": ledger_db_path,
    }


__all__ = ["build_container"]
