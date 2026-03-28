import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / governed_surface.test.ts
 *
 * Canonical governed-surface contract suite.
 *
 * Purpose:
 * - verify that the main-process governed surface composes renderer policy, invariant enforcement,
 *   workspace trust, workspace health, apply gating, and IPC capability rules into one authoritative
 *   allow/deny surface for consequential actions
 * - verify that no local subsystem can authorize an action that the aggregate surface must still deny
 * - verify that governance output remains deterministic, explicit, and evidence-carrying across
 *   inspect, preview, send, verify, review, and apply flows
 *
 * Test philosophy:
 * - no snapshots
 * - assert composition semantics, cross-gate monotonicity, and limiting cases directly
 * - prefer compound counterexamples over isolated happy paths
 *
 * Notes:
 * - this suite assumes src/main/governance/governed_surface exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  evaluateGovernedSurface,
  enforceGovernedSurface,
  assertGovernedSurface,
  summarizeGovernedSurface,
  type GovernedSurfaceContext,
  type GovernedSurfaceEvaluation,
} from "../../../src/main/governance/governed_surface";

function ctx(overrides: Partial<GovernedSurfaceContext> = {}): GovernedSurfaceContext {
  return {
    action: "inspect",
    actor: {
      kind: "user",
      id: "operator-1",
      trustLevel: "trusted",
    },
    visibility: {
      actionVisible: true,
      consequencesVisible: true,
      authorityVisible: true,
      evidenceVisible: true,
    },
    authority: {
      mayRead: true,
      mayReview: true,
      mayVerify: true,
      mayApply: true,
      mayOverride: false,
    },
    rendererPolicy: {
      allowed: true,
      violations: [],
      severity: "none",
    },
    invariants: {
      allowed: true,
      violations: [],
      severity: "none",
    },
    workspaceTrust: {
      allowed: true,
      trustLevel: "trusted",
      violations: [],
    },
    workspaceHealth: {
      level: "healthy",
      actionAllowed: true,
      reasons: [],
    },
    applyGate: {
      allowed: true,
      violations: [],
      severity: "none",
    },
    environment: {
      degraded: false,
      offline: false,
      readonlyMedia: false,
    },
    policy: {
      requireVisibleAuthority: true,
      requireVisibleEvidence: true,
      requireTrustedWorkspaceForMutation: true,
      requireHealthyWorkspaceForMutation: true,
      requireInvariantPassForAllActionsAboveInspect: true,
    },
    ...overrides,
  } as GovernedSurfaceContext;
}

