from __future__ import annotations
from dataclasses import dataclass
from enum import Enum
from typing import Any, Dict, Optional

class DecisionKind(str, Enum):
    ALLOW = "allow"
    DENY = "deny"

@dataclass(frozen=True)
class Decision:
    kind: DecisionKind
    reason: str
    policy_ref: Optional[str] = None
    meta: Optional[Dict[str, Any]] = None

    @property
    def ok(self) -> bool:
        return self.kind == DecisionKind.ALLOW

def allow(reason: str = "allowed", *, policy_ref: Optional[str] = None, meta: Optional[Dict[str, Any]] = None) -> Decision:
    return Decision(kind=DecisionKind.ALLOW, reason=reason, policy_ref=policy_ref, meta=meta)

def deny(reason: str, *, policy_ref: Optional[str] = None, meta: Optional[Dict[str, Any]] = None) -> Decision:
    return Decision(kind=DecisionKind.DENY, reason=reason, policy_ref=policy_ref, meta=meta)
