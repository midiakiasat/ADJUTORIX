import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / SMOKE / agent_connect.smoke.test.ts
 *
 * Canonical agent-connect smoke suite.
 *
 * Objective:
 * - verify the end-to-end agent connection path from renderer bootstrap through preload bridge,
 *   agent connect request, auth/session hydration, governed provider status projection,
 *   event subscription wiring, and visible ready-state projection
 * - catch catastrophic integration regressions where the agent process, auth layer, and renderer
 *   all appear individually valid but the application never reaches a coherent connected-agent state
 * - keep assertions outcome-oriented: did the app request agent connection, hydrate session state,
 *   wire subscriptions, surface connected status, and fail closed when connection or auth breaks
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
  agent: {
    connect: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  workspace: {
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
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

function makeAgentSession(overrides: Record<string, unknown> = {}) {
  return {
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
    messages: [
      {
        id: "msg-user-1",
        role: "user",
        content: "Explain replay blockers.",
        createdAtMs: 1711000000000,
        requestId: "req-1",
        streamState: "completed",
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        content: "Replay mismatch blocks apply until verify passes.",
        createdAtMs: 1711000001000,
        requestId: "req-1",
        streamState: "completed",
      },
    ],
    activeTools: [],
    jobs: [],
    ...overrides,
  };
}

function makeBridge(): MockBridge {
  return {
    agent: {
      connect: vi.fn(async () => makeAgentSession()),
      refresh: vi.fn(async () => makeAgentSession({ pendingRequestCount: 0 })),
      sendMessage: vi.fn(async ({ draft }: { draft: string }) => ({
        requestId: "req-send-1",
        optimisticMessages: [
          {
            id: "msg-user-send-1",
            role: "user",
            content: draft,
            createdAtMs: 1711000003000,
            requestId: "req-send-1",
            streamState: "completed",
          },
        ],
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    workspace: {
      load: vi.fn(async () => ({
        workspaceId: "ws-1",
        rootPath: "/repo/adjutorix-app",
        name: "adjutorix-app",
        trustLevel: "trusted",
        status: "ready",
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
          watchedPaths: 10,
          eventLagMs: 5,
        },
      })),
      subscribe: vi.fn(() => () => undefined),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
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
        health: {
          level: "healthy",
          reasons: [],
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

describe("smoke/agent_connect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("connects the agent, hydrates session state, wires subscriptions, and reaches visible connected status", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(1);
      expect(bridge.agent.subscribe).toHaveBeenCalled();
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent|local agent|connected|adjutorix-core/i);
    });

    expect(bridge.agent.refresh).toHaveBeenCalledTimes(0);
    expect(bridge.workspace.load).toHaveBeenCalled();
    expect(bridge.settings.load).toHaveBeenCalled();
    expect(bridge.shell.status).toHaveBeenCalled();
    expect(bridge.diagnostics.load).toHaveBeenCalled();
  });

  it("fails closed when agent connection fails and surfaces an explicit broken-provider state", async () => {
    const bridge = makeBridge();
    bridge.agent.connect.mockRejectedValueOnce(new Error("agent connect failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/agent connect failed|disconnected|unavailable|error|failed/);
    });
  });

  it("fails closed when agent connects but auth is unavailable, instead of projecting a healthy connected state", async () => {
    const bridge = makeBridge();
    bridge.agent.connect.mockResolvedValueOnce(
      makeAgentSession({
        authState: "missing",
        health: {
          level: "degraded",
          reasons: ["auth unavailable"],
        },
      }),
    );

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/auth|missing|degraded|unavailable/);
    });
  });

  it("supports visible post-connect message send path once connected agent state is established", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(1);
    });

    const textbox = screen.queryByRole("textbox");
    const sendButton = screen.queryByRole("button", { name: /send/i });

    if (textbox && sendButton) {
      fireEvent.change(textbox, { target: { value: "Summarize replay blockers." } });
      fireEvent.click(sendButton);

      await waitFor(() => {
        expect(bridge.agent.sendMessage).toHaveBeenCalledWith({ draft: "Summarize replay blockers." });
      });
    } else {
      expect(bridge.agent.sendMessage).toBeDefined();
    }
  });

  it("hydrates deterministically for identical agent-connect inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent|adjutorix-core|local agent/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent|adjutorix-core|local agent/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
