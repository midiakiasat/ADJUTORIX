"""
ADJUTORIX AGENT — GOVERNANCE / POLICY_ENGINE

Deterministic policy evaluation engine enforcing governance over all operations.

Scope:
- Patch application (preconditions, targets, conflicts)
- Command execution (shell governance)
- Workspace access (trust, paths, ignore rules)
- Secrets handling (redaction, access control)
- Release / environment constraints

Design:
- Policies are declarative (YAML/JSON loaded at runtime) and compiled to predicates
- Evaluation is pure: (context, policy_set) -> Decision
- Decisions are explainable with a full trace (rule-by-rule)
- No side effects; enforcement happens at call sites (apply_gate, command_runner, etc.)

Hard invariants:
- Default deny (fail-closed) when no explicit allow
- Deterministic ordering of rules and outcomes
- No implicit context; all inputs must be explicit in PolicyContext
- Every decision must include an auditable trace and a stable decision_hash
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, List, Tuple, Optional, Any, Callable

import hashlib
import json
import re
import fnmatch


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


DecisionType = str  # "allow" | "deny" | "require" (require = allow with obligations)


@dataclass(frozen=True)
class Obligation:
    key: str
    value: Any


@dataclass(frozen=True)
class Decision:
    decision: DecisionType
    reason: str
    obligations: Tuple[Obligation, ...]
    trace: Tuple["RuleTrace", ...]
    decision_hash: str


@dataclass(frozen=True)
class RuleTrace:
    policy: str
    rule: str
    matched: bool
    outcome: Optional[DecisionType]
    message: str


@dataclass(frozen=True)
class PolicyContext:
    # core
    action: str  # e.g., "patch.apply" | "command.exec" | "workspace.read"
    tx_id: Optional[str]

    # patch-related
    targets: Tuple[str, ...] = ()
    patch_ops: Tuple[Dict[str, Any], ...] = ()

    # command-related
    command: Optional[str] = None
    args: Tuple[str, ...] = ()
    cwd: Optional[str] = None

    # workspace-related
    paths: Tuple[str, ...] = ()
    workspace_root: Optional[str] = None

    # identity / environment
    actor: str = "system"
    roles: Tuple[str, ...] = ()
    env: Dict[str, str] = field(default_factory=dict)

    # secrets (names only; values never here)
    secret_keys: Tuple[str, ...] = ()


@dataclass(frozen=True)
class CompiledRule:
    name: str
    when: Tuple[Callable[[PolicyContext], bool], ...]
    decision: DecisionType
    message: str
    obligations: Tuple[Obligation, ...]


@dataclass(frozen=True)
class CompiledPolicy:
    name: str
    priority: int
    rules: Tuple[CompiledRule, ...]


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _stable_hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


# ---------------------------------------------------------------------------
# PREDICATES (BUILDING BLOCKS)
# ---------------------------------------------------------------------------


def action_is(*actions: str) -> Callable[[PolicyContext], bool]:
    s = set(actions)
    return lambda ctx: ctx.action in s


def role_in(*roles: str) -> Callable[[PolicyContext], bool]:
    s = set(roles)
    return lambda ctx: any(r in s for r in ctx.roles)


def path_matches(patterns: Tuple[str, ...]) -> Callable[[PolicyContext], bool]:
    pats = tuple(patterns)

    def _pred(ctx: PolicyContext) -> bool:
        for p in ctx.paths or ctx.targets:
            if any(fnmatch.fnmatch(p, pat) for pat in pats):
                return True
        return False

    return _pred


def command_matches(regex: str) -> Callable[[PolicyContext], bool]:
    rx = re.compile(regex)
    return lambda ctx: bool(ctx.command and rx.search(ctx.command))


def env_flag(name: str, expected: str) -> Callable[[PolicyContext], bool]:
    return lambda ctx: ctx.env.get(name) == expected


# ---------------------------------------------------------------------------
# COMPILER (DECLARATIVE -> EXECUTABLE)
# ---------------------------------------------------------------------------


class PolicyCompiler:
    """
    Compiles JSON-like policy definitions into executable predicates.

    Supported DSL keys (per rule):
    - when.action: [..]
    - when.role_in: [..]
    - when.path_matches: [..]
    - when.command_regex: "..."
    - when.env: {k: v}
    - decision: "allow" | "deny" | "require"
    - message: str
    - obligations: {k: v}
    """

    def compile(self, name: str, priority: int, raw: Dict[str, Any]) -> CompiledPolicy:
        rules: List[CompiledRule] = []

        for r in raw.get("rules", []):
            preds: List[Callable[[PolicyContext], bool]] = []
            w = r.get("when", {})

            if "action" in w:
                preds.append(action_is(*tuple(w["action"])))

            if "role_in" in w:
                preds.append(role_in(*tuple(w["role_in"])))

            if "path_matches" in w:
                preds.append(path_matches(tuple(w["path_matches"])))

            if "command_regex" in w:
                preds.append(command_matches(w["command_regex"]))

            if "env" in w:
                for k, v in w["env"].items():
                    preds.append(env_flag(k, str(v)))

            decision = r["decision"]
            message = r.get("message", "")

            obligations = tuple(
                Obligation(k, v) for k, v in (r.get("obligations") or {}).items()
            )

            rules.append(
                CompiledRule(
                    name=r.get("name", "unnamed"),
                    when=tuple(preds),
                    decision=decision,
                    message=message,
                    obligations=obligations,
                )
            )

        # deterministic ordering by rule name
        rules_sorted = tuple(sorted(rules, key=lambda x: x.name))

        return CompiledPolicy(name=name, priority=priority, rules=rules_sorted)


# ---------------------------------------------------------------------------
# ENGINE
# ---------------------------------------------------------------------------


class PolicyEngine:
    """
    Evaluates compiled policies against a context.

    Resolution strategy:
    - Policies sorted by priority (desc), then name
    - Rules evaluated in-order
    - First matching DENY => terminal deny
    - Otherwise collect ALLOW/REQUIRE; if any allow/require present and no deny, allow
    - If nothing matches => deny (fail-closed)
    """

    def __init__(self, policies: Tuple[CompiledPolicy, ...]) -> None:
        # sort: highest priority first, then name
        self._policies = tuple(sorted(policies, key=lambda p: (-p.priority, p.name)))

    # ------------------------------------------------------------------
    # PUBLIC
    # ------------------------------------------------------------------

    def evaluate(self, ctx: PolicyContext) -> Decision:
        traces: List[RuleTrace] = []
        obligations: List[Obligation] = []

        any_allow = False

        for policy in self._policies:
            for rule in policy.rules:
                matched = all(pred(ctx) for pred in rule.when)

                if not matched:
                    traces.append(
                        RuleTrace(policy=policy.name, rule=rule.name, matched=False, outcome=None, message="")
                    )
                    continue

                # matched
                outcome = rule.decision
                traces.append(
                    RuleTrace(policy=policy.name, rule=rule.name, matched=True, outcome=outcome, message=rule.message)
                )

                if outcome == "deny":
                    return self._finalize("deny", rule.message, obligations, traces)

                if outcome in ("allow", "require"):
                    any_allow = True
                    obligations.extend(rule.obligations)

        if any_allow:
            return self._finalize("allow", "allowed_by_policy", tuple(obligations), traces)

        return self._finalize("deny", "no_matching_rule", tuple(obligations), traces)

    # ------------------------------------------------------------------
    # INTERNAL
    # ------------------------------------------------------------------

    def _finalize(
        self,
        decision: DecisionType,
        reason: str,
        obligations: Tuple[Obligation, ...] | List[Obligation],
        traces: List[RuleTrace],
    ) -> Decision:
        payload = {
            "decision": decision,
            "reason": reason,
            "obligations": [asdict(o) for o in obligations],
            "trace": [asdict(t) for t in traces],
        }
        return Decision(
            decision=decision,
            reason=reason,
            obligations=tuple(obligations),
            trace=tuple(traces),
            decision_hash=_stable_hash(payload),
        )


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def build_engine_from_dicts(policies: Dict[str, Dict[str, Any]]) -> PolicyEngine:
    """
    policies = {
        "mutation_policy": {"priority": 100, "rules": [...]},
        "command_policy":  {"priority": 80,  "rules": [...]},
        ...
    }
    """
    compiler = PolicyCompiler()
    compiled: List[CompiledPolicy] = []

    for name, raw in policies.items():
        priority = int(raw.get("priority", 0))
        compiled.append(compiler.compile(name=name, priority=priority, raw=raw))

    return PolicyEngine(tuple(compiled))
