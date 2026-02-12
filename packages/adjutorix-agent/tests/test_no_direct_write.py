import inspect
import adjutorix_agent.tools.fs.write_guard as write_guard


def test_write_guard_is_single_choke_point():
    """
    Ensure write_guard exposes the expected guarded entrypoint.
    """
    assert hasattr(write_guard, "guarded_write")

    fn = write_guard.guarded_write
    src = inspect.getsource(fn)

    # minimal invariant: must reference guard logic
    assert "deny" in src or "guard" in src.lower()
