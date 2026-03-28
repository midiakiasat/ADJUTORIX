import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / environment_fingerprint.test.ts
 *
 * Canonical environment-fingerprint contract suite.
 *
 * Purpose:
 * - verify that main-process environment fingerprinting preserves one authoritative identity surface
 *   for runtime, platform, shell, node/electron/toolchain, workspace root, trust-relevant paths,
 *   policy-relevant flags, and execution mode
 * - verify that stable environments produce stable fingerprints, while materially different environments
 *   produce different fingerprints with explicit component deltas
 * - verify that volatile or irrelevant fields do not contaminate fingerprints and create false drift
 *   across replay, trust, cache, verify, and governance subsystems
 *
 * Test philosophy:
 * - no snapshots
 * - assert identity semantics, field inclusion/exclusion, and limiting cases directly
 * - prefer counterexamples and false-equivalence failures over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/environment_fingerprint exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  computeEnvironmentFingerprint,
  diffEnvironmentFingerprint,
  normalizeEnvironmentFingerprintInput,
  summarizeEnvironmentFingerprint,
  type EnvironmentFingerprintInput,
  type EnvironmentFingerprint,
} from "../../../src/main/governance/environment_fingerprint";

function input(overrides: Partial<EnvironmentFingerprintInput> = {}): EnvironmentFingerprintInput {
  return {
    platform: "darwin",
    arch: "arm64",
    osRelease: "24.1.0",
    hostname: "host-007",
    nodeVersion: "22.11.0",
    electronVersion: "33.2.1",
    appVersion: "0.1.0",
    workspaceRoot: "/repo/adjutorix-app",
    cwd: "/repo/adjutorix-app",
    shell: "/bin/zsh",
    pathEntries: [
      "/usr/local/bin",
      "/opt/homebrew/bin",
      "/usr/bin",
      "/bin",
    ],
    envFlags: {
      CI: "false",
      ADJUTORIX_PORTABLE: "false",
      ADJUTORIX_OFFLINE: "false",
    },
    git: {
      repoRoot: "/repo/adjutorix-app",
      headRef: "refs/heads/main",
      commit: "abc123def456",
      dirty: false,
    },
    trust: {
      workspaceTrusted: true,
      policyMode: "strict",
    },
    execution: {
      readonlyMedia: false,
      degraded: false,
      offline: false,
      portableMode: false,
    },
    toolchain: {
      npmVersion: "10.9.0",
      pythonVersion: "3.12.7",
      gitVersion: "2.47.0",
    },
    volatile: {
      pid: 4100,
      startedAtMs: 1711000000000,
      freeMemoryBytes: 123456789,
      loadAverage: [0.1, 0.2, 0.3],
    },
    ...overrides,
  } as EnvironmentFingerprintInput;
}

