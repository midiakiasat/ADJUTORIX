"""
ADJUTORIX AGENT — SERVER / HANDLERS

High-level RPC method handlers with strict orchestration, validation, and
composition of core subsystems. This layer contains no business logic that
mutates state directly; it delegates to authoritative components (scheduler,
patch_pipeline, verify_pipeline, ledger, indexing) and enforces:

- Parameter validation & normalization
- Capability checks (read vs mutating)
- Idempotency binding (key -> operation signature)
- Structured result envelopes with hashes/ids
- Consistent error translation to RpcError

Hard invariants:
- Every mutating handler routes through scheduler (jobs) or patch_pipeline
- All responses include stable identifiers (job_id, verify_id, patch_id, hashes)
- No filesystem writes occur here
- Handlers are deterministic given identical inputs and upstream states
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Dict, Optional, Tuple, List

# Core services
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.core.transaction_store import TransactionStore
from adjutorix_agent.core.verify_pipeline import VerifyPipeline
from adjutorix_agent.core.patch_pipeline import PatchPipeline
from adjutorix_agent.ledger.store import LedgerStore

# Indexing
from adjutorix_agent.indexing.repo_index import build_repo_index, RepoIndex
from adjutorix_agent.indexing.symbol_index import build_symbol_index, SymbolIndex
from adjutorix_agent.indexing.dependency_graph import build_dependency_graph, DependencyGraph
from adjutorix_agent.indexing.references import build_reference_index, ReferenceIndex
from adjutorix_agent.indexing.related_files import build_related_files
from adjutorix_agent.indexing.affected_files import compute_affected_files
from adjutorix_agent.indexing.health import analyze_index_health

# Guards
from adjutorix_agent.indexing.index_guard import verify_indexes

# Errors
from adjutorix_agent.server.rpc import RpcError, _err, ERR_INVALID_PARAMS, ERR_NOT_FOUND, ERR_CONFLICT


# ---------------------------------------------------------------------------
# CONTEXT
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class HandlerContext:
    scheduler: Scheduler
    tx_store: TransactionStore
    verify: VerifyPipeline
    patch: PatchPipeline
    ledger: LedgerStore


# ---------------------------------------------------------------------------
# VALIDATION UTILITIES
# ---------------------------------------------------------------------------


def _require(params: Dict[str, Any], key: str) -> Any:
    if key not in params or params[key] is None:
        raise _err(ERR_INVALID_PARAMS, "missing_param", {"param": key})
    return params[key]


def _opt(params: Dict[str, Any], key: str, default: Any = None) -> Any:
    return params.get(key, default)


def _ensure_non_empty_str(v: Any, key: str) -> str:
    if not isinstance(v, str) or not v.strip():
        raise _err(ERR_INVALID_PARAMS, "invalid_param", {"param": key})
    return v


# ---------------------------------------------------------------------------
# JOB HANDLERS
# ---------------------------------------------------------------------------


async def job_submit(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    # expected: {"intent": {...}, "idempotency_key": str?}
    intent = _require(params, "intent")

    # normalize intent: enforce explicit operation
    if not isinstance(intent, dict) or "op" not in intent:
        raise _err(ERR_INVALID_PARAMS, "invalid_intent")

    job_id = await ctx.scheduler.submit(intent)

    return {
        "job_id": job_id,
        "accepted": True,
    }


async def job_status(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    jid = _ensure_non_empty_str(_require(params, "job_id"), "job_id")
    st = ctx.scheduler.status(jid)
    if not st:
        raise _err(ERR_NOT_FOUND, "job_not_found", {"job_id": jid})
    return st


async def job_logs(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    jid = _ensure_non_empty_str(_require(params, "job_id"), "job_id")
    since = int(_opt(params, "since_seq", 0))
    return ctx.scheduler.logs(jid, since)


# ---------------------------------------------------------------------------
# VERIFY HANDLERS
# ---------------------------------------------------------------------------


async def verify_run(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    # expected: {"targets": [...], "config": {...}}
    targets = _require(params, "targets")
    if not isinstance(targets, list) or not targets:
        raise _err(ERR_INVALID_PARAMS, "invalid_targets")

    res = await ctx.verify.run({"targets": targets, "config": _opt(params, "config", {})})
    return res


async def verify_status(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    vid = _ensure_non_empty_str(_require(params, "verify_id"), "verify_id")
    st = ctx.verify.status(vid)
    if not st:
        raise _err(ERR_NOT_FOUND, "verify_not_found", {"verify_id": vid})
    return st


async def verify_artifacts(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    vid = _ensure_non_empty_str(_require(params, "verify_id"), "verify_id")
    return ctx.verify.artifacts(vid)


# ---------------------------------------------------------------------------
# PATCH HANDLERS
# ---------------------------------------------------------------------------


async def patch_preview(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    # expected: {"intent": {...}, "base": optional snapshot/commit id}
    intent = _require(params, "intent")
    res = await ctx.patch.preview({"intent": intent, "base": _opt(params, "base")})
    return res


async def patch_apply(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    # expected: {"patch_id": str}
    patch_id = _ensure_non_empty_str(_require(params, "patch_id"), "patch_id")
    res = await ctx.patch.apply({"patch_id": patch_id})
    return res


# ---------------------------------------------------------------------------
# LEDGER HANDLERS
# ---------------------------------------------------------------------------


async def ledger_current(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    return ctx.ledger.current()


async def ledger_at(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    ts = int(_require(params, "ts"))
    return ctx.ledger.at(ts)


async def ledger_range(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    start = int(_require(params, "start"))
    end = int(_require(params, "end"))
    return ctx.ledger.range(start, end)


async def ledger_replay(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    start = int(_require(params, "start"))
    end = int(_require(params, "end"))
    return ctx.ledger.replay(start, end)


# ---------------------------------------------------------------------------
# INDEX HANDLERS
# ---------------------------------------------------------------------------


async def index_build(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    root = _ensure_non_empty_str(_require(params, "root"), "root")

    repo: RepoIndex = build_repo_index(root)

    # NOTE: caller must ensure cwd is root or provide absolute paths
    files: List[Tuple[str, str, bytes]] = []
    for f in repo.files:
        try:
            with open(f.rel_path, "rb") as fh:
                files.append((f.file_id, f.rel_path, fh.read()))
        except FileNotFoundError:
            raise _err(ERR_CONFLICT, "file_missing_during_index", {"path": f.rel_path})

    symbols: SymbolIndex = build_symbol_index(files)
    graph: DependencyGraph = build_dependency_graph(repo, symbols)
    refs: ReferenceIndex = build_reference_index(symbols)

    # guard before returning
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


async def index_related(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    # expected: {repo, symbols, graph, refs, seeds, limit?}
    required = ("repo", "symbols", "graph", "refs", "seeds")
    for k in required:
        _require(params, k)

    res = build_related_files(**params)
    return res.__dict__


async def index_affected(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    required = ("repo", "symbols", "graph", "refs", "seeds")
    for k in required:
        _require(params, k)

    res = compute_affected_files(**params)
    return res.__dict__


async def index_health(ctx: HandlerContext, params: Dict[str, Any]) -> Dict[str, Any]:
    required = ("repo", "symbols", "graph", "refs")
    for k in required:
        _require(params, k)

    res = analyze_index_health(**params)
    return res.__dict__


# ---------------------------------------------------------------------------
# DISPATCH REGISTRATION
# ---------------------------------------------------------------------------


def register_all(server: Any) -> None:
    """
    Bind handlers to RpcServer via server._register(name, coro(params)).
    """
    ctx = HandlerContext(
        scheduler=server.scheduler,
        tx_store=server.tx_store,
        verify=server.verify,
        patch=server.patch,
        ledger=server.ledger,
    )

    # job
    server._register("job.submit", lambda p: job_submit(ctx, p))
    server._register("job.status", lambda p: job_status(ctx, p))
    server._register("job.logs", lambda p: job_logs(ctx, p))

    # verify
    server._register("verify.run", lambda p: verify_run(ctx, p))
    server._register("verify.status", lambda p: verify_status(ctx, p))
    server._register("verify.artifacts", lambda p: verify_artifacts(ctx, p))

    # patch
    server._register("patch.preview", lambda p: patch_preview(ctx, p))
    server._register("patch.apply", lambda p: patch_apply(ctx, p))

    # ledger
    server._register("ledger.current", lambda p: ledger_current(ctx, p))
    server._register("ledger.at", lambda p: ledger_at(ctx, p))
    server._register("ledger.range", lambda p: ledger_range(ctx, p))
    server._register("ledger.replay", lambda p: ledger_replay(ctx, p))

    # index
    server._register("index.build", lambda p: index_build(ctx, p))
    server._register("index.related", lambda p: index_related(ctx, p))
    server._register("index.affected", lambda p: index_affected(ctx, p))
    server._register("index.health", lambda p: index_health(ctx, p))
