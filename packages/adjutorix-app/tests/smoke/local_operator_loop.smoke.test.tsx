import "@testing-library/jest-dom/vitest";

import fs from "node:fs";
import path from "node:path";
import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import * as CockpitModule from "../../src/renderer/components/LocalOperatorCockpit";

const LocalOperatorCockpit =
  (CockpitModule as { LocalOperatorCockpit?: React.ComponentType; default?: React.ComponentType })
    .LocalOperatorCockpit ??
  (CockpitModule as { default?: React.ComponentType }).default;

function normalizedBodyText(): string {
  return (document.body.textContent ?? "").replace(/\s+/g, " ").trim();
}

function cockpitSourceText(): string {
  return fs.readFileSync(
    path.resolve(process.cwd(), "src/renderer/components/LocalOperatorCockpit.tsx"),
    "utf8",
  );
}

describe("smoke/local_operator_loop", () => {
  afterEach(() => {
    cleanup();
  });

  it("exports and boots the local operator cockpit", async () => {
    expect(LocalOperatorCockpit).toBeTruthy();

    render(<LocalOperatorCockpit />);

    await waitFor(() => {
      const text = normalizedBodyText();
      expect(text).toMatch(/ADJUTORIX Operator Cockpit/i);
      expect(text).toMatch(/Local governed coding control plane/i);
      expect(text).toMatch(/Repository custody/i);
      expect(text).toMatch(/Trust classification/i);
      expect(text).toMatch(/Intent capture/i);
      expect(text).toMatch(/Plan object/i);
      expect(text).toMatch(/Patch object/i);
      expect(text).toMatch(/Verification/i);
      expect(text).toMatch(/Apply/i);
      expect(text).toMatch(/Rollback/i);
      expect(text).toMatch(/Evidence timeline/i);
      expect(text).not.toMatch(/Welcome toy|chat with files|generic editor shell/i);
    });
  });

  it("contains the complete governed object chain as product source truth", () => {
    const source = cockpitSourceText();

    for (const phrase of [
      "ADJUTORIX_INTENT_PLAN_OBJECT",
      "ADJUTORIX_PATCH_CUSTODY_OBJECT",
      "ADJUTORIX_VERIFICATION_GATE_OBJECT",
      "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
      "ADJUTORIX_APPLY_GATE_OBJECT",
      "ADJUTORIX_APPLY_RECEIPT_OBJECT",
      "ADJUTORIX_ROLLBACK_GATE_OBJECT",
      "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
      "ROLLBACK_COMPLETE",
      "operator_loop_complete",
      "createRollbackGateObject",
      "createRollbackReceiptObject",
      "validateRollbackGateObject",
      "validateRollbackReceiptObject",
    ]) {
      expect(source).toContain(phrase);
    }
  });

  it("makes unsafe apply and rollback impossible to enter silently", () => {
    const source = cockpitSourceText();

    expect(source).toContain("apply_requires_verify_pass");
    expect(source).toContain("rollback_requires_apply_receipt");
    expect(source).toContain("may_mutate_files: false");
    expect(source).toContain("may_apply: false");
    expect(source).toContain("may_rollback: false");
    expect(source).toContain("receipt_required: true");
    expect(source).toContain("rollback_unlocked: true");
    expect(source).toContain("terminal_state: \"ROLLBACK_COMPLETE\"");
  });

  it("renders operator controls for custody, plan, patch, verification, apply, rollback, and evidence", async () => {
    render(<LocalOperatorCockpit />);

    await waitFor(() => {
      const text = normalizedBodyText();

      for (const phrase of [
        /repository/i,
        /trust/i,
        /intent/i,
        /plan/i,
        /patch/i,
        /verification|verify/i,
        /apply/i,
        /rollback/i,
        /evidence/i,
        /advanced/i,
      ]) {
        expect(text).toMatch(phrase);
      }

      const buttons = screen.getAllByRole("button");
      expect(buttons.length).toBeGreaterThanOrEqual(5);
    });
  });
});
