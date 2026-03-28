import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / apply_gate.test.ts
 *
 * Canonical apply-gate contract suite.
 *
 * Purpose:
 * - verify that main-process apply gating preserves one authoritative authorization surface
 *   for consequential patch application across review state, verify evidence, replay posture,
 *   ledger continuity, workspace trust, workspace health, renderer visibility, and actor authority
 * - verify that no combination of partially-green subsystem states can widen into apply permission
 *   when any blocking invariant remains unsatisfied
 * - verify that identical inputs yield identical allow/deny outcomes, violation sets,
 *   and consequence annotations
 *
 * Test philosophy:
 * - no snapshots
 * - assert gating semantics, blocking reasons, monotonicity, and limiting cases directly
 * - prefer compound-failure counterexamples over happy-path-only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/apply_gate exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  evaluateApplyGate,
  enforceApplyGate,
  assertApplyGate,
  summarizeApplyGate,
  type ApplyGateContext,
  type ApplyGateEvaluation,
} from "../../../src/main/governance/apply_gate";

function ctx(overrides: Partial<ApplyGateContext> = {}): ApplyGateContext {
  return {
    action: "apply",
    actor: {
      kind: "user",
      id: "operator-1",
      trustLevel: "trusted",
    },
    authority: {
      mayApply: true,
      mayOverride: false,
      mayReview: true,
      mayVerify: true,
    },
    intent: {
      explicitUserIntent: true,
      visibleDiff: true,
      structuredArtifactsVisible: true,
      consequencesVisible: true,
      authorityVisible: true,
    },
    patch: {
      patchId: "patch-42",
      status: "in-review",
      selectedFileCount: 2,
      rejectedFileCount: 0,
      unresolvedCommentCount: 0,
      applyReadiness: "ready",
    },
    review: {
      approved: true,
      finalDisposition: "approved",
      blockingComments: 0,
      rejectedFiles: 0,
      unresolvedThreads: 0,
    },
    verify: {
      verifyId: "verify-42",
      status: "passed",
      blockingFailureCount: 0,
      replayStatus: "passed",
      applyImpact: "ready",
      evidenceFresh: true,
    },
    replay: {
      replayable: true,
      lineageComplete: true,
      deterministic: true,
    },
    ledger: {
      ledgerId: "ledger-42",
      continuity: "intact",
      headConsistent: true,
      selectedEntryReplayable: true,
    },
    workspaceTrust: {
      level: "trusted",
      allowsMutation: true,
    },
    workspaceHealth: {
      level: "healthy",
      actionAllowed: true,
      reasons: [],
    },
    environment: {
      degraded: false,
      offline: false,
      readonlyMedia: false,
    },
    policy: {
      allowOverride: false,
      requirePassedVerify: true,
      requireReplayableLedger: true,
      requireTrustedWorkspace: true,
      requireHealthyWorkspaceForApply: true,
      requireVisibleConsequences: true,
    },
    ...overrides,
  } as ApplyGateContext;
}

