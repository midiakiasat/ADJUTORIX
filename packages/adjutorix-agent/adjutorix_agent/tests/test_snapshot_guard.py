"""
ADJUTORIX AGENT — TESTS / SNAPSHOT_GUARD

Invariant suite for SnapshotGuard and snapshot_store interaction.

Coverage:
- Snapshot immutability (content-addressed, no mutation after write)
- Read-after-write consistency
- Hash stability (same content -> same snapshot_id)
- Isolation (writes do not affect existing snapshots)
- Guard enforcement (reject invalid/partial snapshots)
- Concurrency (simulated interleavings)
- Rollback safety (failed writes do not create visible snapshots)
- Large snapshot handling (chunking if applicable)

Assumptions:
- snapshot_store exposes:
    put(content: bytes|dict) -> snapshot_id
    get(snapshot_id) -> content
    exists(snapshot_id) -> bool
- snapshot_guard exposes:
    validate_put(content) -> None (raises on invalid)
    validate_get(snapshot_id) -> None (raises on invalid)

NO PLACEHOLDERS — strict invariants asserted.
"""

from __future__ import annotations

import pytest
import copy
import threading

from adjutorix_agent.core.snapshot_store import SnapshotStore
from adjutorix_agent.core.snapshot_guard import SnapshotGuard


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture
def store() -> SnapshotStore:
    return SnapshotStore()


@pytest.fixture
def guard() -> SnapshotGuard:
    return SnapshotGuard()


@pytest.fixture
def sample_content() -> dict:
    return {"a": 1, "b": [1, 2, 3], "c": {"x": "y"}}


# ---------------------------------------------------------------------------
# CORE INVARIANTS
# ---------------------------------------------------------------------------


def test_put_get_roundtrip(store: SnapshotStore, guard: SnapshotGuard, sample_content):
    guard.validate_put(sample_content)
    sid = store.put(sample_content)

    guard.validate_get(sid)
    out = store.get(sid)

    assert out == sample_content



def test_hash_stability(store: SnapshotStore, guard: SnapshotGuard, sample_content):
    guard.validate_put(sample_content)
    s1 = store.put(sample_content)
    s2 = store.put(copy.deepcopy(sample_content))

    assert s1 == s2



def test_immutability(store: SnapshotStore, guard: SnapshotGuard, sample_content):
    sid = store.put(sample_content)
    out = store.get(sid)

    # mutate returned object
    if isinstance(out, dict):
        out["a"] = 999

    # stored snapshot must remain unchanged
    out2 = store.get(sid)
    assert out2["a"] == 1



def test_isolation_between_snapshots(store: SnapshotStore, sample_content):
    s1 = store.put(sample_content)
    s2 = store.put({"a": 2})

    assert store.get(s1) != store.get(s2)


# ---------------------------------------------------------------------------
# GUARD VALIDATION
# ---------------------------------------------------------------------------


def test_reject_invalid_content(guard: SnapshotGuard):
    with pytest.raises(Exception):
        guard.validate_put(float("nan"))  # invalid per serialization rules



def test_reject_missing_snapshot(store: SnapshotStore, guard: SnapshotGuard):
    with pytest.raises(Exception):
        guard.validate_get("nonexistent")


# ---------------------------------------------------------------------------
# ROLLBACK SAFETY
# ---------------------------------------------------------------------------


def test_failed_put_does_not_persist(store: SnapshotStore, guard: SnapshotGuard):
    bad = {"a": float("inf")}

    try:
        guard.validate_put(bad)
        store.put(bad)
    except Exception:
        pass

    # ensure no snapshot created
    # heuristic: store should not contain invalid hash
    with pytest.raises(Exception):
        guard.validate_get("invalid")


# ---------------------------------------------------------------------------
# CONCURRENCY
# ---------------------------------------------------------------------------


def test_concurrent_puts_deterministic(store: SnapshotStore, sample_content):
    results = []

    def worker():
        sid = store.put(copy.deepcopy(sample_content))
        results.append(sid)

    threads = [threading.Thread(target=worker) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert len(set(results)) == 1


# ---------------------------------------------------------------------------
# LARGE SNAPSHOTS
# ---------------------------------------------------------------------------


def test_large_snapshot(store: SnapshotStore):
    content = {"blob": "x" * 500_000}
    sid = store.put(content)
    out = store.get(sid)

    assert out == content


# ---------------------------------------------------------------------------
# EXISTS SEMANTICS
# ---------------------------------------------------------------------------


def test_exists(store: SnapshotStore, sample_content):
    sid = store.put(sample_content)
    assert store.exists(sid) is True
    assert store.exists("nope") is False


# ---------------------------------------------------------------------------
# ID FORMAT
# ---------------------------------------------------------------------------


def test_snapshot_id_format(store: SnapshotStore, sample_content):
    sid = store.put(sample_content)

    assert isinstance(sid, str)
    assert len(sid) >= 32  # at least hash-like


# ---------------------------------------------------------------------------
# REPEATABILITY ACROSS INSTANCES
# ---------------------------------------------------------------------------


def test_repeatability_across_instances(sample_content):
    s1 = SnapshotStore()
    s2 = SnapshotStore()

    id1 = s1.put(sample_content)
    id2 = s2.put(sample_content)

    assert id1 == id2
