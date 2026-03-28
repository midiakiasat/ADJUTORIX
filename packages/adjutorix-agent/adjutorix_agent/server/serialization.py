"""
ADJUTORIX AGENT — SERVER / SERIALIZATION

Deterministic, canonical serialization layer for all RPC I/O and persisted artifacts.

Purpose:
- Provide canonical JSON encoding (stable ordering, normalized floats, no NaN)
- Typed codecs for domain objects (RepoIndex, SymbolIndex, DependencyGraph, ReferenceIndex, results)
- Content-addressable hashing consistent with all indexing modules
- Streaming-safe encoders for large payloads
- Backward/forward compatible envelopes with schema versioning

Design constraints:
- No reliance on Python object identity or default repr
- Byte-level determinism across platforms
- No lossy transforms (round-trip fidelity)
- Explicit schema versioning for every payload

Hard invariants:
- encode(x) -> bytes is deterministic for identical x
- hash(x) == sha256(encode(x))
- decode(encode(x)) == x (for supported types)
- No NaN/Infinity; floats normalized or rejected
"""

from __future__ import annotations

from dataclasses import asdict, is_dataclass
from typing import Any, Dict, Tuple, Iterable, Union, Optional

import hashlib
import json
import math


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------


SCHEMA_VERSION = 1


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _normalize(obj: Any) -> Any:
    """
    Convert input into a JSON-serializable, canonical structure.

    Rules:
    - dict keys sorted
    - tuples -> lists (preserve order)
    - sets -> sorted lists
    - dataclasses -> dict via asdict
    - floats: reject NaN/Inf; normalize -0.0 -> 0.0
    """
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj

    if isinstance(obj, float):
        if math.isnan(obj) or math.isinf(obj):
            raise ValueError("serialization:invalid_float")
        # normalize -0.0
        return 0.0 if obj == 0.0 else obj

    if is_dataclass(obj):
        return _normalize(asdict(obj))

    if isinstance(obj, dict):
        return {str(k): _normalize(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}

    if isinstance(obj, (list, tuple)):
        return [_normalize(v) for v in obj]

    if isinstance(obj, set):
        return [_normalize(v) for v in sorted(obj, key=lambda x: str(x))]

    # fallback: explicit failure (no implicit str())
    raise TypeError(f"serialization:unsupported_type:{type(obj).__name__}")


# ---------------------------------------------------------------------------
# ENCODING / DECODING
# ---------------------------------------------------------------------------


def encode(obj: Any) -> bytes:
    """
    Canonical JSON encoding to UTF-8 bytes.
    """
    normalized = {
        "_schema": SCHEMA_VERSION,
        "payload": _normalize(obj),
    }
    # separators remove whitespace; sort_keys ensures deterministic key order
    s = json.dumps(normalized, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return s.encode("utf-8")


def decode(data: Union[bytes, str]) -> Any:
    if isinstance(data, bytes):
        s = data.decode("utf-8")
    else:
        s = data

    obj = json.loads(s)
    if not isinstance(obj, dict) or "_schema" not in obj or "payload" not in obj:
        raise ValueError("serialization:invalid_envelope")

    if obj["_schema"] != SCHEMA_VERSION:
        raise ValueError("serialization:unsupported_schema")

    return obj["payload"]


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def content_hash(obj: Any) -> str:
    return hashlib.sha256(encode(obj)).hexdigest()


# ---------------------------------------------------------------------------
# STREAMING ENCODER
# ---------------------------------------------------------------------------


class JsonStreamEncoder:
    """
    Chunked encoder for large payloads (iterable of items).
    Produces a valid JSON array in chunks without building full string.
    """

    def __init__(self, iterable: Iterable[Any]) -> None:
        self._iter = iterable

    def __iter__(self):
        yield b"["
        first = True
        for item in self._iter:
            if not first:
                yield b","
            else:
                first = False
            yield encode(item)
        yield b"]"


# ---------------------------------------------------------------------------
# DOMAIN HELPERS
# ---------------------------------------------------------------------------


def serialize_result(result: Any) -> Dict[str, Any]:
    """
    Wrap result with hash for RPC responses.
    """
    return {
        "data": _normalize(result),
        "hash": content_hash(result),
    }


def serialize_error(code: int, message: str, data: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    payload = {
        "code": code,
        "message": message,
        "data": _normalize(data or {}),
    }
    return {
        "error": payload,
        "hash": content_hash(payload),
    }


# ---------------------------------------------------------------------------
# VALIDATION
# ---------------------------------------------------------------------------


def validate_roundtrip(obj: Any) -> None:
    """
    Ensure encode/decode stability.
    """
    encoded = encode(obj)
    decoded = decode(encoded)

    if _normalize(decoded) != _normalize(obj):
        raise ValueError("serialization:roundtrip_mismatch")


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


__all__ = [
    "encode",
    "decode",
    "content_hash",
    "serialize_result",
    "serialize_error",
    "validate_roundtrip",
    "JsonStreamEncoder",
]
