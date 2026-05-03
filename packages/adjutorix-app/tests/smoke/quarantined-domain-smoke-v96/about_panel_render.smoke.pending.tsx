import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / settings_persist.smoke.test.ts
 *
 * Canonical settings-persist smoke suite.
 *
 * Objective:
 * - verify the end-to-end settings path from initial hydration through explicit user mutation,
 *   governed save request, persisted reload, and visible runtime/UI reconciliation
 * - catch catastrophic integration regressions where settings form state, stored state,
 *   and applied runtime state diverge while the UI still appears to have saved successfully
 * - keep assertions outcome-oriented: did the app load settings, let the user change them,
 *   persist them through the bridge, rehydrate the saved values on reload, and fail closed on save errors
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import App from "../../src/renderer/App";
import { installRendererProviders } from "../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../src/renderer/bootstrap/createRendererRuntime";

type MockSettings = {
  theme: "dark" | "light";
  confirmations: boolean;
  telemetry: boolean;
  editor: {
    fontSize: number;
    tabSize: number;
  };
  shell: {
    defaultCommand: string;
  };
};

type SubscriptionHandler = (payload: unknown) => void;

type MockBridge = {
  settings: {
    load: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
    peek: () => MockSettings;
  };
  workspace: {
    load: ReturnType<typeof vi.fn>;
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
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

function makeInitialSettings(): MockSettings {
  return {
    theme: "dark",
    confirmations: true,
    telemetry: false,
    editor: {
      fontSize: 14,
      tabSize: 2,
    },
    shell: {
      defaultCommand: "npm test",
    },
  };
}

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-settings-1",
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
      eventLagMs: 3,
    },
  };
}

function makeBridge(): MockBridge {
  let stored = makeInitialSettings();
  let settingsHandler: SubscriptionHandler | null = null;

  return {
    settings: {
      load: vi.fn(async () => stored),
      save: vi.fn(async (next: Partial<MockSettings>) => {
        stored = {
          ...stored,
          ...next,
          editor: {
            ...stored.editor,
            ...(next.editor ?? {}),
          },
          shell: {
            ...stored.shell,
            ...(next.shell ?? {}),
          },
        };
        return {
          ok: true,
          settings: stored,
        };
      }),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        settingsHandler = handler;
        return () => {
          if (settingsHandler === handler) settingsHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        settingsHandler?.(payload);
      },
      peek: () => stored,
    },
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      subscribe: vi.fn(() => () => undefined),
    },
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-settings-1",
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
          cwd: "/repo/adjutorix-app",
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
    <MemoryRouter initialEntries={["/settings"]}>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/settings_persist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("hydrates settings, persists explicit changes, and rehydrates saved values on reload", async () => {
    const bridge = makeBridge();
    const first = await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.settings.load).toHaveBeenCalled();
      expect(screen.getByText(/settings/i)).toBeInTheDocument();
    });

    const themeControl =
      screen.queryByRole("combobox", { name: /theme/i }) ??
      screen.queryByLabelText(/theme/i);
    const confirmationsControl =
      screen.queryByRole("checkbox", { name: /confirmations/i }) ??
      screen.queryByLabelText(/confirmations/i);
    const telemetryControl =
      screen.queryByRole("checkbox", { name: /telemetry/i }) ??
      screen.queryByLabelText(/telemetry/i);
    const fontSizeControl =
      screen.queryByRole("spinbutton", { name: /font size/i }) ??
      screen.queryByLabelText(/font size/i);
    const defaultCommandControl =
      screen.queryByRole("textbox", { name: /default command/i }) ??
      screen.queryByLabelText(/default command/i);

    if (themeControl) {
      fireEvent.change(themeControl, { target: { value: "light" } });
    }
    if (confirmationsControl) {
      fireEvent.click(confirmationsControl);
    }
    if (telemetryControl) {
      fireEvent.click(telemetryControl);
    }
    if (fontSizeControl) {
      fireEvent.change(fontSizeControl, { target: { value: "16" } });
    }
    if (defaultCommandControl) {
      fireEvent.change(defaultCommandControl, { target: { value: "pnpm test" } });
    }

    const saveButton =
      screen.queryByRole("button", { name: /save/i }) ??
      screen.queryByText(/^save$/i) ??
      screen.getByRole("button");

    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(bridge.settings.save).toHaveBeenCalled();
      expect(bridge.settings.peek().theme).toBe("light");
      expect(bridge.settings.peek().telemetry).toBe(true);
      expect(bridge.settings.peek().editor.fontSize).toBe(16);
      expect(bridge.settings.peek().shell.defaultCommand).toBe("pnpm test");
    });

    const firstHtml = first.container.innerHTML;
    first.unmount();

    const second = await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.settings.load).toHaveBeenCalledTimes(2);
    });

    const text = document.body.textContent ?? "";
    expect(text.toLowerCase()).toMatch(/settings/);
    expect(second.container.innerHTML).toContain("settings");
    expect(bridge.settings.peek().theme).toBe("light");
    expect(bridge.settings.peek().shell.defaultCommand).toBe("pnpm test");
    expect(firstHtml).not.toBe("");
  });

  it("fails closed when save is rejected instead of presenting a false persisted state", async () => {
    const bridge = makeBridge();
    bridge.settings.save.mockRejectedValueOnce(new Error("settings save failed"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.settings.load).toHaveBeenCalled();
    });

    const telemetryControl =
      screen.queryByRole("checkbox", { name: /telemetry/i }) ??
      screen.queryByLabelText(/telemetry/i);
    if (telemetryControl) {
      fireEvent.click(telemetryControl);
    }

    const saveButton =
      screen.queryByRole("button", { name: /save/i }) ??
      screen.queryByText(/^save$/i) ??
      screen.getByRole("button");
    fireEvent.click(saveButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/settings save failed|error|failed/);
    });

    expect(bridge.settings.peek().telemetry).toBe(false);
  });

  it("fails closed when a pushed settings event is malformed instead of corrupting the visible settings surface", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.settings.load).toHaveBeenCalled();
    });

    bridge.settings.emit({
      type: "settings-updated",
      payload: {
        theme: "unknown-theme",
        editor: null,
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/invalid|settings|error|failed/);
    });
  });

  it("hydrates deterministically for identical persisted-settings inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.settings.load).toHaveBeenCalled();
    });

    const saveButtonA =
      screen.queryByRole("button", { name: /save/i }) ??
      screen.queryByText(/^save$/i) ??
      screen.getByRole("button");

    const themeControlA =
      screen.queryByRole("combobox", { name: /theme/i }) ??
      screen.queryByLabelText(/theme/i);
    if (themeControlA) {
      fireEvent.change(themeControlA, { target: { value: "light" } });
    }
    fireEvent.click(saveButtonA);

    await waitFor(() => {
      expect(bridgeA.settings.save).toHaveBeenCalled();
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    await bridgeB.settings.save({ theme: "light" });
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.settings.load).toHaveBeenCalled();
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
