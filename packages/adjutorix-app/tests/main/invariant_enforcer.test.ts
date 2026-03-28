import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / invariant_enforcer.test.ts
 *
 * Canonical invariant-enforcer contract suite.
 *
 * Purpose:
 * - verify that main-process invariant enforcement preserves non-negotiable product guarantees
 *   before consequential actions are allowed to proceed
 * - verify that forbidden transitions are rejected with explicit structured reasons rather than
 *   silently downgraded into warnings
 * - verify that approval, verify, apply, replay, mutation, trust, and visibility gates remain
 *   coherent under partial, degraded, or conflicting state
 * - verify that the enforcer is deterministic: identical context yields identical verdicts
 *
 * Test philosophy:
 * - no snapshots
 * - assert enforcement semantics, rejection surfaces, and boundary cases directly
 * - prefer failure modes and counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes invariant_enforcer exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  enforceInvariantSet,
  evaluateInvariantSet,
  assertInvariantSet,
  type InvariantContext,
  type InvariantEvaluation,
  type InvariantViolation,
} from "../../../src/main/governance/invariant_enforcer";

function context(overrides: Partial<InvariantContext> = {}): InvariantContext {
  return {
    action: "apply-patch",
    actor: {
      kind: "user",
      id: "operator-1",
      trustLevel: "trusted",
    },
    workspace: {
      workspaceId: "ws-1",
      rootPath: "/repo/adjutorix-app",
      isOpen: true,
      trustLevel: "trusted",
      health: "healthy",
    },
    review: {
      patchId: "patch-42",
      status: "approved",
      applyReadiness: "ready",
      selectedFileCount: 3,
      rejectedFileCount: 0,
      unresolvedCommentCount: 0,
    },
    verify: {
      verifyId: "verify-42",
      status: "passed",
      replayStatus: "passed",
      applyGate: "open",
      blockingFailureCount: 0,
    },
    mutation: {
      requested: true,
      previewOnly: false,
      hasExplicitUserIntent: true,
      hasVisibleDiff: true,
      hasStructuredArtifacts: true,
    },
    visibility: {
      actionIsVisible: true,
      evidenceIsVisible: true,
      authorityIsVisible: true,
      consequencesAreVisible: true,
    },
    replay: {
      replayable: true,
      lineageComplete: true,
      ledgerContinuity: "intact",
    },
    authority: {
      mayReview: true,
      mayVerify: true,
      mayApply: true,
      mayOverride: false,
    },
    environment: {
      degraded: false,
      offline: false,
      shellRestricted: true,
    },
    ...overrides,
  } as InvariantContext;
}

