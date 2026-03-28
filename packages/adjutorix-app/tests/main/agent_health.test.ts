import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_health.test.ts
 *
 * Canonical agent-health aggregation and action-gating suite.
 *
 * Purpose:
 * - verify that main-process agent health composition preserves one authoritative health surface
 *   across process lifecycle, auth availability, client transport reachability, session integrity,
 *   stream state, restart pressure, and stale snapshot timing
 * - verify that degraded and unhealthy subsystem signals compose monotonically, preserve explicit reasons,
 *   and gate actions according to consequence level rather than decorative status text
 * - verify that identical subsystem inputs yield identical aggregate health and action allowances
 *
 * Test philosophy:
 * - no snapshots
 * - assert aggregation semantics, edge cases, and limiting cases directly
 * - prefer counterexamples and monotonicity failures over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/agent_health exports the functions and types referenced below
 * - if production exports differ, adapt the harness first rather than weakening the contract intent
 */

import {
  evaluateAgentHealth,
  summarizeAgentHealth,
  isAgentActionAllowedByHealth,
  assertAgentHealthyForAction,
  type AgentHealthContext,
  type AgentHealthEvaluation,
} from "../../../src/main/governance/agent_health";

function ctx(overrides: Partial<AgentHealthContext> = {}): AgentHealthContext {
  return {
    action: "inspect",
    nowMs: 1711000100000,
    policy: {
      staleSnapshotAfterMs: 30_000,
      staleHealthAfterMs: 15_000,
      maxRestartCountBeforeDegraded: 2,
      maxRestartCountBeforeUnhealthy: 4,
      blockSendOnDegraded: false,
      blockSendOnUnhealthy: true,
      blockVerifyOnDegraded: true,
      blockVerifyOnUnhealthy: true,
      blockApplyOnDegraded: true,
      blockApplyOnUnhealthy: true,
    },
    process: {
      lifecycle: "ready",
      pid: 4100,
      startedAtMs: 1711000000000,
      readyAtMs: 1711000002000,
      exitedAtMs: null,
      endpoint: "http://127.0.0.1:8000/rpc",
      authState: "available",
      sessionState: "connected",
      restartCount: 0,
      lastExit: null,
      lastError: null,
    },
    processHealth: {
      level: "healthy",
      reasons: [],
      rpcReachable: true,
      authAvailable: true,
      stdoutFlowing: true,
      stderrFlowing: false,
    },
    auth: {
      status: "available",
      token: "token-1",
      source: "store",
      loadedAtMs: 1711000090000,
      rotatedAtMs: null,
      invalidatedAtMs: null,
      lastError: null,
    },
    authHealth: {
      level: "healthy",
      reasons: [],
      hasToken: true,
      canAuthorizeRequests: true,
    },
    clientHealth: {
      level: "healthy",
      reasons: [],
      reachable: true,
      authenticated: true,
      protocolCompatible: true,
    },
    session: {
      identity: {
        sessionId: "agent-session-1",
        providerLabel: "Local Agent",
        modelLabel: "adjutorix-core",
        endpointLabel: "http://127.0.0.1:8000/rpc",
        protocolVersion: "1",
      },
      connectionState: "connected",
      authState: "available",
      trustLevel: "trusted",
      health: {
        level: "healthy",
        reasons: [],
      },
      streamState: "idle",
      pendingRequestCount: 0,
      messages: [],
      activeTools: [],
      jobs: [],
      snapshotUpdatedAtMs: 1711000095000,
    },
    ...overrides,
  } as AgentHealthContext;
}

function codes(result: AgentHealthEvaluation): string[] {
  return result.reasons.map((r) => r.code);
}

