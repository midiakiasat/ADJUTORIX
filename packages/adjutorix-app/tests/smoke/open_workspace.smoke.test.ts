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

import App from "../../../src/renderer/App";
import { installRendererProviders } from "../../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../../src/renderer/bootstrap/createRendererRuntime";

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
  const snapshot = makeWorkspaceSnapshot();

  return {
    workspace: {
      open: vi.fn(async () => ({
        cancelled: false,
        workspaceId: snapshot.workspaceId,
        rootPath: snapshot.rootPath,
      })),
      load: vi.fn(async () => snapshot),
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
      load: vi.fn(async () => ({
        workspaceId: snapshot.workspaceId,
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
          cwd: snapshot.rootPath,
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
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    const openButton =
      screen.queryByRole("button", { name: /open workspace/i }) ??
      screen.queryByText(/open workspace/i) ??
      screen.getByRole("button");

    fireEvent.click(openButton);

    await waitFor(() => {
      expect(bridge.workspace.open).toHaveBeenCalledTimes(1);
      expect(bridge.workspace.load).toHaveBeenCalledWith({ workspaceId: "ws-open-1" });
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/adjutorix-app/i);
      expect(document.body.textContent ?? "").toMatch(/src/i);
    });

    expect(bridge.workspace.subscribe).toHaveBeenCalled();
    expect(bridge.diagnostics.load).toHaveBeenCalledWith({ workspaceId: "ws-open-1" });
    expect(bridge.diagnostics.subscribe).toHaveBeenCalled();
    expect(bridge.shell.status).toHaveBeenCalled();
    expect(bridge.shell.subscribe).toHaveBeenCalled();
  });

  it("does not attach a workspace when the picker is cancelled and keeps the shell in no-workspace state", async () => {
    const bridge = makeBridge();
    bridge.workspace.open.mockResolvedValueOnce({
      cancelled: true,
      workspaceId: null,
      rootPath: null,
    });

    await renderAppWithBridge(bridge);

    const openButton =
      screen.queryByRole("button", { name: /open workspace/i }) ??
      screen.queryByText(/open workspace/i) ??
      screen.getByRole("button");

    fireEvent.click(openButton);

    await waitFor(() => {
      expect(bridge.workspace.open).toHaveBeenCalledTimes(1);
    });

    expect(bridge.workspace.load).not.toHaveBeenCalledWith({ workspaceId: "ws-open-1" });
    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).not.toMatch(/rootPath/i);
  });

  it("fails closed when workspace open succeeds but workspace load fails, instead of presenting a false attached state", async () => {
    const bridge = makeBridge();
    bridge.workspace.load.mockRejectedValueOnce(new Error("workspace load failed"));

    await renderAppWithBridge(bridge);

    const openButton =
      screen.queryByRole("button", { name: /open workspace/i }) ??
      screen.queryByText(/open workspace/i) ??
      screen.getByRole("button");

    fireEvent.click(openButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/workspace load failed|error|failed/);
    });
  });

  it("hydrates deterministically for identical open-workspace inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    const openButtonA =
      screen.queryByRole("button", { name: /open workspace/i }) ??
      screen.queryByText(/open workspace/i) ??
      screen.getByRole("button");

    fireEvent.click(openButtonA);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/adjutorix-app/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    const openButtonB =
      screen.queryByRole("button", { name: /open workspace/i }) ??
      screen.queryByText(/open workspace/i) ??
      screen.getByRole("button");

    fireEvent.click(openButtonB);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/adjutorix-app/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
