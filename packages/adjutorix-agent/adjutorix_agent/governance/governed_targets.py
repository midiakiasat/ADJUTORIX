"""
ADJUTORIX AGENT — GOVERNANCE / GOVERNED_TARGETS

Authoritative resolution, classification, and enforcement of governed targets.

This module defines WHAT can be mutated and HOW targets are normalized into a
canonical, verifiable set before entering the patch pipeline.

Responsibilities:
- Normalize user/app-supplied target selectors into canonical paths
- Enforce workspace trust boundaries and ignore rules
- Classify targets (source, config, generated, binary, secret, vendor, etc.)
- Apply policy-driven allow/deny with reasoned diagnostics
- Produce a deterministic TargetSet used by patch_builder / apply_gate
- Detect target drift (mtime/hash changes) between selection and execution

Hard invariants:
- All targets are absolute, normalized, and inside workspace_root
- No symlink traversal escapes the workspace root
- Ignore rules (gitignore-like + policy) are strictly enforced
- Generated / derived artifacts are non-authoritative unless explicitly allowed
- Deterministic ordering of targets and stable TargetSet hash
"""

from __future__ import annotations

from dataclasses import dataclass, asdict
from typing import Dict, List, Tuple, Optional, Iterable, Any

import hashlib
import json
import os
import stat
import fnmatch

from adjutorix_agent.governance.policy_engine import PolicyEngine, PolicyContext, Decision
from adjutorix_agent.governance.constitution import classify_constitution_path


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


TargetId = str


@dataclass(frozen=True)
class TargetMeta:
    is_file: bool
    is_dir: bool
    is_symlink: bool
    size: int
    mtime_ns: int
    mode: int


@dataclass(frozen=True)
class TargetClassification:
    kind: str  # source | config | generated | binary | vendor | secret | unknown
    language: Optional[str]
    tags: Tuple[str, ...]


@dataclass(frozen=True)
class Target:
    target_id: TargetId
    abs_path: str
    rel_path: str
    meta: TargetMeta
    classification: TargetClassification


@dataclass(frozen=True)
class TargetSet:
    root: str
    targets: Tuple[Target, ...]
    set_hash: str


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _norm_abs(path: str) -> str:
    return os.path.realpath(os.path.abspath(path))


def _within(root: str, path: str) -> bool:
    root = _norm_abs(root)
    path = _norm_abs(path)
    return os.path.commonpath([root]) == os.path.commonpath([root, path])


def _stat(path: str) -> TargetMeta:
    st = os.lstat(path)
    return TargetMeta(
        is_file=stat.S_ISREG(st.st_mode),
        is_dir=stat.S_ISDIR(st.st_mode),
        is_symlink=stat.S_ISLNK(st.st_mode),
        size=st.st_size,
        mtime_ns=st.st_mtime_ns,
        mode=st.st_mode,
    )


def _read_gitignore(root: str) -> Tuple[str, ...]:
    gi = os.path.join(root, ".gitignore")
    if not os.path.exists(gi):
        return ()
    patterns: List[str] = []
    with open(gi, "r", encoding="utf-8", errors="ignore") as f:
        for line in f:
            s = line.strip()
            if not s or s.startswith("#"):
                continue
            patterns.append(s)
    return tuple(patterns)


def _match_ignore(rel_path: str, patterns: Tuple[str, ...]) -> bool:
    # simple fnmatch-based ignore; deterministic
    for p in patterns:
        if fnmatch.fnmatch(rel_path, p) or fnmatch.fnmatch(os.path.basename(rel_path), p):
            return True
    return False


# ---------------------------------------------------------------------------
# CLASSIFICATION
# ---------------------------------------------------------------------------


class TargetClassifier:
    """
    Constitution-first deterministic classification.

    Heuristics remain only as a fallback inside authoritative source/config
    strata. Derived, ephemeral, release, and forbidden surfaces are classified
    from the repository constitution before extension-based inference.
    """

    CONSTITUTION_GENERATED_STRATA = frozenset({
        "ephemeral/runtime",
        "derived/build",
        "release/distributable",
    })
    CONSTITUTION_FORBIDDEN_STRATA = frozenset({"forbidden"})

    def __init__(self, workspace_root: str) -> None:
        self._workspace_root = _norm_abs(workspace_root)

    TEXT_EXT = {
        ".ts": ("source", "typescript"),
        ".tsx": ("source", "typescript"),
        ".js": ("source", "javascript"),
        ".py": ("source", "python"),
        ".json": ("config", None),
        ".yaml": ("config", None),
        ".yml": ("config", None),
        ".md": ("config", None),
        ".toml": ("config", None),
    }

    BINARY_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".icns", ".zip", ".gz", ".tar"}

    def classify(self, rel_path: str, meta: TargetMeta) -> TargetClassification:
        name = os.path.basename(rel_path)
        _, ext = os.path.splitext(name.lower())

        stratum = classify_constitution_path(self._workspace_root, rel_path)
        tags: List[str] = [f"constitution:{stratum}"]

        if stratum in self.CONSTITUTION_GENERATED_STRATA:
            return TargetClassification("generated", None, tuple(tags + ["generated"]))

        if stratum in self.CONSTITUTION_FORBIDDEN_STRATA:
            return TargetClassification("unknown", None, tuple(tags + ["forbidden"]))

        if name.startswith(".") and name not in (".env.example",):
            tags.append("hidden")

        if ext in self.BINARY_EXT or not meta.is_file:
            return TargetClassification("binary", None, tuple(tags + ["binary"]))

        if ext in self.TEXT_EXT:
            kind, lang = self.TEXT_EXT[ext]
            return TargetClassification(kind, lang, tuple(tags))

        # heuristic: high entropy filename could be generated
        if len(name) > 32:
            return TargetClassification("generated", None, tuple(tags + ["generated"]))

        return TargetClassification("unknown", None, tuple(tags))


