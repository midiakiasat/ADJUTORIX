"""
ADJUTORIX AGENT — SERVER / RPC

Truthful JSON-RPC 2.0 surface aligned to real runtime contracts.
"""

from __future__ import annotations

import inspect
import time
import traceback
from dataclasses import asdict, dataclass, is_dataclass
from typing import Any, Awaitable, Callable, Dict, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

from adjutorix_agent.indexing.affected_files import compute_affected_files
from adjutorix_agent.indexing.dependency_graph import build_dependency_graph
from adjutorix_agent.indexing.health import analyze_index_health
from adjutorix_agent.indexing.references import build_reference_index
from adjutorix_agent.indexing.related_files import build_related_files
from adjutorix_agent.indexing.repo_index import build_repo_index
from adjutorix_agent.indexing.symbol_index import build_symbol_index
from adjutorix_agent.server.auth import require_token


ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603

ERR_UNAUTHORIZED = 1001
ERR_CAPABILITY = 1002
ERR_CONFLICT = 1003
ERR_NOT_FOUND = 1004
ERR_TIMEOUT = 1005


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}


def _err(code: int, message: str, data: Optional[Dict[str, Any]] = None) -> RpcError:
    return RpcError(code, message, data)


@dataclass(frozen=True)
class RpcRequest:
    jsonrpc: str
    method: str
    params: Dict[str, Any]
    id: Any


@dataclass(frozen=True)
class RpcResponse:
    jsonrpc: str
    result: Optional[Any]
    error: Optional[Dict[str, Any]]
    id: Any


def _jsonable(value: Any) -> Any:
    if is_dataclass(value):
        return _jsonable(asdict(value))
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    if isinstance(value, dict):
        return {str(k): _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple, set)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    if hasattr(value, "value") and isinstance(getattr(value, "value"), (str, int, float, bool)):
        return getattr(value, "value")
    if hasattr(value, "__dict__"):
        return _jsonable(vars(value))
    return str(value)


