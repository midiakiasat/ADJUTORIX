import "@testing-library/jest-dom/vitest";
import "./_support/autofix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / SMOKE / restore_workspace_session.smoke.test.ts
 *
 * Canonical restore-workspace-session smoke suite.
 *
 * Objective:
 * - verify the end-to-end session-restore path from persisted renderer/main session state through
 *   trusted workspace reattachment, tree hydration, restored selections/tabs, governed provider
 *   reconnect, and visible ready-state projection
 * - catch catastrophic integration regressions where a persisted session exists but restore only
 *   partially reattaches the workspace, leaving the shell visually plausible but causally false
 * - keep assertions outcome-oriented: did the app restore the right workspace, restore the right
 *   open/selected paths, rehydrate governed surfaces, and fail closed when persisted state is stale
 *   or invalid
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import App from "../../src/renderer/App";
import { installRendererProviders } from "../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../src/renderer/bootstrap/createRendererRuntime";

type MockBridge = {
  session: {
    restore: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
  };
  workspace: {
    load: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    selectPath: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  ledger: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  verify: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  patch: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
};

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-restore-1",
    rootPath: "/repo/adjutorix-app",
    name: "adjutorix-app",
    trustLevel: "trusted",
    status: "ready",
    entries: [
      {
        path: "/repo/adjutorix-app",
        name: "adjutorix-app",
        kind: "directory",
        parentPath: null,
        childCount: 2,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: "/repo/adjutorix-app/src",
        name: "src",
        kind: "directory",
        parentPath: "/repo/adjutorix-app",
        childCount: 1,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: "/repo/adjutorix-app/src/renderer",
        name: "renderer",
        kind: "directory",
        parentPath: "/repo/adjutorix-app/src",
        childCount: 3,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/App.tsx",
        name: "App.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer",
        childCount: 0,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
        name: "AppShell.tsx",
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer/components",
        childCount: 0,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
    ],
    expandedPaths: [
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
    ],
    openedPaths: [
      "/repo/adjutorix-app/src/renderer/App.tsx",
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    ],
    recentPaths: [
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
      "/repo/adjutorix-app/src/renderer/App.tsx",
    ],
    selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    diagnostics: {
      total: 1,
      fatalCount: 0,
      errorCount: 0,
      warningCount: 1,
      infoCount: 0,
    },
    health: {
      level: "healthy",
      reasons: [],
    },
    indexStatus: {
      state: "ready",
      progressPct: 100,
      issueCount: 0,
    },
    watcherStatus: {
      state: "watching",
      watchedPaths: 24,
      eventLagMs: 7,
    },
  };
}

function makeRestoredSession() {
  return {
    sessionId: "session-restore-1",
    workspaceId: "ws-restore-1",
    rootPath: "/repo/adjutorix-app",
    trustLevel: "trusted",
    selectedPath: "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    openedPaths: [
      "/repo/adjutorix-app/src/renderer/App.tsx",
      "/repo/adjutorix-app/src/renderer/components/AppShell.tsx",
    ],
    expandedPaths: [
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
    ],
    verifyId: "verify-42",
    ledgerId: "ledger-42",
    patchId: "patch-42",
    diagnosticsWorkspaceId: "ws-restore-1",
  };
}

