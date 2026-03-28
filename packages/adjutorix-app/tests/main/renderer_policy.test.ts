import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / renderer_policy.test.ts
 *
 * Canonical renderer-policy contract suite.
 *
 * Purpose:
 * - verify that main-process renderer policy preserves one authoritative boundary between
 *   untrusted renderer intent and privileged main-process execution
 * - verify that channel allowlists, action classification, visibility requirements, authority gates,
 *   trust posture, workspace requirements, and mutation policy remain deterministic
 * - verify that renderer requests cannot smuggle hidden capability, unsafe shell intent,
 *   filesystem mutation, or apply/verify authority through loosely validated payloads
 *
 * Test philosophy:
 * - no snapshots
 * - assert boundary semantics, rejection surfaces, and limiting cases directly
 * - prefer counterexamples and cross-boundary failure modes over happy-path only coverage
 *
 * Notes:
 * - this suite assumes renderer_policy exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  evaluateRendererPolicy,
  enforceRendererPolicy,
  assertRendererPolicy,
  type RendererPolicyContext,
  type RendererPolicyEvaluation,
} from "../../../src/main/governance/renderer_policy";

function ctx(overrides: Partial<RendererPolicyContext> = {}): RendererPolicyContext {
  return {
    request: {
      channel: "workspace:open-file",
      action: "open-file",
      payload: {
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
      },
      source: "renderer",
      requestId: "req-1",
    },
    renderer: {
      webContentsId: 7,
      origin: "app://adjutorix",
      isolated: true,
      sandboxed: true,
      trustedSurface: true,
    },
    workspace: {
      isOpen: true,
      workspaceId: "ws-1",
      rootPath: "/repo/adjutorix-app",
      trustLevel: "trusted",
      health: "healthy",
    },
    authority: {
      mayReadWorkspace: true,
      mayWriteWorkspace: false,
      mayRunShell: false,
      mayVerify: true,
      mayApplyPatch: false,
      mayAccessSensitivePaths: false,
    },
    visibility: {
      actionVisibleToUser: true,
      consequencesVisibleToUser: true,
      authorityVisibleToUser: true,
      evidenceVisibleToUser: true,
    },
    mutation: {
      requestsFilesystemWrite: false,
      requestsShellExecution: false,
      requestsNetwork: false,
      requestsPrivilegeEscalation: false,
    },
    policy: {
      allowUnknownChannels: false,
      requireWorkspaceForWorkspaceChannels: true,
      restrictToWorkspaceRoot: true,
      requireVisibleIntentForMutation: true,
    },
    ...overrides,
  } as RendererPolicyContext;
}

function codes(result: RendererPolicyEvaluation): string[] {
  return result.violations.map((v) => v.code);
}

