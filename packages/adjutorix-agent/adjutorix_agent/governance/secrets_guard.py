"""
ADJUTORIX AGENT — GOVERNANCE / SECRETS_GUARD

Centralized secret governance, detection, redaction, and access control.

This module ensures that:
- Secrets NEVER enter the ledger, logs, or artifacts in raw form
- All outputs (stdout/stderr, diagnostics, artifacts) are scanned and redacted
- Secret access is policy-controlled and auditable
- Secret material is handled via opaque references (handles), never raw propagation

Scope:
- Runtime environment variables
- Command outputs
- Patch contents
- Verification diagnostics

Hard invariants:
- Raw secrets must never cross process boundaries unredacted
- All redaction is deterministic and reversible ONLY via secure handle mapping
- Detection must be multi-strategy (pattern + entropy + known keys)
- Any uncertainty => treat as secret (fail-closed)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, List, Tuple, Optional, Iterable

import hashlib
import json
import os
import re
import base64


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


SecretHandle = str


@dataclass(frozen=True)
class DetectedSecret:
    value: str
    start: int
    end: int
    reason: str


@dataclass(frozen=True)
class Redaction:
    original: str
    redacted: str
    handle: SecretHandle


@dataclass(frozen=True)
class RedactionResult:
    text: str
    redactions: Tuple[Redaction, ...]
    redaction_hash: str


# ---------------------------------------------------------------------------
# CONSTANTS
# ---------------------------------------------------------------------------


SECRET_ENV_PATTERNS = (
    r".*TOKEN.*",
    r".*SECRET.*",
    r".*KEY.*",
    r".*PASSWORD.*",
)

HIGH_ENTROPY_THRESHOLD = 3.5
MIN_SECRET_LENGTH = 8

REDACTION_TOKEN_PREFIX = "__SECRET__"


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _entropy(s: str) -> float:
    from math import log2

    prob = [float(s.count(c)) / len(s) for c in dict.fromkeys(list(s))]
    return -sum([p * log2(p) for p in prob])


# ---------------------------------------------------------------------------
# DETECTION
# ---------------------------------------------------------------------------


class SecretDetector:
    """
    Multi-strategy secret detection.
    """

    def __init__(self, known_keys: Optional[Iterable[str]] = None) -> None:
        self._known_keys = set(known_keys or [])

    def detect(self, text: str) -> Tuple[DetectedSecret, ...]:
        findings: List[DetectedSecret] = []

        # 1. Known key match
        for key in self._known_keys:
            for m in re.finditer(re.escape(key), text):
                findings.append(
                    DetectedSecret(value=key, start=m.start(), end=m.end(), reason="known_key")
                )

        # 2. High entropy tokens
        for token in re.findall(r"[A-Za-z0-9+/=_-]{%d,}" % MIN_SECRET_LENGTH, text):
            if _entropy(token) >= HIGH_ENTROPY_THRESHOLD:
                idx = text.find(token)
                findings.append(
                    DetectedSecret(value=token, start=idx, end=idx + len(token), reason="entropy")
                )

        # 3. Base64-like
        for token in re.findall(r"(?:[A-Za-z0-9+/]{16,}={0,2})", text):
            try:
                base64.b64decode(token)
                idx = text.find(token)
                findings.append(
                    DetectedSecret(value=token, start=idx, end=idx + len(token), reason="base64")
                )
            except Exception:
                pass

        return tuple(self._dedupe(findings))

    def _dedupe(self, findings: List[DetectedSecret]) -> List[DetectedSecret]:
        seen = set()
        out = []
        for f in findings:
            key = (f.start, f.end)
            if key not in seen:
                seen.add(key)
                out.append(f)
        return sorted(out, key=lambda x: x.start)


# ---------------------------------------------------------------------------
# REDACTION
# ---------------------------------------------------------------------------


class SecretRedactor:
    """
    Deterministic redaction with stable handles.
    """

    def __init__(self) -> None:
        self._map: Dict[str, SecretHandle] = {}

    def redact(self, text: str, findings: Tuple[DetectedSecret, ...]) -> RedactionResult:
        offset = 0
        redactions: List[Redaction] = []
        result = text

        for f in findings:
            handle = self._handle_for(f.value)
            token = f"{REDACTION_TOKEN_PREFIX}:{handle}"

            start = f.start + offset
            end = f.end + offset

            result = result[:start] + token + result[end:]

            delta = len(token) - (f.end - f.start)
            offset += delta

            redactions.append(
                Redaction(original=f.value, redacted=token, handle=handle)
            )

        redaction_hash = _hash({"text": result, "count": len(redactions)})

        return RedactionResult(text=result, redactions=tuple(redactions), redaction_hash=redaction_hash)

    def _handle_for(self, value: str) -> SecretHandle:
        if value in self._map:
            return self._map[value]
        h = hashlib.sha256(value.encode()).hexdigest()[:16]
        self._map[value] = h
        return h


# ---------------------------------------------------------------------------
# ENVIRONMENT FILTERING
# ---------------------------------------------------------------------------


class SecretEnvFilter:
    """
    Filters environment variables based on key patterns.
    """

    def __init__(self) -> None:
        self._compiled = [re.compile(p, re.IGNORECASE) for p in SECRET_ENV_PATTERNS]

    def filter(self, env: Dict[str, str]) -> Dict[str, str]:
        safe: Dict[str, str] = {}
        for k, v in env.items():
            if any(r.match(k) for r in self._compiled):
                continue
            safe[k] = v
        return safe


# ---------------------------------------------------------------------------
# GUARD
# ---------------------------------------------------------------------------


class SecretsGuard:
    """
    High-level orchestration of detection + redaction.
    """

    def __init__(self, known_secrets: Optional[Iterable[str]] = None) -> None:
        self._detector = SecretDetector(known_secrets)
        self._redactor = SecretRedactor()
        self._env_filter = SecretEnvFilter()

    # ------------------------------------------------------------------

    def sanitize_text(self, text: str) -> RedactionResult:
        findings = self._detector.detect(text)
        return self._redactor.redact(text, findings)

    def sanitize_env(self, env: Dict[str, str]) -> Dict[str, str]:
        return self._env_filter.filter(env)

    def assert_no_secrets(self, text: str) -> None:
        findings = self._detector.detect(text)
        if findings:
            raise RuntimeError(f"secret_leak_detected:{len(findings)}")


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def create_secrets_guard(known_secrets: Optional[Iterable[str]] = None) -> SecretsGuard:
    return SecretsGuard(known_secrets)
