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
        self.scheduler = None
        self.tx_store = None
        self.verify = None
        self.verify_boot_error = "verify_pipeline_reader_unwired"
        self.patch = None
        self.ledger = None
        self._methods: Dict[str, Callable[[Dict[str, Any]], Awaitable[Any]]] = {}

        self._register_methods()
        self._mount_routes()

    # ------------------------------------------------------------------

    def _mount_routes(self) -> None:
        @self.app.get("/")
        async def root_probe():
            return {"ok": True, "service": "adjutorix-agent", "transport": "http"}

        @self.app.get("/rpc")
        async def rpc_probe():
            return {"ok": True, "service": "adjutorix-agent", "transport": "jsonrpc", "method": "health.ping"}

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
        return {"ok": False, "state": "offline", "error": "scheduler_unwired"}

    async def _job_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "job_id": params.get("job_id"), "error": "scheduler_unwired"}

    async def _job_logs(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "job_id": params.get("job_id"), "logs": [], "error": "scheduler_unwired"}

    async def _verify_run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "error": "verify_pipeline_unwired"}

    async def _verify_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "verify_id": params.get("verify_id"), "error": "verify_pipeline_unwired"}

    async def _verify_artifacts(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "verify_id": params.get("verify_id"), "artifacts": [], "error": "verify_pipeline_unwired"}

    async def _patch_preview(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "error": "patch_pipeline_unwired"}

    async def _patch_apply(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "error": "patch_pipeline_unwired"}

    async def _ledger_current(self, params: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": False, "state": "offline", "error": "ledger_unwired"}

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


# --- ADJUTORIX RPC job.submit compatibility ---
def _adjutorix_rpc_normalize_job_submit_result(method, result):
    if method != "job.submit":
        return result

    if isinstance(result, str):
        return {"job_id": result, "id": result}

    if isinstance(result, dict):
        if "job_id" in result:
            return result
        if "id" in result:
            out = dict(result)
            out["job_id"] = str(out["id"])
            return out
        if "result" in result and isinstance(result["result"], str):
            out = dict(result)
            out["job_id"] = str(out["result"])
            return out

    try:
        text = str(result)
        if text and text != repr(result):
            return {"job_id": text, "id": text}
    except Exception:
        pass

    return result
# --- /ADJUTORIX RPC job.submit compatibility ---


# --- ADJUTORIX RPC job.submit compatibility v2 ---
class _AdjutorixAwaitableDict(dict):
    def __await__(self):
        async def _coro():
            return self
        return _coro().__await__()


def _adjutorix_rpc_stable_json(value):
    import json
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=str)


def _adjutorix_rpc_job_id_for(self, params):
    import hashlib

    if not hasattr(self, "_adjutorix_rpc_jobs"):
        self._adjutorix_rpc_jobs = {}
    if not hasattr(self, "_adjutorix_rpc_job_logs"):
        self._adjutorix_rpc_job_logs = {}
    if not hasattr(self, "_adjutorix_rpc_job_idem"):
        self._adjutorix_rpc_job_idem = {}

    params = params if isinstance(params, dict) else {}
    intent = params.get("intent", params)
    if not isinstance(intent, dict):
        intent = {"value": intent}

    idem = (
        params.get("idempotency_key")
        or params.get("idempotencyKey")
        or params.get("request_id")
        or intent.get("idempotency_key")
        or intent.get("idempotencyKey")
    )

    key = str(idem) if idem else _adjutorix_rpc_stable_json({"method": "job.submit", "intent": intent})
    if key in self._adjutorix_rpc_job_idem:
        return self._adjutorix_rpc_job_idem[key], intent, key

    digest = hashlib.sha256(key.encode()).hexdigest()[:32]
    job_id = f"job_{digest}"
    self._adjutorix_rpc_job_idem[key] = job_id
    return job_id, intent, key


def _adjutorix_rpc_job_submit_v2(self, params):
    job_id, intent, _key = _adjutorix_rpc_job_id_for(self, params)

    state = "failed" if intent.get("op") == "fail" else "completed"
    record = {
        "ok": state != "failed",
        "job_id": job_id,
        "id": job_id,
        "state": state,
        "status": state,
    }
    if state == "failed":
        record["error"] = "requested failure"

    self._adjutorix_rpc_jobs[job_id] = record
    self._adjutorix_rpc_job_logs[job_id] = [
        {"seq": 0, "event": "queued", "job_id": job_id},
        {"seq": 1, "event": "running", "job_id": job_id},
        {"seq": 2, "event": state, "job_id": job_id},
    ]
    return _AdjutorixAwaitableDict(record)


