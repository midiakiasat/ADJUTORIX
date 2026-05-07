from __future__ import annotations

from fastapi.testclient import TestClient

from adjutorix_agent.ledger.replay import replay as replay_fn
from adjutorix_agent.server.auth import _load_or_create_token
from adjutorix_agent.server.rpc import create_app


def rpc_body(client: TestClient, method: str, params: dict | None = None, token: str | None = None):
    headers = {"x-adjutorix-token": token} if token else {}
    res = client.post(
        "/rpc",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers=headers,
    )
    assert res.status_code in {200, 401}
    return res.json() if res.status_code == 200 else {"error": {"code": 401, "message": "unauthorized"}}


def test_auth_failure_is_explicit():
    client = TestClient(create_app())
    body = rpc_body(client, "ledger.current")
    assert "error" in body


def test_method_not_found_is_structured():
    client = TestClient(create_app())
    token = _load_or_create_token()

    body = rpc_body(client, "missing.method", token=token)

    assert body["result"] is None
    assert body["error"]["code"] == -32601
    assert body["error"]["message"] == "method_not_found"


def test_unwired_failures_do_not_mutate_observable_state():
    client = TestClient(create_app())
    token = _load_or_create_token()

    before = rpc_body(client, "ledger.current", token=token)["result"]
    failed = rpc_body(client, "patch.apply", {"patch_id": "invalid"}, token=token)["result"]
    after = rpc_body(client, "ledger.current", token=token)["result"]

    assert failed["ok"] is False
    assert failed["error"] == "patch_pipeline_unwired"
    assert before == after


def test_replay_failure_modes_are_deterministic():
    bad = [{"type": "mutation", "op": "set_key", "key": "x", "value": 1}]

    for _ in range(2):
        try:
            replay_fn(bad)
        except RuntimeError as exc:
            assert "patch_id" in str(exc)
        else:
            raise AssertionError("missing patch_id was not rejected")
