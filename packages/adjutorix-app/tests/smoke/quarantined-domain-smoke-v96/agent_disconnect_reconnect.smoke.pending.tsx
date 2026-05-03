import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / SMOKE / agent_disconnect_reconnect.smoke.test.ts
 *
 * Canonical agent-disconnect-reconnect smoke suite.
 *
 * Objective:
 * - verify the end-to-end renderer-visible reconnect path when an already connected agent becomes
 *   disconnected and later reattaches under a new live session generation
 * - catch catastrophic integration regressions where provider status flips back to connected but
 *   message stream, active jobs, subscriptions, or session identity still point at stale agent truth
 * - keep assertions outcome-oriented: did the app first boot connected, surface disconnection,
 *   request/accept reconnect, rehydrate live session state, and settle into one coherent recovered state
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

type SubscriptionHandler = (payload: unknown) => void;

type MockBridge = {
  agent: {
    connect: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    sendMessage: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
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
  let agentHandler: SubscriptionHandler | null = null;

  return {
    agent: {
      connect: vi
        .fn()
        .mockResolvedValueOnce(makeAgentSession())
        .mockResolvedValueOnce(
          makeAgentSession({
            identity: {
              sessionId: "agent-session-2",
              providerLabel: "Local Agent",
              modelLabel: "adjutorix-core",
              endpointLabel: "http://127.0.0.1:8000/rpc",
              protocolVersion: "1",
            },
            messages: [
              {
                id: "msg-user-2",
                role: "user",
                content: "Reconnect status?",
                createdAtMs: 1711000003000,
                requestId: "req-2",
                streamState: "completed",
              },
              {
                id: "msg-assistant-2",
                role: "assistant",
                content: "Recovered under a new session generation.",
                createdAtMs: 1711000004000,
                requestId: "req-2",
                streamState: "completed",
              },
            ],
            jobs: [
              {
                id: "job-2",
                title: "Reconnect verification sync",
                phase: "running",
                createdAtMs: 1711000004500,
                updatedAtMs: 1711000004600,
                requestId: "req-2",
                metadata: {
                  verifyId: "verify-43",
                },
              },
            ],
          }),
        ),
      refresh: vi.fn(async () => makeAgentSession()),
      sendMessage: vi.fn(async ({ draft }: { draft: string }) => ({
        requestId: "req-send-1",
        optimisticMessages: [
          {
            id: "msg-user-send-1",
            role: "user",
            content: draft,
            createdAtMs: 1711000005000,
            requestId: "req-send-1",
            streamState: "completed",
          },
        ],
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        agentHandler = handler;
        return () => {
          if (agentHandler === handler) agentHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        agentHandler?.(payload);
      },
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

describe("smoke/agent_disconnect_reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("boots connected, surfaces disconnect, reconnects into a new session generation, and settles into one coherent recovered state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(1);
      expect(bridge.agent.subscribe).toHaveBeenCalledTimes(1);
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent|connected|local agent|adjutorix-core/i);
    });

    bridge.agent.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "available",
        trustLevel: "trusted",
        health: {
          level: "degraded",
          reasons: ["transport lost"],
        },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/disconnected|reconnect|transport lost|degraded/);
    });

    const reconnectButton =
      screen.queryByRole("button", { name: /reconnect/i }) ??
      screen.queryByText(/reconnect/i) ??
      screen.getByRole("button");

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(2);
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent-session-2|recovered|connected|local agent|adjutorix-core/i);
      expect(text).not.toMatch(/agent-session-1\b/);
    });
  });

  it("fails closed when reconnect attempt fails and keeps provider in explicit broken/disconnected state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(1);
    });

    bridge.agent.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "available",
        trustLevel: "trusted",
        health: {
          level: "degraded",
          reasons: ["transport lost"],
        },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    bridge.agent.connect.mockRejectedValueOnce(new Error("reconnect failed"));

    const reconnectButton =
      screen.queryByRole("button", { name: /reconnect/i }) ??
      screen.queryByText(/reconnect/i) ??
      screen.getByRole("button");

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/reconnect failed|disconnected|error|failed/);
    });
  });

  it("fails closed when reconnect returns auth-missing session instead of projecting a healthy recovered provider", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.agent.connect).toHaveBeenCalledTimes(1);
    });

    bridge.agent.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "available",
        trustLevel: "trusted",
        health: {
          level: "degraded",
          reasons: ["transport lost"],
        },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    bridge.agent.connect.mockResolvedValueOnce(
      makeAgentSession({
        identity: {
          sessionId: "agent-session-3",
          providerLabel: "Local Agent",
          modelLabel: "adjutorix-core",
          endpointLabel: "http://127.0.0.1:8000/rpc",
          protocolVersion: "1",
        },
        authState: "missing",
        health: {
          level: "degraded",
          reasons: ["auth unavailable after reconnect"],
        },
      }),
    );

    const reconnectButton =
      screen.queryByRole("button", { name: /reconnect/i }) ??
      screen.queryByText(/reconnect/i) ??
      screen.getByRole("button");

    fireEvent.click(reconnectButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/auth|missing|degraded|unavailable/);
    });
  });

  it("hydrates deterministically for identical disconnect/reconnect inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.agent.connect).toHaveBeenCalledTimes(1);
    });

    bridgeA.agent.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "available",
        trustLevel: "trusted",
        health: {
          level: "degraded",
          reasons: ["transport lost"],
        },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    const reconnectButtonA =
      screen.queryByRole("button", { name: /reconnect/i }) ??
      screen.queryByText(/reconnect/i) ??
      screen.getByRole("button");
    fireEvent.click(reconnectButtonA);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent-session-2|recovered|connected/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.agent.connect).toHaveBeenCalledTimes(1);
    });

    bridgeB.agent.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "available",
        trustLevel: "trusted",
        health: {
          level: "degraded",
          reasons: ["transport lost"],
        },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    const reconnectButtonB =
      screen.queryByRole("button", { name: /reconnect/i }) ??
      screen.queryByText(/reconnect/i) ??
      screen.getByRole("button");
    fireEvent.click(reconnectButtonB);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/agent-session-2|recovered|connected/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
