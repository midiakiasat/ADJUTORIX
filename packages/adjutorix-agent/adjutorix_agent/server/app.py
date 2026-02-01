import asyncio
import json
import logging
import os
import traceback
from typing import Dict, Any

from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn

from .auth import extract_token, verify_local_request
from .rpc import RPCDispatcher


LOG_LEVEL = os.getenv("ADJUTORIX_LOG_LEVEL", "INFO")

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)

logger = logging.getLogger("adjutorix.server")


class WebSocketManager:
    def __init__(self) -> None:
        self.connections: Dict[str, WebSocket] = {}

    async def connect(self, client_id: str, ws: WebSocket) -> None:
        await ws.accept()
        self.connections[client_id] = ws
        logger.info("WebSocket connected: %s", client_id)

    def disconnect(self, client_id: str) -> None:
        if client_id in self.connections:
            del self.connections[client_id]
            logger.info("WebSocket disconnected: %s", client_id)

    async def send(self, client_id: str, message: Dict[str, Any]) -> None:
        ws = self.connections.get(client_id)
        if not ws:
            return

        await ws.send_text(json.dumps(message))


app = FastAPI(
    title="Adjutorix Agent",
    version="0.1.0",
    docs_url=None,
    redoc_url=None,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost", "vscode-webview://*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

_repo_root = os.getenv("ADJUTORIX_ROOT", os.getcwd())
rpc_dispatcher = RPCDispatcher(repo_root=_repo_root)
ws_manager = WebSocketManager()


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    # Allow /health without auth
    if request.url.path == "/health":
        return await call_next(request)

    # For /rpc: enforce local-only, but return JSON-RPC error envelope on failure (client always parses it)
    if request.url.path == "/rpc":
        try:
            verify_local_request(request)
        except Exception as exc:
            logger.warning("Local verification failed: %s", exc)
            return JSONResponse(
                status_code=200,
                content={
                    "jsonrpc": "2.0",
                    "id": None,
                    "error": {
                        "code": "UNAUTHORIZED",
                        "message": "Unauthorized (local request required)",
                        "data": {"raw": str(exc)},
                    },
                },
            )
        return await call_next(request)

    # For everything else: keep current behavior (plain 401)
    try:
        verify_local_request(request)
    except Exception as exc:
        logger.warning("Auth failed: %s", exc)
        return JSONResponse(status_code=401, content={"error": "unauthorized"})

    return await call_next(request)


@app.get("/health")
async def health() -> Dict[str, str]:
    return {"status": "ok"}


@app.post("/rpc")
async def rpc_endpoint(request: Request) -> Dict[str, Any]:
    """
    JSON-RPC over HTTP. Body read manually so we always return JSON-RPC (no FastAPI 422/500).
    Local-only verified by middleware; token auth in RPCDispatcher.handle().
    """
    req_id = None
    payload = {}
    try:
        body = await request.body()
        if body:
            payload = json.loads(body)
        if not isinstance(payload, dict):
            payload = {}
        req_id = payload.get("id")
    except Exception as exc:
        logger.warning("RPC body parse failed: %s", exc)
        return {
            "jsonrpc": "2.0",
            "id": None,
            "error": {"code": -32700, "message": f"Parse error: {exc}", "data": {"raw": str(exc)}},
        }
    logger.debug("RPC request: %s", payload)
    token = extract_token(request) or ""
    try:
        return rpc_dispatcher.dispatch(payload, token=token)
    except Exception as exc:
        logger.exception("RPC endpoint error")
        return {
            "jsonrpc": "2.0",
            "id": req_id,
            "error": {
                "code": "INTERNAL",
                "message": str(exc),
                "data": {"traceback": traceback.format_exc()},
            },
        }


@app.websocket("/ws/{client_id}")
async def websocket_endpoint(ws: WebSocket, client_id: str):
    """
    JSON-RPC over WebSocket
    """
    try:
        await ws_manager.connect(client_id, ws)

        while True:
            raw = await ws.receive_text()
            payload = json.loads(raw)

            logger.debug("WS RPC from %s: %s", client_id, payload)

            token = (payload.get("params") or {}).get("token") or payload.get("token") or ""
            try:
                response = rpc_dispatcher.dispatch(payload, token=token)
            except Exception as exc:
                logger.exception("WS RPC error")
                response = {
                    "jsonrpc": "2.0",
                    "id": payload.get("id"),
                    "error": {
                        "code": "INTERNAL",
                        "message": str(exc),
                        "data": {"traceback": traceback.format_exc()},
                    },
                }

            await ws_manager.send(client_id, response)

    except WebSocketDisconnect:
        ws_manager.disconnect(client_id)

    except Exception as exc:
        logger.exception("WebSocket fatal error: %s", exc)
        ws_manager.disconnect(client_id)


def run():
    """
    Entrypoint for CLI/dev scripts
    """
    host = os.getenv("ADJUTORIX_HOST", "127.0.0.1")
    port = int(os.getenv("ADJUTORIX_PORT", "7337"))

    logger.info("Starting Adjutorix Agent on %s:%s", host, port)

    uvicorn.run(
        "adjutorix_agent.server.app:app",
        host=host,
        port=port,
        log_level=LOG_LEVEL.lower(),
        reload=False,
    )


if __name__ == "__main__":
    run()
