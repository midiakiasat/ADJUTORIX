from sample_repo_python import render_summary, stable_hash

def test_stable_hash_is_deterministic() -> None:
assert stable_hash(["b", "a"]) == stable_hash(["a", "b"])

def test_render_summary_shapes_payload() -> None:
payload = render_summary([" alpha ", "", "beta"])
assert payload["count"] == 2
assert payload["values"] == ["alpha", "beta"]
assert isinstance(payload["digest"], str)
assert len(payload["digest"]) == 64
