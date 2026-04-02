"""
ADJUTORIX AGENT — RUNTIME WIRING

Truthful runtime composition only.
No shadow service classes.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Dict

from adjutorix_agent.core.job_queue import JobQueue
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.transaction_store import TransactionStore
from adjutorix_agent.governance.policy_engine import PolicyEngine, build_engine_from_dicts
from adjutorix_agent.ledger.store import LedgerStore
from adjutorix_agent.storage.sqlite.engine import SQLiteEngine, build_sqlite_engine


class ServiceRegistry:
    def __init__(self) -> None:
        self._constructors: Dict[str, Callable[["ServiceRegistry"], Any]] = {}
        self._instances: Dict[str, Any] = {}
        self._construction_stack: list[str] = []

    def register(self, name: str, factory: Callable[["ServiceRegistry"], Any]) -> None:
        if name in self._constructors:
            raise RuntimeError(f"service_already_registered:{name}")
        self._constructors[name] = factory

    def get(self, name: str) -> Any:
        if name in self._instances:
            return self._instances[name]
        if name in self._construction_stack:
            raise RuntimeError(f"dependency_cycle:{self._construction_stack + [name]}")
        if name not in self._constructors:
            raise RuntimeError(f"unknown_service:{name}")
        self._construction_stack.append(name)
        try:
            value = self._constructors[name](self)
            self._instances[name] = value
            return value
        finally:
            self._construction_stack.pop()

    def materialize_all(self) -> None:
        for name in list(self._constructors):
            self.get(name)


class Clock:
    def now(self) -> int:
        import time
        return int(time.time() * 1_000_000)


def _sqlite_path(value: str) -> str:
    if value.startswith("sqlite:///"):
        return value[len("sqlite:///") :]
    if value.startswith("sqlite://"):
        return value[len("sqlite://") :]
    if value.startswith("file:"):
        return value[len("file:") :]
    return value


def _build_scheduler(runtime_cfg: Dict[str, Any]) -> Scheduler:
    params = inspect.signature(Scheduler).parameters
    workers = int(runtime_cfg.get("max_concurrent_jobs", 1))
    if "max_workers" in params:
        return Scheduler(max_workers=workers)
    if "max_concurrent" in params:
        return Scheduler(max_concurrent=workers)
    if "max_concurrency" in params:
        return Scheduler(max_concurrency=workers)
    return Scheduler()


def _build_job_queue(reg: ServiceRegistry) -> JobQueue:
    params = inspect.signature(JobQueue).parameters
    if "scheduler" in params:
        return JobQueue(reg.get("scheduler"))
    return JobQueue()


def _build_tx_store(reg: ServiceRegistry) -> TransactionStore:
    params = inspect.signature(TransactionStore).parameters
    if "engine" in params:
        return TransactionStore(reg.get("sqlite_engine"))
    if "repo" in params:
        raise RuntimeError("transaction_store_requires_repo_binding")
    return TransactionStore()


def _build_policy_engine(config: Dict[str, Any]) -> Any:
    security = config.get("security", {})
    if isinstance(security, dict):
        try:
            return build_engine_from_dicts(security)
        except Exception:
            return None
    return None


def build_registry(config: Dict[str, Any]) -> ServiceRegistry:
    reg = ServiceRegistry()

    reg.register("config", lambda _reg: config)
    reg.register("clock", lambda _reg: Clock())
    reg.register("sqlite_engine", lambda _reg: build_sqlite_engine(_sqlite_path(config["storage"]["sqlite_url"])))
    reg.register("scheduler", lambda _reg: _build_scheduler(config["runtime"]))
    reg.register("job_queue", _build_job_queue)
    reg.register("transaction_store", _build_tx_store)
    reg.register("ledger_store", lambda _reg: LedgerStore(_sqlite_path(config["storage"]["sqlite_url"])))
    reg.register("policy_engine", lambda _reg: _build_policy_engine(config))

    reg.materialize_all()
    return reg


def build_container(config: Dict[str, Any]) -> Dict[str, Any]:
    reg = build_registry(config)
    return {
        "config": reg.get("config"),
        "clock": reg.get("clock"),
        "sqlite_engine": reg.get("sqlite_engine"),
        "scheduler": reg.get("scheduler"),
        "job_queue": reg.get("job_queue"),
        "tx_store": reg.get("transaction_store"),
        "transaction_store": reg.get("transaction_store"),
        "ledger": reg.get("ledger_store"),
        "ledger_store": reg.get("ledger_store"),
        "policy_engine": reg.get("policy_engine"),
    }


def bootstrap(config: Dict[str, Any]) -> ServiceRegistry:
    return build_registry(config)


__all__ = [
    "ServiceRegistry",
    "Clock",
    "SQLiteEngine",
    "build_registry",
    "build_container",
    "bootstrap",
]
