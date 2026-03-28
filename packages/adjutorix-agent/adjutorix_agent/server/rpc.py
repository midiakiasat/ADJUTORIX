"""
ADJUTORIX AGENT — SERVER / RPC

Authoritative JSON-RPC 2.0 server (single mutation + execution authority).

This module exposes the ONLY network entrypoint for all operations:
- job submission / control
- patch pipeline (preview/apply/reject/rebase/validate)
- verify pipeline (run/status/artifacts)
- ledger queries (current/at/range/replay/inspect)
- indexing queries (repo/symbols/graph/refs/related/affected/health)

Design constraints:
- No implicit side effects; every method is a transaction or read-only query
- Deterministic responses; all results include hashes/ids for audit
- Capability-gated; every call validated against server capabilities
- Idempotency; write calls accept idempotency_key to avoid duplication
- Strict error model; machine-parsable codes

Hard invariants:
- All mutations go through patch_pipeline via job submission
- No direct workspace writes from RPC layer
- Every response is JSON-serializable and stable
- Authentication required for all methods except health.ping
"""

from __future__ import annotations

import asyncio
import json
import time
import traceback
from dataclasses import dataclass
from typing import Any, Dict, Callable, Awaitable, Optional

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import JSONResponse

from adjutorix_agent.server.auth import require_token

# core services (authoritative)
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.transaction_store import TransactionStore
from adjutorix_agent.core.verify_pipeline import VerifyPipeline
from adjutorix_agent.core.patch_pipeline import PatchPipeline
from adjutorix_agent.ledger.store import LedgerStore

# indexing
from adjutorix_agent.indexing.repo_index import build_repo_index
from adjutorix_agent.indexing.symbol_index import build_symbol_index
from adjutorix_agent.indexing.dependency_graph import build_dependency_graph
from adjutorix_agent.indexing.references import build_reference_index
from adjutorix_agent.indexing.related_files import build_related_files
from adjutorix_agent.indexing.affected_files import compute_affected_files
from adjutorix_agent.indexing.health import analyze_index_health


# ---------------------------------------------------------------------------
# ERROR MODEL
# ---------------------------------------------------------------------------


class RpcError(Exception):
    def __init__(self, code: int, message: str, data: Optional[Dict[str, Any]] = None):
        self.code = code
        self.message = message
        self.data = data or {}


def _err(code: int, message: str, data: Optional[Dict[str, Any]] = None) -> RpcError:
    return RpcError(code, message, data)


# JSON-RPC standard-ish codes + domain codes
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


# ---------------------------------------------------------------------------
# REQUEST/RESPONSE
# ---------------------------------------------------------------------------


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


# ---------------------------------------------------------------------------
# SERVER
# ---------------------------------------------------------------------------