function codes(result: GovernedSurfaceEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("governed_surface", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateGovernedSurface", () => {
    it("permits low-consequence inspection when all composing governance layers agree", () => {
      const result = evaluateGovernedSurface(ctx());

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.severity).toBe("none");
    });

    it("denies when renderer policy denies even if every other governance layer is green", () => {
      const result = evaluateGovernedSurface(
        ctx({
          rendererPolicy: {
            allowed: false,
            violations: [{ code: "UNKNOWN_CHANNEL" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("RENDERER_POLICY_DENIED");
    });

    it("denies when invariant enforcement denies even if transport and workspace are healthy", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "verify",
          invariants: {
            allowed: false,
            violations: [{ code: "NO_UNVERIFIABLE_CLAIM" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("INVARIANT_SURFACE_DENIED");
    });

    it("denies mutation when workspace trust is not trusted even if renderer policy and invariants pass", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "apply",
          workspaceTrust: {
            allowed: false,
            trustLevel: "untrusted",
            violations: [{ code: "MUTATION_REQUIRES_TRUST" }],
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("WORKSPACE_TRUST_DENIED");
    });

    it("denies mutation when workspace health blocks the action even if trust and invariants are satisfied", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "apply",
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("WORKSPACE_HEALTH_DENIED");
    });

    it("denies apply when apply gate denies even if broader governed-surface inputs look permissive", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "apply",
          applyGate: {
            allowed: false,
            violations: [{ code: "VERIFY_NOT_PASSED" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("APPLY_GATE_DENIED");
    });

    it("denies verify/send/apply actions when authority visibility is missing and policy requires it", () => {
      const verify = evaluateGovernedSurface(
        ctx({
          action: "verify",
          visibility: {
            ...ctx().visibility,
            authorityVisible: false,
          },
        }),
      );

      const send = evaluateGovernedSurface(
        ctx({
          action: "send",
          visibility: {
            ...ctx().visibility,
            authorityVisible: false,
          },
        }),
      );

      expect(verify.allowed).toBe(false);
      expect(send.allowed).toBe(false);
      expect(codes(verify)).toContain("VISIBLE_AUTHORITY_REQUIRED");
      expect(codes(send)).toContain("VISIBLE_AUTHORITY_REQUIRED");
    });

    it("denies verify/apply actions when evidence visibility is missing and policy requires it", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "verify",
          visibility: {
            ...ctx().visibility,
            evidenceVisible: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("VISIBLE_EVIDENCE_REQUIRED");
    });

    it("permits preview as the limiting case when mutation gates fail but no irreversible action is requested", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "preview",
          authority: {
            ...ctx().authority,
            mayApply: false,
          },
          workspaceTrust: {
            allowed: false,
            trustLevel: "untrusted-readonly",
            violations: [{ code: "MUTATION_REQUIRES_TRUST" }],
          },
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
          applyGate: {
            allowed: false,
            violations: [{ code: "VERIFY_NOT_PASSED" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("does not let inspect inherit apply-only denials when no mutation or verify consequence is requested", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "inspect",
          applyGate: {
            allowed: false,
            violations: [{ code: "LEDGER_CONTINUITY_BROKEN" }],
            severity: "fatal",
          },
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
        }),
      );

      expect(result.allowed).toBe(true);
    });

    it("blocks send on unhealthy governed surface when invariants or renderer policy fail", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "send",
          rendererPolicy: {
            allowed: false,
            violations: [{ code: "SHELL_AUTHORITY_DENIED" }],
            severity: "fatal",
          },
          invariants: {
            allowed: false,
            violations: [{ code: "NO_HIDDEN_AUTHORITY" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("RENDERER_POLICY_DENIED");
      expect(codes(result)).toContain("INVARIANT_SURFACE_DENIED");
    });

    it("preserves all relevant violations instead of stopping at the first denying layer", () => {
      const result = evaluateGovernedSurface(
        ctx({
          action: "apply",
          visibility: {
            actionVisible: true,
            consequencesVisible: false,
            authorityVisible: false,
            evidenceVisible: false,
          },
          rendererPolicy: {
            allowed: false,
            violations: [{ code: "WRITE_AUTHORITY_DENIED" }],
            severity: "fatal",
          },
          invariants: {
            allowed: false,
            violations: [{ code: "NO_UNVERIFIABLE_CLAIM" }, { code: "NO_HIDDEN_AUTHORITY" }],
            severity: "fatal",
          },
          workspaceTrust: {
            allowed: false,
            trustLevel: "untrusted",
            violations: [{ code: "MUTATION_REQUIRES_TRUST" }],
          },
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
          applyGate: {
            allowed: false,
            violations: [{ code: "VERIFY_NOT_PASSED" }, { code: "LEDGER_CONTINUITY_BROKEN" }],
            severity: "fatal",
          },
          environment: {
            degraded: true,
            offline: true,
            readonlyMedia: true,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(6);
      expect(result.severity).toBe("fatal");
    });

    it("returns deterministic identical evaluations for identical governed-surface inputs", () => {
      const a = evaluateGovernedSurface(ctx());
      const b = evaluateGovernedSurface(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeGovernedSurface", () => {
    it("compresses evaluation while preserving allow/deny and reason-count semantics", () => {
      const evaluation = evaluateGovernedSurface(
        ctx({
          action: "verify",
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["index stale"],
          },
        }),
      );

      const summary = summarizeGovernedSurface(evaluation);

      expect(summary.allowed).toBe(false);
      expect(summary.reasonCount).toBeGreaterThan(0);
      expect(summary.severity).not.toBe("none");
    });
  });

  describe("enforceGovernedSurface", () => {
    it("returns structured denial instead of throwing on ordinary cross-surface rejection", () => {
      const result = enforceGovernedSurface(
        ctx({
          rendererPolicy: {
            allowed: false,
            violations: [{ code: "UNKNOWN_CHANNEL" }],
            severity: "fatal",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe("assertGovernedSurface", () => {
    it("does not throw for a fully valid governed surface context", () => {
      expect(() => assertGovernedSurface(ctx())).not.toThrow();
    });

    it("throws for denied governed surface contexts with explicit aggregate governance failure semantics", () => {
      expect(() =>
        assertGovernedSurface(
          ctx({
            action: "apply",
            applyGate: {
              allowed: false,
              violations: [{ code: "VERIFY_NOT_PASSED" }],
              severity: "fatal",
            },
          }),
        ),
      ).toThrow();
    });
  });
});
