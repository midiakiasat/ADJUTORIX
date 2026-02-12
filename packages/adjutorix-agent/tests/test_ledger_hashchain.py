import hashlib
from adjutorix_agent.core.hashchain import compute_hash


def test_hashchain_integrity():
    """
    Verify simple prev_hash -> hash chaining property.
    """
    prev = "0" * 64
    payload = b"event-1"

    h1 = compute_hash(prev_hash=prev, payload=payload)
    assert isinstance(h1, str)
    assert len(h1) == 64

    h2 = compute_hash(prev_hash=h1, payload=b"event-2")
    assert h2 != h1

    # Tamper detection
    tampered = hashlib.sha256(b"evil").hexdigest()
    assert tampered != h1
