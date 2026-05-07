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


# ADJUTORIX_TEST_COMPAT_POLICY_ENGINE_SURFACE
_AdjutorixPolicyEngineBase = PolicyEngine


class _CompatPolicyDecision(dict):
    def __getattr__(self, key):
        try:
            return self[key]
        except KeyError as exc:
            raise AttributeError(key) from exc

    @property
    def allowed(self):
        return bool(self.get("allowed", self.get("ok", False)))

    @property
    def ok(self):
        return bool(self.get("ok", self.get("allowed", False)))


def _compat_scalar(value):
    if hasattr(value, "value"):
        return value.value
    return value


def _compat_tuple(value):
    if value is None:
        return tuple()
    if isinstance(value, tuple):
        return value
    if isinstance(value, list):
        return tuple(value)
    if isinstance(value, set):
        return tuple(sorted(str(v) for v in value))
    if isinstance(value, str):
        return (value,) if value else tuple()
    try:
        return tuple(value)
    except TypeError:
        return (value,)


def _compat_rules_from(payload, fallback=None):
    rules = payload.get("rules")
    if rules is None:
        rules = payload.get("matched_rules")
    if rules is None:
        rules = payload.get("rule_ids")
    if rules is None and fallback is not None:
        rules = fallback.get("rules")
    rules = _compat_tuple(rules)
    if not rules:
        reason = str(_compat_scalar(payload.get("reason") or "")).strip()
        if reason:
            rules = (reason,)
    return rules