function violationCodes(result: InvariantEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("invariant_enforcer", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("permits a fully visible, verified, approved, replay-safe apply context", () => {
    const result = evaluateInvariantSet(context());

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.severity).toBe("none");
  });

  it("rejects invisible consequential mutation even when all other gates are green", () => {
    const result = evaluateInvariantSet(
      context({
        mutation: {
          ...context().mutation,
          requested: true,
        },
        visibility: {
          ...context().visibility,
          actionIsVisible: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("NO_INVISIBLE_ACTION");
  });

  it("rejects unverifiable apply when evidence is missing despite explicit intent", () => {
    const result = evaluateInvariantSet(
      context({
        mutation: {
          ...context().mutation,
          hasStructuredArtifacts: false,
          hasVisibleDiff: false,
        },
        visibility: {
          ...context().visibility,
          evidenceIsVisible: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("NO_UNVERIFIABLE_CLAIM");
  });

  it("rejects ambiguous state when review, verify, and apply readiness disagree", () => {
    const result = evaluateInvariantSet(
      context({
        review: {
          ...context().review,
          status: "approved",
          applyReadiness: "blocked",
        },
        verify: {
          ...context().verify,
          status: "passed",
          applyGate: "open",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("NO_AMBIGUOUS_STATE");
  });

  it("rejects hidden authority when apply capability is used without visible authority context", () => {
    const result = evaluateInvariantSet(
      context({
        visibility: {
          ...context().visibility,
          authorityIsVisible: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("NO_HIDDEN_AUTHORITY");
  });

  it("rejects apply when review still has rejected files even if verify passed", () => {
    const result = evaluateInvariantSet(
      context({
        review: {
          ...context().review,
          rejectedFileCount: 1,
          status: "rejected",
          applyReadiness: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("REVIEW_BLOCKED");
  });

  it("rejects apply when unresolved review comments remain on an otherwise approved patch", () => {
    const result = evaluateInvariantSet(
      context({
        review: {
          ...context().review,
          unresolvedCommentCount: 2,
          applyReadiness: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("UNRESOLVED_REVIEW_STATE");
  });

  it("rejects apply when verify has blocking failures even if status text is misleadingly passed", () => {
    const result = evaluateInvariantSet(
      context({
        verify: {
          ...context().verify,
          status: "passed",
          blockingFailureCount: 2,
          applyGate: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("VERIFY_BLOCKED");
  });

  it("rejects apply when replay is not safe even if review and verify superficially look ready", () => {
    const result = evaluateInvariantSet(
      context({
        replay: {
          replayable: false,
          lineageComplete: false,
          ledgerContinuity: "broken",
        },
        verify: {
          ...context().verify,
          replayStatus: "failed",
          applyGate: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("REPLAY_UNSAFE");
    expect(violationCodes(result)).toContain("LEDGER_CONTINUITY_BROKEN");
  });

  it("rejects mutation when explicit user intent is absent even if the action is visible", () => {
    const result = evaluateInvariantSet(
      context({
        mutation: {
          ...context().mutation,
          hasExplicitUserIntent: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("MISSING_EXPLICIT_INTENT");
  });

  it("permits preview-only non-mutating flows under blocked apply conditions because the limiting case removes consequence", () => {
    const result = evaluateInvariantSet(
      context({
        action: "preview-patch",
        mutation: {
          requested: false,
          previewOnly: true,
          hasExplicitUserIntent: true,
          hasVisibleDiff: true,
          hasStructuredArtifacts: true,
        },
        authority: {
          ...context().authority,
          mayApply: false,
        },
        review: {
          ...context().review,
          status: "rejected",
          applyReadiness: "blocked",
          rejectedFileCount: 2,
        },
        verify: {
          ...context().verify,
          status: "failed",
          replayStatus: "failed",
          applyGate: "blocked",
          blockingFailureCount: 3,
        },
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects apply when actor lacks apply authority even if every technical gate is open", () => {
    const result = evaluateInvariantSet(
      context({
        authority: {
          ...context().authority,
          mayApply: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("AUTHORITY_DENIED");
  });

  it("rejects trust-sensitive operations from untrusted actors in untrusted workspaces", () => {
    const result = evaluateInvariantSet(
      context({
        actor: {
          ...context().actor,
          trustLevel: "untrusted",
        },
        workspace: {
          ...context().workspace,
          trustLevel: "untrusted",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("TRUST_DENIED");
  });

  it("rejects apply in degraded environments when consequences cannot be trusted to remain explicit", () => {
    const result = evaluateInvariantSet(
      context({
        environment: {
          degraded: true,
          offline: false,
          shellRestricted: true,
        },
        workspace: {
          ...context().workspace,
          health: "degraded",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("ENVIRONMENT_DEGRADED");
  });

  it("rejects offline apply when verification evidence depends on live unavailable context", () => {
    const result = evaluateInvariantSet(
      context({
        environment: {
          degraded: false,
          offline: true,
          shellRestricted: true,
        },
        verify: {
          ...context().verify,
          status: "partial",
          applyGate: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("OFFLINE_EVIDENCE_INSUFFICIENT");
  });

  it("returns deterministic identical verdicts for identical inputs", () => {
    const a = evaluateInvariantSet(context());
    const b = evaluateInvariantSet(context());

    expect(b).toEqual(a);
  });

  it("escalates overall severity to fatal when core invariants fail together", () => {
    const result = evaluateInvariantSet(
      context({
        mutation: {
          ...context().mutation,
          hasExplicitUserIntent: false,
          hasStructuredArtifacts: false,
          hasVisibleDiff: false,
        },
        visibility: {
          actionIsVisible: false,
          evidenceIsVisible: false,
          authorityIsVisible: false,
          consequencesAreVisible: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.severity).toBe("fatal");
  });

  it("enforceInvariantSet returns structured rejection instead of throwing on normal policy failure", () => {
    const result = enforceInvariantSet(
      context({
        review: {
          ...context().review,
          rejectedFileCount: 1,
          status: "rejected",
          applyReadiness: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("assertInvariantSet throws on rejected contexts with explicit violation codes", () => {
    expect(() =>
      assertInvariantSet(
        context({
          verify: {
            ...context().verify,
            blockingFailureCount: 1,
            applyGate: "blocked",
          },
        }),
      ),
    ).toThrow();
  });

  it("assertInvariantSet does not throw on a fully valid context", () => {
    expect(() => assertInvariantSet(context())).not.toThrow();
  });

  it("preserves all violation entries instead of stopping at the first failure, because compound collapse matters", () => {
    const result = evaluateInvariantSet(
      context({
        review: {
          ...context().review,
          rejectedFileCount: 2,
          unresolvedCommentCount: 3,
          status: "rejected",
          applyReadiness: "blocked",
        },
        verify: {
          ...context().verify,
          status: "failed",
          replayStatus: "failed",
          applyGate: "blocked",
          blockingFailureCount: 2,
        },
        replay: {
          replayable: false,
          lineageComplete: false,
          ledgerContinuity: "broken",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(4);
  });

  it("treats no requested mutation as a narrower case than apply, avoiding false blocking for pure inspection", () => {
    const result = evaluateInvariantSet(
      context({
        action: "inspect-ledger",
        mutation: {
          requested: false,
          previewOnly: true,
          hasExplicitUserIntent: true,
          hasVisibleDiff: true,
          hasStructuredArtifacts: true,
        },
        authority: {
          ...context().authority,
          mayApply: false,
        },
        review: {
          ...context().review,
          status: "rejected",
          applyReadiness: "blocked",
        },
        verify: {
          ...context().verify,
          status: "failed",
          replayStatus: "failed",
          applyGate: "blocked",
        },
      }),
    );

    expect(result.allowed).toBe(true);
  });

  it("rejects consequence-hidden operations when consequencesAreVisible is false even if action surface itself is visible", () => {
    const result = evaluateInvariantSet(
      context({
        visibility: {
          ...context().visibility,
          consequencesAreVisible: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(violationCodes(result)).toContain("HIDDEN_CONSEQUENCE");
  });
});
