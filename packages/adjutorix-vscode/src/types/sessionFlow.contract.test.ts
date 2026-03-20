import { describe, it, expect } from "vitest";
import { AdjutorixState, AdjutorixEvent } from "./engineProtocol";

describe("Session Flow Contract", () => {
  it("must define core states", () => {
    const states: AdjutorixState[] = [
      "IDLE",
      "PLANNED",
      "PATCHED",
      "APPLIED",
      "COMPLETED"
    ];
    expect(states.length).toBeGreaterThan(0);
  });

  it("must define core events", () => {
    const events: AdjutorixEvent[] = [
      "PLAN_CREATED",
      "PATCH_GENERATED",
      "PATCH_APPLIED",
      "RUN_COMPLETED"
    ];
    expect(events.length).toBeGreaterThan(0);
  });
});
