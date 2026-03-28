import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / workspace_health.test.ts
 *
 * Canonical workspace-health contract suite.
 *
 * Purpose:
 * - verify that main-process workspace health evaluation preserves one authoritative health surface
 *   across watcher, index, diagnostics, trust, refresh, and environment subsystems
 * - verify that health composition, severity escalation, reason retention, staleness windows,
 *   blocked-action implications, and recovery semantics remain deterministic
 * - verify that degraded or contradictory subsystem signals fail closed instead of allowing
 *   apply/verify/mutation surfaces to treat the workspace as healthier than it is
 *
 * Test philosophy:
 * - no snapshots
 * - assert composition semantics, boundary conditions, and limiting cases directly
 * - prefer counterexamples and monotonicity failures over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/workspace_health exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  evaluateWorkspaceHealth,
  summarizeWorkspaceHealth,
  assertWorkspaceHealthyForAction,
  isWorkspaceActionAllowedByHealth,
  type WorkspaceHealthContext,
  type WorkspaceHealthEvaluation,
} from "../../../src/main/governance/workspace_health";

function ctx(overrides: Partial<WorkspaceHealthContext> = {}): WorkspaceHealthContext {
  return {
    workspaceId: "ws-1",
    rootPath: "/repo/adjutorix-app",
    action: "inspect",
    nowMs: 1711000100000,
    policy: {
      staleSnapshotAfterMs: 30_000,
      staleDiagnosticsAfterMs: 20_000,
      staleIndexAfterMs: 20_000,
      maxWatcherLagMs: 2_000,
      blockMutationOnDegraded: true,
      blockVerifyOnUnhealthy: true,
      blockApplyOnDegraded: true,
    },
    workspace: {
      opened: true,
      trustLevel: "trusted",
      snapshotUpdatedAtMs: 1711000095000,
    },
    watcher: {
      state: "watching",
      watchedPaths: 42,
      eventLagMs: 18,
      lastEventAtMs: 1711000099000,
      health: "healthy",
    },
    index: {
      state: "ready",
      progressPct: 100,
      issueCount: 0,
      updatedAtMs: 1711000096000,
      health: "healthy",
    },
    diagnostics: {
      total: 2,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 1,
      infoCount: 0,
      updatedAtMs: 1711000097000,
      health: "healthy",
    },
    refresh: {
      state: "idle",
      lastSuccessAtMs: 1711000095000,
      consecutiveFailureCount: 0,
    },
    environment: {
      degraded: false,
      offline: false,
      readonlyMedia: false,
    },
    ...overrides,
  } as WorkspaceHealthContext;
}

function codes(result: WorkspaceHealthEvaluation): string[] {
  return result.reasons.map((r) => r.code);
}