describe("renderer_policy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("permits a visible read-only workspace action from a trusted isolated renderer", () => {
    const result = evaluateRendererPolicy(ctx());

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
    expect(result.severity).toBe("none");
  });

  it("rejects unknown channels when the allowlist policy is closed", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          ...ctx().request,
          channel: "totally:unknown-channel",
          action: "unknown",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("UNKNOWN_CHANNEL");
  });

  it("rejects non-isolated renderer origins because hidden authority can leak through the boundary", () => {
    const result = evaluateRendererPolicy(
      ctx({
        renderer: {
          ...ctx().renderer,
          isolated: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("RENDERER_NOT_ISOLATED");
  });

  it("rejects non-sandboxed renderers for privileged channels", () => {
    const result = evaluateRendererPolicy(
      ctx({
        renderer: {
          ...ctx().renderer,
          sandboxed: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("RENDERER_NOT_SANDBOXED");
  });

  it("rejects untrusted renderer surfaces even if the workspace itself is trusted", () => {
    const result = evaluateRendererPolicy(
      ctx({
        renderer: {
          ...ctx().renderer,
          trustedSurface: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("UNTRUSTED_RENDERER_SURFACE");
  });

  it("rejects workspace-scoped channels when no workspace is open", () => {
    const result = evaluateRendererPolicy(
      ctx({
        workspace: {
          ...ctx().workspace,
          isOpen: false,
          workspaceId: null as unknown as string,
          rootPath: null as unknown as string,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("WORKSPACE_REQUIRED");
  });

  it("rejects file access outside the active workspace root when root restriction is enabled", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          ...ctx().request,
          payload: {
            path: "/etc/passwd",
          },
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("PATH_OUTSIDE_WORKSPACE");
  });

  it("permits root-contained dotfiles without confusing hidden files with out-of-root access", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          ...ctx().request,
          payload: {
            path: "/repo/adjutorix-app/.gitignore",
          },
        },
      }),
    );

    expect(result.allowed).toBe(true);
  });

  it("rejects filesystem write requests when renderer authority is read-only", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:write-file",
          action: "write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
          },
          source: "renderer",
          requestId: "req-write-1",
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("WRITE_AUTHORITY_DENIED");
  });

  it("rejects shell execution requests from renderer when shell authority is absent", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "shell:run",
          action: "run-shell-command",
          payload: {
            command: "npm test",
          },
          source: "renderer",
          requestId: "req-shell-1",
        },
        mutation: {
          ...ctx().mutation,
          requestsShellExecution: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("SHELL_AUTHORITY_DENIED");
  });

  it("rejects patch-apply requests when apply authority is absent even if the request is explicit", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "patch:apply",
          action: "apply-patch",
          payload: {
            patchId: "patch-42",
          },
          source: "renderer",
          requestId: "req-apply-1",
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("APPLY_AUTHORITY_DENIED");
  });

  it("rejects verify requests when verify authority is absent", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "verify:run",
          action: "run-verify",
          payload: { patchId: "patch-42" },
          source: "renderer",
          requestId: "req-verify-1",
        },
        authority: {
          ...ctx().authority,
          mayVerify: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("VERIFY_AUTHORITY_DENIED");
  });

  it("rejects hidden-consequence mutation when user-visible consequence surfacing is absent", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:write-file",
          action: "write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
          },
          source: "renderer",
          requestId: "req-write-2",
        },
        authority: {
          ...ctx().authority,
          mayWriteWorkspace: true,
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
        visibility: {
          ...ctx().visibility,
          consequencesVisibleToUser: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("HIDDEN_MUTATION_CONSEQUENCE");
  });

  it("rejects hidden-authority mutation when authority is not surfaced to the operator", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:write-file",
          action: "write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
          },
          source: "renderer",
          requestId: "req-write-3",
        },
        authority: {
          ...ctx().authority,
          mayWriteWorkspace: true,
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
        visibility: {
          ...ctx().visibility,
          authorityVisibleToUser: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("HIDDEN_AUTHORITY_BOUNDARY");
  });

  it("rejects mutation without explicit visible user intent when mutation policy requires it", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:write-file",
          action: "write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
            explicitIntent: false,
          },
          source: "renderer",
          requestId: "req-write-4",
        },
        authority: {
          ...ctx().authority,
          mayWriteWorkspace: true,
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("MUTATION_INTENT_MISSING");
  });

  it("permits explicit visible write intent only when write authority is granted and workspace root constraints hold", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:write-file",
          action: "write-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            contents: "mutated",
            explicitIntent: true,
          },
          source: "renderer",
          requestId: "req-write-5",
        },
        authority: {
          ...ctx().authority,
          mayWriteWorkspace: true,
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
      }),
    );

    expect(result.allowed).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it("rejects privilege-escalation requests even if the nominal channel looks allowed", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:open-file",
          action: "open-file",
          payload: {
            path: "/repo/adjutorix-app/src/renderer/App.tsx",
            escalate: true,
          },
          source: "renderer",
          requestId: "req-escalate-1",
        },
        mutation: {
          ...ctx().mutation,
          requestsPrivilegeEscalation: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("PRIVILEGE_ESCALATION_DENIED");
  });

  it("rejects sensitive-path access when the renderer lacks that capability even inside a nominally readable request", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:open-file",
          action: "open-file",
          payload: {
            path: "/repo/adjutorix-app/.env.production",
            sensitive: true,
          },
          source: "renderer",
          requestId: "req-sensitive-1",
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("SENSITIVE_PATH_DENIED");
  });

  it("rejects raw network requests initiated through renderer policy when networking is not allowed through this boundary", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "network:fetch",
          action: "fetch-url",
          payload: {
            url: "https://example.com",
          },
          source: "renderer",
          requestId: "req-net-1",
        },
        mutation: {
          ...ctx().mutation,
          requestsNetwork: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(codes(result)).toContain("NETWORK_BOUNDARY_DENIED");
  });

  it("treats pure read-only metadata refresh as a narrower limiting case than mutation and allows it under read authority", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "workspace:refresh-metadata",
          action: "refresh-workspace-metadata",
          payload: {},
          source: "renderer",
          requestId: "req-refresh-1",
        },
      }),
    );

    expect(result.allowed).toBe(true);
  });

  it("returns deterministic identical verdicts for identical boundary contexts", () => {
    const a = evaluateRendererPolicy(ctx());
    const b = evaluateRendererPolicy(ctx());

    expect(b).toEqual(a);
  });

  it("preserves all violations instead of stopping at the first one because compound boundary failure matters", () => {
    const result = evaluateRendererPolicy(
      ctx({
        request: {
          channel: "shell:run",
          action: "run-shell-command",
          payload: {
            command: "rm -rf /",
            explicitIntent: false,
          },
          source: "renderer",
          requestId: "req-shell-2",
        },
        renderer: {
          ...ctx().renderer,
          isolated: false,
          sandboxed: false,
          trustedSurface: false,
        },
        mutation: {
          requestsFilesystemWrite: true,
          requestsShellExecution: true,
          requestsNetwork: false,
          requestsPrivilegeEscalation: true,
        },
        visibility: {
          actionVisibleToUser: false,
          consequencesVisibleToUser: false,
          authorityVisibleToUser: false,
          evidenceVisibleToUser: false,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(5);
  });

  it("enforceRendererPolicy returns structured rejection instead of throwing on ordinary policy denial", () => {
    const result = enforceRendererPolicy(
      ctx({
        request: {
          channel: "patch:apply",
          action: "apply-patch",
          payload: { patchId: "patch-42" },
          source: "renderer",
          requestId: "req-apply-2",
        },
        mutation: {
          ...ctx().mutation,
          requestsFilesystemWrite: true,
        },
      }),
    );

    expect(result.allowed).toBe(false);
    expect(result.violations.length).toBeGreaterThan(0);
  });

  it("assertRendererPolicy throws on rejected contexts with explicit policy failure semantics", () => {
    expect(() =>
      assertRendererPolicy(
        ctx({
          request: {
            channel: "shell:run",
            action: "run-shell-command",
            payload: { command: "npm test" },
            source: "renderer",
            requestId: "req-shell-3",
          },
          mutation: {
            ...ctx().mutation,
            requestsShellExecution: true,
          },
        }),
      ),
    ).toThrow();
  });

  it("assertRendererPolicy does not throw on a fully valid read-only context", () => {
    expect(() => assertRendererPolicy(ctx())).not.toThrow();
  });
});