describe("agent_health", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateAgentHealth", () => {
    it("returns healthy when process, auth, client, and session surfaces are coherent and fresh", () => {
      const result = evaluateAgentHealth(ctx());

      expect(result.level).toBe("healthy");
      expect(result.reasons).toEqual([]);
      expect(result.actionAllowed).toBe(true);
    });

    it("becomes unhealthy when the process is not ready even if cached client/session data still look healthy", () => {
      const result = evaluateAgentHealth(
        ctx({
          process: {
            ...ctx().process,
            lifecycle: "crashed",
            exitedAtMs: 1711000099000,
            lastExit: { code: 1, signal: null },
            lastError: "unexpected exit",
          },
          processHealth: {
            ...ctx().processHealth,
            level: "unhealthy",
            reasons: ["process crashed"],
            rpcReachable: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("PROCESS_NOT_READY");
    });

    it("degrades when restart count exceeds the degraded threshold even if the latest process is ready", () => {
      const result = evaluateAgentHealth(
        ctx({
          process: {
            ...ctx().process,
            restartCount: 3,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("RESTART_PRESSURE_HIGH");
    });

    it("becomes unhealthy when restart count exceeds the unhealthy threshold", () => {
      const result = evaluateAgentHealth(
        ctx({
          process: {
            ...ctx().process,
            restartCount: 5,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("RESTART_PRESSURE_CRITICAL");
    });

    it("degrades when auth token is missing even if process and transport are reachable", () => {
      const result = evaluateAgentHealth(
        ctx({
          auth: {
            ...ctx().auth,
            status: "missing",
            token: null,
          },
          authHealth: {
            ...ctx().authHealth,
            level: "degraded",
            reasons: ["missing token"],
            hasToken: false,
            canAuthorizeRequests: false,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("AUTH_MISSING");
    });

    it("becomes unhealthy when auth is explicitly invalid even if a stale token string still exists", () => {
      const result = evaluateAgentHealth(
        ctx({
          auth: {
            ...ctx().auth,
            status: "invalid",
            invalidatedAtMs: 1711000099000,
            lastError: "token rejected",
          },
          authHealth: {
            ...ctx().authHealth,
            level: "unhealthy",
            reasons: ["token rejected"],
            hasToken: false,
            canAuthorizeRequests: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("AUTH_INVALID");
    });

    it("degrades when client transport is unreachable even if process lifecycle remains ready", () => {
      const result = evaluateAgentHealth(
        ctx({
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["rpc unreachable"],
            reachable: false,
          },
          processHealth: {
            ...ctx().processHealth,
            rpcReachable: false,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("CLIENT_UNREACHABLE");
    });

    it("becomes unhealthy when protocol compatibility is broken because transport success alone is insufficient", () => {
      const result = evaluateAgentHealth(
        ctx({
          clientHealth: {
            ...ctx().clientHealth,
            level: "unhealthy",
            reasons: ["protocol mismatch"],
            protocolCompatible: false,
          },
          session: {
            ...ctx().session,
            identity: {
              ...ctx().session.identity,
              protocolVersion: "999",
            },
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("PROTOCOL_INCOMPATIBLE");
    });

    it("degrades when session snapshot is stale beyond policy even if process and transport remain healthy", () => {
      const result = evaluateAgentHealth(
        ctx({
          session: {
            ...ctx().session,
            snapshotUpdatedAtMs: 1711000000000,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("SESSION_SNAPSHOT_STALE");
    });

    it("degrades when the session reports active streaming state with inconsistent zero pending requests", () => {
      const result = evaluateAgentHealth(
        ctx({
          session: {
            ...ctx().session,
            streamState: "streaming",
            pendingRequestCount: 0,
            health: {
              level: "degraded",
              reasons: ["stream/pending mismatch"],
            },
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("SESSION_STREAM_INCONSISTENT");
    });

    it("becomes unhealthy when process/session connection states contradict each other at the hard boundary", () => {
      const result = evaluateAgentHealth(
        ctx({
          process: {
            ...ctx().process,
            sessionState: "connected",
          },
          session: {
            ...ctx().session,
            connectionState: "disconnected",
            health: {
              level: "unhealthy",
              reasons: ["session disconnected"],
            },
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("SESSION_PROCESS_STATE_CONFLICT");
    });

    it("preserves all relevant reasons instead of collapsing to the first subsystem failure", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "apply",
          process: {
            ...ctx().process,
            lifecycle: "crashed",
            restartCount: 5,
          },
          processHealth: {
            ...ctx().processHealth,
            level: "unhealthy",
            reasons: ["process crashed"],
            rpcReachable: false,
            authAvailable: false,
          },
          auth: {
            ...ctx().auth,
            status: "invalid",
            token: null,
            lastError: "token rejected",
          },
          authHealth: {
            ...ctx().authHealth,
            level: "unhealthy",
            reasons: ["token rejected"],
            hasToken: false,
            canAuthorizeRequests: false,
          },
          clientHealth: {
            ...ctx().clientHealth,
            level: "unhealthy",
            reasons: ["rpc unreachable", "protocol mismatch"],
            reachable: false,
            authenticated: false,
            protocolCompatible: false,
          },
          session: {
            ...ctx().session,
            connectionState: "disconnected",
            authState: "invalid",
            snapshotUpdatedAtMs: 1711000000000,
            health: {
              level: "unhealthy",
              reasons: ["stale and disconnected"],
            },
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(result.reasons.length).toBeGreaterThanOrEqual(5);
    });

    it("allows inspect on degraded health when policy only blocks higher-consequence actions", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "inspect",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["minor latency"],
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(result.actionAllowed).toBe(true);
    });

    it("blocks verify on degraded health when policy marks verify as consequence-sensitive", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "verify",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["minor latency"],
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(result.actionAllowed).toBe(false);
      expect(codes(result)).toContain("ACTION_BLOCKED_BY_HEALTH");
    });

    it("blocks apply on degraded health more aggressively than send because consequence level is higher", () => {
      const send = evaluateAgentHealth(
        ctx({
          action: "send",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["latency rising"],
          },
        }),
      );

      const apply = evaluateAgentHealth(
        ctx({
          action: "apply",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["latency rising"],
          },
        }),
      );

      expect(send.level).toBe("degraded");
      expect(send.actionAllowed).toBe(true);
      expect(apply.level).toBe("degraded");
      expect(apply.actionAllowed).toBe(false);
    });

    it("blocks send on unhealthy health even if degraded sends would be allowed", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "send",
          process: {
            ...ctx().process,
            lifecycle: "error",
            lastError: "bootstrap failed",
          },
          processHealth: {
            ...ctx().processHealth,
            level: "unhealthy",
            reasons: ["bootstrap failed"],
            rpcReachable: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(result.actionAllowed).toBe(false);
    });

    it("returns deterministic identical health evaluations for identical subsystem inputs", () => {
      const a = evaluateAgentHealth(ctx());
      const b = evaluateAgentHealth(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeAgentHealth", () => {
    it("compresses evaluation into a stable summary while preserving level and blocked-action semantics", () => {
      const evaluation = evaluateAgentHealth(
        ctx({
          action: "verify",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["latency rising"],
          },
        }),
      );

      const summary = summarizeAgentHealth(evaluation);

      expect(summary.level).toBe("degraded");
      expect(summary.actionAllowed).toBe(false);
      expect(summary.reasonCount).toBeGreaterThan(0);
    });
  });

  describe("isAgentActionAllowedByHealth", () => {
    it("returns true for healthy inspect contexts", () => {
      expect(isAgentActionAllowedByHealth(evaluateAgentHealth(ctx()))).toBe(true);
    });

    it("returns false for blocked degraded or unhealthy contexts", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "apply",
          authHealth: {
            ...ctx().authHealth,
            level: "degraded",
            reasons: ["token nearing expiry"],
            canAuthorizeRequests: true,
          },
        }),
      );

      expect(isAgentActionAllowedByHealth(result)).toBe(false);
    });
  });

  describe("assertAgentHealthyForAction", () => {
    it("does not throw for healthy allowed contexts", () => {
      expect(() => assertAgentHealthyForAction(evaluateAgentHealth(ctx()))).not.toThrow();
    });

    it("throws for blocked degraded or unhealthy contexts with explicit health failure semantics", () => {
      const result = evaluateAgentHealth(
        ctx({
          action: "verify",
          clientHealth: {
            ...ctx().clientHealth,
            level: "degraded",
            reasons: ["rpc lat