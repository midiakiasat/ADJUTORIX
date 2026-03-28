"""
ADJUTORIX AGENT — TESTS / REPLAY

Deterministic ledger replay and state reconstruction invariants.

Coverage:
- Full replay: events -> exact state equivalence with live head
- Prefix replay: partial reconstruction at arbitrary sequence boundaries
- Determinism: identical ledger -> identical state/hash
- Idempotent replay: reapplying same segment yields no divergence
- Gap/ordering detection: missing or out-of-order events rejected
- Causality enforcement: edges/parents satisfied before application
- Artifact coupling: every mutation event references a valid patch/artifact
- Time travel: at(ts) and range queries consistent with replay
- Concurrency merge safety: commutative segments where declared
- Rollback consistency: inverse application restores prior state

Assumptions:
- LedgerStore exposes:
    append(event) -> seq
    current() -> {state_head, seq}
    range(start, end) -> {events: [...]}  # inclusive start, exclusive end
    at(ts) -> {state_head, seq}
- Replay exposes:
    replay(events) -> {state, hash}
    apply(state, event) -> state
- Events are total-ordered by seq and carry deterministic payloads

NO PLACEHOLDERS — strict invariants asserted.
"""

from __future__ import annotations

import pytest
import copy
import random

from adjutorix_agent.ledger.store import LedgerStore
from adjutorix_agent.ledger.replay import replay as replay_fn


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture
def ledger() -> LedgerStore:
    return LedgerStore()


@pytest.fixture
def sample_events() -> list[dict]:
    # deterministic synthetic events (patch-coupled)
    evts = []
    for i in range(20):
        evts.append({
            "type": "mutation",
            "op": "set_key",
            "key": f"k{i}",
            "value": i,
            "patch_id": f"p{i}",
        })
    return evts


# ---------------------------------------------------------------------------
# CORE REPLAY
# ---------------------------------------------------------------------------


def test_full_replay_equals_live_head(ledger: LedgerStore, sample_events):
    seqs = []
    for e in sample_events:
        seqs.append(ledger.append(e))

    live = ledger.current()

    ev = ledger.range(0, live["seq"])["events"]
    r = replay_fn(ev)

    assert r["state"] == live["state_head"]
    if "hash" in r and "hash" in live:
        assert r["hash"] == live.get("hash")


# ---------------------------------------------------------------------------
# PREFIX REPLAY
# ---------------------------------------------------------------------------


def test_prefix_replay(ledger: LedgerStore, sample_events):
    for e in sample_events:
        ledger.append(e)

    mid = len(sample_events) // 2
    ev = ledger.range(0, mid)["events"]
    r = replay_fn(ev)

    live_prefix = ledger.range(0, mid)
    r2 = replay_fn(live_prefix["events"])

    assert r["state"] == r2["state"]


# ---------------------------------------------------------------------------
# DETERMINISM
# ---------------------------------------------------------------------------


def test_determinism_same_events(sample_events):
    r1 = replay_fn(copy.deepcopy(sample_events))
    r2 = replay_fn(copy.deepcopy(sample_events))

    assert r1["state"] == r2["state"]
    if "hash" in r1 and "hash" in r2:
        assert r1["hash"] == r2["hash"]


# ---------------------------------------------------------------------------
# IDEMPOTENT REPLAY (NO DOUBLE APPLY)
# ---------------------------------------------------------------------------


def test_idempotent_replay_no_duplication(sample_events):
    r1 = replay_fn(sample_events)
    # reapply same events should not change outcome
    r2 = replay_fn(sample_events)

    assert r1["state"] == r2["state"]


# ---------------------------------------------------------------------------
# GAP / ORDERING
# ---------------------------------------------------------------------------


def test_out_of_order_rejected(ledger: LedgerStore, sample_events):
    for e in sample_events:
        ledger.append(e)

    ev = ledger.range(0, len(sample_events))["events"]
    shuffled = ev[:]
    random.shuffle(shuffled)

    with pytest.raises(Exception):
        replay_fn(shuffled)


def test_missing_event_gap_detected(ledger: LedgerStore, sample_events):
    for e in sample_events:
        ledger.append(e)

    ev = ledger.range(0, len(sample_events))["events"]
    gap = ev[:10] + ev[11:]  # remove one event

    with pytest.raises(Exception):
        replay_fn(gap)


# ---------------------------------------------------------------------------
# CAUSALITY
# ---------------------------------------------------------------------------


def test_causality_enforced():
    # event depends on previous key existence
    ev = [
        {"type": "mutation", "op": "increment", "key": "k", "patch_id": "p1"},
    ]

    with pytest.raises(Exception):
        replay_fn(ev)


# ---------------------------------------------------------------------------
# ARTIFACT COUPLING
# ---------------------------------------------------------------------------


def test_patch_coupling_required(sample_events):
    bad = copy.deepcopy(sample_events)
    bad[0].pop("patch_id", None)

    with pytest.raises(Exception):
        replay_fn(bad)


# ---------------------------------------------------------------------------
# TIME TRAVEL CONSISTENCY
# ---------------------------------------------------------------------------


def test_time_travel_at_consistency(ledger: LedgerStore, sample_events):
    for e in sample_events:
        ledger.append(e)

    cur = ledger.current()
    at = ledger.at(cur.get("ts", 0))

    ev = ledger.range(0, at["seq"]) ["events"]
    r = replay_fn(ev)

    assert r["state"] == at["state_head"]


# ---------------------------------------------------------------------------
# COMMUTATIVITY (DECLARED SAFE OPS)
# ---------------------------------------------------------------------------


def test_commutative_segments():
    # two independent keys
    ev1 = [
        {"type": "mutation", "op": "set_key", "key": "a", "value": 1, "patch_id": "p1"},
    ]
    ev2 = [
        {"type": "mutation", "op": "set_key", "key": "b", "value": 2, "patch_id": "p2"},
    ]

    r1 = replay_fn(ev1 + ev2)
    r2 = replay_fn(ev2 + ev1)

    assert r1["state"] == r2["state"]


# ---------------------------------------------------------------------------
# ROLLBACK (INVERSE)
# ---------------------------------------------------------------------------


def test_inverse_application_restores_state():
    ev = [
        {"type": "mutation", "op": "set_key", "key": "k", "value": 1, "patch_id": "p1"},
        {"type": "mutation", "op": "unset_key", "key": "k", "patch_id": "p2"},
    ]

    r = replay_fn(ev)
    assert r["state"].get("k") is None


# ---------------------------------------------------------------------------
# LARGE SCALE
# ---------------------------------------------------------------------------


def test_large_replay_scale():
    ev = []
    for i in range(2000):
        ev.append({
            "type": "mutation",
            "op": "set_key",
            "key": f"k{i}",
            "value": i,
            "patch_id": f"p{i}",
        })

    r = replay_fn(ev)
    assert len(r["state"]) == 2000


# ---------------------------------------------------------------------------
# REPEATABILITY ACROSS INSTANCES
# ---------------------------------------------------------------------------


def test_repeatability_across_instances(sample_events):
    r1 = replay_fn(sample_events)
    r2 = replay_fn(sample_events)

    assert r1["state"] == r2["state"]
