"""
ADJUTORIX AGENT — RUNTIME BOOTSTRAP

Single authoritative process bootstrap.
"""

from __future__ import annotations

import asyncio
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
from adjutorix_agent.core.concurrency_guard import ConcurrencyGuard
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.runtime.config import load_config, validate_config
from adjutorix_agent.runtime.wiring import build_container
from adjutorix_agent.server.rpc import create_app
from adjutorix_agent.storage.sqlite.engine import create_engine
from adjutorix_agent.storage.sqlite.migrations import run_migrations


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


async def _init_storage(config: Dict[str, Any]) -> None:
    db_url = config["storage"]["sqlite_url"]
    engine = create_engine(db_url)
    await run_migrations(engine)


async def _init_server(ctx: RuntimeContext):
    import uvicorn

    app = create_app(
        container=ctx.container,
        protocol_version=__protocol_version__,
    )

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


def _install_signal_handlers(loop: asyncio.AbstractEventLoop, shutdown_event: asyncio.Event) -> None:
    def _handler(signame: str) -> None:
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
        ctx.scheduler.shutdown()
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
    scheduler = container["scheduler"]
    concurrency_guard = container["concurrency_guard"]

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

    async def _serve() -> None:
        await server.serve()

    async def _watch_shutdown() -> None:
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
