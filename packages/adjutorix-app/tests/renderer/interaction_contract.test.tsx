import { describe, expect, it } from "vitest";
import {
  assertEnabledControlHasVisibleContract,
  createInitialInteractionContractState,
  recordInteraction,
} from "../../src/renderer/lib/interaction_contract";

describe("interaction contract", () => {
  it("records visible control transitions", () => {
    const state = createInitialInteractionContractState();
    const next = recordInteraction(state, "diagnostics", "Diagnostics surface selected");

    expect(next.selectedView).toBe("diagnostics");
    expect(next.lastInteraction?.id).toBe("diagnostics");
    expect(next.lastInteraction?.detail).toContain("Diagnostics");
  });

  it("rejects enabled controls without actions", () => {
    expect(
      assertEnabledControlHasVisibleContract({
        label: "Dead button",
        disabled: false,
        hasAction: false,
      }),
    ).toBe(false);
  });

  it("allows disabled controls only with visible reason", () => {
    expect(
      assertEnabledControlHasVisibleContract({
        label: "Open workspace",
        disabled: true,
        hasAction: false,
        disabledReason: "Workspace bridge unavailable",
      }),
    ).toBe(true);
  });
});
