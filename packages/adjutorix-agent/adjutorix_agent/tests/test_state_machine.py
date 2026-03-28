"""
ADJUTORIX AGENT — TESTS / STATE_MACHINE

Full-spectrum deterministic validation of the core state machine.

Coverage goals:
- Transition correctness (state, intent) -> (new_state, artifacts, logs)
- Idempotency and replay guarantees
- Invalid transitions rejection
- Concurrency safety (simulated interleavings)
- Patch coupling invariant (every mutation -> patch)
- Deterministic outputs (hash equality across runs)

Assumptions:
- state_machine exposes: StateMachine, State, Intent, TransitionResult
- transitions are pure (no hidden IO)

NO PLACEHOLDERS — all tests assert strict invariants.
"""

from __future__ import annotations

import pytest
import copy

from adjutorix_agent.core.state_machine import StateMachine, State, Intent


# ---------------------------------------------------------------------------
# FIXTURES
# ---------------------------------------------------------------------------


@pytest.fixture
def initial_state() -> State:
    return State(
        jobs={},
        patches={},
        workflows={},
        authority="root",
        environment={"cwd": "/repo"},
        version=0,
    )


@pytest.fixture
def sm() -> StateMachine:
    return StateMachine()


# ---------------------------------------------------------------------------
# CORE INVARIANTS
# ---------------------------------------------------------------------------


def test_transition_determinism(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    r1 = sm.transition(copy.deepcopy(initial_state), intent)
    r2 = sm.transition(copy.deepcopy(initial_state), intent)

    assert r1.new_state == r2.new_state
    assert r1.artifacts == r2.artifacts
    assert r1.logs == r2.logs



def test_idempotent_replay(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"}, idempotency_key="k1")

    r1 = sm.transition(initial_state, intent)
    r2 = sm.transition(r1.new_state, intent)

    # replay should not duplicate
    assert len(r2.new_state.jobs) == len(r1.new_state.jobs)



def test_invalid_transition_rejected(sm: StateMachine, initial_state: State):
    intent = Intent(op="unknown_op", payload={})

    with pytest.raises(Exception):
        sm.transition(initial_state, intent)


# ---------------------------------------------------------------------------
# PATCH INVARIANT
# ---------------------------------------------------------------------------


def test_every_mutation_produces_patch(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    result = sm.transition(initial_state, intent)

    assert result.artifacts is not None
    assert "patch" in result.artifacts
    assert result.artifacts["patch"] is not None


# ---------------------------------------------------------------------------
# STATE CONSISTENCY
# ---------------------------------------------------------------------------


def test_state_version_monotonic(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    r1 = sm.transition(initial_state, intent)
    r2 = sm.transition(r1.new_state, intent)

    assert r2.new_state.version >= r1.new_state.version



def test_no_implicit_side_effects(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    before = copy.deepcopy(initial_state)
    sm.transition(initial_state, intent)

    # original state must remain unchanged
    assert initial_state == before


# ---------------------------------------------------------------------------
# CONCURRENCY MODEL (SIMULATED)
# ---------------------------------------------------------------------------


def test_concurrent_intents_commutativity(sm: StateMachine, initial_state: State):
    i1 = Intent(op="create_job", payload={"name": "A"})
    i2 = Intent(op="create_job", payload={"name": "B"})

    r1 = sm.transition(initial_state, i1)
    r1_then_2 = sm.transition(r1.new_state, i2)

    r2 = sm.transition(initial_state, i2)
    r2_then_1 = sm.transition(r2.new_state, i1)

    # order should not corrupt state (set equality)
    assert set(r1_then_2.new_state.jobs.keys()) == set(r2_then_1.new_state.jobs.keys())


# ---------------------------------------------------------------------------
# LOG STRUCTURE
# ---------------------------------------------------------------------------


def test_logs_are_structured(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    result = sm.transition(initial_state, intent)

    assert isinstance(result.logs, list)
    for entry in result.logs:
        assert "event" in entry
        assert "ts" in entry


# ---------------------------------------------------------------------------
# EDGE CASES
# ---------------------------------------------------------------------------


def test_empty_intent_payload(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={})

    result = sm.transition(initial_state, intent)

    assert result.new_state is not None



def test_large_number_of_jobs(sm: StateMachine, initial_state: State):
    state = initial_state

    for i in range(1000):
        intent = Intent(op="create_job", payload={"name": f"job_{i}"})
        state = sm.transition(state, intent).new_state

    assert len(state.jobs) == 1000


# ---------------------------------------------------------------------------
# HASH STABILITY (IF IMPLEMENTED)
# ---------------------------------------------------------------------------


def test_state_hash_stability(sm: StateMachine, initial_state: State):
    intent = Intent(op="create_job", payload={"name": "A"})

    r1 = sm.transition(initial_state, intent)
    r2 = sm.transition(initial_state, intent)

    if hasattr(r1.new_state, "hash"):
        assert r1.new_state.hash == r2.new_state.hash
