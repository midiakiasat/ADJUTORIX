"""
ADJUTORIX AGENT — GOVERNANCE / DECISIONS

Canonical decision model, composition, normalization, and verification.

This module centralizes how decisions are represented, combined, persisted
and verified across the system. It is used by:
- policy_engine (primary producer)
- command_guard / governed_targets / apply_gate (consumers + enforcers)
- ledger (for auditable recording of decisions)

Responsibilities:
- Provide immutable Decision model with full trace and obligations
- Deterministic hashing of decisions (content-addressable)
- Decision algebra (merge/compose across multiple guards)
- Obligation handling (validation + extraction)
- Serialization / deserialization (stable)
- Verification utilities (equality, implication, dominance)

Hard invariants:
- Decision hash is a pure function of normalized payload
- Trace ordering is deterministic
- Merge is associative and commutative under identical inputs
- Deny dominates allow/require
- Missing decision => implicit deny (never represent as None)
"""

from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Dict, Tuple, List, Any, Iterable, Optional

import hashlib
import json


# ---------------------------------------------------------------------------
# TYPES
# ---------------------------------------------------------------------------


DecisionType = str  # "allow" | "deny" | "require"


@dataclass(frozen=True)
class Obligation:
    key: str
    value: Any


@dataclass(frozen=True)
class RuleTrace:
    policy: str
    rule: str
    matched: bool
    outcome: Optional[DecisionType]
    message: str


@dataclass(frozen=True)
class Decision:
    decision: DecisionType
    reason: str
    obligations: Tuple[Obligation, ...] = field(default_factory=tuple)
    trace: Tuple[RuleTrace, ...] = field(default_factory=tuple)
    decision_hash: str = ""


# ---------------------------------------------------------------------------
# HELPERS
# ---------------------------------------------------------------------------


def _stable_json(obj: Any) -> str:
    return json.dumps(obj, sort_keys=True, separators=(",", ":"))


def _hash(obj: Any) -> str:
    return hashlib.sha256(_stable_json(obj).encode()).hexdigest()


def _norm_obligations(obs: Iterable[Obligation]) -> Tuple[Obligation, ...]:
    # dedupe by (key, value) and sort deterministically
    uniq = {(o.key, _stable_json(o.value)): o for o in obs}
    ordered = sorted(uniq.values(), key=lambda o: (o.key, _stable_json(o.value)))
    return tuple(ordered)


def _norm_trace(trace: Iterable[RuleTrace]) -> Tuple[RuleTrace, ...]:
    # stable ordering: policy, rule, matched desc, outcome, message
    return tuple(sorted(trace, key=lambda t: (t.policy, t.rule, not t.matched, t.outcome or "", t.message)))


# ---------------------------------------------------------------------------
# CONSTRUCTORS
# ---------------------------------------------------------------------------


def make_decision(
    decision: DecisionType,
    reason: str,
    obligations: Iterable[Obligation] = (),
    trace: Iterable[RuleTrace] = (),
) -> Decision:
    obs = _norm_obligations(obligations)
    tr = _norm_trace(trace)

    payload = {
        "decision": decision,
        "reason": reason,
        "obligations": [asdict(o) for o in obs],
        "trace": [asdict(t) for t in tr],
    }

    return Decision(
        decision=decision,
        reason=reason,
        obligations=obs,
        trace=tr,
        decision_hash=_hash(payload),
    )


# ---------------------------------------------------------------------------
# DECISION ALGEBRA
# ---------------------------------------------------------------------------


