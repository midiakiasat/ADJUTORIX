from __future__ import annotations
import hashlib
import json
from typing import Any, Dict

def canonical_json(data: Dict[str, Any]) -> bytes:
    return json.dumps(data, sort_keys=True, separators=(",", ":")).encode("utf-8")

def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()

def compute_event_hash(event_without_hash: Dict[str, Any]) -> str:
    return sha256_hex(canonical_json(event_without_hash))
