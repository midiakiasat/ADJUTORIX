from __future__ import annotations

from dataclasses import dataclass
from typing import Dict, Tuple, Literal

AdjutorixState = Literal[
    "IDLE",
    "PROMPTED",
    "PLANNED",
    "PATCHED",
    "REVIEWED",
    "APPLIED",
    "RUNNING",
    "RESULT",
    "FAILED",
]

AdjutorixEvent = Literal[
    "PROMPT",
    "PLAN_OK",
    "PLAN_FAIL",
    "PATCH_OK",
    "PATCH_FAIL",
    "REVIEW_ACCEPT",
    "REVIEW_REJECT",
    "APPLY_OK",
    "APPLY_FAIL",
    "RUN_START",
    "RUN_OK",
    "RUN_FAIL",
    "RESET",
]

TRANSITIONS: Dict[Tuple[AdjutorixState, AdjutorixEvent], AdjutorixState] = {
    ("IDLE", "PROMPT"): "PROMPTED",

    ("PROMPTED", "PLAN_OK"): "PLANNED",
    ("PROMPTED", "PLAN_FAIL"): "FAILED",

    ("PLANNED", "PATCH_OK"): "PATCHED",
    ("PLANNED", "PATCH_FAIL"): "FAILED",

    ("PATCHED", "REVIEW_ACCEPT"): "REVIEWED",
    ("PATCHED", "REVIEW_REJECT"): "PLANNED",

    ("REVIEWED", "APPLY_OK"): "APPLIED",
    ("REVIEWED", "APPLY_FAIL"): "FAILED",

    ("APPLIED", "RUN_START"): "RUNNING",

    ("RUNNING", "RUN_OK"): "RESULT",
    ("RUNNING", "RUN_FAIL"): "FAILED",

    ("RESULT", "RESET"): "IDLE",
    ("FAILED", "RESET"): "IDLE",
}


class InvalidTransition(RuntimeError):
    def __init__(self, state: AdjutorixState, event: AdjutorixEvent) -> None:
        super().__init__(f"Invalid transition: {state} --{event}--> ?")
        self.state = state
        self.event = event


@dataclass
class MachineSnapshot:
    state: AdjutorixState


class StateMachine:
    def __init__(self, initial: AdjutorixState = "IDLE") -> None:
        self._state: AdjutorixState = initial

    @property
    def state(self) -> AdjutorixState:
        return self._state

    def dispatch(self, event: AdjutorixEvent) -> AdjutorixState:
        key = (self._state, event)
        nxt = TRANSITIONS.get(key)
        if nxt is None:
            raise InvalidTransition(self._state, event)
        self._state = nxt
        return self._state

    def snapshot(self) -> MachineSnapshot:
        return MachineSnapshot(state=self._state)

    def restore(self, snap: MachineSnapshot) -> None:
        self._state = snap.state
