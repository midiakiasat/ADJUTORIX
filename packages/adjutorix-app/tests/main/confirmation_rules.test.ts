import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / confirmation_rules.test.ts
 *
 * Canonical confirmation-rules contract suite.
 *
 * Purpose:
 * - verify that main-process confirmation rules preserve one authoritative consent boundary
 *   for mutation, apply, delete, shell execution, trust elevation, external effects,
 *   irreversible operations, and high-consequence overrides
 * - verify that confirmation requirements are driven by actual consequence surface rather than
 *   UI labels or stale prior intent, and that consent cannot silently carry across materially
 *   different actions or targets
 * - verify that identical rule inputs yield identical confirmation requirements, scopes,
 *   and invalidation behavior
 *
 * Test philosophy:
 * - no snapshots
 * - assert consequence semantics, consent scope, and boundary invalidation directly
 * - prefer counterexamples and limiting cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/confirmation_rules exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  evaluateConfirmationRules,
  enforceConfirmationRules,
  assertConfirmationRules,
  summarizeConfirmationRules,
  type ConfirmationRulesContext,
  type ConfirmationRulesEvaluation,
} from "../../../src/main/governance/confirmation_rules";

function ctx(overrides: Partial<ConfirmationRulesContext> = {}): ConfirmationRulesContext {
  return {
    action: "inspect",
    target: {
      kind: "file",
      id: "/repo/adjutorix-app/src/renderer/App.tsx",
      label: "App.tsx",
    },
    consequence: {
      mutatesWorkspace: false,
      deletesData: false,
      appliesPatch: false,
      runsShell: false,
      elevatesTrust: false,
      externalSideEffect: false,
      irreversible: false,
      overridePath: false,
    },
    visibility: {
      actionVisible: true,
      consequencesVisible: true,
      targetVisible: true,
    },
    authority: {
      mayInspect: true,
      mayMutate: true,
      mayApply: true,
      mayRunShell: true,
      mayOverride: false,
      mayElevateTrust: true,
    },
    confirmation: {
      hasFreshConfirmation: false,
      confirmedAction: null,
      confirmedTargetId: null,
      confirmedFingerprint: null,
      confirmedAtMs: null,
      expiresAtMs: null,
    },
    policy: {
      requireConfirmationForMutation: true,
      requireConfirmationForDelete: true,
      requireConfirmationForApply: true,
      requireConfirmationForShell: true,
      requireConfirmationForTrustElevation: true,
      requireConfirmationForExternalEffects: true,
      requireConfirmationForOverride: true,
      confirmationTtlMs: 60_000,
      requireFreshConfirmationOnTargetChange: true,
      requireFreshConfirmationOnFingerprintChange: true,
    },
    fingerprint: "fp-inspect-1",
    nowMs: 1711000100000,
    ...overrides,
  } as ConfirmationRulesContext;
}

