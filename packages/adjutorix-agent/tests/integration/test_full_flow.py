from __future__ import annotations

from fastapi.testclient import TestClient

from adjutorix_agent.ledger.replay import replay as replay_fn
from adjutorix_agent.server.auth import _load_or_create_token
from adjutorix_agent.server.rpc import create_app


def rpc(client: TestClient, token: str, method: str, params: dict | None = None):
    res = client.post(
        "/rpc",
        json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params or {}},
        headers={"x-adjutorix-token": token},
    )
    assert res.status_code == 200
    return res.json()


def test_health_ping_is_public_and_stable_shape():
    client = TestClient(create_app())
    res = client.post("/rpc", json={"jsonrpc": "2.0", "id": 1, "method": "health.ping", "params": {}})
    assert res.status_code == 200
    body = res.json()
    assert body["jsonrpc"] == "2.0"
    assert body["error"] is None
    assert isinstance(body["result"]["ts"], int)


def test_mutation_pipeline_surfaces_offline_authority_explicitly():
    client = TestClient(create_app())
    token = _load_or_create_token()

    cases = {
        "job.submit": "scheduler_unwired",
        "patch.preview": "patch_pipeline_unwired",
        "patch.apply": "patch_pipeline_unwired",
        "verify.run": "verify_pipeline_unwired",
        "verify.status": "verify_pipeline_unwired",
        "ledger.current": "ledger_unwired",
    }

    for method, expected_error in cases.items():
        body = rpc(client, token, method, {"intent": {"op": "edit_file", "path": "x", "content": "y"}})
        assert body["error"] is None
        assert body["result"]["ok"] is False
        assert body["result"]["state"] == "offline"
        assert body["result"]["error"] == expected_error


def test_replay_contract_remains_executable_without_wired_services():
    events = [
        {"type": "mutation", "op": "set_key", "key": "integration_test.txt", "value": "hello", "patch_id": "p1"},
        {"type": "mutation", "op": "set_key", "key": "idem.txt", "value": "x", "patch_id": "p2"},
    ]

    replay = replay_fn(events)
    assert replay["state"]["integration_test.txt"] == "hello"
    assert replay["state"]["idem.txt"] == "x"
    assert replay["hash"] == replay_fn(events)["hash"]
