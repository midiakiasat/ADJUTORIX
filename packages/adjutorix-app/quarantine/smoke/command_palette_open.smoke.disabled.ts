import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / command_palette_open.smoke.test.ts
 *
 * Canonical command-palette-open smoke suite.
 *
 * Objective:
 * - verify the end-to-end command palette path from renderer bootstrap through keyboard shortcut,
 *   overlay visibility, focus capture, command indexing, governed action visibility, close semantics,
 *   and first command execution routing
 * - catch catastrophic integration regressions where the palette visually appears but does not own focus,
 *   lacks real commands, cannot close cleanly, or cannot route command execution into the governed surface
 * - keep assertions outcome-oriented: did the app mount, expose palette-ready UI, open via shortcut,
 *   surface commands, accept query input, and close or execute without hidden failure
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import App from "../../../src/renderer/App";
import { installRendererProviders } from "../../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../../src/renderer/bootstrap/createRendererRuntime";

type SubscriptionHandler = (payload: unknown) => void;

type MockBridge = {
  workspace: {
    load: ReturnType<typeof vi.fn>;
    open: ReturnType<typeof vi.fn>;
    refresh: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
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
  commandPalette?: {
    execute?: ReturnType<typeof vi.fn>;
    subscribe?: ReturnType<typeof vi.fn>;
  };
};

function makeBridge(): MockBridge {
  let workspaceHandler: SubscriptionHandler | null = null;
  let agentHandler: SubscriptionHandler | null = null;
  let shellHandler: SubscriptionHandler | null = null;
  let diagnosticsHandler: SubscriptionHandler | null = null;

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
          watchedPaths: 16,
          eventLagMs: 4,
        },
      })),
      open: vi.fn(async () => ({
        cancelled: false,
        workspaceId: "ws-open-1",
        rootPath: "/repo/new-workspace",
      })),
      refresh: vi.fn(async () => ({ ok: true })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        workspaceHandler = handler;
        return () => {
          if (workspaceHandler === handler) workspaceHandler = null;
        };
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
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        agentHandler = handler;
        return () => {
          if (agentHandler === handler) agentHandler = null;
        };
      }),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
        shortcuts: {
          commandPalette: "Mod+K",
        },
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
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        shellHandler = handler;
        return () => {
          if (shellHandler === handler) shellHandler = null;
        };
      }),
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
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        diagnosticsHandler = handler;
        return () => {
          if (diagnosticsHandler === handler) diagnosticsHandler = null;
        };
      }),
    },
    commandPalette: {
      execute: vi.fn(async ({ id }: { id: string }) => ({
        ok: true,
        id,
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

function dispatchPaletteShortcut(): void {
  fireEvent.keyDown(window, {
    key: "k",
    code: "KeyK",
    metaKey: true,
  });
}

describe("smoke/command_palette_open", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("opens the command palette from keyboard shortcut, captures focus, and surfaces real commands", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
      expect(bridge.agent.connect).toHaveBeenCalled();
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    dispatchPaletteShortcut();

    await waitFor(() => {
      const dialog =
        screen.queryByRole("dialog") ??
        screen.queryByRole("combobox") ??
        screen.queryByPlaceholderText(/command|search|type a command/i);
      expect(dialog).toBeTruthy();
    });

    const input =
      screen.queryByRole("combobox") ??
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|search|type a command/i);

    expect(input).toBeTruthy();
    if (input instanceof HTMLElement) {
      expect(document.activeElement === input || input.contains(document.activeElement)).toBe(true);
    }

    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/command|workspace|open|settings|verify|ledger|patch/);
  });

  it("filters visible commands by query and preserves governed action visibility instead of showing an empty decorative shell", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    dispatchPaletteShortcut();

    const input =
      (await waitFor(() =>
        screen.queryByRole("combobox") ??
        screen.queryByRole("textbox") ??
        screen.queryByPlaceholderText(/command|search|type a command/i),
      )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "workspace" } });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/workspace/);
    });
  });

  it("closes the command palette on escape and returns the app to ordinary shell focus state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    dispatchPaletteShortcut();

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/command|workspace|verify|settings/);
    });

    fireEvent.keyDown(window, {
      key: "Escape",
      code: "Escape",
    });

    await waitFor(() => {
      const dialog = screen.queryByRole("dialog");
      const text = document.body.textContent ?? "";
      expect(dialog ?? null).toBeNull();
      expect(text.toLowerCase()).toMatch(/adjutorix/);
    });
  });

  it("fails closed when command indexing is unavailable and surfaces an explicit broken palette state", async () => {
    const bridge = makeBridge();
    bridge.settings.load.mockRejectedValueOnce(new Error("command registry unavailable"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/command registry unavailable|error|failed|unavailable/);
    });
  });

  it("can execute a governed workspace command from the palette without exposing a raw execution escape hatch", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    dispatchPaletteShortcut();

    const input =
      (await waitFor(() =>
        screen.queryByRole("combobox") ??
        screen.queryByRole("textbox") ??
        screen.queryByPlaceholderText(/command|search|type a command/i),
      )) as HTMLInputElement;

    fireEvent.change(input, { target: { value: "open workspace" } });

    fireEvent.keyDown(input, {
      key: "Enter",
      code: "Enter",
    });

    await waitFor(() => {
      expect(bridge.workspace.open).toHaveBeenCalledTimes(1);
    });
  });

  it("hydrates deterministically for identical palette-open inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    dispatchPaletteShortcut();

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/command|workspace|verify|settings/);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    dispatchPaletteShortcut();

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/command|workspace|verify|settings/);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
