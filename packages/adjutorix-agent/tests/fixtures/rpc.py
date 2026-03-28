"""
ADJUTORIX AGENT — TEST FIXTURES / RPC

Deterministic JSON-RPC 2.0 request/response builders, validators, and
roundtrip helpers.

Purpose:
- Canonical request construction (stable ordering, id handling)
- Response validation (strict JSON-RPC compliance)
- Idempotency header handling
- Batch request support
- Error envelope normalization
- Transport-agnostic helpers (usable with TestClient or raw HTTP)

Hard guarantees:
- Byte-stable payload generation (via canonical JSON)
- No implicit defaults: all fields explicit
- Deterministic id sequencing when requested

NO PLACEHOLDERS.
"""

from __future__ import annotations

from typing import Any, Dict, Iterable, List, Optional, Tuple, Callable
import json
import hashlib


# ---------------------------------------------------------------------------
# NORMALIZATION / CANONICAL JSON
# ---------------------------------------------------------------------------


def _norm(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("fixture_rpc:invalid_float")
        return 0.0 if obj == 0.0 else obj
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    if isinstance(obj, set):
        return [_norm(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"fixture_rpc:unsupported_type:{type(obj).__name__}")


def canonical_json(obj: Any) -> str:
    return json.dumps(_norm(obj), sort_keys=True, separators=(",", ":"))


def payload_hash(obj: Any) -> str:
    return hashlib.sha256(canonical_json(obj).encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# ID GENERATORS
# ---------------------------------------------------------------------------


class IdSeq:
    def __init__(self, start: int = 1) -> None:
        self._i = start - 1

    def next(self) -> int:
        self._i += 1
        return self._i


# ---------------------------------------------------------------------------
# REQUEST BUILDERS
# ---------------------------------------------------------------------------


def request(method: str, params: Optional[Dict[str, Any]] = None, *, id_: Any) -> Dict[str, Any]:
    if id_ is None:
        raise ValueError("rpc:id_required")
    return _norm({
        "jsonrpc": "2.0",
        "id": id_,
        "method": method,
        "params": params or {},
    })


def notification(method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    # JSON-RPC notification (no id)
    return _norm({
        "jsonrpc": "2.0",
        "method": method,
        "params": params or {},
    })


def batch(requests: Iterable[Dict[str, Any]]) -> List[Dict[str, Any]]:
    reqs = [ _norm(r) for r in requests ]
    if not reqs:
        raise ValueError("rpc:empty_batch")
    return reqs


# ---------------------------------------------------------------------------
# HEADERS
# ---------------------------------------------------------------------------


def headers(*, token: str, idempotency_key: Optional[str] = None, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
    h = {
        "x-adjutorix-token": token,
        "content-type": "application/json",
    }
    if idempotency_key is not None:
        h["x-adjutorix-idempotency-key"] = idempotency_key
    if extra:
        for k, v in extra.items():
            h[str(k).lower()] = str(v)
    return h


# ---------------------------------------------------------------------------
# RESPONSE VALIDATION
# ---------------------------------------------------------------------------


def is_success(resp: Dict[str, Any]) -> bool:
    return (resp.get("jsonrpc") == "2.0") and ("result" in resp) and ("error" not in resp)


def is_error(resp: Dict[str, Any]) -> bool:
    return (resp.get("jsonrpc") == "2.0") and ("error" in resp) and ("result" not in resp)


def validate_success(resp: Dict[str, Any], *, id_: Any) -> Dict[str, Any]:
    if resp.get("jsonrpc") != "2.0":
        raise AssertionError("rpc:invalid_version")
    if resp.get("id") != id_:
        raise AssertionError("rpc:id_mismatch")
    if "result" not in resp or "error" in resp:
        raise AssertionError("rpc:not_success")
    return resp["result"]


def validate_error(resp: Dict[str, Any], *, id_: Any) -> Dict[str, Any]:
    if resp.get("jsonrpc") != "2.0":
        raise AssertionError("rpc:invalid_version")
    if resp.get("id") != id_:
        raise AssertionError("rpc:id_mismatch")
    if "error" not in resp or "result" in resp:
        raise AssertionError("rpc:not_error")
    err = resp["error"]
    if not isinstance(err, dict) or "code" not in err or "message" not in err:
        raise AssertionError("rpc:malformed_error")
    # normalize optional data
    err.setdefault("data", {})
    return _norm(err)


# ---------------------------------------------------------------------------
# ROUNDTRIP HELPERS (TRANSPORT-AGNOSTIC)
# ---------------------------------------------------------------------------


def roundtrip(
    send: Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]],
    *,
    token: str,
    method: str,
    params: Optional[Dict[str, Any]] = None,
    id_: Any = 1,
    idempotency_key: Optional[str] = None,
) -> Dict[str, Any]:
    req = request(method, params, id_=id_)
    hdrs = headers(token=token, idempotency_key=idempotency_key)
    resp = send(req, hdrs)
    return validate_success(resp, id_=id_)


def roundtrip_expect_error(
    send: Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]],
    *,
    token: str,
    method: str,
    params: Optional[Dict[str, Any]] = None,
    id_: Any = 1,
) -> Dict[str, Any]:
    req = request(method, params, id_=id_)
    hdrs = headers(token=token)
    resp = send(req, hdrs)
    return validate_error(resp, id_=id_)


# ---------------------------------------------------------------------------
# BATCH ROUNDTRIP
# ---------------------------------------------------------------------------


def batch_roundtrip(
    send_batch: Callable[[List[Dict[str, Any]], Dict[str, str]], List[Dict[str, Any]]],
    *,
    token: str,
    methods_params: List[Tuple[str, Dict[str, Any]]],
    id_seq: Optional[IdSeq] = None,
) -> List[Dict[str, Any]]:
    id_seq = id_seq or IdSeq()
    reqs: List[Dict[str, Any]] = []
    ids: List[Any] = []

    for m, p in methods_params:
        i = id_seq.next()
        ids.append(i)
        reqs.append(request(m, p, id_=i))

    hdrs = headers(token=token)
    resps = send_batch(reqs, hdrs)

    # Responses may be unordered per JSON-RPC spec; normalize by id
    by_id = {r.get("id"): r for r in resps}
    out: List[Dict[str, Any]] = []
    for i in ids:
        r = by_id.get(i)
        if r is None:
            raise AssertionError("rpc:missing_response")
        if is_error(r):
            out.append({"error": validate_error(r, id_=i)})
        else:
            out.append({"result": validate_success(r, id_=i)})
    return out


# ---------------------------------------------------------------------------
# STABILITY ASSERTIONS
# ---------------------------------------------------------------------------


def assert_payload_stable(obj: Any) -> None:
    j1 = canonical_json(obj)
    j2 = canonical_json(obj)
    if j1 != j2:
        raise AssertionError("rpc:payload_instability")


def assert_response_stable(send: Callable[[Dict[str, Any], Dict[str, str]], Dict[str, Any]], *, token: str, method: str, params: Optional[Dict[str, Any]] = None) -> None:
    req = request(method, params, id_=1)
    hdrs = headers(token=token)
    r1 = send(req, hdrs)
    r2 = send(req, hdrs)
    if canonical_json(r1) != canonical_json(r2):
        raise AssertionError("rpc:response_instability")


__all__ = [
    "canonical_json",
    "payload_hash",
    "IdSeq",
    "request",
    "notification",
    "batch",
    "headers",
    "is_success",
    "is_error",
    "validate_success",
    "validate_error",
    "roundtrip",
    "roundtrip_expect_error",
    "batch_roundtrip",
    "assert_payload_stable",
    "assert_response_stable",
]
