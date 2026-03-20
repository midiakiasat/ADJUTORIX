# packages/adjutorix-agent/adjutorix_agent/server/rpc.py

from __future__ import annotations

import asyncio
import os
import secrets
import time
import traceback
from pathlib import Path
from typing import Any, Dict, List, Optional

from ..actions.safe_runner import PolicyError, run_action as safe_run_action
from ..chat.controller import Controller
from ..chat.router import ChatRouter
from ..core.context_budget import ContextBudget
from ..core.executor import Executor
from ..core.job_ledger import JobLedger
from ..core.lock_manager import LockManager
from ..core.recovery import RecoveryManager
from ..core.rollback import RollbackManager
from ..core.state_machine import StateMachine
from ..core.taxonomy import ErrorTaxonomy
from ..governance.policy import PolicyManager
from ..llm.ollama_chat import OllamaChat
from ..tools.registry import ToolRegistry
from .auth import require_local_token
from ..core.sqlite_ledger import SCHEMA_VERSION as LEDGER_SCHEMA_VERSION
from ..core.sqlite_ledger import LedgerError, SqliteLedger
from ..core.workflow import (
    WorkflowError,
    apply_intent,
    allowed_intents,
    _empty_snapshot,
)


PROTOCOL_VERSION = 1
BUILD_FINGERPRINT = "job_v1"
# Advertised RPC methods (engine never lies). debug.snapshot is debug-only but advertised.
JOB_METHODS = [
    "ping",
    "capabilities",
    "authority",
    "job.run",
    "job.status",
    "job.logs",
    "job.cancel",
    "job.list_recent",
    "patch.propose",
    "patch.list",
    "patch.get",
    "patch.accept",
    "patch.reject",
    "patch.apply",
    "workflow.get",
    "workflow.intent",
    "ledger.tail",
    "ledger.replay",
    "debug.snapshot",
]


def _reject(code: str, message: str, trace_id: Optional[str] = None) -> Dict[str, Any]:
    return {
        "type": "reject",
        "trace_id": trace_id or "no_trace",
        "engine": "none",
        "payload": {"code": code, "message": message},
    }


class RPCError(Exception):
    def __init__(self, code: str, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}


