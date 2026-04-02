"""
ADJUTORIX AGENT — INTEGRATION TEST / RPC ROUNDTRIP

Strict end-to-end validation of RPC boundary:
client → HTTP → auth → handlers → serialization → core → serialization → client

Focus:
- Transport correctness (JSON-RPC 2.0 compliance)
- Serialization determinism (byte-level stability)
- Error propagation fidelity (no mutation of error structure)
- Idempotency across network boundary
- Header-driven behavior (auth, idempotency)
- No hidden state mutation from read-only calls

This test is intentionally protocol-heavy: it verifies the *contract surface*, not business logic.

NO PLACEHOLDERS.
"""

from __future__ import annotations

import pytest
import json
import time

from fastapi.testclient import TestClient

from adjutorix_agent.server.rpc import create_app
from adjutorix_agent.core.scheduler import Scheduler
from adjutorix_agent.server.auth import _load_or_create_token


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def client() -> TestClient:
    return TestClient(create_app(container={"scheduler": Scheduler()}))


@pytest.fixture(scope="module")
def token() -> str:
    return _load_or_create_token()


def raw_rpc(client: TestClient, token: str, payload: dict, headers_extra: dict | None = None):
    headers = {"x-adjutorix-token": token}
    if headers_extra:
        headers.update(headers_extra)

    res = client.post("/rpc", json=payload, headers=headers)
    assert res.status_code == 200
    return res.json()


# ---------------------------------------------------------------------------
# BASIC ROUNDTRIP
# ---------------------------------------------------------------------------


def test_basic_roundtrip(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 1,
        "method": "ledger.current",
        "params": {}
    }

    res = raw_rpc(client, token, payload)

    assert res["jsonrpc"] == "2.0"
    assert res["id"] == 1
    assert "result" in res


# ---------------------------------------------------------------------------
# SERIALIZATION DETERMINISM
# ---------------------------------------------------------------------------


def test_response_determinism(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 2,
        "method": "ledger.current",
        "params": {}
    }

    r1 = raw_rpc(client, token, payload)
    r2 = raw_rpc(client, token, payload)

    assert json.dumps(r1, sort_keys=True) == json.dumps(r2, sort_keys=True)


# ---------------------------------------------------------------------------
# ERROR PROPAGATION
# ---------------------------------------------------------------------------


def test_error_structure_stability(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 3,
        "method": "nonexistent.method",
        "params": {}
    }

    res = raw_rpc(client, token, payload)

    assert "error" in res
    err = res["error"]

    assert "code" in err
    assert "message" in err
    assert "data" in err

    # deterministic error payload
    res2 = raw_rpc(client, token, payload)
    assert json.dumps(res, sort_keys=True) == json.dumps(res2, sort_keys=True)


# ---------------------------------------------------------------------------
# AUTH ENFORCEMENT
# ---------------------------------------------------------------------------


def test_auth_required(client: TestClient):
    payload = {
        "jsonrpc": "2.0",
        "id": 4,
        "method": "ledger.current",
        "params": {}
    }

    res = client.post("/rpc", json=payload)

    # either 401 or JSON-RPC error
    assert res.status_code in {200, 401}

    if res.status_code == 200:
        body = res.json()
        assert "error" in body


# ---------------------------------------------------------------------------
# IDEMPOTENCY OVER HTTP
# ---------------------------------------------------------------------------


def test_http_idempotency(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 5,
        "method": "job.submit",
        "params": {
            "intent": {
                "op": "edit_file",
                "path": "rpc_idem.txt",
                "content": "x"
            }
        }
    }

    headers = {"x-adjutorix-idempotency-key": "rpc-idem-1"}

    r1 = raw_rpc(client, token, payload, headers)
    r2 = raw_rpc(client, token, payload, headers)


    assert r1["result"]["job_id"] == r2["result"]["job_id"]


# ---------------------------------------------------------------------------
# READ-ONLY SAFETY
# ---------------------------------------------------------------------------


def test_read_only_no_mutation(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 6,
        "method": "ledger.current",
        "params": {}
    }

    before = raw_rpc(client, token, payload)
    for _ in range(5):
        raw_rpc(client, token, payload)
    after = raw_rpc(client, token, payload)

    assert json.dumps(before, sort_keys=True) == json.dumps(after, sort_keys=True)


# ---------------------------------------------------------------------------
# LARGE PAYLOAD HANDLING
# ---------------------------------------------------------------------------


def test_large_payload(client: TestClient, token: str):
    large_content = "x" * 200_000

    payload = {
        "jsonrpc": "2.0",
        "id": 7,
        "method": "job.submit",
        "params": {
            "intent": {
                "op": "edit_file",
                "path": "large_rpc.txt",
                "content": large_content
            }
        }
    }

    res = raw_rpc(client, token, payload)

    assert "result" in res
    assert "job_id" in res["result"]


# ---------------------------------------------------------------------------
# SEQUENTIAL ID CONSISTENCY
# ---------------------------------------------------------------------------


def test_id_field_roundtrip(client: TestClient, token: str):
    for i in range(10, 20):
        payload = {
            "jsonrpc": "2.0",
            "id": i,
            "method": "ledger.current",
            "params": {}
        }

        res = raw_rpc(client, token, payload)
        assert res["id"] == i


# ---------------------------------------------------------------------------
# TIMING / NO RACE LEAK
# ---------------------------------------------------------------------------


def test_rapid_fire_requests(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 100,
        "method": "ledger.current",
        "params": {}
    }

    results = []

    for _ in range(50):
        results.append(raw_rpc(client, token, payload))

    base = json.dumps(results[0], sort_keys=True)
    for r in results[1:]:
        assert json.dumps(r, sort_keys=True) == base


# ---------------------------------------------------------------------------
# MALFORMED REQUESTS
# ---------------------------------------------------------------------------


def test_invalid_jsonrpc_envelope(client: TestClient, token: str):
    payload = {
        "id": 999,
        "method": "ledger.current"
        # missing jsonrpc field
    }

    res = raw_rpc(client, token, payload)

    assert "error" in res


# ---------------------------------------------------------------------------
# CONCURRENCY (CLIENT SIDE BURST)
# ---------------------------------------------------------------------------


def test_parallel_requests(client: TestClient, token: str):
    payload = {
        "jsonrpc": "2.0",
        "id": 200,
        "method": "ledger.current",
        "params": {}
    }

    from concurrent.futures import ThreadPoolExecutor

    def call():
        return raw_rpc(client, token, payload)

    with ThreadPoolExecutor(max_workers=10) as ex:
        results = list(ex.map(lambda _: call(), range(20)))

    base = json.dumps(results[0], sort_keys=True)
    for r in results:
        assert json.dumps(r, sort_keys=True) == base