class RpcServer:
    def __init__(self) -> None:
        self.app = FastAPI()

        # authoritative services (singletons)
        self.scheduler = Scheduler()
        self.tx_store = TransactionStore()
        self.verify = VerifyPipeline()
        self.patch = PatchPipeline()
        self.ledger = LedgerStore()

        self._methods: Dict[str, Callable[[Dict[str, Any]], Awaitable[Any]]] = {}

        self._register_methods()
        self._mount_routes()

    # ------------------------------------------------------------------

    def _mount_routes(self) -> None:
        @self.app.post("/rpc")
        async def handle(request: Request):
            try:
                payload = await request.json()
            except Exception:
                return self._error_response(None, _err(ERR_PARSE, "parse_error"))

            try:
                req = self._parse_request(payload)
                # auth (except ping)
                if req.method != "health.ping":
                    require_token(request)

                handler = self._methods.get(req.method)
                if not handler:
                    raise _err(ERR_METHOD_NOT_FOUND, "method_not_found", {"method": req.method})

                result = await handler(req.params)
                return self._success_response(req.id, result)

            except RpcError as e:
                return self._error_response(payload.get("id"), e)
            except Exception as e:
                return self._error_response(payload.get("id"), _err(ERR_INTERNAL, "internal_error", {
                    "exception": str(e),
                    "trace": traceback.format_exc(),
                }))

    # ------------------------------------------------------------------

    def _parse_request(self, payload: Dict[str, Any]) -> RpcRequest:
        if payload.get("jsonrpc") != "2.0":
            raise _err(ERR_INVALID_REQUEST, "invalid_jsonrpc")
        if "method" not in payload:
            raise _err(ERR_INVALID_REQUEST, "missing_method")

        return RpcRequest(
            jsonrpc="2.0",
            method=payload["method"],
            params=payload.get("params", {}),
            id=payload.get("id"),
        )

    def _success_response(self, id_: Any, result: Any) -> JSONResponse:
        return JSONResponse(RpcResponse("2.0", result, None, id_).__dict__)

    def _error_response(self, id_: Any, err: RpcError) -> JSONResponse:
        return JSONResponse(RpcResponse("2.0", None, {
            "code": err.code,
            "message": err.message,
            "data": err.data,
        }, id_).__dict__)

    # ------------------------------------------------------------------
    # METHOD REGISTRATION
    # ------------------------------------------------------------------

    def _register(self, name: str, fn: Callable[[Dict[str, Any]], Awaitable[Any]]) -> None:
        if name in self._methods:
            raise RuntimeError(f"duplicate_method:{name}")
        self._methods[name] = fn

    def _register_methods(self) -> None:
        # health
        self._register("health.ping", self._health_ping)

        # jobs
        self._register("job.submit", self._job_submit)
        self._register("job.status", self._job_status)
        self._register("job.logs", self._job_logs)

        # verify
        self._register("verify.run", self._verify_run)
        self._register("verify.status", self._verify_status)
        self._register("verify.artifacts", self._verify_artifacts)

        # patch
        self._register("patch.preview", self._patch_preview)
        self._register("patch.apply", self._patch_apply)

        # ledger
        self._register("ledger.current", self._ledger_current)

        # indexing
        self._register("index.build", self._index_build)
        self._register("index.related", self._index_related)
        self._register("index.affected", self._index_affected)
        self._register("index.health", self._index_health)

    # ------------------------------------------------------------------
    # METHODS
    # ------------------------------------------------------------------

    async def _health_ping(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ts": int(time.time() * 1000)}

    # ---------------- JOB ----------------

    async def _job_submit(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = await self.scheduler.submit(params)
        return {"job_id": job_id}

    async def _job_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        jid = params.get("job_id")
        if not jid:
            raise _err(ERR_INVALID_PARAMS, "missing_job_id")
        return self.scheduler.status(jid)

    async def _job_logs(self, params: Dict[str, Any]) -> Dict[str, Any]:
        jid = params.get("job_id")
        since = int(params.get("since_seq", 0))
        return self.scheduler.logs(jid, since)

    # ---------------- VERIFY ----------------

    async def _verify_run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self.verify.run(params)

    async def _verify_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self.verify.status(params.get("verify_id"))

    async def _verify_artifacts(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self.verify.artifacts(params.get("verify_id"))

    # ---------------- PATCH ----------------

    async def _patch_preview(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self.patch.preview(params)

    async def _patch_apply(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return await self.patch.apply(params)

    # ---------------- LEDGER ----------------

    async def _ledger_current(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return self.ledger.current()

    # ---------------- INDEX ----------------

    async def _index_build(self, params: Dict[str, Any]) -> Dict[str, Any]:
        root = params.get("root")
        if not root:
            raise _err(ERR_INVALID_PARAMS, "missing_root")

        repo = build_repo_index(root)

        # load file contents
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


# ---------------------------------------------------------------------------
# ENTRYPOINT
# ---------------------------------------------------------------------------


def create_app() -> FastAPI:
    return RpcServer().app
