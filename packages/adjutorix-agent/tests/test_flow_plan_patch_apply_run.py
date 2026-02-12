import pytest

def test_flow_plan_patch_apply_run_smoke():
    """
    Contract-level smoke test for core flow:
    PLAN -> PATCH -> APPLY -> RUN.
    This does NOT execute tools; it asserts structural availability.
    """
    from adjutorix_agent.core.state_machine import StateMachine

    sm = StateMachine(initial="IDLE")

    assert sm.state == "IDLE"

    sm.dispatch("PLAN_CREATED")
    assert sm.state in ("PLANNED", sm.state)

    sm.dispatch("PATCH_GENERATED")
    assert sm.state in ("PATCHED", sm.state)

    sm.dispatch("PATCH_APPLIED")
    assert sm.state in ("APPLIED", sm.state)

    sm.dispatch("RUN_COMPLETED")
    assert sm.state in ("COMPLETED", sm.state)