class JobEngine:
    """
    SQLite-backed job engine: one worker, durable queue, job.run returns job_id immediately.
    State lives in DB. Restart marks running jobs aborted (engine_restart).
    """

    def __init__(self, repo_root: str, ledger: SqliteLedger) -> None:
        self.repo_root = Path(repo_root).resolve()
        self.ledger = ledger
        self._current_job_id: Optional[str] = None
        self._lock = asyncio.Lock()
        self._worker_task: Optional[asyncio.Task] = None

    def _resolve_cwd(self, cwd: Optional[str]) -> Path:
        if not cwd or not cwd.strip():
            return self.repo_root
        p = Path(cwd).resolve()
        if not p.exists():
            raise RPCError("INVALID_CWD", f"cwd does not exist: {cwd}")
        if not p.is_dir():
            raise RPCError("INVALID_CWD", f"cwd is not a directory: {cwd}")
        try:
            p.relative_to(self.repo_root)
        except ValueError:
            if p != self.repo_root:
                raise RPCError("INVALID_CWD", f"cwd must be under repo_root: {self.repo_root}")
        return p

    def create_job(self, kind: str, cwd: Optional[str], confirm: bool) -> str:
        cwd_path = self._resolve_cwd(cwd)
        job_id = secrets.token_hex(8)
        self.ledger.create_job(
            job_id=job_id,
            kind=kind,
            repo_root=str(self.repo_root),
            cwd=str(cwd_path),
            confirm=confirm,
        )
        return job_id

    def get_status(self, job_id: str) -> Optional[Dict[str, Any]]:
        job = self.ledger.get_job(job_id)
        if not job:
            return None
        return {
            "id": job["job_id"],
            "kind": job["kind"],
            "state": job["state"],
            "created_at": job["created_at_ms"] / 1000.0,
            "started_at": job["started_at_ms"] / 1000.0 if job["started_at_ms"] is not None else None,
            "finished_at": job["finished_at_ms"] / 1000.0 if job["finished_at_ms"] is not None else None,
            "cwd": job["cwd"],
            "exit_code": 0 if job["state"] == "success" else (1 if job["state"] in ("failed", "aborted") else None),
            "summary": job["summary"] or job["error"] or "",
            "report": {},
            "logs_cursor": self.ledger.next_seq(job_id),
        }

    def get_logs(self, job_id: str, since_seq: int = 0) -> Dict[str, Any]:
        return self.ledger.get_logs(job_id, since_seq=since_seq)

    def cancel(self, job_id: str) -> bool:
        """Cancel queued or running job via DB only. Returns True if state was updated."""
        return self.ledger.cancel_job(job_id)

    def _finish_job_safe(
        self, job_id: str, *, state: str, summary: str = "", error: str = ""
    ) -> None:
        """Call ledger.finish_job; if LedgerError and job is already terminal, swallow."""
        try:
            self.ledger.finish_job(
                job_id, state=state, summary=summary, error=error
            )
        except LedgerError:
            job = self.ledger.get_job(job_id)
            if job and job["state"] in ("success", "failed", "canceled", "aborted"):
                return
            raise

    async def _run_one(self, job_id: str, repo_root: str) -> None:
        job = self.ledger.get_job(job_id)
        if not job or job["state"] != "queued":
            return

        try:
            self.ledger.start_job(job_id)
        except LedgerError:
            return

        kind = job["kind"]
        confirm = bool(job.get("confirm", 0))
        cwd = job["cwd"]

        def append_log(line: str) -> None:
            self.ledger.append_log(job_id, line, stream="system")

        try:
            result = await asyncio.to_thread(
                safe_run_action,
                repo_root,
                kind,
                require_confirm=confirm,
                cwd=cwd,
            )
            status = result.get("status", "failed")
            if status == "success":
                self._finish_job_safe(
                    job_id, state="success", summary=result.get("message", "success")
                )
            else:
                self._finish_job_safe(
                    job_id,
                    state="failed",
                    summary=result.get("message", status),
                    error="nonzero",
                )
            results = result.get("results") or []
            # When lint fails due to config/tooling, prepend one contextual line
            for r in results:
                cmd = (r.get("command") or "").lower()
                stderr = (r.get("stderr") or "").lower()
                if "lint" in cmd and (
                    "configuration" in stderr
                    or "no eslint" in stderr
                    or "no config" in stderr
                ):
                    append_log(
                        "lint failed: ESLint configuration missing or invalid"
                    )
                    break
            for r in results:
                append_log(
                    f"[{r.get('command', '')}] return_code={r.get('return_code', '')}"
                )
                if r.get("stdout"):
                    for line in (r["stdout"] or "").strip().split("\n")[:50]:
                        append_log(line)
                if r.get("stderr"):
                    for line in (r["stderr"] or "").strip().split("\n")[:50]:
                        append_log(f"stderr: {line}")
        except PolicyError as e:
            self.ledger.append_log(job_id, f"blocked: {e}", stream="system")
            self._finish_job_safe(
                job_id, state="failed", summary=str(e), error="policy_blocked"
            )
        except Exception as e:
            self.ledger.append_log(job_id, f"error: {e}", stream="system")
            self._finish_job_safe(
                job_id, state="failed", summary=str(e), error="exception"
            )

    async def _worker(self, repo_root: str) -> None:
        try:
            while True:
                async with self._lock:
                    queued = self.ledger.list_queued_job_ids()
                    if not queued:
                        self._current_job_id = None
                        return
                    job_id = queued[0]
                    self._current_job_id = job_id
                await self._run_one(job_id, repo_root)
                async with self._lock:
                    self._current_job_id = None
        finally:
            async with self._lock:
                self._worker_task = None
                self._current_job_id = None

    async def ensure_worker(self, repo_root: str) -> None:
        async with self._lock:
            queued = self.ledger.list_queued_job_ids()
            if not queued:
                return
            if self._worker_task is not None and not self._worker_task.done():
                return
            self._worker_task = asyncio.create_task(self._worker(repo_root))

    def snapshot(self, last_n_logs: int = 20) -> Dict[str, Any]:
        jobs_out: List[Dict[str, Any]] = []
        for j in self.ledger.list_recent_jobs(50):
            jid = j["job_id"]
            data = self.ledger.get_logs(jid, since_seq=0, limit=last_n_logs * 2)
            lines = data["lines"][-last_n_logs:] if data["lines"] else []
            jobs_out.append({
                "job_id": jid,
                "state": j["state"],
                "last_logs": [x["line"] for x in lines],
            })
        return {
            "queue_length": self.ledger.count_queued(),
            "current_job_id": self._current_job_id,
            "jobs": jobs_out,
        }


