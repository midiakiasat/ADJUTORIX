"""
ADJUTORIX AGENT — INTEGRATION TEST / FAILURE PROPAGATION

System-level validation that failures propagate correctly across ALL layers:

RPC → handlers → scheduler → patch_pipeline → verify_pipeline → ledger

Critical invariants:
- Failures NEVER mutate state (no partial apply)
- Errors are preserved (code, message, structure) across boundaries
- Ledger never records failed mutations as applied state
- Replay remains valid after any failure sequence
- No silent fallback / no implicit recovery
- All failures are explicit, inspectable, deterministic

Failure classes covered:
- validation failure
- verify failure
- patch conflict
- authorization failure
- internal exception

NO PLACEHOLDERS. FULL SYSTEM.
"""

from __future__ import annotations

import pytest
import time

from fastapi.testclient import TestClient

from adjutorix_agent.server.rpc import create_app
from adjutorix_agent.server.auth import _load_or_create_token
from adjutorix_agent.ledger.replay import replay as replay_fn


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app())


@pytest.fixture(scope="module")
def token() -> str:
    return _load_or_create_token()


def rpc(client: TestClient, token: str, method: str, params: dict, id_: int = 1, allow_error=False):
    res = client.post(
        "/rpc",
        json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params},
        headers={"x-adjutorix-token": token},
    )

    assert res.status_code == 200
    body = res.json()

    if body.get("error"):
        if allow_error:
            return body["error"]
        raise AssertionError(body["error"])

    return body["result"]


# ---------------------------------------------------------------------------
# VALIDATION FAILURE (INPUT LEVEL)
# ---------------------------------------------------------------------------


def test_invalid_intent_rejected(client: TestClient, token: str):
    bad_intent = {"invalid": "structure"}

    err = rpc(client, token, "patch.preview", {"intent": bad_intent}, allow_error=True)

    assert "code" in err
    assert "message" in err


# ---------------------------------------------------------------------------
# VERIFY FAILURE BLOCKS APPLY
# ---------------------------------------------------------------------------


def test_verify_failure_blocks_state_change(client: TestClient, token: str):
    bad_intent = {
        "op": "edit_file",
        "path": "/forbidden/location",
        "content": "x"
    }

    preview = rpc(client, token, "patch.preview", {"intent": bad_intent})

    verify = rpc(client, token, "verify.run", {"targets": [bad_intent["path"]]})
    vid = verify["verify_id"]

    for _ in range(100):
        st = rpc(client, token, "verify.status", {"verify_id": vid})
        if st["state"] in {"failed", "passed"}:
            break
        time.sleep(0.01)

    assert st["state"] == "failed"

    # apply must fail
    err = rpc(client, token, "patch.apply", {"patch_id": preview["patch_id"]}, allow_error=True)

    assert "code" in err


# ---------------------------------------------------------------------------
# PATCH CONFLICT
# ---------------------------------------------------------------------------


def test_patch_conflict_propagation(client: TestClient, token: str):
    intent_a = {"op": "edit_file", "path": "conflict.txt", "content": "A"}
    intent_b = {"op": "edit_file", "path": "conflict.txt", "content": "B"}

    p1 = rpc(client, token, "patch.preview", {"intent": intent_a})
    rpc(client, token, "patch.apply", {"patch_id": p1["patch_id"]})

    p2 = rpc(client, token, "patch.preview", {"intent": intent_b})

    err = rpc(client, token, "patch.apply", {"patch_id": p2["patch_id"]}, allow_error=True)

    assert "code" in err


# ---------------------------------------------------------------------------
# AUTH FAILURE
# ---------------------------------------------------------------------------


def test_auth_failure(client: TestClient):
    res = client.post("/rpc", json={
        "jsonrpc": "2.0",
        "id": 10,
        "method": "ledger.current",
        "params": {}
    })

    assert res.status_code in {200, 401}

    if res.status_code == 200:
        body = res.json()
        assert "error" in body


# ---------------------------------------------------------------------------
# INTERNAL ERROR PROPAGATION
# ---------------------------------------------------------------------------


def test_internal_error_surface(client: TestClient, token: str):
    # force internal error via impossible params
    err = rpc(client, token, "job.status", {"job_id": None}, allow_error=True)

    assert "code" in err
    assert "message" in err


# ---------------------------------------------------------------------------
# NO STATE CORRUPTION AFTER FAILURE
# ---------------------------------------------------------------------------


def test_no_state_mutation_on_failure(client: TestClient, token: str):
    before = rpc(client, token, "ledger.current", {})

    # trigger failure
    rpc(client, token, "patch.apply", {"patch_id": "nonexistent"}, allow_error=True)

    after = rpc(client, token, "ledger.current", {})

    assert before == after


# ---------------------------------------------------------------------------
# REPLAY AFTER FAILURES
# ---------------------------------------------------------------------------


def test_replay_consistency_after_failures(client: TestClient, token: str):
    # trigger multiple failures
    for _ in range(5):
        rpc(client, token, "patch.apply", {"patch_id": "invalid"}, allow_error=True)

    current = rpc(client, token, "ledger.current", {})

    ev = rpc(client, token, "ledger.range", {
        "start": 0,
        "end": current.get("seq", 0)
    })

    replay = replay_fn(ev["events"])

    assert replay["state"] == current["state_head"]


# ---------------------------------------------------------------------------
# ERROR DETERMINISM
# ---------------------------------------------------------------------------


def test_error_determinism(client: TestClient, token: str):
    err1 = rpc(client, token, "patch.apply", {"patch_id": "invalid"}, allow_error=True)
    err2 = rpc(client, token, "patch.apply", {"patch_id": "invalid"}, allow_error=True)

    assert err1 == err2


# ---------------------------------------------------------------------------
# FAILURE UNDER LOAD
# ---------------------------------------------------------------------------


def test_failure_under_load(client: TestClient, token: str):
    for _ in range(20):
        rpc(client, token, "patch.apply", {"patch_id": "invalid"}, allow_error=True)

    # system must still respond correctly
    res = rpc(client, token, "ledger.current", {})
    assert "state_head" in res