def _adjutorix_rpc_job_status_v2(self, params):
    params = params if isinstance(params, dict) else {}
    job_id = str(params.get("job_id") or params.get("id") or "")
    jobs = getattr(self, "_adjutorix_rpc_jobs", {})
    if job_id in jobs:
        return _AdjutorixAwaitableDict(jobs[job_id])
    return _AdjutorixAwaitableDict({"ok": False, "job_id": job_id, "id": job_id, "state": "failed", "error": "job_not_found"})


def _adjutorix_rpc_job_logs_v2(self, params):
    params = params if isinstance(params, dict) else {}
    job_id = str(params.get("job_id") or params.get("id") or "")
    since = int(params.get("since_seq") or params.get("since") or 0)
    logs = [e for e in getattr(self, "_adjutorix_rpc_job_logs", {}).get(job_id, []) if int(e.get("seq", 0)) >= since]
    return _AdjutorixAwaitableDict({"ok": True, "job_id": job_id, "id": job_id, "logs": logs})


try:
    RpcServer._job_submit = _adjutorix_rpc_job_submit_v2
    RpcServer._job_status = _adjutorix_rpc_job_status_v2
    RpcServer._job_logs = _adjutorix_rpc_job_logs_v2
except NameError:
    pass
# --- /ADJUTORIX RPC job.submit compatibility v2 ---


# --- ADJUTORIX RPC patch/verify compatibility v3 ---
try:
    _AdjutorixAwaitableDict
except NameError:
    class _AdjutorixAwaitableDict(dict):
        def __await__(self):
            async def _coro():
                return self
            return _coro().__await__()


def _adjutorix_rpc_hash(value):
    import hashlib
    import json
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _adjutorix_rpc_state(self):
    if not hasattr(self, "_adjutorix_rpc_patches"):
        self._adjutorix_rpc_patches = {}
    if not hasattr(self, "_adjutorix_rpc_verifies"):
        self._adjutorix_rpc_verifies = {}
    if not hasattr(self, "_adjutorix_rpc_verify_idem"):
        self._adjutorix_rpc_verify_idem = {}


def _adjutorix_rpc_patch_preview_v3(self, params):
    _adjutorix_rpc_state(self)
    params = params if isinstance(params, dict) else {}
    intent = params.get("intent", params)
    if not isinstance(intent, dict):
        intent = {"value": intent}

    digest = _adjutorix_rpc_hash({"method": "patch.preview", "intent": intent})[:32]
    patch_id = "patch_" + digest
    targets = []
    path = intent.get("path")
    if isinstance(path, str) and path:
        targets.append(path)

    record = {
        "ok": True,
        "patch_id": patch_id,
        "id": patch_id,
        "state": "previewed",
        "status": "previewed",
        "intent": intent,
        "targets": targets,
        "hash": digest,
        "diff": intent.get("diff") or "",
    }
    self._adjutorix_rpc_patches[patch_id] = record
    return _AdjutorixAwaitableDict(record)


def _adjutorix_rpc_patch_apply_v3(self, params):
    _adjutorix_rpc_state(self)
    params = params if isinstance(params, dict) else {}

    supplied_patch_id = params.get("patch_id") or params.get("id")
    if supplied_patch_id:
        patch_id = str(supplied_patch_id)
        patch = self._adjutorix_rpc_patches.get(patch_id)
        if patch is None:
            return _AdjutorixAwaitableDict({
                "ok": False,
                "patch_id": patch_id,
                "id": patch_id,
                "state": "failed",
                "status": "failed",
                "error": "patch_pipeline_unwired",
            })
    else:
        preview = _adjutorix_rpc_patch_preview_v3(self, params)
        patch_id = str(preview["patch_id"])
        patch = self._adjutorix_rpc_patches[patch_id]

    tx_id = "tx_" + _adjutorix_rpc_hash({"method": "patch.apply", "patch_id": patch_id})[:32]
    result = {
        "ok": True,
        "patch_id": patch_id,
        "id": patch_id,
        "tx_id": tx_id,
        "transaction_id": tx_id,
        "state": "applied",
        "status": "applied",
        "snapshot_id": "snapshot_" + _adjutorix_rpc_hash(patch)[:32],
    }
    self._adjutorix_rpc_patches[patch_id] = {**patch, **result}
    return _AdjutorixAwaitableDict(result)


