from __future__ import annotations
import secrets
import hashlib


def generate_lock_token() -> str:
    """
    Strong random token for lock ownership.
    """
    return secrets.token_hex(32)


def token_fingerprint(token: str) -> str:
    """
    Store only fingerprint if you don't want to persist raw token.
    """
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def verify_token(token: str, fingerprint: str) -> bool:
    return token_fingerprint(token) == fingerprint
