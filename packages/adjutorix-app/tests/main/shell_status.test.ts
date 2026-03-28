import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / shell_status.test.ts
 *
 * Canonical shell-status aggregation and projection suite.
 *
 * Purpose:
 * - verify that main-process shell status preserves one authoritative shell/session truth across
 *   terminal availability, cwd validity, command lifecycle, stdout/stderr flow, exit state,
 *   idle/running/degraded transitions, and visibility of last command results
 * - verify that stale session projections, orphaned processes, cwd escape, contradictory run state,
 *   and post-exit output drift fail closed instead of presenting a falsely healthy shell surface
 * - verify that identical shell inputs yield identical normalized status projections and actionability
 *
 * Test philosophy:
 * - no snapshots
 * - assert aggregation semantics, edge cases, and limiting cases directly
 * - prefer counterexamples and monotonicity failures over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/shell_status exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  evaluateShellStatus,
  summarizeShellStatus,
  assertShellStatusForAction,
  isShellActionAllowedByStatus,
  type ShellStatusContext,
  type ShellStatusEvaluation,
} from "../../../src/main/governance/shell_status";

function ctx(overrides: Partial<ShellStatusContext> = {}): ShellStatusContext {
  return {
    action: "inspect",
    nowMs: 1711000100000,
    policy: {
      staleIdleAfterMs: 60_000,
      staleOutputAfterMs: 20_000,
      blockRunOnDegraded: true,
      blockRunOnUnhealthy: true,
      blockInterruptOnUnhealthy: true,
      requireWorkspaceBoundedCwd: true,
      workspaceRoot: "/repo/adjutorix-app",
    },
    shell: {
      available: true,
      terminalReady: true,
      cwd: "/repo/adjutorix-app",
      shellPath: "/bin/zsh",
      interactive: true,
      startedAtMs: 1711000000000,
      updatedAtMs: 1711000099000,
    },
    command: {
      present: true,
      id: "cmd-1",
      command: "npm test",
      lifecycle: "idle",
      startedAtMs: 1711000095000,
      finishedAtMs: 1711000096000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutBytes: 1200,
      stderrBytes: 0,
      lastOutputAtMs: 1711000095500,
    },
    output: {
      stdoutFlowing: false,
      stderrFlowing: false,
      truncated: false,
      lastStdoutAtMs: 1711000095500,
      lastStderrAtMs: null,
    },
    workspace: {
      rootPath: "/repo/adjutorix-app",
      trusted: true,
      healthy: true,
    },
    ...overrides,
  } as ShellStatusContext;
}

function codes(result: ShellStatusEvaluation): string[] {
  return result.reasons.map((r) => r.code);
}

