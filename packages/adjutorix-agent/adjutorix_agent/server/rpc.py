# packages/adjutorix-agent/adjutorix_agent/server/rpc.py

from __future__ import annotations

import traceback
from pathlib import Path
from typing import Any, Dict, Optional

from ..core.context_budget import ContextBudget
from ..core.executor import Executor
from ..core.job_ledger import JobLedger
from ..core.locks import LockManager
from ..core.recovery import RecoveryManager
from ..core.rollback import RollbackManager
from ..core.state_machine import StateMachine
from ..core.taxonomy import ErrorTaxonomy
from ..governance.policy import PolicyManager
from ..tools.registry import ToolRegistry
from .auth import require_local_token


class RPCError(Exception):
    def __init__(self, code: str, message: str, data: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.data = data or {}


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

    # -----------------------
    # JSON-RPC entrypoint
    # -----------------------
    def dispatch(self, payload: Dict[str, Any], token: str) -> Dict[str, Any]:
        """
        Parse JSON-RPC 2.0 payload, call handle(token, method, params), return JSON-RPC response.
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
            result = self.handle(token, method, params or {})
            return {"jsonrpc": "2.0", "id": req_id, "result": result}
        except RPCError as e:
            return {
                "jsonrpc": "2.0",
                "id": req_id,
                "error": {"code": e.code, "message": e.message, "data": e.data},
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

    def handle(self, token: str, method: str, params: Dict[str, Any]) -> Dict[str, Any]:
        try:
            require_local_token(token)
        except Exception as e:
            raise RPCError("UNAUTHORIZED", "Invalid or missing token", {"raw": str(e)})

        fn = getattr(self, f"rpc_{method}", None)
        if fn is None:
            raise RPCError("METHOD_NOT_FOUND", f"Unknown method: {method}")

        return fn(params or {})

    # -----------------------
    # RPC methods (minimal set)
    # -----------------------
    def rpc_ping(self, _: Dict[str, Any]) -> Dict[str, Any]:
        return {"ok": True, "name": "adjutorix-agent"}

    def rpc_status(self, _: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "ok": True,
            "state": self.state_machine.state,
            "repo_root": self.repo_root,
        }

    def rpc_run(self, params: Dict[str, Any]) -> Dict[str, Any]:
        """
        params:
          - job_name: str
          - action: str (check|fix|verify|deploy_preview|deploy_prod)
          - allow_override: bool (optional)
        """
        job_name = str(params.get("job_name") or "job")
        action = str(params.get("action") or "check")
        allow_override = bool(params.get("allow_override", False))

        with self.locks.job_lock():
            self.job_ledger.start(job_name=job_name, action=action)
            try:
                result = self.executor.run_action(
                    job_name=job_name,
                    action=action,
                    allow_override=allow_override,
                    ledger=self.job_ledger,
                )
                self.job_ledger.finish(result=result)
                return {"ok": True, "result": result}
            except Exception as e:
                self.job_ledger.finish(result={"status": "failed", "error": str(e)})
                raise

    def rpc_recover(self, _: Dict[str, Any]) -> Dict[str, Any]:
        with self.locks.job_lock():
            recovered = self.recovery.recover()
            return {"ok": True, "recovered": recovered}