function makeBridge(): MockBridge {
  const workspace = makeWorkspaceSnapshot();
  const session = makeRestoredSession();

  return {
    session: {
      restore: vi.fn(async () => {
        console.log("[restore-smoke] session.restore()");
        return {
          restored: true,
          session,
        };
      }),
      load: vi.fn(async () => {
        console.log("[restore-smoke] session.load()");
        return session;
      }),
    },
    workspace: {
      load: vi.fn(async (input?: { workspaceId?: string }) => {
        console.log("[restore-smoke] workspace.load", input);
        const workspaceId = input?.workspaceId ?? session.workspaceId;
        if (workspaceId !== session.workspaceId) {
          throw new Error(`unexpected workspace id: ${workspaceId}`);
        }
        return workspace;
      }),
      refresh: vi.fn(async () => ({ ok: true })),
      selectPath: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => undefined),
    },
    diagnostics: {
      load: vi.fn(async (input?: { workspaceId?: string }) => ({
        workspaceId: input?.workspaceId ?? session.workspaceId,
        selectedPath: session.selectedPath,
        diagnostics: [
          {
            id: "diag-1",
            severity: "warning",
            message: "Restored workspace selection has one pending warning.",
          },
        ],
        summary: {
          total: 1,
          fatalCount: 0,
          errorCount: 0,
          warningCount: 1,
          infoCount: 0,
          byProducer: { eslint: 1 },
          byCategory: { lint: 1 },
          byFile: {
            [session.selectedPath]: 1,
          },
        },
        health: {
          level: "healthy",
          reasons: [],
        },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    shell: {
      status: vi.fn(async () => ({
        level: "healthy",
        actionAllowed: true,
        reasons: [],
        shell: {
          available: true,
          terminalReady: true,
          cwd: session.rootPath,
          shellPath: "/bin/zsh",
        },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    ledger: {
      load: vi.fn(async (input?: { ledgerId?: string }) => ({
        ledgerId: input?.ledgerId ?? session.ledgerId,
        headSeq: 12,
        selectedSeq: 12,
        replayable: true,
        entries: [],
        edges: [],
        metrics: {
          totalEntries: 12,
          totalEdges: 11,
          pendingEntries: 0,
          failedEntries: 0,
          replayEdges: 1,
          rollbackEdges: 0,
        },
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    verify: {
      load: vi.fn(async (input?: { verifyId?: string }) => ({
        verifyId: input?.verifyId ?? session.verifyId,
        status: "passed",
        phase: "completed",
        replayable: true,
        applyReadinessImpact: "ready",
        checks: [],
        artifacts: [],
        summary: {
          totalChecks: 4,
          passedChecks: 4,
          warningChecks: 0,
          failedChecks: 0,
          replayChecks: 1,
        },
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    patch: {
      load: vi.fn(async (input?: { patchId?: string }) => ({
        patchId: input?.patchId ?? session.patchId,
        title: "Renderer shell refactor",
        status: "in-review",
        files: [],
        comments: [],
        verifyEvidence: [],
        applyReadiness: "ready",
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    agent: {
      connect: vi.fn(async () => ({
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
        health: { level: "healthy", reasons: [] },
        streamState: "idle",
        pendingRequestCount: 0,
        messages: [],
        activeTools: [],
        jobs: [],
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
      })),
    },
  };
}

function normalizeRenderedText(container: HTMLElement): string {
  return (container.textContent ?? "").replace(/\s+/g, " ").trim();
}

function installBridgeOnWindow(bridge: MockBridge): void {
  Object.defineProperty(window, "adjutorix", {
    configurable: true,
    writable: true,
    value: bridge,
  });
}

async function renderAppWithBridge(bridge: MockBridge) {
  installBridgeOnWindow(bridge);

  const runtime = createRendererRuntime({
    bridge: (window as any).adjutorix,
  });

  const Providers = installRendererProviders(runtime);

  return render(
    <MemoryRouter>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/restore_workspace_session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("restores persisted workspace session, reattaches governed surfaces, and reaches visible ready state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.session.restore).toHaveBeenCalled();
      expect(bridge.workspace.load).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-restore-1" }));
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/adjutorix-app/i);
      expect(text).toMatch(/AppShell\.tsx/i);
    });

    expect(bridge.diagnostics.load).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-restore-1" }));
    expect(bridge.verify.load).toHaveBeenCalledWith({ verifyId: "verify-42" });
    expect(bridge.ledger.load).toHaveBeenCalledWith({ ledgerId: "ledger-42" });
    expect(bridge.patch.load).toHaveBeenCalledWith({ patchId: "patch-42" });
    expect(bridge.shell.status).toHaveBeenCalled();
    expect(bridge.agent.connect).toHaveBeenCalled();

    expect(bridge.workspace.subscribe).toHaveBeenCalled();
    expect(bridge.diagnostics.subscribe).toHaveBeenCalled();
  });

  it("fails closed when persisted session exists but workspace reattach fails", async () => {
    const bridge = makeBridge();
    bridge.workspace.load.mockRejectedValueOnce(new Error("workspace restore failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/workspace restore failed|error|failed/);
    });
  });

  it("fails closed when persisted session references stale selected path that no longer belongs to the restored workspace", async () => {
    const bridge = makeBridge();
    bridge.session.restore.mockResolvedValueOnce({
      restored: true,
      session: {
        ...makeRestoredSession(),
        selectedPath: "/repo/other-project/src/ghost.ts",
      },
    });

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/stale|invalid|restore|error|failed/);
    });
  });

  it("does nothing destructive when no restorable session exists and remains in ordinary cold-boot state", async () => {
    const bridge = makeBridge();
    bridge.session.restore.mockImplementation(async () => undefined);
    bridge.session.load.mockImplementation(async () => undefined);
    bridge.session.restore.mockResolvedValueOnce({
      restored: false,
      session: null,
    });

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.session.restore).toHaveBeenCalled();
    });

    expect(
      bridge.workspace.load.mock.calls.some(
        ([arg]) => !!arg && typeof arg === "object" && (arg as any).workspaceId === "ws-restore-1",
      ),
    ).toBe(false);
  });

  it("hydrates deterministically for identical restored-session inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/adjutorix-app/i);
    });

    const firstHtml = normalizeRenderedText(renderedA.container);
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/adjutorix-app/i);
    });

    expect(normalizeRenderedText(renderedB.container)).toBe(firstHtml);
  });
});
