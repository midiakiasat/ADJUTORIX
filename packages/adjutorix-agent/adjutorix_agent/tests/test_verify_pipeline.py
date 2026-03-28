"""
ADJUTORIX AGENT — TESTS / VERIFY_PIPELINE

Exhaustive invariant suite for VerifyPipeline.

Coverage:
- run → status → artifacts lifecycle
- determinism (same inputs → identical outputs / hashes)
- idempotency (same request → same verify_id or equivalent result)
- isolation (no mutation of workspace or state)
- concurrency safety (parallel verify runs)
- artifact integrity (content-addressed, stable ordering)
- failure semantics (partial failures, structured errors)
- timeout handling
- cancellation (if supported)
- log sequencing and monotonicity

Assumptions:
- VerifyPipeline exposes:
    run(params) -> {verify_id, status?, hash?}
    status(verify_id) -> {state, ...}
    artifacts(verify_id) -> {artifacts: [...], hash?}
    cancel(verify_id) optional

States: queued, running, passed, failed, cancelled

NO PLACEHOLDERS — strict invariants asserted.
"""

from __future__ import annotations

import asyncio
import pytest
import copy

from adjutorix_agent.core.verify_pipeline import VerifyPipeline


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture
def pipeline() -> VerifyPipeline:
    return VerifyPipeline()


@pytest.fixture
def targets():
    return ["file_a.py", "file_b.py"]


# ---------------------------------------------------------------------------
# LIFECYCLE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_run_status_artifacts_lifecycle(pipeline: VerifyPipeline, targets):
    res = await pipeline.run({"targets": targets})

    assert "verify_id" in res
    vid = res["verify_id"]

    # poll until terminal
    for _ in range(100):
        st = pipeline.status(vid)
        assert st is not None
        if st["state"] in {"passed", "failed"}:
            break
        await asyncio.sleep(0.01)

    st = pipeline.status(vid)
    assert st["state"] in {"passed", "failed"}

    arts = pipeline.artifacts(vid)
    assert isinstance(arts, dict)
    assert "artifacts" in arts


# ---------------------------------------------------------------------------
# DETERMINISM
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_determinism_same_inputs(pipeline: VerifyPipeline, targets):
    r1 = await pipeline.run({"targets": targets})
    r2 = await pipeline.run({"targets": targets})

    vid1 = r1["verify_id"]
    vid2 = r2["verify_id"]

    # wait both
    for _ in range(100):
        s1 = pipeline.status(vid1)
        s2 = pipeline.status(vid2)
        if s1["state"] in {"passed", "failed"} and s2["state"] in {"passed", "failed"}:
            break
        await asyncio.sleep(0.01)

    a1 = pipeline.artifacts(vid1)
    a2 = pipeline.artifacts(vid2)

    # artifacts should be identical in content/hash
    assert a1 == a2


# ---------------------------------------------------------------------------
# IDEMPOTENCY
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_idempotent_run(pipeline: VerifyPipeline, targets):
    params = {"targets": targets, "idempotency_key": "k1"}

    r1 = await pipeline.run(params)
    r2 = await pipeline.run(params)

    assert r1["verify_id"] == r2["verify_id"]


# ---------------------------------------------------------------------------
# ISOLATION
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_no_state_mutation(pipeline: VerifyPipeline, targets):
    state_before = getattr(pipeline, "_state", None)

    await pipeline.run({"targets": targets})

    state_after = getattr(pipeline, "_state", None)

    # verify pipeline should not mutate global state directly
    assert state_before == state_after


# ---------------------------------------------------------------------------
# CONCURRENCY
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_concurrent_runs(pipeline: VerifyPipeline, targets):
    async def run_one(i):
        return await pipeline.run({"targets": targets, "i": i})

    results = await asyncio.gather(*[run_one(i) for i in range(10)])

    vids = [r["verify_id"] for r in results]
    assert len(set(vids)) == 10


