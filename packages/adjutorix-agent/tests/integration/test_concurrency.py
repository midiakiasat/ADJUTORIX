from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

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
    return res.json()["result"]


def test_concurrent_offline_queries_are_deterministic():
    client = TestClient(create_app())
    token = _load_or_create_token()

    def call(_: int):
        return rpc(client, token, "ledger.current")

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(call, range(48)))

    assert results
    assert all(item == results[0] for item in results)
    assert results[0]["ok"] is False
    assert results[0]["error"] == "ledger_unwired"


def test_concurrent_replay_is_pure():
    events = [
        {"type": "mutation", "op": "set_key", "key": f"k{i}", "value": i, "patch_id": f"p{i}"}
        for i in range(32)
    ]

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda _: replay_fn(events), range(32)))

    assert all(item["state"] == results[0]["state"] for item in results)
    assert all(item["hash"] == results[0]["hash"] for item in results)