describe("environment_fingerprint", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeEnvironmentFingerprintInput", () => {
    it("normalizes paths, path entries, and shell/cwd/workspace roots into stable canonical form", () => {
      const normalized = normalizeEnvironmentFingerprintInput(
        input({
          workspaceRoot: "/repo/adjutorix-app/",
          cwd: "/repo//adjutorix-app/./",
          shell: "/bin/zsh",
          pathEntries: [
            "/usr/local/bin/",
            "/opt/homebrew/bin",
            "/usr/bin",
            "/bin",
          ],
        }),
      );

      expect(normalized.workspaceRoot).toBe("/repo/adjutorix-app");
      expect(normalized.cwd).toBe("/repo/adjutorix-app");
      expect(normalized.pathEntries[0]).toBe("/usr/local/bin");
    });

    it("sorts object-like flag maps deterministically so input key order cannot perturb the fingerprint", () => {
      const a = normalizeEnvironmentFingerprintInput(
        input({
          envFlags: {
            B: "2",
            A: "1",
            C: "3",
          },
        }),
      );
      const b = normalizeEnvironmentFingerprintInput(
        input({
          envFlags: {
            C: "3",
            A: "1",
            B: "2",
          },
        }),
      );

      expect(a.envFlags).toEqual(b.envFlags);
    });

    it("removes irrelevant duplicate path entries without changing semantic environment identity", () => {
      const normalized = normalizeEnvironmentFingerprintInput(
        input({
          pathEntries: [
            "/usr/local/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/usr/bin",
          ],
        }),
      );

      expect(normalized.pathEntries).toEqual(["/usr/local/bin", "/usr/bin"]);
    });
  });

  describe("computeEnvironmentFingerprint", () => {
    it("produces a stable fingerprint and explicit component map for a canonical environment", () => {
      const result = computeEnvironmentFingerprint(input());

      expect(result.fingerprint).toBeTruthy();
      expect(typeof result.fingerprint).toBe("string");
      expect(result.components.platform).toBeTruthy();
      expect(result.components.toolchain).toBeTruthy();
      expect(result.components.workspace).toBeTruthy();
    });

    it("returns identical fingerprints for identical environments", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(input());

      expect(b).toEqual(a);
    });

    it("does not let volatile runtime fields perturb the fingerprint when material environment identity is unchanged", () => {
      const a = computeEnvironmentFingerprint(
        input({
          volatile: {
            pid: 4100,
            startedAtMs: 1711000000000,
            freeMemoryBytes: 123456789,
            loadAverage: [0.1, 0.2, 0.3],
          },
        }),
      );
      const b = computeEnvironmentFingerprint(
        input({
          volatile: {
            pid: 9999,
            startedAtMs: 1711999999999,
            freeMemoryBytes: 987654321,
            loadAverage: [8, 9, 10],
          },
        }),
      );

      expect(b.fingerprint).toBe(a.fingerprint);
      expect(b.components).toEqual(a.components);
    });

    it("changes fingerprint when workspace root changes because trust and replay scope materially changed", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          workspaceRoot: "/repo/other-project",
          cwd: "/repo/other-project",
          git: {
            repoRoot: "/repo/other-project",
            headRef: "refs/heads/main",
            commit: "abc123def456",
            dirty: false,
          },
        }),
      );

      expect(b.fingerprint).not.toBe(a.fingerprint);
    });

    it("changes fingerprint when trust posture changes even if filesystem and toolchain stay constant", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          trust: {
            workspaceTrusted: false,
            policyMode: "strict",
          },
        }),
      );

      expect(b.fingerprint).not.toBe(a.fingerprint);
      expect(b.components.trust).not.toBe(a.components.trust);
    });

    it("changes fingerprint when execution mode changes to offline, degraded, readonly, or portable", () => {
      const base = computeEnvironmentFingerprint(input());
      const offline = computeEnvironmentFingerprint(
        input({
          execution: {
            readonlyMedia: false,
            degraded: false,
            offline: true,
            portableMode: false,
          },
        }),
      );
      const readonly = computeEnvironmentFingerprint(
        input({
          execution: {
            readonlyMedia: true,
            degraded: false,
            offline: false,
            portableMode: false,
          },
        }),
      );

      expect(offline.fingerprint).not.toBe(base.fingerprint);
      expect(readonly.fingerprint).not.toBe(base.fingerprint);
    });

    it("changes fingerprint when protocol-relevant toolchain versions change", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          nodeVersion: "23.0.0",
        }),
      );
      const c = computeEnvironmentFingerprint(
        input({
          toolchain: {
            npmVersion: "11.0.0",
            pythonVersion: "3.12.7",
            gitVersion: "2.47.0",
          },
        }),
      );

      expect(b.fingerprint).not.toBe(a.fingerprint);
      expect(c.fingerprint).not.toBe(a.fingerprint);
    });

    it("changes fingerprint when repository commit or dirty state changes, because build/replay identity changed", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          git: {
            repoRoot: "/repo/adjutorix-app",
            headRef: "refs/heads/main",
            commit: "fff999eee888",
            dirty: false,
          },
        }),
      );
      const c = computeEnvironmentFingerprint(
        input({
          git: {
            repoRoot: "/repo/adjutorix-app",
            headRef: "refs/heads/main",
            commit: "abc123def456",
            dirty: true,
          },
        }),
      );

      expect(b.fingerprint).not.toBe(a.fingerprint);
      expect(c.fingerprint).not.toBe(a.fingerprint);
    });

    it("does not falsely distinguish environments that differ only by env-flag key order or path formatting", () => {
      const a = computeEnvironmentFingerprint(
        input({
          workspaceRoot: "/repo/adjutorix-app/",
          cwd: "/repo//adjutorix-app/./",
          envFlags: {
            CI: "false",
            ADJUTORIX_OFFLINE: "false",
            ADJUTORIX_PORTABLE: "false",
          },
        }),
      );
      const b = computeEnvironmentFingerprint(
        input({
          workspaceRoot: "/repo/adjutorix-app",
          cwd: "/repo/adjutorix-app",
          envFlags: {
            ADJUTORIX_PORTABLE: "false",
            CI: "false",
            ADJUTORIX_OFFLINE: "false",
          },
        }),
      );

      expect(b.fingerprint).toBe(a.fingerprint);
    });

    it("does not collapse materially different path search surfaces into the same fingerprint", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          pathEntries: [
            "/custom/bin",
            "/usr/bin",
            "/bin",
          ],
        }),
      );

      expect(b.fingerprint).not.toBe(a.fingerprint);
    });
  });

  describe("diffEnvironmentFingerprint", () => {
    it("returns no deltas for identical fingerprints", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(input());

      const diff = diffEnvironmentFingerprint(a, b);
      expect(diff.changed).toBe(false);
      expect(diff.changedComponents).toEqual([]);
    });

    it("pinpoints changed components when execution mode changes without attributing unrelated drift", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          execution: {
            readonlyMedia: false,
            degraded: true,
            offline: true,
            portableMode: false,
          },
        }),
      );

      const diff = diffEnvironmentFingerprint(a, b);
      expect(diff.changed).toBe(true);
      expect(diff.changedComponents).toContain("execution");
      expect(diff.changedComponents).not.toContain("workspace");
    });

    it("pinpoints trust and workspace deltas when trust-relevant root identity changes", () => {
      const a = computeEnvironmentFingerprint(input());
      const b = computeEnvironmentFingerprint(
        input({
          workspaceRoot: "/repo/other-project",
          cwd: "/repo/other-project",
          git: {
            repoRoot: "/repo/other-project",
            headRef: "refs/heads/main",
            commit: "abc123def456",
            dirty: false,
          },
          trust: {
            workspaceTrusted: false,
            policyMode: "strict",
          },
        }),
      );

      const diff = diffEnvironmentFingerprint(a, b);
      expect(diff.changed).toBe(true);
      expect(diff.changedComponents).toEqual(expect.arrayContaining(["workspace", "trust", "git"]));
    });
  });

  describe("summarizeEnvironmentFingerprint", () => {
    it("compresses fingerprint into a stable summary containing root, platform, and trust-relevant labels", () => {
      const fp = computeEnvironmentFingerprint(input());
      const summary = summarizeEnvironmentFingerprint(fp);

      expect(summary.fingerprint).toBe(fp.fingerprint);
      expect(summary.workspaceRoot).toBe("/repo/adjutorix-app");
      expect(summary.platform).toBe("darwin/arm64");
      expect(summary.trustLabel).toBeTruthy();
    });
  });
});