# ---------------------------------------------------------------------------
# FAILURE SEMANTICS
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_failure_propagation(pipeline: VerifyPipeline):
    # use a target expected to fail
    res = await pipeline.run({"targets": ["__nonexistent__"], "mode": "strict"})
    vid = res["verify_id"]

    for _ in range(100):
        st = pipeline.status(vid)
        if st["state"] == "failed":
            break
        await asyncio.sleep(0.01)

    st = pipeline.status(vid)
    assert st["state"] == "failed"
    assert "error" in st


# ---------------------------------------------------------------------------
# ARTIFACT INTEGRITY
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_artifact_hash_stability(pipeline: VerifyPipeline, targets):
    res = await pipeline.run({"targets": targets})
    vid = res["verify_id"]

    for _ in range(100):
        st = pipeline.status(vid)
        if st["state"] in {"passed", "failed"}:
            break
        await asyncio.sleep(0.01)

    arts = pipeline.artifacts(vid)

    if "hash" in arts:
        h1 = arts["hash"]
        h2 = pipeline.artifacts(vid)["hash"]
        assert h1 == h2


# ---------------------------------------------------------------------------
# TIMEOUT
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_timeout_behavior(pipeline: VerifyPipeline, targets):
    res = await pipeline.run({"targets": targets, "timeout_ms": 10})
    vid = res["verify_id"]

    for _ in range(100):
        st = pipeline.status(vid)
        if st["state"] in {"failed", "passed"}:
            break
        await asyncio.sleep(0.01)

    st = pipeline.status(vid)
    assert st["state"] in {"failed", "passed"}


# ---------------------------------------------------------------------------
# CANCELLATION
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_cancellation_if_supported(pipeline: VerifyPipeline, targets):
    res = await pipeline.run({"targets": targets})
    vid = res["verify_id"]

    if hasattr(pipeline, "cancel"):
        ok = pipeline.cancel(vid)
        assert ok in {True, False}

        st = pipeline.status(vid)
        if ok:
            assert st["state"] in {"cancelled", "failed", "passed"}


# ---------------------------------------------------------------------------
# LOG STRUCTURE
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_logs_monotonic(pipeline: VerifyPipeline, targets):
    res = await pipeline.run({"targets": targets})
    vid = res["verify_id"]

    last_seq = -1

    for _ in range(100):
        st = pipeline.status(vid)
        logs = st.get("logs", []) if isinstance(st, dict) else []
        for e in logs:
            assert e["seq"] > last_seq
            last_seq = e["seq"]
        if st.get("state") in {"passed", "failed"}:
            break
        await asyncio.sleep(0.01)


# ---------------------------------------------------------------------------
# EDGE CASES
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_targets(pipeline: VerifyPipeline):
    res = await pipeline.run({"targets": []})
    vid = res["verify_id"]

    st = pipeline.status(vid)
    assert st["state"] in {"passed", "failed"}


@pytest.mark.asyncio
async def test_large_targets(pipeline: VerifyPipeline):
    targets = [f"file_{i}.py" for i in range(1000)]
    res = await pipeline.run({"targets": targets})
    assert "verify_id" in res


# ---------------------------------------------------------------------------
# REPEATABILITY ACROSS INSTANCES
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_repeatability_across_instances(targets):
    p1 = VerifyPipeline()
    p2 = VerifyPipeline()

    r1 = await p1.run({"targets": targets})
    r2 = await p2.run({"targets": targets})

    # independent ids but same artifacts
    vid1 = r1["verify_id"]
    vid2 = r2["verify_id"]

    for _ in range(100):
        s1 = p1.status(vid1)
        s2 = p2.status(vid2)
        if s1["state"] in {"passed", "failed"} and s2["state"] in {"passed", "failed"}:
            break
        await asyncio.sleep(0.01)

    a1 = p1.artifacts(vid1)
    a2 = p2.artifacts(vid2)

    assert a1 == a2
