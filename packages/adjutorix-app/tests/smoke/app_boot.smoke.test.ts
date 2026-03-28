import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / SMOKE / app_boot.smoke.test.ts
 *
 * Canonical app-boot smoke suite.
 *
 * Objective:
 * - verify the end-to-end first-load path from preload exposure through renderer bootstrap,
 *   initial state hydration, governed surface wiring, and first visible ready-state projection
 * - catch catastrophic integration regressions where subsystems are individually valid but the
 *   application never reaches a coherent booted shell
 * - keep the assertions outcome-oriented: did the app mount, wire the bridge, request baseline
 *   data, surface key governed panels, and settle into a ready UI state without hidden failure
 *
 * Notes:
 * - this suite assumes a renderer bootstrap module and app shell entry compatible with the imports below
 * - if actual bootstrap exports differ, adapt the test harness first rather than weakening boot guarantees
 */

import React from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import App from "../../../src/renderer/App";
import { installRendererProviders } from "../../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../../src/renderer/bootstrap/createRendererRuntime";

type MockBridge = {
  workspace: {
    load: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  patch: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  verify: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  ledger: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

function makeBridge(): MockBridge {
  return {
    workspace: {
      load: vi.fn(async () => ({
        workspaceId: "ws-1",
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
            childCount: 1,
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
        ],
        expandedPaths: ["/repo/adjutorix-app"],
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
          watchedPaths: 12,
          eventLagMs: 5,
        },
      })),
      refresh: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn((handler: (payload: unknown) => void) => {
        return () => undefined;
      }),
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
        health: {
          level: "healthy",
          reasons: [],
        },
        streamState: "idle",
        pendingRequestCount: 0,
        messages: [],
        activeTools: [],
        jobs: [],
      })),
      refresh: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn(() => () => undefined),
    },
    patch: {
      load: vi.fn(async () => ({
        patchId: "patch-42",
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
    verify: {
      load: vi.fn(async () => ({
        verifyId: "verify-42",
        status: "passed",
        phase: "completed",
        replayable: true,
        applyReadinessImpact: "ready",
        checks: [],
        artifacts: [],
        summary: {
          totalChecks: 3,
          passedChecks: 3,
          warningChecks: 0,
          failedChecks: 0,
          replayChecks: 1,
        },
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    ledger: {
      load: vi.fn(async () => ({
        ledgerId: "ledger-42",
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
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-1",
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
        health: { level: "healthy", reasons: [] },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        telemetry: false,
        confirmations: true,
      })),
    },
    shell: {
      status: vi.fn(async () => ({
        level: "healthy",
        actionAllowed: true,
        reasons: [],
        shell: {
          available: true,
          terminalReady: true,
          cwd: "/repo/adjutorix-app",
          shellPath: "/bin/zsh",
        },
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

describe("smoke/app_boot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("boots the renderer shell, hydrates baseline governed domains, and reaches a visible ready state", async () => {
    const bridge = makeBridge();
    installBridgeOnWindow(bridge);

    const runtime = createRendererRuntime({
      bridge: (window as any).adjutorix,
    });

    const Providers = installRendererProviders(runtime);

    render(
      <MemoryRouter>
        <Providers>
          <App />
        </Providers>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
      expect(bridge.agent.connect).toHaveBeenCalled();
      expect(bridge.verify.load).toHaveBeenCalled();
      expect(bridge.ledger.load).toHaveBeenCalled();
      expect(bridge.diagnostics.load).toHaveBeenCalled();
      expect(bridge.settings.load).toHaveBeenCalled();
      expect(bridge.shell.status).toHaveBeenCalled();
    });

    await waitFor(() => {
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    expect(bridge.workspace.subscribe).toHaveBeenCalled();
    expect(bridge.agent.subscribe).toHaveBeenCalled();
    expect(bridge.patch.subscribe).toHaveBeenCalled();
    expect(bridge.verify.subscribe).toHaveBeenCalled();
    expect(bridge.ledger.subscribe).toHaveBeenCalled();
    expect(bridge.diagnostics.subscribe).toHaveBeenCalled();
    expect(bridge.shell.subscribe).toHaveBeenCalled();
  });

  it("does not reach ready state when the preload bridge is missing and instead fails visibly/explicitly", async () => {
    const runtime = createRendererRuntime({
      bridge: undefined as any,
    });

    const Providers = installRendererProviders(runtime);

    render(
      <MemoryRouter>
        <Providers>
          <App />
        </Providers>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/bridge|preload|unavailable|missing|error/);
    });
  });

  it("fails closed on baseline hydration error instead of presenting a false healthy shell", async () => {
    const bridge = makeBridge();
    bridge.workspace.load.mockRejectedValueOnce(new Error("workspace bootstrap failed"));
    installBridgeOnWindow(bridge);

    const runtime = createRendererRuntime({
      bridge: (window as any).adjutorix,
    });
    const Providers = installRendererProviders(runtime);

    render(
      <MemoryRouter>
        <Providers>
          <App />
        </Providers>
      </MemoryRouter>,
    );

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/workspace bootstrap failed|error|failed/);
    });
  });

  it("hydrates deterministically for identical boot inputs", async () => {
    const bridgeA = makeBridge();
    installBridgeOnWindow(bridgeA);

    const runtimeA = createRendererRuntime({ bridge: (window as any).adjutorix });
    const ProvidersA = installRendererProviders(runtimeA);

    const a = render(
      <MemoryRouter>
        <ProvidersA>
          <App />
        </ProvidersA>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    const firstHtml = a.container.innerHTML;
    a.unmount();

    const bridgeB = makeBridge();
    installBridgeOnWindow(bridgeB);

    const runtimeB = createRendererRuntime({ bridge: (window as any).adjutorix });
    const ProvidersB = installRendererProviders(runtimeB);

    const b = render(
      <MemoryRouter>
        <ProvidersB>
          <App />
        </ProvidersB>
      </MemoryRouter>,
    );

    await waitFor(() => {
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    expect(b.container.innerHTML).toBe(firstHtml);
  });
});