class DecisionAlgebra:
    """
    Composition rules across multiple decisions.

    Semantics:
    - deny dominates everything
    - require behaves like allow but accumulates obligations
    - allow only if at least one allow/require and no deny
    - no decisions => deny
    """

    @staticmethod
    def merge(decisions: Iterable[Decision]) -> Decision:
        ds = list(decisions)
        if not ds:
            return make_decision("deny", "no_decision")

        any_allow = False
        obligations: List[Obligation] = []
        trace: List[RuleTrace] = []

        for d in ds:
            trace.extend(d.trace)

            if d.decision == "deny":
                # short-circuit but include full trace
                return make_decision("deny", d.reason, (), trace)

            if d.decision in ("allow", "require"):
                any_allow = True
                obligations.extend(d.obligations)

        if any_allow:
            return make_decision("allow", "merged_allow", obligations, trace)

        return make_decision("deny", "no_allowing_decision", obligations, trace)

    @staticmethod
    def require_with(base: Decision, extra_obligations: Iterable[Obligation]) -> Decision:
        if base.decision == "deny":
            return base
        obs = list(base.obligations) + list(extra_obligations)
        return make_decision(base.decision, base.reason, obs, base.trace)

    @staticmethod
    def implies(a: Decision, b: Decision) -> bool:
        """
        Returns True if decision a is at least as restrictive as b.
        Partial order:
        deny >= require >= allow
        """
        order = {"allow": 0, "require": 1, "deny": 2}
        return order[a.decision] >= order[b.decision]

    @staticmethod
    def equivalent(a: Decision, b: Decision) -> bool:
        return a.decision_hash == b.decision_hash


# ---------------------------------------------------------------------------
# OBLIGATION HANDLING
# ---------------------------------------------------------------------------


class ObligationSet:
    """
    Utilities for extracting and validating obligations.
    """

    def __init__(self, obligations: Iterable[Obligation]) -> None:
        self._by_key: Dict[str, List[Any]] = {}
        for o in obligations:
            self._by_key.setdefault(o.key, []).append(o.value)

    def require(self, key: str) -> List[Any]:
        if key not in self._by_key:
            raise RuntimeError(f"missing_obligation:{key}")
        return list(self._by_key[key])

    def get(self, key: str, default: Optional[List[Any]] = None) -> List[Any]:
        return list(self._by_key.get(key, default or []))

    def assert_single(self, key: str) -> Any:
        vals = self.require(key)
        if len(vals) != 1:
            raise RuntimeError(f"expected_single_obligation:{key}")
        return vals[0]


# ---------------------------------------------------------------------------
# SERIALIZATION
# ---------------------------------------------------------------------------


def encode(decision: Decision) -> str:
    payload = {
        "decision": decision.decision,
        "reason": decision.reason,
        "obligations": [asdict(o) for o in decision.obligations],
        "trace": [asdict(t) for t in decision.trace],
        "decision_hash": decision.decision_hash,
    }
    return _stable_json(payload)


def decode(s: str) -> Decision:
    payload = json.loads(s)
    obs = tuple(Obligation(**o) for o in payload.get("obligations", []))
    tr = tuple(RuleTrace(**t) for t in payload.get("trace", []))

    d = Decision(
        decision=payload["decision"],
        reason=payload["reason"],
        obligations=_norm_obligations(obs),
        trace=_norm_trace(tr),
        decision_hash=payload.get("decision_hash", ""),
    )

    # verify hash
    recomputed = make_decision(d.decision, d.reason, d.obligations, d.trace)
    if d.decision_hash and d.decision_hash != recomputed.decision_hash:
        raise RuntimeError("decision_hash_mismatch")

    return recomputed


# ---------------------------------------------------------------------------
# VERIFICATION
# ---------------------------------------------------------------------------


class DecisionVerifier:
    """
    Cross-checks decisions against expectations.
    """

    @staticmethod
    def assert_allowed(decision: Decision) -> None:
        if decision.decision == "deny":
            raise RuntimeError(f"denied:{decision.reason}")

    @staticmethod
    def assert_denied(decision: Decision) -> None:
        if decision.decision != "deny":
            raise RuntimeError("expected_denied")

    @staticmethod
    def assert_obligation(decision: Decision, key: str) -> None:
        obs = ObligationSet(decision.obligations)
        obs.require(key)


# ---------------------------------------------------------------------------
# FACADE
# ---------------------------------------------------------------------------


def merge_decisions(*decisions: Decision) -> Decision:
    return DecisionAlgebra.merge(decisions)


def require_obligation(decision: Decision, key: str) -> List[Any]:
    return ObligationSet(decision.obligations).require(key)


def is_equivalent(a: Decision, b: Decision) -> bool:
    return DecisionAlgebra.equivalent(a, b)