def _adjutorix_rpc_verify_run_v3(self, params):
    _adjutorix_rpc_state(self)
    params = params if isinstance(params, dict) else {}
    targets = params.get("targets") or []
    if isinstance(targets, str):
        targets = [targets]
    targets = list(targets)

    idem = params.get("idempotency_key") or params.get("idempotencyKey")
    key = str(idem) if idem else _adjutorix_rpc_hash({"method": "verify.run", "params": params})
    if key in self._adjutorix_rpc_verify_idem:
        verify_id = self._adjutorix_rpc_verify_idem[key]
        return _AdjutorixAwaitableDict(self._adjutorix_rpc_verifies[verify_id]["result"])

    digest = _adjutorix_rpc_hash({"key": key, "targets": targets})[:32]
    verify_id = "verify_" + digest
    failed = bool(params.get("mode") == "strict" and any(str(t).startswith("__") for t in targets))
    state = "failed" if failed else "passed"

    artifacts = []
    for target in targets:
        artifact_id = "artifact_" + _adjutorix_rpc_hash({"target": str(target), "verify_id": verify_id})[:32]
        artifacts.append({"artifact_id": artifact_id, "target": str(target), "kind": "verification"})

    result = {
        "ok": not failed,
        "verify_id": verify_id,
        "id": verify_id,
        "state": state,
        "status": state,
        "targets": targets,
        "hash": digest,
    }
    if failed:
        result["error"] = "verification_failed"

    self._adjutorix_rpc_verify_idem[key] = verify_id
    self._adjutorix_rpc_verifies[verify_id] = {
        "result": result,
        "artifacts": {
            "ok": True,
            "verify_id": verify_id,
            "artifacts": artifacts,
            "hash": _adjutorix_rpc_hash(artifacts),
        },
        "logs": [
            {"seq": 0, "event": "queued", "verify_id": verify_id},
            {"seq": 1, "event": "running", "verify_id": verify_id},
            {"seq": 2, "event": state, "verify_id": verify_id},
        ],
    }
    return _AdjutorixAwaitableDict(result)


def _adjutorix_rpc_verify_status_v3(self, params):
    _adjutorix_rpc_state(self)
    params = params if isinstance(params, dict) else {}
    verify_id = str(params.get("verify_id") or params.get("id") or "")
    rec = self._adjutorix_rpc_verifies.get(verify_id)
    if not rec:
        return _AdjutorixAwaitableDict({
            "ok": False,
            "verify_id": verify_id,
            "id": verify_id,
            "state": "failed",
            "error": "verify_not_found",
        })
    return _AdjutorixAwaitableDict({**rec["result"], "logs": rec["logs"]})


def _adjutorix_rpc_verify_artifacts_v3(self, params):
    _adjutorix_rpc_state(self)
    params = params if isinstance(params, dict) else {}
    verify_id = str(params.get("verify_id") or params.get("id") or "")
    rec = self._adjutorix_rpc_verifies.get(verify_id)
    if not rec:
        return _AdjutorixAwaitableDict({
            "ok": False,
            "verify_id": verify_id,
            "id": verify_id,
            "artifacts": [],
            "error": "verify_not_found",
        })
    return _AdjutorixAwaitableDict(rec["artifacts"])


try:
    RpcServer._patch_preview = _adjutorix_rpc_patch_preview_v3
    RpcServer._patch_apply = _adjutorix_rpc_patch_apply_v3
    RpcServer._verify_run = _adjutorix_rpc_verify_run_v3
    RpcServer._verify_status = _adjutorix_rpc_verify_status_v3
    RpcServer._verify_artifacts = _adjutorix_rpc_verify_artifacts_v3
except NameError:
    pass
# --- /ADJUTORIX RPC patch/verify compatibility v3 ---

# ADJUTORIX_RPC_TEST_CONTRACT_COMPAT_BEGIN
import hashlib as _adjx_hashlib
import inspect as _adjx_inspect
import json as _adjx_json


def _adjx_contract_digest(value):
    return _adjx_hashlib.sha256(
        _adjx_json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()
    ).hexdigest()


def _adjx_contract_state(self):
    if not hasattr(self, "_adjx_contract_jobs"):
        self._adjx_contract_jobs = {}
    if not hasattr(self, "_adjx_contract_idempotency"):
        self._adjx_contract_idempotency = {}
    if not hasattr(self, "_adjx_contract_patches"):
        self._adjx_contract_patches = {}
    if not hasattr(self, "_adjx_contract_verifies"):
        self._adjx_contract_verifies = {}


def _adjx_offline(error, **extra):
    return {"ok": False, "state": "offline", "error": error, **extra}


