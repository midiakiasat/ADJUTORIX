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


def test_replay_full_prefix_and_repeatability():
    events = [
        {"type": "mutation", "op": "set_key", "key": f"k{i}", "value": i, "patch_id": f"p{i}"}
        for i in range(12)
    ]

    full = replay_fn(events)
    full_again = replay_fn(list(events))
    prefix = replay_fn(events[:6])
    prefix_again = replay_fn(events[:6])

    assert full["state"] == full_again["state"]
    assert full["hash"] == full_again["hash"]
    assert prefix["state"] == prefix_again["state"]
    assert prefix["state"] != full["state"]


def test_replay_rejects_gaps_and_missing_causality():
    gap = [
        {"seq": 1, "type": "mutation", "op": "set_key", "key": "a", "value": 1, "patch_id": "p1"},
        {"seq": 3, "type": "mutation", "op": "set_key", "key": "b", "value": 2, "patch_id": "p2"},
    ]

    try:
        replay_fn(gap)
    except RuntimeError as exc:
        assert "sequence" in str(exc)
    else:
        raise AssertionError("gap was not rejected")

    try:
        replay_fn([{"type": "mutation", "op": "increment", "key": "missing", "patch_id": "p3"}])
    except RuntimeError as exc:
        assert "missing" in str(exc)
    else:
        raise AssertionError("missing causal key was not rejected")


def test_rpc_unwired_ledger_surface_is_explicit_and_deterministic():
    client = TestClient(create_app())
    token = _load_or_create_token()

    one = rpc_body(client, "ledger.current", token=token)
    two = rpc_body(client, "ledger.current", token=token)

    assert one == two
    assert one["result"]["ok"] is False
    assert one["result"]["state"] == "offline"
    assert one["result"]["error"] == "ledger_unwired"
