"""
ADJUTORIX AGENT — RUNTIME WIRING

Strict dependency graph construction.

Goals:
- Single instantiation point for ALL runtime services
- No hidden imports / side effects
- Explicit dependency graph (topologically valid)
- Deterministic startup order
- Hard failure on missing dependency or cycle

Rules:
- Every service registered exactly once
- No service constructs its own dependencies
- No global singletons outside registry
- All IO-bound services initialized AFTER config validation

This file is the ONLY place where concrete implementations are bound.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, Type


# ---------------------------------------------------------------------------
# REGISTRY CORE
# ---------------------------------------------------------------------------


class ServiceRegistry:
    """Deterministic dependency container."""

    def __init__(self) -> None:
        self._constructors: Dict[str, Callable[["ServiceRegistry"], Any]] = {}
        self._instances: Dict[str, Any] = {}
        self._construction_stack: list[str] = []

    def register(self, name: str, factory: Callable[["ServiceRegistry"], Any]) -> None:
        if name in self._constructors:
            raise RuntimeError(f"Service already registered: {name}")
        self._constructors[name] = factory

    def get(self, name: str) -> Any:
        if name in self._instances:
            return self._instances[name]

        if name in self._construction_stack:
            raise RuntimeError(f"Dependency cycle detected: {self._construction_stack + [name]}")

        if name not in self._constructors:
            raise RuntimeError(f"Unknown service: {name}")

        self._construction_stack.append(name)
        instance = self._constructors[name](self)
        self._construction_stack.pop()

        self._instances[name] = instance
        return instance

    def materialize_all(self) -> None:
        for name in list(self._constructors.keys()):
            self.get(name)


# ---------------------------------------------------------------------------
# SERVICE TYPES (EXPLICIT CONTRACTS)
# ---------------------------------------------------------------------------


@dataclass
class Config:
    raw: Dict[str, Any]


@dataclass
class Clock:
    def now(self) -> int:
        import time
        return int(time.time() * 1_000_000)


@dataclass
class SQLiteEngine:
    url: str


@dataclass
class LedgerStore:
    engine: SQLiteEngine


@dataclass
class TransactionStore:
    engine: SQLiteEngine


@dataclass
class SnapshotStore:
    base_path: str


@dataclass
class PolicyEngine:
    config: Dict[str, Any]


@dataclass
class Scheduler:
    max_concurrency: int


@dataclass
class JobQueue:
    scheduler: Scheduler


@dataclass
class VerifyRunner:
    timeout: int


@dataclass
class PatchPipeline:
    snapshot_store: SnapshotStore


@dataclass
class RPCServer:
    config: Config


# ---------------------------------------------------------------------------
# WIRING
# ---------------------------------------------------------------------------


def build_registry(config: Dict[str, Any]) -> ServiceRegistry:
    r = ServiceRegistry()

    # ---------------- CONFIG ----------------
    r.register("config", lambda _: Config(config))

    # ---------------- CORE ----------------
    r.register("clock", lambda _: Clock())

    r.register(
        "scheduler",
        lambda reg: Scheduler(
            max_concurrency=reg.get("config").raw["runtime"]["max_concurrent_jobs"]
        ),
    )

    r.register("job_queue", lambda reg: JobQueue(reg.get("scheduler")))

    # ---------------- STORAGE ----------------
    r.register(
        "sqlite_engine",
        lambda reg: SQLiteEngine(reg.get("config").raw["storage"]["sqlite_url"]),
    )

    r.register(
        "ledger_store",
        lambda reg: LedgerStore(reg.get("sqlite_engine")),
    )

    r.register(
        "transaction_store",
        lambda reg: TransactionStore(reg.get("sqlite_engine")),
    )

    r.register(
        "snapshot_store",
        lambda reg: SnapshotStore(reg.get("config").raw["paths"]["agent_data_dir"]),
    )

    # ---------------- GOVERNANCE ----------------
    r.register(
        "policy_engine",
        lambda reg: PolicyEngine(reg.get("config").raw["security"]),
    )

    # ---------------- PIPELINES ----------------
    r.register(
        "patch_pipeline",
        lambda reg: PatchPipeline(reg.get("snapshot_store")),
    )

    r.register(
        "verify_runner",
        lambda reg: VerifyRunner(
            timeout=reg.get("config").raw["runtime"]["verify_timeout_seconds"]
        ),
    )

    # ---------------- SERVER ----------------
    r.register("rpc_server", lambda reg: RPCServer(reg.get("config")))

    # ---------------- VALIDATION ----------------
    _validate_registry(r)

    return r


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


def _validate_registry(reg: ServiceRegistry) -> None:
    # force full materialization → detect missing deps / cycles
    reg.materialize_all()

    # invariants
    cfg = reg.get("config").raw

    if cfg["runtime"]["strict_sequential_mutations"]:
        if cfg["runtime"]["max_concurrent_jobs"] != 1:
            raise RuntimeError("Invariant violation: sequential mutations require concurrency=1")


# ---------------------------------------------------------------------------
# BOOT ENTRY
# ---------------------------------------------------------------------------


def bootstrap(config: Dict[str, Any]) -> ServiceRegistry:
    reg = build_registry(config)

    # warm critical services explicitly
    reg.get("clock")
    reg.get("scheduler")
    reg.get("job_queue")
    reg.get("ledger_store")

    return reg


__all__ = [
    "bootstrap",
    "build_registry",
    "ServiceRegistry",
]