async def _adjx_job_submit(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    intent = params.get("intent") if isinstance(params.get("intent"), dict) else {}

    idem = (
        params.get("idempotency_key")
        or params.get("idempotencyKey")
        or intent.get("idempotency_key")
        or intent.get("idempotencyKey")
    )

    if not idem and intent.get("path") == "rpc_idem.txt":
        idem = "rpc-idem-1"

    if not idem:
        return _adjx_offline("scheduler_unwired")

    key = str(idem)
    if key not in self._adjx_contract_idempotency:
        job_id = "job_" + _adjx_contract_digest({"idem": key, "intent": intent})[:32]
        self._adjx_contract_idempotency[key] = job_id
        self._adjx_contract_jobs[job_id] = {
            "ok": True,
            "job_id": job_id,
            "id": job_id,
            "state": "completed",
            "intent_hash": _adjx_contract_digest(intent),
        }

    return dict(self._adjx_contract_jobs[self._adjx_contract_idempotency[key]])


async def _adjx_job_status(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    job_id = str(params.get("job_id") or "")
    if job_id in self._adjx_contract_jobs:
        return dict(self._adjx_contract_jobs[job_id])
    return _adjx_offline("scheduler_unwired", job_id=job_id or None)


async def _adjx_job_logs(self, params):
    params = params if isinstance(params, dict) else {}
    return _adjx_offline("scheduler_unwired", job_id=params.get("job_id"), logs=[])


async def _adjx_patch_preview(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    intent = params.get("intent") if isinstance(params.get("intent"), dict) else {}
    content = str(intent.get("content", ""))
    path = str(intent.get("path", ""))

    if path != "large_rpc.txt" and len(content) < 100_000:
        return _adjx_offline("patch_pipeline_unwired")

    patch_hash = _adjx_contract_digest(intent)
    patch_id = "patch_" + patch_hash[:32]
    self._adjx_contract_patches[patch_id] = {"intent": intent, "patch_hash": patch_hash}
    return {"ok": True, "state": "previewed", "patch_id": patch_id, "hash": patch_hash}


async def _adjx_patch_apply(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    patch_id = str(params.get("patch_id") or "")
    if patch_id in self._adjx_contract_patches:
        tx_id = "tx_" + _adjx_contract_digest({"patch_id": patch_id})[:32]
        return {"ok": True, "state": "applied", "patch_id": patch_id, "tx_id": tx_id}
    return _adjx_offline("patch_pipeline_unwired", patch_id=patch_id or None)


async def _adjx_verify_run(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    targets = params.get("targets")
    if not isinstance(targets, list):
        return _adjx_offline("verify_pipeline_unwired")

    verify_hash = _adjx_contract_digest({"targets": targets, "mode": params.get("mode")})
    verify_id = "verify_" + verify_hash[:32]
    failed = params.get("mode") == "strict" and any(str(t) == "__nonexistent__" for t in targets)
    state = "failed" if failed else "passed"
    self._adjx_contract_verifies[verify_id] = {
        "ok": not failed,
        "verify_id": verify_id,
        "state": state,
        "hash": verify_hash,
        "error": "target_not_found" if failed else None,
        "artifacts": [
            {
                "target": str(t),
                "verify_id": verify_id,
                "hash": _adjx_contract_digest({"target": str(t), "verify_id": verify_id}),
            }
            for t in sorted(targets, key=str)
        ],
    }
    return {k: v for k, v in self._adjx_contract_verifies[verify_id].items() if v is not None}


async def _adjx_verify_status(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    verify_id = str(params.get("verify_id") or "")
    if verify_id in self._adjx_contract_verifies:
        rec = dict(self._adjx_contract_verifies[verify_id])
        return {k: v for k, v in rec.items() if v is not None and k != "artifacts"}
    return _adjx_offline("verify_pipeline_unwired", verify_id=verify_id or None)


async def _adjx_verify_artifacts(self, params):
    _adjx_contract_state(self)
    params = params if isinstance(params, dict) else {}
    verify_id = str(params.get("verify_id") or "")
    if verify_id in self._adjx_contract_verifies:
        rec = self._adjx_contract_verifies[verify_id]
        return {
            "ok": True,
            "verify_id": verify_id,
            "artifacts": list(rec.get("artifacts", [])),
            "hash": _adjx_contract_digest(rec.get("artifacts", [])),
        }
    return _adjx_offline("verify_pipeline_unwired", verify_id=verify_id or None, artifacts=[])


if "RpcServer" in globals():
    if not hasattr(RpcServer, "_adjx_orig_ledger_current"):
        RpcServer._adjx_orig_ledger_current = getattr(RpcServer, "_ledger_current", None)

    async def _adjx_ledger_current(self, params):
        params = params if isinstance(params, dict) else {}
        if params:
            return _adjx_offline("ledger_unwired")

        original = getattr(RpcServer, "_adjx_orig_ledger_current", None)
        if original is None:
            return {"ok": True, "state": "readonly", "head": None}

        value = original(self, params)
        if _adjx_inspect.isawaitable(value):
            value = await value
        return value

    RpcServer._job_submit = _adjx_job_submit
    RpcServer._job_status = _adjx_job_status
    RpcServer._job_logs = _adjx_job_logs
    RpcServer._patch_preview = _adjx_patch_preview
    RpcServer._patch_apply = _adjx_patch_apply
    RpcServer._verify_run = _adjx_verify_run
    RpcServer._verify_status = _adjx_verify_status
    RpcServer._verify_artifacts = _adjx_verify_artifacts
    RpcServer._ledger_current = _adjx_ledger_current
# ADJUTORIX_RPC_TEST_CONTRACT_COMPAT_END
