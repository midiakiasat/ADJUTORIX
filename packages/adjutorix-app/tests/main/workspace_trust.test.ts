import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / workspace_trust.test.ts
 *
 * Canonical workspace-trust contract suite.
 *
 * Purpose:
 * - verify that main-process workspace trust evaluation preserves one authoritative trust boundary
 *   for workspace roots, nested paths, inherited policy, explicit approvals, and mutation authority
 * - verify that trust state remains deterministic across open, reopen, relocation, nested-root,
 *   ignored/hidden-path, and degraded-environment cases
 * - verify that untrusted or ambiguously trusted roots fail closed instead of silently widening
 *   file, shell, verify, or apply authority
 *
 * Test philosophy:
 * - no snapshots
 * - assert trust semantics, boundary conditions, and monotonicity directly
 * - prefer counterexamples and limiting cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/governance/workspace_trust exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  evaluateWorkspaceTrust,
  enforceWorkspaceTrust,
  assertWorkspaceTrust,
  isPathTrustedUnderWorkspace,
  normalizeWorkspaceTrustRoot,
  type WorkspaceTrustContext,
  type WorkspaceTrustEvaluation,
} from "../../src/main/workspace/workspace_trust";

function ctx(overrides: Partial<WorkspaceTrustContext> = {}): WorkspaceTrustContext {
  return {
    workspaceId: "ws-1",
    rootPath: "/repo/adjutorix-app",
    requestedPath: "/repo/adjutorix-app/src/renderer/App.tsx",
    actor: {
      kind: "user",
      id: "operator-1",
    },
    persistedTrust: {
      trustedRoots: ["/repo/adjutorix-app"],
      deniedRoots: [],
      lastTrustedAtMs: 1711000000000,
    },
    explicitDecision: {
      decision: "trusted",
      decidedAtMs: 1711000000000,
      source: "user",
    },
    environment: {
      degraded: false,
      offline: false,
      portableMode: false,
      readonlyMedia: false,
    },
    policy: {
      requireExplicitTrustForMutation: true,
      trustNestedPathsUnderTrustedRoot: true,
      denyUnknownRootsByDefault: true,
      allowReadonlyInspectionWhenUntrusted: true,
    },
    requestedCapability: "read",
    requestedMutation: false,
    ...overrides,
  } as WorkspaceTrustContext;
}

