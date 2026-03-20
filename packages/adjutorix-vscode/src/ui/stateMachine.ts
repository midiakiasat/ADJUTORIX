import type { AdjutorixEvent, AdjutorixState } from "../../../shared/src/state/transitions";
import { StateMachine } from "../../../shared/src/state/machine";

/**
 * UI wrapper around the shared state machine.
 * Keep UI logic here if you need telemetry, logging, or VS Code storage hooks later.
 */
export class UiStateMachine {
  private readonly m: StateMachine;

  constructor(initial: AdjutorixState = "IDLE") {
    this.m = new StateMachine(initial);
  }

  get state(): AdjutorixState {
    return this.m.state;
  }

  dispatch(event: AdjutorixEvent): AdjutorixState {
    return this.m.dispatch(event);
  }

  snapshot(): { state: AdjutorixState } {
    return this.m.snapshot();
  }

  restore(snapshot: { state: AdjutorixState }): void {
    this.m.restore(snapshot);
  }
}