function codes(result: ApplyGateEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("apply_gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateApplyGate", () => {
    it("permits apply only when review, verify, replay, ledger, trust, health, authority, and visibility are all satisfied", () => {
      const result = evaluateApplyGate(ctx());

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
      expect(result.severity).toBe("none");
    });

    it("rejects apply when explicit user intent is missing even if every technical gate is green", () => {
      const result = evaluateApplyGate(
        ctx({
          intent: {
            ...ctx().intent,
            explicitUserIntent: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("EXPLICIT_INTENT_REQUIRED");
    });

    it("rejects apply when visible diff evidence is missing because consequential mutation cannot be hidden", () => {
      const result = evaluateApplyGate(
        ctx({
          intent: {
            ...ctx().intent,
            visibleDiff: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("VISIBLE_DIFF_REQUIRED");
    });

    it("rejects apply when authority or consequence visibility is missing even if authority technically exists", () => {
      const result = evaluateApplyGate(
        ctx({
          intent: {
            ...ctx().intent,
            consequencesVisible: false,
            authorityVisible: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("VISIBLE_CONSEQUENCE_REQUIRED");
      expect(codes(result)).toContain("VISIBLE_AUTHORITY_REQUIRED");
    });

    it("rejects apply when actor lacks apply authority even if all substantive readiness checks pass", () => {
      const result = evaluateApplyGate(
        ctx({
          authority: {
            ...ctx().authority,
            mayApply: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("APPLY_AUTHORITY_DENIED");
    });

    it("rejects apply when review is not approved even if verify passed", () => {
      const result = evaluateApplyGate(
        ctx({
          review: {
            ...ctx().review,
            approved: false,
            finalDisposition: "rejected",
            rejectedFiles: 1,
          },
          patch: {
            ...ctx().patch,
            rejectedFileCount: 1,
            applyReadiness: "blocked",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("REVIEW_NOT_APPROVED");
      expect(codes(result)).toContain("REJECTED_FILES_PRESENT");
    });

    it("rejects apply when unresolved review threads remain on an otherwise approved patch", () => {
      const result = evaluateApplyGate(
        ctx({
          review: {
            ...ctx().review,
            unresolvedThreads: 2,
            blockingComments: 1,
          },
          patch: {
            ...ctx().patch,
            unresolvedCommentCount: 2,
            applyReadiness: "blocked",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("UNRESOLVED_REVIEW_THREADS");
      expect(codes(result)).toContain("BLOCKING_REVIEW_COMMENTS");
    });

    it("rejects apply when verify has blocking failures even if patch review is approved", () => {
      const result = evaluateApplyGate(
        ctx({
          verify: {
            ...ctx().verify,
            status: "failed",
            blockingFailureCount: 2,
            applyImpact: "blocked",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("VERIFY_NOT_PASSED");
      expect(codes(result)).toContain("VERIFY_BLOCKING_FAILURES_PRESENT");
    });

    it("rejects apply when verify evidence is stale because fresh consequences cannot rely on stale proof", () => {
      const result = evaluateApplyGate(
        ctx({
          verify: {
            ...ctx().verify,
            evidenceFresh: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("VERIFY_EVIDENCE_STALE");
    });

    it("rejects apply when replay status failed even if verify status text is superficially passed", () => {
      const result = evaluateApplyGate(
        ctx({
          verify: {
            ...ctx().verify,
            status: "passed",
            replayStatus: "failed",
            applyImpact: "blocked",
          },
          replay: {
            ...ctx().replay,
            replayable: false,
            deterministic: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("REPLAY_NOT_PASSED");
      expect(codes(result)).toContain("REPLAY_NOT_REPLAYABLE");
    });

    it("rejects apply when replay lineage is incomplete even if the current verify run passed", () => {
      const result = evaluateApplyGate(
        ctx({
          replay: {
            ...ctx().replay,
            lineageComplete: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("REPLAY_LINEAGE_INCOMPLETE");
    });

    it("rejects apply when ledger continuity is broken because rollback/replay semantics are no longer trustworthy", () => {
      const result = evaluateApplyGate(
        ctx({
          ledger: {
            ...ctx().ledger,
            continuity: "broken",
            headConsistent: false,
            selectedEntryReplayable: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("LEDGER_CONTINUITY_BROKEN");
      expect(codes(result)).toContain("LEDGER_HEAD_INCONSISTENT");
      expect(codes(result)).toContain("LEDGER_ENTRY_NOT_REPLAYABLE");
    });

    it("rejects apply when workspace trust does not allow mutation", () => {
      const result = evaluateApplyGate(
        ctx({
          workspaceTrust: {
            level: "untrusted",
            allowsMutation: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("WORKSPACE_MUTATION_NOT_TRUSTED");
    });

    it("rejects apply when workspace health is degraded and policy requires healthy workspace for apply", () => {
      const result = evaluateApplyGate(
        ctx({
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("WORKSPACE_HEALTH_BLOCKS_APPLY");
    });

    it("rejects apply in degraded environment even when local subsystem state appears green", () => {
      const result = evaluateApplyGate(
        ctx({
          environment: {
            degraded: true,
            offline: false,
            readonlyMedia: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("ENVIRONMENT_DEGRADED_FOR_APPLY");
    });

    it("rejects apply on readonly media because irreversible mutation is structurally impossible", () => {
      const result = evaluateApplyGate(
        ctx({
          environment: {
            degraded: false,
            offline: false,
            readonlyMedia: true,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("READONLY_MEDIA_APPLY_DENIED");
    });

    it("does not let override capability widen into apply authorization when policy forbids override", () => {
      const result = evaluateApplyGate(
        ctx({
          authority: {
            ...ctx().authority,
            mayApply: false,
            mayOverride: true,
          },
          policy: {
            ...ctx().policy,
            allowOverride: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("APPLY_AUTHORITY_DENIED");
    });

    it("allows override only when actor mayOverride and policy explicitly allows override, but still not past core replay/ledger failures", () => {
      const result = evaluateApplyGate(
        ctx({
          authority: {
            ...ctx().authority,
            mayApply: false,
            mayOverride: true,
          },
          policy: {
            ...ctx().policy,
            allowOverride: true,
          },
          ledger: {
            ...ctx().ledger,
            continuity: "broken",
            headConsistent: false,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("LEDGER_CONTINUITY_BROKEN");
    });

    it("treats preview as the limiting case and does not block it with apply-only denials when no mutation occurs", () => {
      const result = evaluateApplyGate(
        ctx({
          action: "preview",
          authority: {
            ...ctx().authority,
            mayApply: false,
          },
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
          environment: {
            degraded: true,
            offline: false,
            readonlyMedia: true,
          },
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.violations).toEqual([]);
    });

    it("preserves all blocking reasons instead of stopping at the first deny cause because compound failure matters", () => {
      const result = evaluateApplyGate(
        ctx({
          authority: {
            ...ctx().authority,
            mayApply: false,
          },
          intent: {
            ...ctx().intent,
            explicitUserIntent: false,
            visibleDiff: false,
            consequencesVisible: false,
          },
          review: {
            ...ctx().review,
            approved: false,
            finalDisposition: "rejected",
            rejectedFiles: 2,
            unresolvedThreads: 3,
            blockingComments: 2,
          },
          patch: {
            ...ctx().patch,
            rejectedFileCount: 2,
            unresolvedCommentCount: 3,
            applyReadiness: "blocked",
          },
          verify: {
            ...ctx().verify,
            status: "failed",
            blockingFailureCount: 2,
            replayStatus: "failed",
            evidenceFresh: false,
            applyImpact: "blocked",
          },
          replay: {
            replayable: false,
            lineageComplete: false,
            deterministic: false,
          },
          ledger: {
            ...ctx().ledger,
            continuity: "broken",
            headConsistent: false,
            selectedEntryReplayable: false,
          },
          workspaceTrust: {
            level: "untrusted",
            allowsMutation: false,
          },
          workspaceHealth: {
            level: "degraded",
            actionAllowed: false,
            reasons: ["watcher lag high"],
          },
          environment: {
            degraded: true,
            offline: true,
            readonlyMedia: true,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(8);
      expect(result.severity).toBe("fatal");
    });

    it("returns deterministic identical evaluations for identical apply-gate inputs", () => {
      const a = evaluateApplyGate(ctx());
      const b = evaluateApplyGate(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeApplyGate", () => {
    it("compresses apply-gate evaluation while preserving allow state and blocking reason count", () => {
      const evaluation = evaluateApplyGate(
        ctx({
          verify: {
            ...ctx().verify,
            evidenceFresh: false,
          },
        }),
      );

      const summary = summarizeApplyGate(evaluation);

      expect(summary.allowed).toBe(false);
      expect(summary.reasonCount).toBeGreaterThan(0);
      expect(summary.severity).not.toBe("none");
    });
  });

  describe("enforceApplyGate", () => {
    it("returns structured denial instead of throwing on ordinary gate failure", () => {
      const result = enforceApplyGate(
        ctx({
          review: {
            ...ctx().review,
            approved: false,
            finalDisposition: "rejected",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });
  });

  describe("assertApplyGate", () => {
    it("does not throw for a fully valid apply context", () => {
      expect(() => assertApplyGate(ctx())).not.toThrow();
    });

    it("throws for denied apply contexts with explicit gate-failure semantics", () => {
      expect(() =>
        assertApplyGate(
          ctx({
            ledger: {
              ...ctx().ledger,
              continuity: "broken",
            },
          }),
        ),
      ).toThrow();
    });
  });
});