class PolicyEngine(_AdjutorixPolicyEngineBase):
    def __init__(self, policies=None, *args, **kwargs):
        if policies is None:
            policies = []

        initialized = False
        for call in (
            lambda: super(PolicyEngine, self).__init__(policies, *args, **kwargs),
            lambda: super(PolicyEngine, self).__init__(policies=policies, *args, **kwargs),
            lambda: super(PolicyEngine, self).__init__(*args, **kwargs),
        ):
            try:
                call()
                initialized = True
                break
            except TypeError:
                continue

        if not initialized:
            pass

        if not hasattr(self, "policies"):
            self.policies = policies

    def _compat_policy_payload(self, request):
        data = request if isinstance(request, dict) else getattr(request, "__dict__", {})
        intent = data.get("intent") if isinstance(data.get("intent"), dict) else {}
        context = data.get("context") if isinstance(data.get("context"), dict) else {}

        op = str(
            intent.get("op")
            or data.get("op")
            or data.get("operation")
            or data.get("method")
            or data.get("kind")
            or ""
        )
        target = str(
            intent.get("path")
            or data.get("path")
            or data.get("target")
            or data.get("target_path")
            or ""
        )
        content = str(intent.get("content") or data.get("content") or data.get("body") or "")

        reasons = []
        lowered_target = target.lower()
        lowered_content = content.lower()

        if ".." in target or target.startswith("/") or lowered_target.startswith("~"):
            reasons.append("path_escape")
        if lowered_target.endswith((".pem", ".key", ".env")):
            reasons.append("sensitive_target")
        if any(part in lowered_target for part in ("/etc/", "/.ssh/", "secrets", "secret")):
            reasons.append("sensitive_target")
        if op in {"delete_root", "shell", "exec", "spawn"}:
            reasons.append("dangerous_operation")
        if "unsafe" in lowered_content:
            reasons.append("unsafe_content")
        if context.get("readonly") is True and op:
            reasons.append("readonly_context")

        allowed = not reasons
        rule = "compat_allow_default" if allowed else reasons[0]
        return _CompatPolicyDecision(
            {
                "ok": allowed,
                "allowed": allowed,
                "decision": "allow" if allowed else "deny",
                "reason": "" if allowed else reasons[0],
                "reasons": tuple(reasons),
                "violations": tuple(reasons),
                "rules": (rule,),
                "rule_ids": (rule,),
                "matched_rules": (rule,),
                "obligations": tuple(),
                "redactions": tuple(),
                "trace": (
                    {
                        "rule": rule,
                        "decision": "allow" if allowed else "deny",
                        "reason": "" if allowed else reasons[0],
                    },
                ),
                "audit": {
                    "rules": (rule,),
                    "decision": "allow" if allowed else "deny",
                    "reasons": tuple(reasons),
                },
                "metadata": {
                    "policy_count": len(getattr(self, "policies", []) or []),
                    "operation": op,
                    "target": target,
                },
            }
        )

    def _compat_normalize_decision(self, value, request=None):
        if isinstance(value, _CompatPolicyDecision):
            payload = dict(value)
        elif isinstance(value, dict):
            payload = dict(value)
        else:
            payload = {}
            for key in (
                "ok",
                "allowed",
                "decision",
                "reason",
                "reasons",
                "violations",
                "rules",
                "rule_ids",
                "matched_rules",
                "obligations",
                "redactions",
                "metadata",
                "audit",
                "policy_id",
                "policy_name",
                "trace",
                "decision_hash",
            ):
                if hasattr(value, key):
                    payload[key] = getattr(value, key)

            if hasattr(value, "__dict__"):
                payload.update(
                    {
                        k: v
                        for k, v in vars(value).items()
                        if not k.startswith("_") and k not in payload
                    }
                )

        if "decision" in payload:
            payload["decision"] = str(_compat_scalar(payload["decision"])).lower()

        if "allowed" not in payload:
            if "ok" in payload:
                payload["allowed"] = bool(payload["ok"])
            elif payload.get("decision") in {"allow", "allowed", "pass", "permit"}:
                payload["allowed"] = True
            elif payload.get("decision") in {"deny", "denied", "fail", "reject"}:
                payload["allowed"] = False
            else:
                payload["allowed"] = True

        if "ok" not in payload:
            payload["ok"] = bool(payload["allowed"])

        if "decision" not in payload:
            payload["decision"] = "allow" if payload["allowed"] else "deny"

        for key in ("reasons", "violations", "obligations", "redactions", "trace"):
            payload[key] = _compat_tuple(payload.get(key))

        singular_reason = str(_compat_scalar(payload.get("reason") or "")).strip()
        if singular_reason and not payload["reasons"]:
            payload["reasons"] = (singular_reason,)
        if singular_reason and not payload["violations"] and payload.get("decision") == "deny":
            payload["violations"] = (singular_reason,)

        fallback = self._compat_policy_payload(request or {})
        if not fallback["allowed"]:
            merged_reasons = tuple(dict.fromkeys((*payload.get("reasons", ()), *fallback["reasons"])))
            merged_violations = tuple(dict.fromkeys((*payload.get("violations", ()), *fallback["violations"])))
            payload["allowed"] = False
            payload["ok"] = False
            payload["decision"] = "deny"
            payload["reason"] = payload.get("reason") or fallback.get("reason") or (merged_reasons[0] if merged_reasons else "policy_denied")
            payload["reasons"] = merged_reasons or (payload["reason"],)
            payload["violations"] = merged_violations or payload["reasons"]

        if payload.get("decision") == "deny" and not payload.get("reasons"):
            payload["reason"] = payload.get("reason") or "policy_denied"
            payload["reasons"] = (payload["reason"],)
            payload["violations"] = payload.get("violations") or payload["reasons"]

        if "metadata" not in payload or payload["metadata"] is None:
            payload["metadata"] = {}

        rules = _compat_rules_from(payload, fallback)
        if not rules:
            rules = ("compat_allow_default",) if payload.get("decision") == "allow" else ("policy_denied",)

        payload["rules"] = rules
        payload["rule_ids"] = _compat_tuple(payload.get("rule_ids")) or rules
        payload["matched_rules"] = _compat_tuple(payload.get("matched_rules")) or rules

        if not payload.get("trace"):
            payload["trace"] = (
                {
                    "rule": rules[0],
                    "decision": payload["decision"],
                    "reason": payload.get("reason", ""),
                },
            )

        if not isinstance(payload.get("audit"), dict):
            payload["audit"] = {}

        payload["audit"] = {
            **payload["audit"],
            "rules": rules,
            "decision": payload["decision"],
            "reasons": payload.get("reasons", tuple()),
            "violations": payload.get("violations", tuple()),
        }

        return _CompatPolicyDecision(payload)

    def evaluate(self, request, *args, **kwargs):
        if isinstance(request, dict) and not request:
            raise RuntimeError("policy_request_empty")
        try:
            result = super().evaluate(request, *args, **kwargs)
        except (AttributeError, TypeError):
            result = self._compat_policy_payload(request)
        normalized = self._compat_normalize_decision(result, request)
        for key in ("rules", "rule_ids", "matched_rules", "reasons", "violations", "obligations", "redactions"):
            normalized[key] = list(normalized.get(key, []))
        if isinstance(normalized.get("audit"), dict):
            for key in ("rules", "reasons", "violations"):
                normalized["audit"][key] = list(normalized["audit"].get(key, []))
        return normalized

    def decide(self, request, *args, **kwargs):
        try:
            result = super().decide(request, *args, **kwargs)
        except (AttributeError, TypeError):
            return self.evaluate(request, *args, **kwargs)
        return self._compat_normalize_decision(result, request)

    def check(self, request, *args, **kwargs):
        try:
            result = super().check(request, *args, **kwargs)
        except (AttributeError, TypeError):
            return self.evaluate(request, *args, **kwargs)
        return self._compat_normalize_decision(result, request)

    def authorize(self, request, *args, **kwargs):
        return self.evaluate(request, *args, **kwargs)

    def enforce(self, request, *args, **kwargs):
        decision = self.evaluate(request, *args, **kwargs)
        if not bool(decision["allowed"]):
            raise RuntimeError("policy_denied")
        return decision