class RPCDispatcher:
    """
    Minimal JSON-RPC dispatcher used by the FastAPI app.
    Keeps stateful singletons (policy/tooling/ledger) and exposes RPC methods.
    """

    def __init__(self, repo_root: str):
        self.repo_root = repo_root

        # Governance + safety primitives
        self.policy_manager = PolicyManager(repo_root=self.repo_root)
        self.policy = self.policy_manager.load()

        self.tool_registry = ToolRegistry()
        self.rollback = RollbackManager(workspace=Path(self.repo_root))
        self.context_budget = ContextBudget()

        # Core orchestration
        self.state_machine = StateMachine()
        _root = Path(self.repo_root)
        self.job_ledger = JobLedger(agent_root=_root / ".agent", repo_root=_root)
        self.taxonomy = ErrorTaxonomy()
        self.locks = LockManager(repo_root=self.repo_root)
        self.recovery = RecoveryManager(
            repo_root=self.repo_root,
            state_machine=self.state_machine,
            job_ledger=self.job_ledger,
        )

        self.executor = Executor(
            workspace=_root,
            tool_registry=self.tool_registry,
            rollback=self.rollback,
            policy=self.policy,
            context_budget=self.context_budget,
        )

        try:
            ollama = OllamaChat(model="mistral", base_url="http://127.0.0.1:11434")
            self.chat_router = ChatRouter(llm=ollama)
        except Exception:
            self.chat_router = ChatRouter(llm=None)
        self.controller = Controller()

        agent_root = Path(self.repo_root) / ".agent"
        db_path = agent_root / "ledger.sqlite"
        self.ledger = SqliteLedger(db_path=db_path)
        recovered = self.ledger.recover_on_startup(reason="engine_restart")
        self._recovered_on_startup = recovered
        self._db_path = db_path
        self.job_engine = JobEngine(repo_root=self.repo_root, ledger=self.ledger)
        self._started_at_ms = int(time.time() * 1000)
        self._workflow_snapshots: Dict[str, Dict[str, Any]] = {}

    def _engine_identity(self) -> Dict[str, Any]:
        """Return EngineIdentity shape for ping/capabilities (TS contract)."""
        return {
            "name": "adjutorix-engine",
            "version": "v1.0.0",
            "fingerprint": BUILD_FINGERPRINT,
            "mode": "unknown",
            "pid": os.getpid(),
            "started_at": self._started_at_ms,
            "workspace_root": self.repo_root,
            "db_path": str(self._db_path),
        }

    # -----------------------
    # JSON-RPC entrypoint
    # -----------------------
    async def dispatch(self, payload: Dict[str, Any], token: str) -> Dict[str, Any]:
        """
        Parse JSON-RPC 2.0 payload, call handle(token, method, params), return JSON-RPC response.
        Supports async RPC methods (e.g. chat) so blocking LLM calls don't starve health/ping.
        """
        req_id = payload.get("id")
        method = payload.get("method")
        params = payload.get("params")
        if not method:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": -32600, "message": "Invalid Request", "data": "missing method"},
            }
        try:
            result = await self.handle(token, method, params or {})
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except RPCError as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": e.code, "message": e.message, "data": e.data},
            }
        except WorkflowError as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": e.code,
                    "message": e.message,
                    "data": {"detail": e.detail},
                },
            }
        except Exception as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {
                    "code": "INTERNAL",
                    "message": str(e),
                    "data": {"traceback": traceback.format_exc()},
                },
            }

    async def handle(self, token: str, method: str, params: Dict[str, Any]) -> Any:
        try:
            require_local_token(token)
        except Exception as e:
            raise RPCError("UNAUTHORIZED", "Invalid or missing token", {"raw": str(e)})

        method_key = method.replace(".", "_")
        fn = getattr(self, f"rpc_{method_key}", None)
        if fn is None:
            raise RPCError("METHOD_NOT_FOUND", f"Unknown method: {method}")

        result = fn(params or {})
        if asyncio.iscoroutine(result):
            return await result
        return result

    # -----------------------
    # RPC methods (minimal set)
    # -----------------------
    def rpc_ping(self, _: Dict[str, Any]) -> Dict[str, Any]:
        """PingResult: { ok: true, engine: EngineIdentity }."""
        return {"ok": True, "engine": self._engine_identity()}

    def rpc_status(self, _: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "state": self.state_machine.state,
            "repo_root": self.repo_root,
        }

    def rpc_capabilities(self, _: Dict[str, Any]) -> Dict[str, Any]:
        """EngineCapabilities: ok, engine, features, actions[], drivers[], limits?, protocol?, methods?."""
        return {
            "ok": True,
            "engine": self._engine_identity(),
            "features": {"chat": True, "actions": True, "streaming": False},
            "actions": [
                {"name": "check"},
                {"name": "fix"},
                {"name": "verify"},
                {"name": "deploy", "requires_confirm": True},
            ],
            "drivers": ["shell"],
            "protocol": PROTOCOL_VERSION,
            "methods": list(JOB_METHODS),
        }

    def rpc_authority(self, _: Dict[str, Any]) -> Dict[str, Any]:
        """
        Live authority snapshot: what the engine can do right now.
        Derived from safe_runner gates, ledger state, env. UI must show this.
        writes_allowed: set ADJUTORIX_WRITES_ALLOWED=1 to enable apply path (default: patch-only).
        """
        import os

        sandbox_enforced = os.getenv("ADJUTORIX_SANDBOX_ACTIONS", "1") != "0"
        writes_allowed = os.getenv("ADJUTORIX_WRITES_ALLOWED", "0").strip().lower() in ("1", "true", "yes")
        queued = self.ledger.list_queued_job_ids()
        proposed = self.ledger.list_patches(status="proposed", limit=500)
        accepted = self.ledger.list_patches(status="accepted", limit=500)
        pending_patches = len(proposed) + len(accepted)
        pending_jobs = len(queued)
        running = [
            j for j in (self.job_engine.snapshot(last_n_logs=0).get("jobs") or [])
            if j.get("state") == "running"
        ]
        ledger_state = "clean" if (not running and pending_jobs == 0) else "active"
        actions = ["check", "verify"]
        if writes_allowed:
            actions.append("fix")
        if writes_allowed and os.getenv("ADJUTORIX_DEPLOY_ALLOWED", "0").strip().lower() in ("1", "true", "yes"):
            actions.append("deploy")
        return {
            "writes_allowed": writes_allowed,
            "writes_note": "patch-only" if not writes_allowed else "apply-enabled",
            "actions_allowed": actions,
            "sandbox_enforced": sandbox_enforced,
            "ledger_state": ledger_state,
            "pending_patches": pending_patches,
            "pending_jobs": pending_jobs,
        }

    async def rpc_chat(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        Chat RPC: returns envelope only. intent is one of: no_action, propose_patch, propose_job.
        Chat is advisory; no freeform text pretending to act.
        """
        trace_id = secrets.token_hex(8)

        messages = params.get("messages") or []
        if not isinstance(messages, list):
            messages = []

        try:
            env = await asyncio.to_thread(self.controller.handle, messages)
            if isinstance(env, dict) and "type" in env:
                env.setdefault("trace_id", trace_id)
                env.setdefault("engine", "none")
                env.setdefault("payload", {})
                env.setdefault("intent", "no_action")
                env.setdefault("analysis", "")
                return env
            return _reject("INVALID_CHAT_RESULT", "chat returned non-envelope", trace_id=trace_id)
        except Exception as e:
            return _reject("RPC_CHAT_FAILED", str(e), trace_id=trace_id)

    async def rpc_job_run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        kind = str(params.get("kind") or "check")
        if kind not in ("check", "fix", "verify", "deploy"):
            raise RPCError("INVALID_REQUEST", f"kind must be check|fix|verify|deploy, got: {kind}")
        workflow_session_id = params.get("workflow_session_id") or params.get("session_id")
        if kind == "deploy":
            if not workflow_session_id:
                raise RPCError(
                    "error.precondition_failed",
                    "deploy requires workflow_session_id for gate (result.regression must be pass)",
                )
            snap = self._workflow_snapshots.get(workflow_session_id)
            if not snap:
                raise RPCError("error.precondition_failed", "workflow session not found for deploy gate")
            if (snap.get("result") or {}).get("regression") != "pass":
                raise RPCError(
                    "error.precondition_failed",
                    "Deploy blocked: no passing verify result (result.regression must be 'pass')",
                )
            authority = self._workflow_authority()
            actions = authority.get("actions_allowed") or []
            if "deploy" not in actions:
                raise RPCError("error.permission_denied", "deploy not in actions_allowed")
        cwd = params.get("cwd")
        confirm = bool(params.get("confirm", False))
        job_id = self.job_engine.create_job(kind=kind, cwd=cwd, confirm=confirm)
        await self.job_engine.ensure_worker(self.repo_root)
        return {"job_id": job_id}

    def rpc_job_status(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            raise RPCError("INVALID_REQUEST", "id or job_id required")
        status = self.job_engine.get_status(str(job_id))
        if status is None:
            raise RPCError("NOT_FOUND", f"Job not found: {job_id}")
        return status

    def rpc_job_logs(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            raise RPCError("INVALID_REQUEST", "id or job_id required")
        since_seq = int(params.get("since_seq", 0))
        return self.job_engine.get_logs(str(job_id), since_seq=since_seq)

    def rpc_job_cancel(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = params.get("id") or params.get("job_id")
        if not job_id:
            raise RPCError("INVALID_REQUEST", "id or job_id required")
        ok = self.job_engine.cancel(str(job_id))
        return {"ok": ok}

    def rpc_job_list_recent(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Return recent jobs for truth UI without scraping snapshot. Keys: job_id, state, created_at_ms, started_at_ms, finished_at_ms, kind, summary."""
        limit = int(params.get("limit", 50))
        limit = min(max(limit, 1), 200)
        rows = self.ledger.list_recent_jobs(limit=limit)
        jobs = [
            {
                "job_id": r["job_id"],
                "state": r["state"],
                "created_at_ms": r["created_at_ms"],
                "started_at_ms": r["started_at_ms"],
                "finished_at_ms": r["finished_at_ms"],
                "kind": r["kind"],
                "summary": r.get("summary") or "",
            }
            for r in rows
        ]
        return {"jobs": jobs}

    def rpc_patch_propose(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Propose a patch. Engine computes base_rev from file_ops when patch_format is file_ops."""
        job_id = str(params.get("job_id") or "none")
        summary = str(params.get("summary") or "")
        patch_format = str(params.get("patch_format") or "file_ops")
        patch_text = params.get("patch_text")
        if patch_text is None:
            raise RPCError("INVALID_REQUEST", "patch_text required")
        patch_text = str(patch_text)
        author = str(params.get("author") or "engine")
        if patch_format == "file_ops":
            base_rev = self.ledger.compute_base_rev_from_file_ops(patch_text)
        else:
            base_rev = str(params.get("base_rev") or "")
        patch_id = secrets.token_hex(8)
        try:
            self.ledger.propose_patch(
                patch_id=patch_id,
                job_id=job_id,
                author=author,
                summary=summary,
                base_rev=base_rev,
                patch_format=patch_format,
                patch_text=patch_text,
            )
        except LedgerError as e:
            raise RPCError("INVALID_REQUEST", str(e))
        return {"patch_id": patch_id}

    def rpc_patch_list(self, params: Dict[str, Any]) -> Dict[str, Any]:
        job_id = params.get("job_id")
        status = params.get("status")
        limit = int(params.get("limit", 50))
        limit = min(max(limit, 1), 200)
        rows = self.ledger.list_patches(job_id=job_id, status=status, limit=limit)
        patches = [
            {
                "patch_id": r["patch_id"],
                "job_id": r["job_id"],
                "status": r["status"],
                "created_at_ms": r["created_at_ms"],
                "summary": r.get("summary") or "",
            }
            for r in rows
        ]
        return {"patches": patches}

    def rpc_patch_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        patch_id = params.get("patch_id")
        if not patch_id:
            raise RPCError("INVALID_REQUEST", "patch_id required")
        p = self.ledger.get_patch(str(patch_id))
        if not p:
            raise RPCError("NOT_FOUND", f"Patch not found: {patch_id}")
        out = {
            "patch_id": p["patch_id"],
            "job_id": p["job_id"],
            "created_at_ms": p["created_at_ms"],
            "author": p["author"],
            "status": p["status"],
            "summary": p.get("summary") or "",
            "base_rev": p["base_rev"],
            "patch_format": p["patch_format"],
            "patch_text": p["patch_text"],
            "error": p.get("error") or "",
        }
        if params.get("include_review"):
            review = self.ledger.get_patch_review(str(patch_id), Path(self.repo_root))
            if review is not None:
                out["review_ops"] = review
        return out

    def rpc_patch_accept(self, params: Dict[str, Any]) -> Dict[str, Any]:
        patch_id = params.get("patch_id")
        if not patch_id:
            raise RPCError("INVALID_REQUEST", "patch_id required")
        ok = self.ledger.accept_patch(str(patch_id))
        return {"ok": ok}

    def rpc_patch_reject(self, params: Dict[str, Any]) -> Dict[str, Any]:
        patch_id = params.get("patch_id")
        if not patch_id:
            raise RPCError("INVALID_REQUEST", "patch_id required")
        ok = self.ledger.reject_patch(str(patch_id))
        return {"ok": ok}

    def rpc_patch_apply(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Apply patch (file_ops only). Requires status=accepted. Atomic per file.
        If workflow_session_id + consent_token provided, requires workflow state APPLY_ARMED and token match.
        """
        patch_id = params.get("patch_id")
        if not patch_id:
            raise RPCError("INVALID_REQUEST", "patch_id required")
        workflow_session_id = params.get("workflow_session_id") or params.get("session_id")
        consent_token = params.get("consent_token")
        if workflow_session_id and consent_token is not None:
            snap = self._workflow_snapshots.get(workflow_session_id)
            if not snap:
                raise RPCError("error.precondition_failed", "workflow session not found")
            if snap.get("state") != "APPLY_ARMED":
                raise RPCError(
                    "error.invalid_transition",
                    f"patch.apply not allowed: workflow state is {snap.get('state')}, expected APPLY_ARMED",
                    {"from_state": snap.get("state"), "allowed_from": ["APPLY_ARMED"]},
                )
            armed = snap.get("armed") or {}
            if armed.get("consent_token") != consent_token:
                raise RPCError("error.permission_denied", "consent_token mismatch")
            patch = snap.get("patch") or {}
            if patch.get("patch_id") != patch_id:
                raise RPCError("error.invalid_argument", "patch_id does not match workflow patch")
            authority = self._workflow_authority()
            if not authority.get("writes_allowed"):
                raise RPCError("error.permission_denied", "writes not allowed")
        result = self.ledger.apply_patch(
            str(patch_id), Path(self.repo_root)
        )
        return result

    def _workflow_authority(self) -> Dict[str, Any]:
        """Authority snapshot for workflow context (writes_allowed, actions_allowed)."""
        auth = self.rpc_authority({})
        return {
            "writes_allowed": bool(auth.get("writes_allowed")),
            "writes_note": auth.get("writes_note"),
            "actions_allowed": list(auth.get("actions_allowed") or ["check", "verify"]),
        }

    def rpc_workflow_get(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Returns authoritative snapshot + allowed_intents for session. Protocol 3."""
        session_id = params.get("session_id") or params.get("workflow_id")
        if session_id and session_id in self._workflow_snapshots:
            snap = self._workflow_snapshots[session_id]
        else:
            snap = _empty_snapshot()
            if session_id:
                snap["workflow_id"] = session_id
        authority = self._workflow_authority()
        state = snap.get("state", "IDLE")
        return {
            "snapshot": snap,
            "allowed_intents": allowed_intents(state, authority),
        }

    async def rpc_workflow_intent(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Apply one intent; transition table + effects. Returns new snapshot or raises WorkflowError."""
        session_id = params.get("session_id") or params.get("workflow_id")
        intent = params.get("intent")
        if not intent or not isinstance(intent, dict):
            raise RPCError("INVALID_REQUEST", "intent required (object)")
        if not session_id:
            session_id = intent.get("workflow_id") or (params.get("workflow_id"))
        snap = self._workflow_snapshots.get(session_id) if session_id else None
        if snap is None:
            snap = _empty_snapshot(workflow_id=session_id)
            if session_id:
                self._workflow_snapshots[session_id] = snap
        authority = self._workflow_authority()
        context = {
            "authority": authority,
            "cwd": self.repo_root,
        }
        try:
            new_snap, effects = apply_intent(snap, intent, context)
        except WorkflowError:
            raise
        session_id = new_snap.get("workflow_id")
        if session_id:
            self._workflow_snapshots[session_id] = new_snap
        for eff in effects:
            if eff.get("type") == "ledger_append" and session_id:
                self.ledger.append_workflow_event(
                    session_id, eff.get("event", ""), payload={"intent_kind": intent.get("kind")}
                )
        for eff in effects:
            if eff.get("type") == "patch_apply":
                patch_id = eff.get("patch_id")
                if patch_id:
                    try:
                        self.ledger.apply_patch(patch_id, Path(self.repo_root))
                    except LedgerError as e:
                        new_snap = dict(new_snap)
                        new_snap["state"] = "FAILED"
                        new_snap["failure"] = {
                            "code": "APPLY_FAILED",
                            "message": str(e),
                            "at_state": new_snap.get("state", "APPLIED"),
                        }
                        if session_id:
                            self._workflow_snapshots[session_id] = new_snap
                        raise RPCError("APPLY_FAILED", str(e))
            elif eff.get("type") == "job_run":
                kind = eff.get("kind", "check")
                cwd = eff.get("cwd") or self.repo_root
                confirm = bool(eff.get("confirm", False))
                try:
                    job_id = self.job_engine.create_job(kind=kind, cwd=cwd, confirm=confirm)
                    await self.job_engine.ensure_worker(self.repo_root)
                    jobs = list(new_snap.get("jobs") or [])
                    jobs.append({"job_id": job_id, "kind": kind, "state": "running", "summary": None})
                    new_snap = dict(new_snap)
                    new_snap["jobs"] = jobs
                    if session_id:
                        self._workflow_snapshots[session_id] = new_snap
                except Exception as e:
                    new_snap = dict(new_snap)
                    new_snap["state"] = "FAILED"
                    new_snap["failure"] = {
                        "code": "JOB_RUN_FAILED",
                        "message": str(e),
                        "at_state": new_snap.get("state", "RUNNING"),
                    }
                    if session_id:
                        self._workflow_snapshots[session_id] = new_snap
                    raise RPCError("JOB_RUN_FAILED", str(e))
        return {"snapshot": new_snap}

    def rpc_ledger_tail(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Last N workflow events for session (chronological). Keys: session_id, events[]."""
        session_id = params.get("session_id") or params.get("workflow_id")
        if not session_id:
            raise RPCError("INVALID_REQUEST", "session_id or workflow_id required")
        limit = int(params.get("limit", 50))
        limit = min(max(limit, 1), 500)
        events = self.ledger.tail_workflow_events(session_id, limit=limit)
        return {"session_id": session_id, "events": events}

    def rpc_ledger_replay(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Full workflow event stream for session (replay). Keys: session_id, events[]."""
        session_id = params.get("session_id") or params.get("workflow_id")
        if not session_id:
            raise RPCError("INVALID_REQUEST", "session_id or workflow_id required")
        events = self.ledger.list_workflow_events(session_id, since_seq=0, limit=0)
        return {"session_id": session_id, "events": events}

    def rpc_debug_snapshot(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """Observability: engine identity, db path, schema version, recovered count, queue, jobs, last N logs."""
        last_n_logs = int(params.get("last_n_logs", 20))
        last_n_logs = min(max(last_n_logs, 0), 200)
        job_snapshot = self.job_engine.snapshot(last_n_logs=last_n_logs)
        return {
            "engine": self._engine_identity(),
            "protocol": PROTOCOL_VERSION,
            "methods": list(JOB_METHODS),
            "db_path": str(self._db_path),
            "schema_version": LEDGER_SCHEMA_VERSION,
            "recovered_jobs_on_startup": self._recovered_on_startup,
            "queue_length": job_snapshot["queue_length"],
            "current_job_id": job_snapshot["current_job_id"],
            "jobs": job_snapshot["jobs"],
        }

    def rpc_run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        params:
          - job_name: str (optional)
          - action: str (check|fix|verify|deploy). NOT chat.
          - confirm: bool (required for deploy when requireConfirm)
        Returns envelope {type: "report", trace_id, engine, payload}.
        """
        trace_id = secrets.token_hex(8)
        action = str(params.get("action") or "check")
        confirm = bool(params.get("confirm", False))

        if action == "chat":
            return _reject("INVALID_REQUEST", "chat must use rpc method 'chat'", trace_id=trace_id)

        try:
            result = safe_run_action(self.repo_root, action, require_confirm=confirm)
            payload = {"action": action, "result": result}
            if action == "fix":
                payload["next_required"] = "verify"
            return {
                "type": "report",
                "trace_id": trace_id,
                "engine": "tooling",
                "payload": payload,
            }
        except PolicyError as e:
            return {
                "type": "report",
                "trace_id": trace_id,
                "engine": "policy",
                "payload": {"action": action, "blocked": True, "message": str(e)},
            }
        except Exception as e:
            return _reject("RUN_FAILED", str(e), trace_id=trace_id)

    def rpc_recover(self, _: Dict[str, Any]) -> Dict[str, Any]:
        with self.locks.job_lock():
            recovered = self.recovery.recover()
            return {"ok": True, "recovered": recovered}