describe("workspace_health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateWorkspaceHealth", () => {
    it("returns healthy when watcher, index, diagnostics, trust, and refresh are all coherent and fresh", () => {
      const result = evaluateWorkspaceHealth(ctx());

      expect(result.level).toBe("healthy");
      expect(result.reasons).toEqual([]);
      expect(result.actionAllowed).toBe(true);
    });

    it("degrades when watcher lag exceeds policy threshold even if everything else is healthy", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          watcher: {
            ...ctx().watcher,
            eventLagMs: 5000,
            health: "degraded",
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("WATCHER_LAG_HIGH");
    });

    it("becomes unhealthy when watcher is stopped for an open workspace", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          watcher: {
            ...ctx().watcher,
            state: "stopped",
            health: "unhealthy",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("WATCHER_STOPPED");
    });

    it("degrades when snapshot age exceeds the stale snapshot policy window", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          workspace: {
            ...ctx().workspace,
            snapshotUpdatedAtMs: 1711000000000,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("WORKSPACE_SNAPSHOT_STALE");
    });

    it("degrades when index state is partial or stale even if watcher remains healthy", () => {
      const partial = evaluateWorkspaceHealth(
        ctx({
          index: {
            ...ctx().index,
            state: "partial",
            progressPct: 74,
            issueCount: 2,
            health: "degraded",
          },
        }),
      );

      const stale = evaluateWorkspaceHealth(
        ctx({
          index: {
            ...ctx().index,
            updatedAtMs: 1711000000000,
          },
        }),
      );

      expect(partial.level).toBe("degraded");
      expect(codes(partial)).toContain("INDEX_PARTIAL");

      expect(stale.level).toBe("degraded");
      expect(codes(stale)).toContain("INDEX_STALE");
    });

    it("becomes unhealthy when index explicitly reports failed state", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          index: {
            ...ctx().index,
            state: "failed",
            issueCount: 8,
            health: "unhealthy",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("INDEX_FAILED");
    });

    it("degrades when diagnostics are stale even if current counts are small", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          diagnostics: {
            ...ctx().diagnostics,
            updatedAtMs: 1711000000000,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("DIAGNOSTICS_STALE");
    });

    it("becomes unhealthy when fatal diagnostics exist because the limiting case is stronger than watcher/index health", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          diagnostics: {
            ...ctx().diagnostics,
            total: 3,
            fatalCount: 1,
            errorCount: 1,
            warningCount: 1,
            health: "unhealthy",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("FATAL_DIAGNOSTICS_PRESENT");
    });

    it("becomes unhealthy when workspace trust is not trusted for trust-sensitive actions", () => {
      const verifyResult = evaluateWorkspaceHealth(
        ctx({
          action: "verify",
          workspace: {
            ...ctx().workspace,
            trustLevel: "untrusted",
          },
        }),
      );

      const applyResult = evaluateWorkspaceHealth(
        ctx({
          action: "apply",
          workspace: {
            ...ctx().workspace,
            trustLevel: "untrusted",
          },
        }),
      );

      expect(verifyResult.level).toBe("unhealthy");
      expect(codes(verifyResult)).toContain("WORKSPACE_UNTRUSTED_FOR_ACTION");
      expect(applyResult.level).toBe("unhealthy");
      expect(codes(applyResult)).toContain("WORKSPACE_UNTRUSTED_FOR_ACTION");
    });

    it("degrades when refresh is repeatedly failing even if the last materialized snapshot still exists", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          refresh: {
            state: "idle",
            lastSuccessAtMs: 1711000095000,
            consecutiveFailureCount: 3,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("REFRESH_FAILURES_ACCUMULATING");
    });

    it("becomes unhealthy when no workspace is open for actions that require workspace truth", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          workspace: {
            ...ctx().workspace,
            opened: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("WORKSPACE_NOT_OPEN");
    });

    it("degrades under environment degradation even if direct workspace subsystems look healthy", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          environment: {
            degraded: true,
            offline: false,
            readonlyMedia: false,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("ENVIRONMENT_DEGRADED");
    });

    it("blocks mutation on degraded health when policy requires it", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          action: "mutation",
          watcher: {
            ...ctx().watcher,
            eventLagMs: 8000,
            health: "degraded",
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(result.actionAllowed).toBe(false);
      expect(codes(result)).toContain("WATCHER_LAG_HIGH");
      expect(codes(result)).toContain("ACTION_BLOCKED_BY_HEALTH");
    });

    it("blocks apply on degraded health more aggressively than inspect because consequences are stronger", () => {
      const inspect = evaluateWorkspaceHealth(
        ctx({
          action: "inspect",
          index: {
            ...ctx().index,
            state: "partial",
            progressPct: 80,
            issueCount: 1,
            health: "degraded",
          },
        }),
      );

      const apply = evaluateWorkspaceHealth(
        ctx({
          action: "apply",
          index: {
            ...ctx().index,
            state: "partial",
            progressPct: 80,
            issueCount: 1,
            health: "degraded",
          },
        }),
      );

      expect(inspect.level).toBe("degraded");
      expect(inspect.actionAllowed).toBe(true);
      expect(apply.level).toBe("degraded");
      expect(apply.actionAllowed).toBe(false);
    });

    it("blocks verify on unhealthy health when policy requires it", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          action: "verify",
          diagnostics: {
            ...ctx().diagnostics,
            fatalCount: 1,
            total: 3,
            health: "unhealthy",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(result.actionAllowed).toBe(false);
      expect(codes(result)).toContain("FATAL_DIAGNOSTICS_PRESENT");
      expect(codes(result)).toContain("ACTION_BLOCKED_BY_HEALTH");
    });

    it("preserves all relevant degradation reasons instead of collapsing to the first signal", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          action: "apply",
          watcher: {
            ...ctx().watcher,
            state: "stopped",
            health: "unhealthy",
            eventLagMs: 9000,
          },
          index: {
            ...ctx().index,
            state: "failed",
            issueCount: 5,
            health: "unhealthy",
          },
          diagnostics: {
            ...ctx().diagnostics,
            fatalCount: 1,
            total: 4,
            health: "unhealthy",
          },
          environment: {
            degraded: true,
            offline: true,
            readonlyMedia: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(result.reasons.length).toBeGreaterThanOrEqual(4);
    });

    it("returns deterministic identical evaluations for identical subsystem inputs", () => {
      const a = evaluateWorkspaceHealth(ctx());
      const b = evaluateWorkspaceHealth(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeWorkspaceHealth", () => {
    it("compresses evaluation into a stable summary while preserving level and blocked-action semantics", () => {
      const evaluation = evaluateWorkspaceHealth(
        ctx({
          action: "apply",
          watcher: {
            ...ctx().watcher,
            eventLagMs: 7000,
            health: "degraded",
          },
        }),
      );

      const summary = summarizeWorkspaceHealth(evaluation);

      expect(summary.level).toBe("degraded");
      expect(summary.actionAllowed).toBe(false);
      expect(summary.reasonCount).toBeGreaterThan(0);
    });
  });

  describe("isWorkspaceActionAllowedByHealth", () => {
    it("returns true for healthy inspection contexts", () => {
      expect(isWorkspaceActionAllowedByHealth(evaluateWorkspaceHealth(ctx()))).toBe(true);
    });

    it("returns false for degraded apply or mutation contexts blocked by policy", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          action: "apply",
          watcher: {
            ...ctx().watcher,
            eventLagMs: 4000,
            health: "degraded",
          },
        }),
      );

      expect(isWorkspaceActionAllowedByHealth(result)).toBe(false);
    });
  });

  describe("assertWorkspaceHealthyForAction", () => {
    it("does not throw for healthy allowed contexts", () => {
      expect(() => assertWorkspaceHealthyForAction(evaluateWorkspaceHealth(ctx()))).not.toThrow();
    });

    it("throws for blocked degraded/unhealthy contexts with explicit health failure semantics", () => {
      const result = evaluateWorkspaceHealth(
        ctx({
          action: "mutation",
          index: {
            ...ctx().index,
            state: "failed",
            issueCount: 6,
            health: "unhealthy",
          },
        }),
      );

      expect(() => assertWorkspaceHealthyForAction(result)).toThrow();
    });
  });
});
