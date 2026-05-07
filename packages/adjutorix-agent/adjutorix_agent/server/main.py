"""
ADJUTORIX AGENT — SERVER / MAIN

Module entrypoint used by smoke/runtime launchers.

Provides:
- ASGI app object for uvicorn imports
- health endpoint expected by smoke/runtime launchers
- `python -m adjutorix_agent.server.main` executable path
"""

from __future__ import annotations

import os

from adjutorix_agent.server.rpc import create_app


app = create_app()


@app.get("/health")
async def health() -> dict[str, object]:
    return {
        "ok": True,
        "service": "adjutorix-agent",
        "state": "ready",
    }


def main() -> None:
    import uvicorn

    host = os.environ.get("ADJUTORIX_AGENT_HOST", os.environ.get("ADJUTORIX_HOST", "127.0.0.1"))
    port = int(os.environ.get("ADJUTORIX_AGENT_PORT", os.environ.get("PORT", "8000")))
    log_level = os.environ.get("ADJUTORIX_LOG_LEVEL", "info").lower()

    uvicorn.run(
        "adjutorix_agent.server.main:app",
        host=host,
        port=port,
        log_level=log_level,
    )


if __name__ == "__main__":
    main()
