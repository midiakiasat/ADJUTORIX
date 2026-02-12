import { AdjutorixEvent, AdjutorixState, TRANSITIONS } from "./transitions";

export class InvalidTransition extends Error {
  constructor(public readonly from: AdjutorixState, public readonly event: AdjutorixEvent) {
    super(`Invalid transition: ${from} --${event}--> ?`);
    this.name = "InvalidTransition";
  }
}

export function nextState(from: AdjutorixState, event: AdjutorixEvent): AdjutorixState {
  const t = TRANSITIONS.find((x) => x.from === from && x.event === event);
  if (!t) throw new InvalidTransition(from, event);
  return t.to;
}

export type MachineSnapshot = { state: AdjutorixState };

export class StateMachine {
  private _state: AdjutorixState;

  constructor(initial: AdjutorixState = "IDLE") {
    this._state = initial;
  }

  get state(): AdjutorixState {
    return this._state;
  }

  dispatch(event: AdjutorixEvent): AdjutorixState {
    this._state = nextState(this._state, event);
    return this._state;
  }

  snapshot(): MachineSnapshot {
    return { state: this._state };
  }

  restore(snapshot: MachineSnapshot): void {
    this._state = snapshot.state;
  }
}