function codes(result: WorkspaceTrustEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("workspace_trust", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("normalizeWorkspaceTrustRoot", () => {
    it("normalizes path separators and trailing slashes into stable root identity", () => {
      expect(normalizeWorkspaceTrustRoot("/repo/adjutorix-app/")).toBe("/repo/adjutorix-app");
      expect(normalizeWorkspaceTrustRoot("C:\\repo\\adjutorix-app\\")).toBe("C:/repo/adjutorix-app");
    });

    it("preserves root-like paths without collapsing them into empty strings", () => {
      expect(normalizeWorkspaceTrustRoot("/")).toBe("/");
      expect(normalizeWorkspaceTrustRoot("C:/")).toBe("C:/");
    });
  });

  describe("isPathTrustedUnderWorkspace", () => {
    it("returns true for paths nested under a trusted workspace root", () => {
      expect(
        isPathTrustedUnderWorkspace(
          "/repo/adjutorix-app/src/renderer/App.tsx",
          "/repo/adjutorix-app",
        ),
      ).toBe(true);
    });

    it("returns true for the workspace root itself", () => {
      expect(isPathTrustedUnderWorkspace("/repo/adjutorix-app", "/repo/adjutorix-app")).toBe(true);
    });

    it("returns false for sibling or parent paths outside the trusted root", () => {
      expect(
        isPathTrustedUnderWorkspace(
          "/repo/other-project/src/index.ts",
          "/repo/adjutorix-app",
        ),
      ).toBe(false);
      expect(isPathTrustedUnderWorkspace("/repo", "/repo/adjutorix-app")).toBe(false);
    });
  });

  describe("evaluateWorkspaceTrust", () => {
    it("permits read capability for explicitly trusted roots and nested paths", () => {
      const result = evaluateWorkspaceTrust(ctx());

      expect(result.allowed).toBe(true);
      expect(result.trustLevel).toBe("trusted");
      expect(result.violations).toEqual([]);
    });

    it("permits mutation only when the root is explicitly trusted and policy allows mutation under trust", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedCapability: "write",
          requestedMutation: true,
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.trustLevel).toBe("trusted");
    });

    it("rejects unknown roots by default when no persisted or explicit trust exists", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: [],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.trustLevel).toBe("unknown");
      expect(codes(result)).toContain("UNKNOWN_ROOT_UNTRUSTED");
    });

    it("rejects explicitly denied roots even if the requested path is otherwise within scope", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: ["/repo/adjutorix-app"],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: {
            decision: "denied",
            decidedAtMs: 1711000000000,
            source: "user",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.trustLevel).toBe("denied");
      expect(codes(result)).toContain("ROOT_EXPLICITLY_DENIED");
    });

    it("permits readonly inspection for untrusted roots only in the limiting case where policy explicitly allows it", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: [],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
          requestedCapability: "inspect",
          requestedMutation: false,
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.trustLevel).toBe("untrusted-readonly");
    });

    it("rejects mutation for untrusted roots even when readonly inspection would be allowed", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: [],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
          requestedCapability: "write",
          requestedMutation: true,
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("MUTATION_REQUIRES_TRUST");
    });

    it("rejects requested paths outside the workspace root even if the root itself is trusted", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedPath: "/etc/passwd",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("PATH_OUTSIDE_TRUSTED_ROOT");
    });

    it("supports nested trusted paths under a trusted root without requiring separate trust records", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.trustLevel).toBe("trusted");
    });

    it("rejects nested sibling roots when the requested path escapes the trusted root by prefix trick", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedPath: "/repo/adjutorix-app-malicious/src/index.ts",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("PATH_OUTSIDE_TRUSTED_ROOT");
    });

    it("treats hidden or dotfiles under a trusted root as still within trust scope, not out-of-root", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedPath: "/repo/adjutorix-app/.env.local",
          requestedCapability: "read",
        }),
      );

      expect(result.allowed).toBe(true);
      expect(result.trustLevel).toBe("trusted");
    });

    it("does not silently upgrade trust from persisted state when explicit current decision is denied", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: ["/repo/adjutorix-app"],
            deniedRoots: [],
            lastTrustedAtMs: 1711000000000,
          },
          explicitDecision: {
            decision: "denied",
            decidedAtMs: 1711000001000,
            source: "user",
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.trustLevel).toBe("denied");
    });

    it("rejects ambiguous trust state when persisted trust and explicit decision conflict without a defined precedence", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: ["/repo/adjutorix-app"],
            deniedRoots: ["/repo/adjutorix-app"],
            lastTrustedAtMs: 1711000000000,
          },
          explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("AMBIGUOUS_TRUST_STATE");
    });

    it("rejects trust-sensitive capabilities under degraded environments when policy cannot safely infer trust", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          environment: {
            degraded: true,
            offline: false,
            portableMode: false,
            readonlyMedia: false,
          },
          requestedCapability: "verify",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(codes(result)).toContain("DEGRADED_ENVIRONMENT_TRUST_UNSAFE");
    });

    it("permits readonly inspection on readonly media only when no mutation is requested", () => {
      const inspect = evaluateWorkspaceTrust(
        ctx({
          environment: {
            degraded: false,
            offline: false,
            portableMode: false,
            readonlyMedia: true,
          },
          requestedCapability: "inspect",
          requestedMutation: false,
        }),
      );

      const mutate = evaluateWorkspaceTrust(
        ctx({
          environment: {
            degraded: false,
            offline: false,
            portableMode: false,
            readonlyMedia: true,
          },
          requestedCapability: "write",
          requestedMutation: true,
        }),
      );

      expect(inspect.allowed).toBe(true);
      expect(mutate.allowed).toBe(false);
      expect(codes(mutate)).toContain("READONLY_MEDIA_MUTATION_DENIED");
    });

    it("keeps trust monotonic: adding explicit trust can narrow denial, but removing trust cannot widen mutation authority", () => {
      const untrustedWrite = evaluateWorkspaceTrust(
        ctx({
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: [],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
          requestedCapability: "write",
          requestedMutation: true,
        }),
      );

      const trustedWrite = evaluateWorkspaceTrust(
        ctx({
          requestedCapability: "write",
          requestedMutation: true,
        }),
      );

      expect(untrustedWrite.allowed).toBe(false);
      expect(trustedWrite.allowed).toBe(true);
    });

    it("returns deterministic identical verdicts for identical trust contexts", () => {
      const a = evaluateWorkspaceTrust(ctx());
      const b = evaluateWorkspaceTrust(ctx());
      expect(b).toEqual(a);
    });

    it("enforceWorkspaceTrust returns structured rejection instead of throwing on ordinary trust denial", () => {
      const result = enforceWorkspaceTrust(
        ctx({
          requestedPath: "/etc/passwd",
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThan(0);
    });

    it("assertWorkspaceTrust throws on denied trust contexts with explicit trust failure semantics", () => {
      expect(() =>
        assertWorkspaceTrust(
          ctx({
            requestedCapability: "write",
            requestedMutation: true,
            persistedTrust: {
              trustedRoots: [],
              deniedRoots: [],
              lastTrustedAtMs: null as unknown as number,
            },
            explicitDecision: null as unknown as WorkspaceTrustContext["explicitDecision"],
          }),
        ),
      ).toThrow();
    });

    it("assertWorkspaceTrust does not throw on a fully trusted read or write context", () => {
      expect(() => assertWorkspaceTrust(ctx())).not.toThrow();
      expect(() =>
        assertWorkspaceTrust(
          ctx({
            requestedCapability: "write",
            requestedMutation: true,
          }),
        ),
      ).not.toThrow();
    });

    it("preserves all violations instead of stopping at the first one because compound trust failure matters", () => {
      const result = evaluateWorkspaceTrust(
        ctx({
          requestedPath: "/etc/passwd",
          requestedCapability: "write",
          requestedMutation: true,
          persistedTrust: {
            trustedRoots: [],
            deniedRoots: ["/repo/adjutorix-app"],
            lastTrustedAtMs: null as unknown as number,
          },
          explicitDecision: {
            decision: "denied",
            decidedAtMs: 1711000000000,
            source: "user",
          },
          environment: {
            degraded: true,
            offline: true,
            portableMode: false,
            readonlyMedia: true,
          },
        }),
      );

      expect(result.allowed).toBe(false);
      expect(result.violations.length).toBeGreaterThanOrEqual(4);
    });
  });
});