function codes(result: ConfirmationRulesEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("confirmation_rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateConfirmationRules", () => {
    it("does not require confirmation for pure inspection when no consequential effect exists", () => {
      const result = evaluateConfirmationRules(ctx());

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
      expect(result.violations).toEqual([]);
    });

    it("requires confirmation for workspace mutation even when the operation is otherwise authorized", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "write-file",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
          },
          fingerprint: "fp-write-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_MUTATION");
    });

    it("requires confirmation for apply because consequence is broader than ordinary mutation", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          fingerprint: "fp-apply-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.requiresConfirmation).toBe(true);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_APPLY");
    });

    it("requires confirmation for delete and irreversible consequences even if mutation confirmation would also apply", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "delete-file",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            deletesData: true,
            irreversible: true,
          },
          fingerprint: "fp-delete-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_DELETE");
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_IRREVERSIBLE_ACTION");
    });

    it("requires confirmation for shell execution because external execution is not equivalent to local preview", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "run-shell",
          target: {
            kind: "command",
            id: "npm test",
            label: "npm test",
          },
          consequence: {
            ...ctx().consequence,
            runsShell: true,
            externalSideEffect: true,
          },
          fingerprint: "fp-shell-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_SHELL");
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_EXTERNAL_EFFECT");
    });

    it("requires confirmation for trust elevation because authority expansion is itself consequential", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "trust-workspace",
          target: {
            kind: "workspace",
            id: "/repo/adjutorix-app",
            label: "adjutorix-app",
          },
          consequence: {
            ...ctx().consequence,
            elevatesTrust: true,
          },
          fingerprint: "fp-trust-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_TRUST_ELEVATION");
    });

    it("requires confirmation for override paths even when normal authority exists, because override is a different consent surface", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply-override",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
            overridePath: true,
          },
          authority: {
            ...ctx().authority,
            mayOverride: true,
          },
          fingerprint: "fp-override-1",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_REQUIRED_FOR_OVERRIDE");
    });

    it("accepts fresh confirmation when action, target, and fingerprint all match within ttl", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          fingerprint: "fp-apply-42",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-42",
            confirmedFingerprint: "fp-apply-42",
            confirmedAtMs: 1711000095000,
            expiresAtMs: 1711000160000,
          },
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it("rejects stale confirmation after ttl expires even if action and target still match", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          fingerprint: "fp-apply-42",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-42",
            confirmedFingerprint: "fp-apply-42",
            confirmedAtMs: 1710990000000,
            expiresAtMs: 1711000000000,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_EXPIRED");
    });

    it("rejects reused confirmation when action changes even if target is the same", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "delete-file",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            deletesData: true,
          },
          target: {
            kind: "file",
            id: "/repo/adjutorix-app/src/renderer/App.tsx",
            label: "App.tsx",
          },
          fingerprint: "fp-delete-app",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "write-file",
            confirmedTargetId: "/repo/adjutorix-app/src/renderer/App.tsx",
            confirmedFingerprint: "fp-delete-app",
            confirmedAtMs: 1711000090000,
            expiresAtMs: 1711000160000,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_ACTION_MISMATCH");
    });

    it("rejects reused confirmation when target changes and policy requires target-bound confirmation", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          target: {
            kind: "patch",
            id: "patch-99",
            label: "patch-99",
          },
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          fingerprint: "fp-apply-99",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-42",
            confirmedFingerprint: "fp-apply-99",
            confirmedAtMs: 1711000090000,
            expiresAtMs: 1711000160000,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_TARGET_MISMATCH");
    });

    it("rejects reused confirmation when consequence fingerprint changes even if action and target stay constant", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          fingerprint: "fp-apply-42-v2",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-42",
            confirmedFingerprint: "fp-apply-42-v1",
            confirmedAtMs: 1711000090000,
            expiresAtMs: 1711000160000,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_FINGERPRINT_MISMATCH");
    });

    it("denies confirmation reuse when consequence visibility is missing because informed consent cannot be inferred", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
            appliesPatch: true,
          },
          visibility: {
            actionVisible: true,
            consequencesVisible: false,
            targetVisible: true,
          },
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          fingerprint: "fp-apply-42",
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-42",
            confirmedFingerprint: "fp-apply-42",
            confirmedAtMs: 1711000090000,
            expiresAtMs: 1711000160000,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("CONFIRMATION_NOT_INFORMED");
    });

    it("treats preview as the limiting case and does not require confirmation when no external or irreversible effect occurs", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "preview",
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          consequence: {
            mutatesWorkspace: false,
            deletesData: false,
            appliesPatch: false,
            runsShell: false,
            elevatesTrust: false,
            externalSideEffect: false,
            irreversible: false,
            overridePath: false,
          },
          fingerprint: "fp-preview-42",
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.requiresConfirmation).toBe(false);
    });

    it("preserves all relevant confirmation violations instead of collapsing to the first one", () => {
      const result = evaluateConfirmationRules(
        ctx({
          action: "apply-override",
          target: {
            kind: "patch",
            id: "patch-42",
            label: "patch-42",
          },
          consequence: {
            mutatesWorkspace: true,
            deletesData: false,
            appliesPatch: true,
            runsShell: false,
            elevatesTrust: false,
            externalSideEffect: true,
            irreversible: true,
            overridePath: true,
          },
          visibility: {
            actionVisible: true,
            consequencesVisible: false,
            targetVisible: false,
          },
          confirmation: {
            hasFreshConfirmation: true,
            confirmedAction: "apply",
            confirmedTargetId: "patch-99",
            confirmedFingerprint: "fp-other",
            confirmedAtMs: 1710990000000,
            expiresAtMs: 1711000000000,
          },
          fingerprint: "fp-override-42",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(5);
    });

    it("returns deterministic identical evaluations for identical confirmation-rule inputs", () => {
      const a = evaluateConfirmationRules(ctx());
      const b = evaluateConfirmationRules(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeConfirmationRules", () => {
    it("compresses evaluation while preserving requires-confirmation and violation count semantics", () => {
      const evaluation = evaluateConfirmationRules(
        ctx({
          action: "write-file",
          consequence: {
            ...ctx().consequence,
            mutatesWorkspace: true,
          },
          fingerprint: "fp-write-2",
        }),
      );

      const summary = summarizeConfirmationRules(evaluation);

      expect(summary.allowed).toBe(false);
      expect(summary.requiresConfirmation).toBe(true);
      expect(summary.reasonCount).toBeGreaterThan(0);
    });
  });

  describe("enforceConfirmationRules", () => {
    it("returns structured denial instead of throwing on ordinary missing-confirmation cases", () => {
      const result = enforceConfirmationRules(
        ctx({
          action: "run-shell",
          target: {
            kind: "command",
            id: "npm test",
            label: "npm test",
          },
          consequence: {
            ...ctx().consequence,
            runsShell: true,
            externalSideEffect: true,
          },
          fingerprint: "fp-shell-2",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe("assertConfirmationRules", () => {
    it("does not throw for a non-consequential inspection context", () => {
      expect(() => assertConfirmationRules(ctx())).not.toThrow();
    });

    it("does not throw for a freshly confirmed consequential action with matching scope", () => {
      expect(() =>
        assertConfirmationRules(
          ctx({
            action: "apply",
            target: {
              kind: "patch",
              id: "patch-42",
              label: "patch-42",
            },
            consequence: {
              ...ctx().consequence,
              mutatesWorkspace: true,
              appliesPatch: true,
            },
            fingerprint: "fp-apply-42",
            confirmation: {
              hasFreshConfirmation: true,
              confirmedAction: "apply",
              confirmedTargetId: "patch-42",
              confirmedFingerprint: "fp-apply-42",
              confirmedAtMs: 1711000095000,
              expiresAtMs: 1711000160000,
            },
          }),
        ),
      ).not.toThrow();
    });

    it("throws for denied consequential contexts with explicit confirmation failure semantics", () => {
      expect(() =>
        assertConfirmationRules(
          ctx({
            action: "delete-file",
            consequence: {
              ...ctx().consequence,
              mutatesWorkspace: true,
              deletesData: true,
              irreversible: true,
            },
            fingerprint: "fp-delete-2",
          }),
        ),
      ).toThrow();
    });
  });
});
