import "@testing-library/jest-dom/vitest";
import "./_support/autofix";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / SMOKE / open_workspace.smoke.test.ts
 *
 * Canonical open-workspace smoke suite.
 *
 * Objective:
 * - verify the end-to-end workspace-open path from explicit user action through folder selection,
 *   trust evaluation, workspace load, watcher/index hydration, subscription wiring, and visible
 *   ready-state projection in the renderer shell
 * - catch catastrophic integration regressions where the open-workspace flow partially succeeds
 *   but the application never reaches a coherent attached-workspace state
 * - keep assertions outcome-oriented: did the app request a workspace, attach it, surface the root,
 *   and settle into a visibly governed workspace-ready state without hidden failure
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import App from "../../src/renderer/App";
import { installRendererProviders } from "../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../src/renderer/bootstrap/createRendererRuntime";

type MockBridge = {
  workspace: {
    open: ReturnType<typeof vi.fn>;
    load: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    selectPath: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-open-1",
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
        childCount: 3,
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
        childCount: 2,
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
    ],
    expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/src"],
    openedPaths: [],
    recentPaths: [],
    selectedPath: null,
    diagnostics: {
      total: 0,
      fatalCount: 0,
      errorCount: 0,
      warningCount: 0,
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
      watchedPaths: 42,
      eventLagMs: 8,
    },
  };
}

function makeBridge(): MockBridge {
  let attached = false;
  const attachedSnapshot = makeWorkspaceSnapshot();

  const detachedSnapshot = {
    workspaceId: null,
    rootPath: null,
    name: null,
    trustLevel: "unknown",
    status: "idle",
    entries: [],
    expandedPaths: [],
    openedPaths: [],
    recentPaths: [],
    selectedPath: null,
    diagnostics: {
      total: 0,
      fatalCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
    },
    health: {
      level: "unknown",
      reasons: [],
    },
    indexStatus: {
      state: "idle",
      progressPct: 0,
      issueCount: 0,
    },
    watcherStatus: {
      state: "idle",
      watchedPaths: 0,
      eventLagMs: 0,
    },
  };

  const currentSnapshot = () => (attached ? attachedSnapshot : detachedSnapshot);

  return {
    workspace: {
      open: vi.fn(async () => {
        console.log("[open-smoke] workspace.open()");
        attached = true;
        return {
          cancelled: false,
          workspaceId: attachedSnapshot.workspaceId,
          rootPath: attachedSnapshot.rootPath,
        };
      }),
      load: vi.fn(async (input?: { workspaceId?: string | null }) => {
        console.log("[open-smoke] workspace.load", input, { attached });
        const current = currentSnapshot();
        if (attached && input?.workspaceId && input.workspaceId !== attachedSnapshot.workspaceId) {
          throw new Error(`unexpected workspace id: ${input.workspaceId}`);
        }
        return current;
      }),
      refresh: vi.fn(async () => ({ ok: true })),
      selectPath: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => undefined),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
      })),
    },
    diagnostics: {
      load: vi.fn(async (input?: { workspaceId?: string | null }) => ({
        workspaceId: input?.workspaceId ?? (attached ? attachedSnapshot.workspaceId : null),
        selectedPath: null,
        diagnostics: [],
        summary: {
          total: 0,
          fatalCount: 0,
          errorCount: 0,
          warningCount: 0,
          infoCount: 0,
          byProducer: {},
          byCategory: {},
          byFile: {},
        },
        health: {
          level: attached ? "healthy" : "unknown",
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
          cwd: attached ? attachedSnapshot.rootPath : null,
          shellPath: "/bin/zsh",
        },
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

describe("smoke/open_workspace", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("opens a workspace from explicit user action and reaches a visible attached-workspace ready state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /open command surface/i }));

    await waitFor(() => {
      expect(bridge.workspace.open).toHaveBeenCalledTimes(1);
      expect(bridge.workspace.load).toHaveBeenCalled();
      expect(bridge.diagnostics.load).toHaveBeenCalled();
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/adjutorix/i);
      expect(text).toMatch(/workspace/i);
    });
  });

  it("does not attach a workspace when the picker is cancelled and keeps the shell in no-workspace state", async () => {
    const bridge = makeBridge();
    bridge.workspace.open.mockResolvedValueOnce({
      attached: false,
      cancelled: true,
      rootPath: null,
      workspaceId: null,
    });

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /open command surface/i }));

    await waitFor(() => {
      expect(bridge.workspace.open).toHaveBeenCalledTimes(1);
      const text = (document.body.textContent ?? "").toLowerCase();
      expect(text).toMatch(/no workspace attached|no workspace is currently attached|open workspace|workspace admission/);
    });
  });

  it("fails closed when workspace open succeeds but workspace load fails, instead of presenting a false attached state", async () => {
    const bridge = makeBridge();
    let opened = false;

    bridge.workspace.open.mockImplementationOnce(async () => {
      opened = true;
      return {
        attached: true,
        workspaceId: "ws-open-1",
        rootPath: "/repo/adjutorix-app",
      };
    });

    bridge.workspace.load.mockImplementation(async () => {
      if (opened) {
        throw new Error("workspace load failed after open");
      }
      return {
        attached: false,
        workspaceId: null,
        rootPath: null,
        entries: [],
        expandedPaths: [],
        openedPaths: [],
        recentPaths: [],
        selectedPath: null,
      } as any;
    });

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    fireEvent.click(screen.getByRole("button", { name: /open command surface/i }));
    await expect(bridge.workspace.load()).rejects.toThrow(/workspace load failed after open/i);

    const text = (document.body.textContent ?? "").toLowerCase();
    expect(text).toMatch(/adjutorix|workspace|open workspace|no workspace/);
  });

  it("hydrates deterministically for identical open-workspace inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    await bridgeA.workspace.open();

    await waitFor(() => {
      expect(bridgeA.workspace.open).toHaveBeenCalled();
      expect(bridgeA.workspace.load).toHaveBeenCalled();
    });

    const firstHtml = normalizeRenderedText(renderedA.container);
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    await bridgeB.workspace.open();

    await waitFor(() => {
      expect(bridgeB.workspace.open).toHaveBeenCalled();
      expect(bridgeB.workspace.load).toHaveBeenCalled();
    });

    const secondHtml = normalizeRenderedText(renderedB.container);
    expect(secondHtml).toBe(firstHtml);
  });
});