class RpcServer:
    def __init__(self, *, container: Optional[Dict[str, Any]] = None, protocol_version: Optional[str] = None) -> None:
        self.app = FastAPI()
        self.container = container or {}
        self.protocol_version = protocol_version or "unknown"

        self.scheduler = self.container.get("scheduler")
        self.tx_store = self.container.get("tx_store")
        self.verify = self.container.get("verify")
        self.patch = self.container.get("patch")
        self.ledger = self.container.get("ledger")

        self._methods: Dict[str, Callable[[Dict[str, Any]], Awaitable[Any]]] = {}
        self._register_methods()
        self._mount_routes()

    def _mount_routes(self) -> None:
        @self.app.get("/")
        async def root_probe():
            return {
                "ok": True,
                "service": "adjutorix-agent",
                "transport": "http",
                "protocol_version": self.protocol_version,
            }

        @self.app.get("/rpc")
        async def rpc_probe():
            return {
                "ok": True,
                "service": "adjutorix-agent",
                "transport": "jsonrpc",
                "method": "health.ping",
                "protocol_version": self.protocol_version,
            }

        @self.app.post("/rpc")
        async def handle(request: Request):
            payload: Dict[str, Any] | None = None
            try:
                payload = await request.json()
            except Exception:
                return self._error_response(None, _err(ERR_PARSE, "parse_error"))

            try:
                req = self._parse_request(payload)

                if req.method != "health.ping":
                    require_token(request, method=req.method)

                handler = self._methods.get(req.method)
                if handler is None:
                    raise _err(ERR_METHOD_NOT_FOUND, "method_not_found", {"method": req.method})

                result = await handler(req.params)
                return self._success_response(req.id, result)

            except HTTPException as exc:
                code = (
                    ERR_UNAUTHORIZED if exc.status_code == 401
                    else ERR_CONFLICT if exc.status_code == 409
                    else ERR_INVALID_PARAMS if exc.status_code == 400
                    else ERR_INTERNAL
                )
                message = str(exc.detail) if getattr(exc, "detail", None) is not None else "http_error"
                return self._error_response(payload.get("id") if payload else None, _err(code, message, {"status_code": exc.status_code}))
            except RpcError as exc:
                return self._error_response(payload.get("id") if payload else None, exc)
            except Exception as exc:
                return self._error_response(
                    payload.get("id") if payload else None,
                    _err(ERR_INTERNAL, "internal_error", {
                        "exception": str(exc),
                        "trace": traceback.format_exc(),
                    }),
                )

    def _parse_request(self, payload: Dict[str, Any]) -> RpcRequest:
        if payload.get("jsonrpc") != "2.0":
            raise _err(ERR_INVALID_REQUEST, "invalid_jsonrpc")
        if "method" not in payload:
            raise _err(ERR_INVALID_REQUEST, "missing_method")

        return RpcRequest(
            jsonrpc="2.0",
            method=str(payload["method"]),
            params=payload.get("params", {}) or {},
            id=payload.get("id"),
        )

    def _success_response(self, id_: Any, result: Any) -> JSONResponse:
        return JSONResponse(RpcResponse("2.0", _jsonable(result), None, id_).__dict__)

    def _error_response(self, id_: Any, err: RpcError) -> JSONResponse:
        return JSONResponse(RpcResponse("2.0", None, {
            "code": err.code,
            "message": err.message,
            "data": _jsonable(err.data),
        }, id_).__dict__)

    def _register(self, name: str, fn: Callable[[Dict[str, Any]], Awaitable[Any]]) -> None:
        if name in self._methods:
            raise RuntimeError(f"duplicate_method:{name}")
        self._methods[name] = fn

    def _register_methods(self) -> None:
        self._register("health.ping", self._health_ping)
        self._register("job.submit", self._job_submit)
        self._register("job.status", self._job_status)
        self._register("index.build", self._index_build)
        self._register("index.related", self._index_related)
        self._register("index.affected", self._index_affected)
        self._register("index.health", self._index_health)

    def _require_service(self, attr: str, method: str) -> Any:
        service = getattr(self, attr)
        if service is None:
            raise _err(ERR_INTERNAL, "service_unavailable", {"service": attr, "method": method})
        return service

    async def _invoke(self, attr: str, method: str, *args: Any, **kwargs: Any) -> Any:
        service = self._require_service(attr, method)
        fn = getattr(service, method, None)
        if fn is None:
            raise _err(ERR_CAPABILITY, "capability_unavailable", {"service": attr, "method": method})
        result = fn(*args, **kwargs)
        if inspect.isawaitable(result):
            result = await result
        return result

    async def _health_ping(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ts": int(time.time() * 1000),
            "protocol_version": self.protocol_version,
            "services": {
                "scheduler": self.scheduler is not None,
                "tx_store": self.tx_store is not None,
                "verify": self.verify is not None,
                "patch": self.patch is not None,
                "ledger": self.ledger is not None,
            },
        }

    async def _job_submit(self, params: Dict[str, Any]) -> Dict[str, Any]:
        scheduler = self._require_service("scheduler", "submit")
        key = params.get("idempotency_key")
        is_mutation = bool(params.get("is_mutation", False))
        job_id = scheduler.submit(
            lambda _ctx: {"accepted": True, "params": params},
            key=key if isinstance(key, str) and key else None,
            is_mutation=is_mutation,
            metadata={"source": "jsonrpc", "method": "job.submit"},
        )
        return {"job_id": job_id, "accepted": True}

    async def _job_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = params.get("job_id")
        if not isinstance(job_id, str) or not job_id.strip():
            raise _err(ERR_INVALID_PARAMS, "missing_job_id")
        record = await self._invoke("scheduler", "status", job_id)
        if record is None:
            raise _err(ERR_NOT_FOUND, "job_not_found", {"job_id": job_id})
        payload = _jsonable(record)
        if isinstance(payload, dict) and "state" in payload and hasattr(record, "state"):
            state = getattr(record, "state")
            payload["state"] = getattr(state, "value", payload["state"])
        return payload

    async def _index_build(self, params: Dict[str, Any]) -> Dict[str, Any]:
        root = params.get("root")
        if not isinstance(root, str) or not root.strip():
            raise _err(ERR_INVALID_PARAMS, "missing_root")

        repo = build_repo_index(root)

        files = []
        for f in repo.files:
            with open(f.rel_path, "rb") as fh:
                files.append((f.file_id, f.rel_path, fh.read()))

        symbols = build_symbol_index(files)
        graph = build_dependency_graph(repo, symbols)
        refs = build_reference_index(symbols)

        return {
            "repo": repo.index_hash,
            "symbols": symbols.index_hash,
            "graph": graph.index_hash,
            "refs": refs.index_hash,
        }

    async def _index_related(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return build_related_files(**params).__dict__

    async def _index_affected(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return compute_affected_files(**params).__dict__

    async def _index_health(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return analyze_index_health(**params).__dict__


def create_app(*, container: Optional[Dict[str, Any]] = None, protocol_version: Optional[str] = None) -> FastAPI:
    return RpcServer(container=container, protocol_version=protocol_version).app