# ---------------------------------------------------------------------------
# RESOLUTION
# ---------------------------------------------------------------------------


class TargetResolver:
    """
    Expands selectors into concrete file targets.
    Selectors supported:
    - exact paths (files/dirs)
    - glob patterns ("src/**/*.ts")
    """

    def __init__(self, root: str, ignore: Tuple[str, ...]) -> None:
        self._root = _norm_abs(root)
        self._ignore = ignore

    def resolve(self, selectors: Tuple[str, ...]) -> Tuple[str, ...]:
        out: List[str] = []

        for sel in selectors:
            abs_sel = _norm_abs(os.path.join(self._root, sel) if not os.path.isabs(sel) else sel)

            if not _within(self._root, abs_sel):
                raise RuntimeError(f"target_outside_workspace:{sel}")

            if any(ch in sel for ch in "*?[]"):
                out.extend(self._glob(sel))
                continue

            if os.path.isdir(abs_sel):
                out.extend(self._walk(abs_sel))
            elif os.path.isfile(abs_sel):
                out.append(abs_sel)
            else:
                raise RuntimeError(f"target_not_found:{sel}")

        # dedupe + deterministic order
        uniq = sorted(set(out))
        return tuple(uniq)

    def _walk(self, start: str) -> List[str]:
        res: List[str] = []
        for root, _, files in os.walk(start):
            for f in files:
                p = os.path.join(root, f)
                rel = os.path.relpath(p, self._root)
                if _match_ignore(rel, self._ignore):
                    continue
                res.append(_norm_abs(p))
        return res

    def _glob(self, pattern: str) -> List[str]:
        # simple recursive glob
        import glob

        pattern_abs = os.path.join(self._root, pattern)
        matches = glob.glob(pattern_abs, recursive=True)
        res: List[str] = []
        for p in matches:
            if not os.path.isfile(p):
                continue
            rel = os.path.relpath(p, self._root)
            if _match_ignore(rel, self._ignore):
                continue
            res.append(_norm_abs(p))
        return res


# ---------------------------------------------------------------------------
# GOVERNOR
# ---------------------------------------------------------------------------


class GovernedTargets:
    """
    End-to-end pipeline: resolve -> classify -> policy-check -> finalize TargetSet.
    """

    def __init__(self, workspace_root: str, policy_engine: PolicyEngine) -> None:
        self._root = _norm_abs(workspace_root)
        self._policy = policy_engine
        self._ignore = _read_gitignore(self._root)
        self._resolver = TargetResolver(self._root, self._ignore)
        self._classifier = TargetClassifier(self._root)

    # ------------------------------------------------------------------

    def build(
        self,
        selectors: Tuple[str, ...],
        *,
        actor: str = "system",
        roles: Tuple[str, ...] = (),
        tx_id: Optional[str] = None,
    ) -> Tuple[TargetSet, Decision]:
        """
        Returns (TargetSet, decision). Caller must enforce decision.
        """

        paths = self._resolver.resolve(selectors)

        targets: List[Target] = []
        for p in paths:
            rel = os.path.relpath(p, self._root)
            meta = _stat(p)

            # symlink escape prevention
            if meta.is_symlink:
                real = _norm_abs(p)
                if not _within(self._root, real):
                    raise RuntimeError(f"symlink_escape:{rel}")

            cls = self._classifier.classify(rel, meta)

            tid = _hash({"p": p, "m": asdict(meta)})

            targets.append(
                Target(
                    target_id=tid,
                    abs_path=p,
                    rel_path=rel,
                    meta=meta,
                    classification=cls,
                )
            )

        # deterministic order
        targets_sorted = tuple(sorted(targets, key=lambda t: t.rel_path))

        # policy evaluation (using rel paths)
        ctx = PolicyContext(
            action="patch.targets",
            tx_id=tx_id,
            targets=tuple(t.rel_path for t in targets_sorted),
            paths=tuple(t.rel_path for t in targets_sorted),
            workspace_root=self._root,
            actor=actor,
            roles=roles,
        )

        decision = self._policy.evaluate(ctx)

        tset = TargetSet(
            root=self._root,
            targets=targets_sorted,
            set_hash=_hash([
                (t.rel_path, t.target_id, t.classification.kind) for t in targets_sorted
            ]),
        )

        return tset, decision

    # ------------------------------------------------------------------

    def verify_unchanged(self, tset: TargetSet) -> None:
        """
        Detect drift between selection and execution (mtime/size/mode changes).
        """
        for t in tset.targets:
            if not os.path.exists(t.abs_path):
                raise RuntimeError(f"target_missing:{t.rel_path}")
            cur = _stat(t.abs_path)
            if (
                cur.mtime_ns != t.meta.mtime_ns
                or cur.size != t.meta.size
                or cur.mode != t.meta.mode
            ):
                raise RuntimeError(f"target_drift:{t.rel_path}")


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_governed_targets(
    workspace_root: str,
    policy_engine: PolicyEngine,
) -> GovernedTargets:
    return GovernedTargets(workspace_root, policy_engine)
