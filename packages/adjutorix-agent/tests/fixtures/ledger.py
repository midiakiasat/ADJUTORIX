"""
ADJUTORIX AGENT — TEST FIXTURES / LEDGER

Deterministic ledger event constructors, sequences, and replay helpers.

Purpose:
- Provide canonical event streams independent of runtime ledger
- Enable reproducible replay validation
- Model causality, ordering, and edge constraints explicitly

Ledger event schema (canonical):
{
  "seq": int,
  "ts": int,
  "type": str,
  "payload": dict,
  "patch_id": str,
  "prev_hash": Optional[str],
  "hash": str
}

Key invariants enforced here:
- strict monotonic seq
- stable hashing (content-addressed)
- causal linkage via prev_hash
- no implicit fields

NO PLACEHOLDERS.
"""

from __future__ import annotations

from typing import Dict, Any, List, Optional
import hashlib
import json
import copy


# ---------------------------------------------------------------------------
# NORMALIZATION
# ---------------------------------------------------------------------------


def _norm(obj: Any) -> Any:
    if obj is None or isinstance(obj, (bool, int, str)):
        return obj
    if isinstance(obj, float):
        if obj != obj or obj in (float("inf"), float("-inf")):
            raise ValueError("fixture_ledger:invalid_float")
        return 0.0 if obj == 0.0 else obj
    if isinstance(obj, dict):
        return {str(k): _norm(v) for k, v in sorted(obj.items(), key=lambda kv: str(kv[0]))}
    if isinstance(obj, (list, tuple)):
        return [_norm(v) for v in obj]
    if isinstance(obj, set):
        return [_norm(v) for v in sorted(obj, key=lambda x: str(x))]
    raise TypeError(f"fixture_ledger:unsupported_type:{type(obj).__name__}")


# ---------------------------------------------------------------------------
# HASHING
# ---------------------------------------------------------------------------


def compute_event_hash(event: Dict[str, Any]) -> str:
    payload = _norm({
        "seq": event["seq"],
        "ts": event["ts"],
        "type": event["type"],
        "payload": event["payload"],
        "patch_id": event.get("patch_id"),
        "prev_hash": event.get("prev_hash"),
    })

    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


# ---------------------------------------------------------------------------
# BUILDERS
# ---------------------------------------------------------------------------


def build_event(
    *,
    seq: int,
    ts: int,
    type_: str,
    payload: Dict[str, Any],
    patch_id: Optional[str],
    prev_hash: Optional[str],
) -> Dict[str, Any]:
    base = {
        "seq": seq,
        "ts": ts,
        "type": type_,
        "payload": _norm(payload),
        "patch_id": patch_id,
        "prev_hash": prev_hash,
    }

    h = compute_event_hash(base)
    base["hash"] = h

    return _norm(base)


# ---------------------------------------------------------------------------
# SEQUENCE GENERATION
# ---------------------------------------------------------------------------


def linear_sequence(n: int) -> List[Dict[str, Any]]:
    events: List[Dict[str, Any]] = []
    prev_hash: Optional[str] = None

    for i in range(n):
        ev = build_event(
            seq=i,
            ts=1000 + i,
            type_="mutation",
            payload={"op": "set", "k": f"k{i}", "v": i},
            patch_id=f"p{i}",
            prev_hash=prev_hash,
        )
        events.append(ev)
        prev_hash = ev["hash"]

    return events


def branching_sequence() -> List[Dict[str, Any]]:
    # creates a fork-like inconsistency for testing rejection
    base = linear_sequence(3)

    fork = copy.deepcopy(base[-1])
    fork["seq"] = 3
    fork["payload"] = {"op": "set", "k": "fork", "v": 999}
    fork["hash"] = compute_event_hash(fork)

    return base + [fork]


# ---------------------------------------------------------------------------
# REPLAY (PURE SIMULATION)
# ---------------------------------------------------------------------------


def replay(events: List[Dict[str, Any]]) -> Dict[str, Any]:
    state: Dict[str, Any] = {}
    last_hash: Optional[str] = None

    for ev in events:
        if ev["prev_hash"] != last_hash:
            raise ValueError("causality_violation")

        if ev["type"] == "mutation":
            op = ev["payload"].get("op")
            if op == "set":
                state[ev["payload"]["k"]] = ev["payload"]["v"]
            elif op == "unset":
                state.pop(ev["payload"]["k"], None)
            else:
                raise ValueError("unknown_op")

        last_hash = ev["hash"]

    return _norm(state)


# ---------------------------------------------------------------------------
# ASSERTIONS
# ---------------------------------------------------------------------------


def assert_chain_valid(events: List[Dict[str, Any]]) -> None:
    last_hash = None
    for ev in events:
        if ev["prev_hash"] != last_hash:
            raise AssertionError("broken_chain")
        if compute_event_hash(ev) != ev["hash"]:
            raise AssertionError("hash_mismatch")
        last_hash = ev["hash"]


def assert_replay_deterministic(events: List[Dict[str, Any]]) -> None:
    r1 = replay(events)
    r2 = replay(events)
    if r1 != r2:
        raise AssertionError("replay_nondeterministic")


# ---------------------------------------------------------------------------
# UTIL
# ---------------------------------------------------------------------------


def slice_events(events: List[Dict[str, Any]], end: int) -> List[Dict[str, Any]]:
    return events[:end]


def corrupt_event(events: List[Dict[str, Any]], idx: int) -> List[Dict[str, Any]]:
    evs = copy.deepcopy(events)
    evs[idx]["payload"]["v"] = "corrupt"
    return evs


__all__ = [
    "compute_event_hash",
    "build_event",
    "linear_sequence",
    "branching_sequence",
    "replay",
    "assert_chain_valid",
    "assert_replay_deterministic",
    "slice_events",
    "corrupt_event",
]
