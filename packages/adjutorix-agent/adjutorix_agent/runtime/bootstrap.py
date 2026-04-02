"""
ADJUTORIX AGENT — RUNTIME BOOTSTRAP

Single entrypoint for process startup. Responsibilities:
- Deterministic initialization order
- Configuration loading + validation
- Dependency graph wiring (no implicit globals)
- Invariant registration (hard fail on violation)
- Storage + ledger initialization
- Scheduler + concurrency guards
- RPC server startup
- Graceful shutdown + signal handling
"""

from __future__ import annotations

import asyncio
import inspect
import importlib
import os
import signal
import sys
from dataclasses import dataclass
from typing import Any, Dict

from adjutorix_agent import (
    __protocol_version__,
    __system_name__,
    __version__,
    get_logger,
    register_invariants,
)
from adjutorix_agent.runtime.config import load_config, validate_config
from adjutorix_agent.runtime.wiring import build_container
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.concurrency_guard import ConcurrencyGuard
from adjutorix_agent.server.rpc import create_app


@dataclass(frozen=True)
class RuntimeContext:
    config: Dict[str, Any]
    container: Dict[str, Any]
    scheduler: Scheduler
    concurrency_guard: ConcurrencyGuard
    shutdown_event: asyncio.Event


def _assert_process_context() -> None:
    if os.environ.get("ADJUTORIX_RENDERER_CONTEXT") == "1":
        raise RuntimeError("Bootstrap cannot run in renderer context")
    if os.environ.get("ADJUTORIX_PRELOAD_CONTEXT") == "1":
        raise RuntimeError("Bootstrap cannot run in preload context")


def _normalize_env() -> None:
    os.environ.setdefault("PYTHONASYNCIODEBUG", "0")
    os.environ.setdefault("UVICORN_WORKERS", "1")


def _sqlite_path_from_url(db_url: str) -> str:
    if db_url.startswith("sqlite:///"):
        return db_url.removeprefix("sqlite:///")
    if db_url.startswith("sqlite://"):
        return db_url.removeprefix("sqlite://")
    return db_url


def _resolve_sqlite_engine(db_url: str):
    mod = importlib.import_module("adjutorix_agent.storage.sqlite.engine")
    exported = sorted(name for name in dir(mod) if not name.startswith("_"))

    factory = None
    for name in ("create_engine", "build_engine", "make_engine", "init_engine", "build_sqlite_engine"):
        candidate = getattr(mod, name, None)
        if callable(candidate):
            factory = candidate
            break

    if factory is None:
        raise ImportError(
            f"No supported engine factory found in adjutorix_agent.storage.sqlite.engine; exported={exported}"
        )

    sqlite_path = _sqlite_path_from_url(db_url)
    sqlite_config_cls = getattr(mod, "SQLiteConfig", None)

    values = [db_url, sqlite_path]
    config_candidates = []

    if sqlite_config_cls is not None:
        try:
            sig = inspect.signature(sqlite_config_cls)
            params = tuple(sig.parameters.keys())
        except Exception:
            params = ()

        kwargs_candidates = [
            {k: sqlite_path for k in ("path",) if k in params},
            {k: db_url for k in ("url", "db_url", "sqlite_url", "dsn", "database") if k in params},
        ]

        for kwargs in kwargs_candidates:
            if kwargs:
                try:
                    config_candidates.append(sqlite_config_cls(**kwargs))
                except Exception:
                    pass

        for value in values:
            try:
                config_candidates.append(sqlite_config_cls(value))
            except Exception:
                pass

    attempts = []
    for args, kwargs in (
        ((db_url,), {}),
        ((sqlite_path,), {}),
        *[((cfg,), {}) for cfg in config_candidates],
        *[((), {"config": cfg}) for cfg in config_candidates],
        *[((), {"cfg": cfg}) for cfg in config_candidates],
        *[((), {"sqlite_config": cfg}) for cfg in config_candidates],
    ):
        try:
            return factory(*args, **kwargs)
        except TypeError as exc:
            attempts.append(f"{factory.__name__}{args or ''}{kwargs or ''}: {exc}")

    raise TypeError(f"Unable to construct sqlite engine; attempts={attempts}")


