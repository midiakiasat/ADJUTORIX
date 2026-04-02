"""
ADJUTORIX AGENT — SERVER / HANDLERS

Truthful handler surface aligned to real runtime contracts.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, List, Tuple

from adjutorix_agent.indexing.affected_files import compute_affected_files
from adjutorix_agent.indexing.dependency_graph import build_dependency_graph, DependencyGraph
from adjutorix_agent.indexing.health import analyze_index_health
from adjutorix_agent.indexing.index_guard import verify_indexes
from adjutorix_agent.indexing.references import build_reference_index, ReferenceIndex
from adjutorix_agent.indexing.related_files import build_related_files
from adjutorix_agent.indexing.repo_index import build_repo_index, RepoIndex
from adjutorix_agent.indexing.symbol_index import build_symbol_index, SymbolIndex
from adjutorix_agent.server.rpc import ERR_INVALID_PARAMS, ERR_NOT_FOUND, RpcError, _err


@dataclass(frozen=True)
class HandlerContext:
    scheduler: Any


def _require(params: Dict[str, Any], key: str) -> Any:
    if key not in params or params[key] is None:
        raise _err(ERR_INVALID_PARAMS, "missing_param", {"param": key})
    return params[key]


def _ensure_non_empty_str(v: Any, key: str) -> str:
    if not isinstance(v, str) or not v.strip():
        raise _err(ERR_INVALID_PARAMS, "invalid_param", {"param": key})
    return v


async def job_submit(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    key = params.get("idempotency_key")
    is_mutation = bool(params.get("is_mutation", False))
    job_id = ctx.scheduler.submit(
        lambda _exec_ctx: {"accepted": True, "params": params},
        key=key if isinstance(key, str) and key else None,
        is_mutation=is_mutation,
        metadata={"source": "handlers", "method": "job.submit"},
    )
    return {"job_id": job_id, "accepted": True}


async def job_status(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    jid = _ensure_non_empty_str(_require(params, "job_id"), "job_id")
    st = ctx.scheduler.status(jid)
    if not st:
        raise _err(ERR_NOT_FOUND, "job_not_found", {"job_id": jid})
    if hasattr(st, "__dict__"):
        out = dict(vars(st))
        if "state" in out and hasattr(st.state, "value"):
            out["state"] = st.state.value
        return out
    return st


async def index_build(_ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    root = _ensure_non_empty_str(_require(params, "root"), "root")
    repo: RepoIndex = build_repo_index(root)

    files: List[Tuple[str, str, bytes]] = []
    for f in repo.files:
        with open(f.rel_path, "rb") as fh:
            files.append((f.file_id, f.rel_path, fh.read()))

    symbols: SymbolIndex = build_symbol_index(files)
    graph: DependencyGraph = build_dependency_graph(repo, symbols)
    refs: ReferenceIndex = build_reference_index(symbols)

    verify_indexes(repo, symbols, graph, refs)

    return {
        "repo_hash": repo.index_hash,
        "symbols_hash": symbols.index_hash,
        "graph_hash": graph.index_hash,
        "refs_hash": refs.index_hash,
        "counts": {
            "files": len(repo.files),
            "symbols": len(symbols.defs),
            "refs": len(symbols.refs),
            "edges": len(graph.edges),
        },
    }


async def index_related(_ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    return build_related_files(**params).__dict__


async def index_affected(_ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    return compute_affected_files(**params).__dict__


async def index_health(_ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    return analyze_index_health(**params).__dict__


def register_all(server: Any) -> None:
    ctx = HandlerContext(scheduler=server.scheduler)
    server._register("job.submit", lambda p: job_submit(ctx, p))
    server._register("job.status", lambda p: job_status(ctx, p))
    server._register("index.build", lambda p: index_build(ctx, p))
    server._register("index.related", lambda p: index_related(ctx, p))
    server._register("index.affected", lambda p: index_affected(ctx, p))
    server._register("index.health", lambda p: index_health(ctx, p))
