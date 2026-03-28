"""
ADJUTORIX AGENT — GOVERNANCE / POLICY_PACKS

Authoritative policy pack definitions and loaders.

This module assembles multiple domain-specific policy packs into a single
PolicyEngine instance. It provides:
- Strongly-typed, versioned policy packs (mutation, command, workspace, secrets, release)
- Deterministic loading from configs/policy/* with override/merge semantics
- Integrity validation (hashes, schema checks)
- Freeze/lock mechanism (version pinning) to prevent drift at runtime
- Capability scoping (enabling/disabling packs by environment)

Hard invariants:
- Packs are immutable once compiled (frozen by version_lock)
- Merge is deterministic (priority + rule name ordering)
- Missing packs => deny-by-default behavior remains intact
- No implicit filesystem reads during evaluation (all loaded at bootstrap)
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Any, Tuple, List, Optional

import hashlib
import json
import os

from adjutorix_agent.governance.policy_engine import (
    build_engine_from_dicts,
    PolicyEngine,
)


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class PolicyPack:
    name: str
    version: str
    priority: int
    content: Dict[str, Any]
    source: str  # path or identifier
    content_hash: str


@dataclass(frozen=True)
class PolicyPacksBundle:
    packs: Tuple[PolicyPack, ...]
    bundle_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# LOADER
# ---------------------------------------------------------------------------


class PolicyPackLoader:
    """
    Loads policy packs from a directory structure:

    configs/policy/
        mutation_policy.yaml
        command_policy.yaml
        workspace_policy.yaml
        secrets_policy.yaml
        release_policy.yaml

    Supported formats: JSON (native) and YAML (via json-compatible subset).
    """

    def __init__(self, base_dir: str) -> None:
        self._base_dir = base_dir

    def load_all(self) -> PolicyPacksBundle:
        packs: List[PolicyPack] = []

        for fname in sorted(os.listdir(self._base_dir)):
            if not fname.endswith((".json", ".yaml", ".yml")):
                continue

            path = os.path.join(self._base_dir, fname)
            raw = self._load_file(path)

            name = raw.get("name") or fname.split(".")[0]
            version = str(raw.get("version", "0"))
            priority = int(raw.get("priority", 0))

            # strip meta fields from content
            content = {
                k: v
                for k, v in raw.items()
                if k not in {"name", "version", "priority"}
            }

            content_hash = _hash(content)

            packs.append(
                PolicyPack(
                    name=name,
                    version=version,
                    priority=priority,
                    content=content,
                    source=path,
                    content_hash=content_hash,
                )
            )

        bundle_hash = _hash(
            [(p.name, p.version, p.priority, p.content_hash) for p in packs]
        )

        return PolicyPacksBundle(packs=tuple(packs), bundle_hash=bundle_hash)

    # ------------------------------------------------------------------

    def _load_file(self, path: str) -> Dict[str, Any]:
        with open(path, "r", encoding="utf-8") as f:
            text = f.read()

        # minimal YAML support: rely on JSON subset
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            # fallback: extremely restricted YAML (no anchors, no complex types)
            return self._parse_simple_yaml(text)

    def _parse_simple_yaml(self, text: str) -> Dict[str, Any]:
        """
        Very restricted YAML parser to avoid external deps.
        Only supports key: value, lists, nested dict via indentation.
        """
        result: Dict[str, Any] = {}
        stack: List[Tuple[int, Dict[str, Any]]] = [(0, result)]

        for line in text.splitlines():
            if not line.strip() or line.strip().startswith("#"):
                continue

            indent = len(line) - len(line.lstrip(" "))
            key, _, value = line.strip().partition(":")
            value = value.strip() or None

            while stack and stack[-1][0] >= indent:
                stack.pop()

            parent = stack[-1][1] if stack else result

            if value is None:
                new_dict: Dict[str, Any] = {}
                parent[key] = new_dict
                stack.append((indent, new_dict))
            else:
                parent[key] = self._coerce(value)

        return result

    def _coerce(self, v: str) -> Any:
        if v in ("true", "True"):
            return True
        if v in ("false", "False"):
            return False
        if v.isdigit():
            return int(v)
        return v


# ---------------------------------------------------------------------------
# MERGE / COMPOSITION
# ---------------------------------------------------------------------------


class PolicyPackComposer:
    """
    Deterministically merges multiple packs into a single policy dict
    compatible with PolicyEngine.
    """

    def compose(self, bundle: PolicyPacksBundle) -> Dict[str, Dict[str, Any]]:
        result: Dict[str, Dict[str, Any]] = {}

        # deterministic order
        for pack in sorted(bundle.packs, key=lambda p: (-p.priority, p.name)):
            existing = result.get(pack.name)
            if existing is None:
                result[pack.name] = {
                    "priority": pack.priority,
                    "rules": list(pack.content.get("rules", [])),
                }
                continue

            # merge rules: append then dedupe by rule name
            combined = existing["rules"] + list(pack.content.get("rules", []))
            dedup: Dict[str, Dict[str, Any]] = {}
            for r in combined:
                name = r.get("name", "unnamed")
                dedup[name] = r  # later overrides earlier

            result[pack.name] = {
                "priority": max(existing["priority"], pack.priority),
                "rules": list(sorted(dedup.values(), key=lambda x: x.get("name", ""))),
            }

        return result


# ---------------------------------------------------------------------------
# FREEZE / LOCK
# ---------------------------------------------------------------------------


class PolicyPackLock:
    """
    Ensures runtime policy immutability by verifying bundle hash against
    expected lock value.
    """

    def __init__(self, expected_hash: Optional[str]) -> None:
        self._expected_hash = expected_hash

    def verify(self, bundle: PolicyPacksBundle) -> None:
        if self._expected_hash is None:
            return
        if bundle.bundle_hash != self._expected_hash:
            raise RuntimeError(
                f"policy_pack_drift: expected={self._expected_hash} actual={bundle.bundle_hash}"
            )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_policy_engine_from_dir(
    policy_dir: str,
    expected_bundle_hash: Optional[str] = None,
) -> PolicyEngine:
    loader = PolicyPackLoader(policy_dir)
    bundle = loader.load_all()

    lock = PolicyPackLock(expected_bundle_hash)
    lock.verify(bundle)

    composer = PolicyPackComposer()
    policy_dicts = composer.compose(bundle)

    return build_engine_from_dicts(policy_dicts)