async def _run_sqlite_migrations(engine, config: Dict[str, Any], db_url: str) -> None:
    mod = importlib.import_module("adjutorix_agent.storage.sqlite.migrations")
    exported = sorted(name for name in dir(mod) if not name.startswith("_"))

    migrate_fn = None
    for name in ("run_migrations", "migrate", "apply_migrations", "migrate_all"):
        candidate = getattr(mod, name, None)
        if callable(candidate):
            migrate_fn = candidate
            break

    if migrate_fn is None:
        raise ImportError(
            f"No supported migration runner found in adjutorix_agent.storage.sqlite.migrations; exported={exported}"
        )

    attempts = []
    for args, kwargs in (
        ((engine,), {}),
        ((engine, config), {}),
        ((engine, db_url), {}),
        ((), {"engine": engine}),
        ((), {"engine": engine, "config": config}),
        ((), {"db_url": db_url}),
    ):
        try:
            result = migrate_fn(*args, **kwargs)
            if inspect.isawaitable(result):
                await result
            return
        except TypeError as exc:
            attempts.append(f"{migrate_fn.__name__}{args or ''}{kwargs or ''}: {exc}")

    raise TypeError(f"Unable to run migrations; attempts={attempts}")


async def _init_storage(config: Dict[str, Any]) -> None:
    db_url = config["storage"]["sqlite_url"]
    engine = _resolve_sqlite_engine(db_url)
    await _run_sqlite_migrations(engine, config, db_url)


async def _init_core(config: Dict[str, Any]) -> tuple[Scheduler, ConcurrencyGuard]:
    scheduler = Scheduler(max_concurrent=config["runtime"]["max_concurrent_jobs"])
    guard = ConcurrencyGuard(strict_sequential=config["runtime"]["strict_sequential_mutations"])
    return scheduler, guard


async def _init_server(ctx: RuntimeContext):
    app = create_app(
        container=ctx.container,
        protocol_version=__protocol_version__,
    )

    import uvicorn

    cfg = ctx.config["server"]

    return uvicorn.Server(
        uvicorn.Config(
            app=app,
            host=cfg["host"],
            port=cfg["port"],
            log_level=cfg.get("log_level", "info"),
            loop="asyncio",
            http="httptools",
            lifespan="on",
        )
    )


def _install_signal_handlers(loop: asyncio.AbstractEventLoop, shutdown_event: asyncio.Event):
    def _handler(signame: str):
        logger = get_logger()
        logger.info("shutdown.signal", signal=signame)
        shutdown_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handler, sig.name)
        except NotImplementedError:
            signal.signal(sig, lambda *_: _handler(sig.name))


async def _graceful_shutdown(ctx: RuntimeContext) -> None:
    logger = get_logger()
    logger.info("shutdown.begin")
    try:
        await ctx.scheduler.shutdown()
    except Exception as exc:
        logger.error("shutdown.scheduler_error", error=str(exc))
    logger.info("shutdown.complete")


async def _bootstrap_async(dev: bool = False) -> int:
    logger = get_logger()

    _assert_process_context()
    _normalize_env()

    logger.info(
        "bootstrap.start",
        system=__system_name__,
        version=__version__,
        protocol=__protocol_version__,
        dev=dev,
    )

    config = load_config(dev=dev)
    validate_config(config)
    register_invariants()
    await _init_storage(config)

    container = build_container(config)
    scheduler, concurrency_guard = await _init_core(config)
    shutdown_event = asyncio.Event()

    ctx = RuntimeContext(
        config=config,
        container=container,
        scheduler=scheduler,
        concurrency_guard=concurrency_guard,
        shutdown_event=shutdown_event,
    )

    server = await _init_server(ctx)

    loop = asyncio.get_running_loop()
    _install_signal_handlers(loop, shutdown_event)

    async def _serve():
        await server.serve()

    async def _watch_shutdown():
        await shutdown_event.wait()
        server.should_exit = True

    try:
        await asyncio.gather(_serve(), _watch_shutdown())
    finally:
        await _graceful_shutdown(ctx)

    return 0


def main() -> None:
    try:
        code = asyncio.run(_bootstrap_async(dev=False))
    except Exception as exc:
        logger = get_logger()
        logger.error("bootstrap.fatal", error=str(exc))
        raise
    sys.exit(code)


def dev() -> None:
    try:
        code = asyncio.run(_bootstrap_async(dev=True))
    except Exception as exc:
        logger = get_logger()
        logger.error("bootstrap.dev_fatal", error=str(exc))
        raise
    sys.exit(code)


if __name__ == "__main__":
    main()