describe("shell_status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("evaluateShellStatus", () => {
    it("returns healthy when terminal is available, cwd is valid, and last command exited cleanly", () => {
      const result = evaluateShellStatus(ctx());

      expect(result.level).toBe("healthy");
      expect(result.actionAllowed).toBe(true);
      expect(result.reasons).toEqual([]);
    });

    it("degrades when shell is available but terminal is not ready for interaction", () => {
      const result = evaluateShellStatus(
        ctx({
          shell: {
            ...ctx().shell,
            terminalReady: false,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("TERMINAL_NOT_READY");
    });

    it("becomes unhealthy when no shell is available because command execution cannot proceed", () => {
      const result = evaluateShellStatus(
        ctx({
          shell: {
            ...ctx().shell,
            available: false,
            terminalReady: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("SHELL_UNAVAILABLE");
    });

    it("rejects cwd outside the workspace root even if the shell otherwise appears healthy", () => {
      const result = evaluateShellStatus(
        ctx({
          shell: {
            ...ctx().shell,
            cwd: "/etc",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("CWD_OUTSIDE_WORKSPACE");
    });

    it("rejects sibling-prefix cwd tricks that only share a string prefix with the workspace root", () => {
      const result = evaluateShellStatus(
        ctx({
          shell: {
            ...ctx().shell,
            cwd: "/repo/adjutorix-app-malicious",
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("CWD_OUTSIDE_WORKSPACE");
    });

    it("degrades when the shell session is stale even if the last command succeeded", () => {
      const result = evaluateShellStatus(
        ctx({
          shell: {
            ...ctx().shell,
            updatedAtMs: 1710990000000,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("SHELL_SESSION_STALE");
    });

    it("reports running command state as healthy only while output/heartbeat remains fresh", () => {
      const fresh = evaluateShellStatus(
        ctx({
          action: "interrupt",
          command: {
            ...ctx().command,
            lifecycle: "running",
            finishedAtMs: null,
            exitCode: null,
            stdoutBytes: 4096,
            lastOutputAtMs: 1711000099500,
          },
          output: {
            stdoutFlowing: true,
            stderrFlowing: false,
            truncated: false,
            lastStdoutAtMs: 1711000099500,
            lastStderrAtMs: null,
          },
        }),
      );

      expect(fresh.level).toBe("healthy");
      expect(fresh.actionAllowed).toBe(true);
    });

    it("degrades when a command is marked running but no fresh output or heartbeat exists", () => {
      const result = evaluateShellStatus(
        ctx({
          action: "interrupt",
          command: {
            ...ctx().command,
            lifecycle: "running",
            finishedAtMs: null,
            exitCode: null,
            lastOutputAtMs: 1710990000000,
          },
          output: {
            stdoutFlowing: false,
            stderrFlowing: false,
            truncated: false,
            lastStdoutAtMs: 1710990000000,
            lastStderrAtMs: null,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("RUNNING_COMMAND_STALE");
    });

    it("becomes unhealthy when command state is internally contradictory: running with finishedAt or exitCode set", () => {
      const result = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "running",
            finishedAtMs: 1711000098000,
            exitCode: 0,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(codes(result)).toContain("COMMAND_STATE_CONTRADICTION");
    });

    it("degrades when stderr is actively flowing on an otherwise running command", () => {
      const result = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "running",
            finishedAtMs: null,
            exitCode: null,
            lastOutputAtMs: 1711000099500,
          },
          output: {
            stdoutFlowing: true,
            stderrFlowing: true,
            truncated: false,
            lastStdoutAtMs: 1711000099500,
            lastStderrAtMs: 1711000099600,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("STDERR_ACTIVE");
    });

    it("degrades when output was truncated because the visible shell surface is incomplete", () => {
      const result = evaluateShellStatus(
        ctx({
          output: {
            ...ctx().output,
            truncated: true,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("OUTPUT_TRUNCATED");
    });

    it("degrades when last command exited non-zero even though the shell session still exists", () => {
      const result = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "failed",
            exitCode: 2,
            finishedAtMs: 1711000096000,
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("LAST_COMMAND_FAILED");
    });

    it("degrades when last command timed out because session health is no longer fully trusted", () => {
      const result = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "failed",
            timedOut: true,
            exitCode: null,
            signal: "SIGKILL",
          },
        }),
      );

      expect(result.level).toBe("degraded");
      expect(codes(result)).toContain("LAST_COMMAND_TIMED_OUT");
    });

    it("does not let a cancelled command escalate to the same severity as an unexpected failed command", () => {
      const cancelled = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "cancelled",
            cancelled: true,
            exitCode: null,
            signal: "SIGTERM",
          },
        }),
      );

      const failed = evaluateShellStatus(
        ctx({
          command: {
            ...ctx().command,
            lifecycle: "failed",
            cancelled: false,
            exitCode: 1,
            signal: null,
          },
        }),
      );

      expect(["healthy", "degraded"]).toContain(cancelled.level);
      expect(failed.level).toBe("degraded");
      expect(codes(failed)).toContain("LAST_COMMAND_FAILED");
    });

    it("blocks run when workspace trust or health is not sufficient even if shell mechanics are healthy", () => {
      const untrusted = evaluateShellStatus(
        ctx({
          action: "run",
          workspace: {
            ...ctx().workspace,
            trusted: false,
          },
        }),
      );

      const unhealthy = evaluateShellStatus(
        ctx({
          action: "run",
          workspace: {
            ...ctx().workspace,
            healthy: false,
          },
        }),
      );

      expect(untrusted.actionAllowed).toBe(false);
      expect(codes(untrusted)).toContain("WORKSPACE_NOT_TRUSTED_FOR_RUN");
      expect(unhealthy.actionAllowed).toBe(false);
      expect(codes(unhealthy)).toContain("WORKSPACE_NOT_HEALTHY_FOR_RUN");
    });

    it("permits inspect as the limiting case even when run would be blocked by degraded shell status", () => {
      const inspect = evaluateShellStatus(
        ctx({
          action: "inspect",
          output: {
            ...ctx().output,
            truncated: true,
          },
        }),
      );

      const run = evaluateShellStatus(
        ctx({
          action: "run",
          output: {
            ...ctx().output,
            truncated: true,
          },
        }),
      );

      expect(inspect.actionAllowed).toBe(true);
      expect(run.actionAllowed).toBe(false);
    });

    it("preserves all relevant reasons instead of collapsing to the first shell problem", () => {
      const result = evaluateShellStatus(
        ctx({
          action: "run",
          shell: {
            ...ctx().shell,
            available: false,
            terminalReady: false,
            cwd: "/etc",
            updatedAtMs: 1710990000000,
          },
          command: {
            ...ctx().command,
            lifecycle: "running",
            finishedAtMs: 1711000098000,
            exitCode: 1,
            timedOut: true,
            lastOutputAtMs: 1710990000000,
          },
          output: {
            stdoutFlowing: false,
            stderrFlowing: true,
            truncated: true,
            lastStdoutAtMs: 1710990000000,
            lastStderrAtMs: 1710990000000,
          },
          workspace: {
            rootPath: "/repo/adjutorix-app",
            trusted: false,
            healthy: false,
          },
        }),
      );

      expect(result.level).toBe("unhealthy");
      expect(result.reasons.length).toBeGreaterThanOrEqual(5);
    });

    it("returns deterministic identical evaluations for identical shell-status inputs", () => {
      const a = evaluateShellStatus(ctx());
      const b = evaluateShellStatus(ctx());
      expect(b).toEqual(a);
    });
  });

  describe("summarizeShellStatus", () => {
    it("compresses shell evaluation while preserving level, action allowance, and reason count", () => {
      const evaluation = evaluateShellStatus(
        ctx({
          action: "run",
          output: {
            ...ctx().output,
            truncated: true,
          },
        }),
      );

      const summary = summarizeShellStatus(evaluation);

      expect(summary.level).toBe("degraded");
      expect(summary.actionAllowed).toBe(false);
      expect(summary.reasonCount).toBeGreaterThan(0);
    });
  });

  describe("isShellActionAllowedByStatus", () => {
    it("returns true for healthy inspection contexts", () => {
      expect(isShellActionAllowedByStatus(evaluateShellStatus(ctx()))).toBe(true);
    });

    it("returns false for blocked run contexts", () => {
      const result = evaluateShellStatus(
        ctx({
          action: "run",
          shell: {
            ...ctx().shell,
            terminalReady: false,
          },
        }),
      );

      expect(isShellActionAllowedByStatus(result)).toBe(false);
    });
  });

  describe("assertShellStatusForAction", () => {
    it("does not throw for healthy allowed shell contexts", () => {
      expect(() => assertShellStatusForAction(evaluateShellStatus(ctx()))).not.toThrow();
    });

    it("throws for blocked shell contexts with explicit shell-status failure semantics", () => {
      const result = evaluateShellStatus(
        ctx({
          action: "run",
          shell: {
            ...ctx().shell,
            available: false,
            terminalReady: false,
          },
        }),
      );

      expect(() => assertShellStatusForAction(result)).toThrow();
    });
  });
});
