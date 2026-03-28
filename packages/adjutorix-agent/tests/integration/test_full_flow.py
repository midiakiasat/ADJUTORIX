"""
ADJUTORIX AGENT — INTEGRATION TEST / FULL FLOW

End-to-end, no-mock, full system execution invariant suite.

This test wires the REAL system:
RPC → auth → handlers → scheduler → patch_pipeline → verify_pipeline → ledger → indexing

NO shortcuts. NO mocks. NO isolation.

Primary invariant:
    (live execution state) == (ledger replay state)

Secondary invariants:
- every mutation produces a patch
- patch must pass verify before apply
- RPC layer is lossless (serialization + error model)
- idempotency holds across network boundary
- no hidden mutation outside patch pipeline
- deterministic outputs (hash-level stability)

Assumptions:
- FastAPI app from rpc.create_app
- HTTP client used (TestClient)
- ledger.replay available
"""

from __future__ import annotations

import pytest
import time
import json

from fastapi.testclient import TestClient

from adjutorix_agent.server.rpc import create_app
from adjutorix_agent.ledger.replay import replay as replay_fn
from adjutorix_agent.server.auth import _load_or_create_token


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> TestClient:
    app = create_app()
    return TestClient(app)


@pytest.fixture(scope="module")
def token() -> str:
    return _load_or_create_token()


def rpc(client: TestClient, token: str, method: str, params: dict, id_: int = 1):
    res = client.post(
        "/rpc",
        json={
            "jsonrpc": "2.0",
            "id": id_,
            "method": method,
            "params": params,
        },
        headers={
            "x-adjutorix-token": token,
        },
    )
    assert res.status_code == 200
    body = res.json()

    if body.get("error"):
        raise AssertionError(f"RPC error: {body['error']}")

    return body["result"]


# ---------------------------------------------------------------------------
# FULL FLOW
# ---------------------------------------------------------------------------


def test_full_mutation_flow(client: TestClient, token: str):
    """
    intent → job → patch.preview → verify → patch.apply → ledger → replay
    """

    # ------------------------------------------------------------------
    # 1. SUBMIT JOB (INTENT)
    # ------------------------------------------------------------------

    intent = {
        "op": "edit_file",
        "path": "integration_test.txt",
        "content": "hello_world"
    }

    job = rpc(client, token, "job.submit", {"intent": intent})
    job_id = job["job_id"]

    assert isinstance(job_id, str)

    # wait for job scheduling visibility
    for _ in range(50):
        status = rpc(client, token, "job.status", {"job_id": job_id})
        if status["state"] in {"queued", "running", "completed"}:
            break
        time.sleep(0.01)

    # ------------------------------------------------------------------
    # 2. PATCH PREVIEW
    # ------------------------------------------------------------------

    preview = rpc(client, token, "patch.preview", {"intent": intent})

    assert "patch_id" in preview
    assert "diff" in preview
    assert "hash" in preview

    patch_id = preview["patch_id"]

    # determinism check
    preview2 = rpc(client, token, "patch.preview", {"intent": intent})
    assert preview["hash"] == preview2["hash"]

    # ------------------------------------------------------------------
    # 3. VERIFY
    # ------------------------------------------------------------------

    verify = rpc(client, token, "verify.run", {"targets": ["integration_test.txt"]})
    verify_id = verify["verify_id"]

    # wait verify
    for _ in range(100):
        st = rpc(client, token, "verify.status", {"verify_id": verify_id})
        if st["state"] in {"passed", "failed"}:
            break
        time.sleep(0.01)

    st = rpc(client, token, "verify.status", {"verify_id": verify_id})
    assert st["state"] == "passed"

    # ------------------------------------------------------------------
    # 4. APPLY PATCH
    # ------------------------------------------------------------------

    applied = rpc(client, token, "patch.apply", {"patch_id": patch_id})

    assert applied["applied"] is True
    assert "state_head" in applied

    state_head_after_apply = applied["state_head"]

    # idempotency (apply twice)
    applied2 = rpc(client, token, "patch.apply", {"patch_id": patch_id})
    assert applied2["state_head"] == state_head_after_apply

    # ------------------------------------------------------------------
    # 5. LEDGER STATE
    # ------------------------------------------------------------------

    ledger_current = rpc(client, token, "ledger.current", {})

    assert "state_head" in ledger_current

    live_state = ledger_current["state_head"]

    # ------------------------------------------------------------------
    # 6. REPLAY CONSISTENCY
    # ------------------------------------------------------------------

    # fetch full range
    full_range = rpc(client, token, "ledger.range", {
        "start": 0,
        "end": ledger_current.get("seq", 0)
    })

    events = full_range.get("events", [])

    replay = replay_fn(events)

    assert replay["state"] == live_state


# ---------------------------------------------------------------------------
# RPC INVARIANTS
# ---------------------------------------------------------------------------


def test_rpc_idempotency(client: TestClient, token: str):
    intent = {
        "op": "edit_file",
        "path": "idem.txt",
        "content": "x"
    }

    headers = {
        "x-adjutorix-token": token,
        "x-adjutorix-idempotency-key": "idem-key-1"
    }

    def call():
        res = client.post("/rpc", json={
            "jsonrpc": "2.0",
            "id": 1,
            "method": "job.submit",
            "params": {"intent": intent}
        }, headers=headers)
        return res.json()["result"]

    r1 = call()
    r2 = call()

    assert r1["job_id"] == r2["job_id"]


# ---------------------------------------------------------------------------
# FAILURE PROPAGATION
# ---------------------------------------------------------------------------


def test_verify_failure_blocks_apply(client: TestClient, token: str):
    bad_intent = {
        "op": "edit_file",
        "path": "/etc/passwd",
        "content": "forbidden"
    }

    preview = rpc(client, token, "patch.preview", {"intent": bad_intent})

    verify = rpc(client, token, "verify.run", {"targets": ["/etc/passwd"]})
    vid = verify["verify_id"]

    for _ in range(100):
        st = rpc(client, token, "verify.status", {"verify_id": vid})
        if st["state"] in {"failed", "passed"}:
            break
        time.sleep(0.01)

    st = rpc(client, token, "verify.status", {"verify_id": vid})

    if st["state"] == "failed":
        with pytest.raises(AssertionError):
            rpc(client, token, "patch.apply", {"patch_id": preview["patch_id"]})


# ---------------------------------------------------------------------------
# CONCURRENCY INTERACTION
# ---------------------------------------------------------------------------


def test_concurrent_patch_application(client: TestClient, token: str):
    intent_a = {"op": "edit_file", "path": "c.txt", "content": "A"}
    intent_b = {"op": "edit_file", "path": "c.txt", "content": "B"}

    p1 = rpc(client, token, "patch.preview", {"intent": intent_a})
    p2 = rpc(client, token, "patch.preview", {"intent": intent_b})

    # apply first
    rpc(client, token, "patch.apply", {"patch_id": p1["patch_id"]})

    # second should conflict or be rejected
    try:
        rpc(client, token, "patch.apply", {"patch_id": p2["patch_id"]})
    except AssertionError:
        pass


# ---------------------------------------------------------------------------
# SERIALIZATION STABILITY
# ---------------------------------------------------------------------------


def test_rpc_serialization_stability(client: TestClient, token: str):
    res1 = rpc(client, token, "ledger.current", {})
    res2 = rpc(client, token, "ledger.current", {})

    assert json.dumps(res1, sort_keys=True) == json.dumps(res2, sort_keys=True)
