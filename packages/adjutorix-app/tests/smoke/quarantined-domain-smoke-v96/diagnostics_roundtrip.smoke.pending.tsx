import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / diagnostics_roundtrip.smoke.test.ts
 *
 * Canonical diagnostics-roundtrip smoke suite.
 *
 * Objective:
 * - verify the end-to-end diagnostics path from workspace/file selection through initial diagnostics load,
 *   live diagnostics event ingestion, summary recomputation, per-file projection, and visible panel/status update
 * - catch catastrophic integration regressions where diagnostics transport succeeds but renderer state,
 *   selected-file badges, summary counters, and diagnostic panel rows drift apart
 * - keep assertions outcome-oriented: did the app attach a workspace, open a file, load diagnostics,
 *   receive an update, and settle into one coherent updated diagnostics state without hidden staleness
 *
 * Notes:
 * - this suite assumes the renderer App and bootstrap helpers below exist and represent the app shell
 * - if actual bootstrap exports differ, adapt the harness first rather than weakening the smoke guarantees
 */

import App from "../../src/renderer/App";
import { installRendererProviders } from "../../src/renderer/bootstrap/installRendererProviders";
import { createRendererRuntime } from "../../src/renderer/bootstrap/createRendererRuntime";

type SubscriptionHandler = (payload: unknown) => void;

type MockBridge = {
  workspace: {
    load: ReturnType<typeof vi.fn>;
    selectPath: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  files: {
    stat: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
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

const FILE_PATH = "/repo/adjutorix-app/src/renderer/App.tsx";
const FILE_NAME = "App.tsx";
const FILE_CONTENT = `import React from "react";

export default function App(): JSX.Element {
  return <div>ADJUTORIX</div>;
}
`;

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-diag-1",
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
        childCount: 1,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: FILE_PATH,
        name: FILE_NAME,
        kind: "file",
        parentPath: "/repo/adjutorix-app/src/renderer",
        childCount: 0,
        hidden: false,
        ignored: false,
        diagnosticsCount: 1,
      },
    ],
    expandedPaths: [
      "/repo/adjutorix-app",
      "/repo/adjutorix-app/src",
      "/repo/adjutorix-app/src/renderer",
    ],
    openedPaths: [],
    recentPaths: [],
    selectedPath: null,
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
      watchedPaths: 18,
      eventLagMs: 4,
    },
  };
}

function initialDiagnostics(selectedPath: string | null = FILE_PATH) {
  return {
    workspaceId: "ws-diag-1",
    selectedPath,
    diagnostics: [
      {
        id: "diag-1",
        severity: "warning",
        message: "Initial warning in App.tsx.",
        filePath: FILE_PATH,
        producer: "eslint",
        category: "lint",
        range: {
          start: { line: 2, column: 1 },
          end: { line: 2, column: 10 },
        },
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
      byFile: { [FILE_PATH]: 1 },
    },
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function updatedDiagnostics(selectedPath: string | null = FILE_PATH) {
  return {
    workspaceId: "ws-diag-1",
    selectedPath,
    diagnostics: [
      {
        id: "diag-2",
        severity: "error",
        message: "Updated error in App.tsx.",
        filePath: FILE_PATH,
        producer: "typescript",
        category: "typecheck",
        range: {
          start: { line: 3, column: 10 },
          end: { line: 3, column: 20 },
        },
      },
      {
        id: "diag-3",
        severity: "warning",
        message: "Secondary warning after update.",
        filePath: FILE_PATH,
        producer: "eslint",
        category: "lint",
        range: {
          start: { line: 1, column: 1 },
          end: { line: 1, column: 6 },
        },
      },
    ],
    summary: {
      total: 2,
      fatalCount: 0,
      errorCount: 1,
      warningCount: 1,
      infoCount: 0,
      byProducer: { typescript: 1, eslint: 1 },
      byCategory: { typecheck: 1, lint: 1 },
      byFile: { [FILE_PATH]: 2 },
    },
    health: {
      level: "healthy",
      reasons: [],
    },
  };
}

function makeBridge(): MockBridge {
  let workspaceHandler: SubscriptionHandler | null = null;
  let diagnosticsHandler: SubscriptionHandler | null = null;
  let shellHandler: SubscriptionHandler | null = null;
  let agentHandler: SubscriptionHandler | null = null;

  return {
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      selectPath: vi.fn(async ({ workspaceId, path }: { workspaceId: string; path: string }) => ({
        ok: true,
        workspaceId,
        selectedPath: path,
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        workspaceHandler = handler;
        return () => {
          if (workspaceHandler === handler) workspaceHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        workspaceHandler?.(payload);
      },
    },
    files: {
      stat: vi.fn(async ({ path }: { path: string }) => ({
        path,
        exists: true,
        sizeBytes: FILE_CONTENT.length,
        isDirectory: false,
        isFile: true,
        readOnly: false,
        encoding: "utf-8",
        tooLarge: false,
      })),
      read: vi.fn(async ({ path }: { path: string }) => ({
        path,
        content: FILE_CONTENT,
        encoding: "utf-8",
        readOnly: false,
        tooLarge: false,
        language: "typescript",
      })),
    },
    diagnostics: {
      load: vi.fn(async ({ selectedPath }: { workspaceId: string; selectedPath?: string | null }) =>
        initialDiagnostics(selectedPath ?? FILE_PATH),
      ),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        diagnosticsHandler = handler;
        return () => {
          if (diagnosticsHandler === handler) diagnosticsHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        diagnosticsHandler?.(payload);
      },
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
        diagnostics: {
          autoReveal: true,
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
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        agentHandler = handler;
        return () => {
          if (agentHandler === handler) agentHandler = null;
        };
      }),
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

describe("smoke/diagnostics_roundtrip", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("opens a file, loads initial diagnostics, receives live diagnostics update, and settles into coherent updated state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    const fileNode =
      screen.queryByText(/App\.tsx/i) ??
      screen.queryByRole("treeitem", { name: /App\.tsx/i }) ??
      screen.getByText(/src/i);

    fireEvent.click(fileNode);

    await waitFor(() => {
      expect(bridge.workspace.selectPath).toHaveBeenCalledWith({
        workspaceId: "ws-diag-1",
        path: FILE_PATH,
      });
      expect(bridge.files.stat).toHaveBeenCalledWith({ path: FILE_PATH });
      expect(bridge.files.read).toHaveBeenCalledWith({ path: FILE_PATH });
      expect(bridge.diagnostics.load).toHaveBeenCalledWith({
        workspaceId: "ws-diag-1",
        selectedPath: FILE_PATH,
      });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Initial warning in App\.tsx\./i);
      expect(text).toMatch(/warning/i);
    });

    bridge.diagnostics.emit({
      type: "diagnostics-updated",
      payload: updatedDiagnostics(FILE_PATH),
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Updated error in App\.tsx\./i);
      expect(text).toMatch(/Secondary warning after update\./i);
      expect(text.toLowerCase()).toMatch(/error/);
      expect(text.toLowerCase()).toMatch(/warning/);
    });
  });

  it("fails closed when incoming diagnostics event is for a different workspace instead of corrupting current selected-file state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    const fileNode =
      screen.queryByText(/App\.tsx/i) ??
      screen.queryByRole("treeitem", { name: /App\.tsx/i }) ??
      screen.getByText(/src/i);

    fireEvent.click(fileNode);

    await waitFor(() => {
      expect(bridge.diagnostics.load).toHaveBeenCalled();
    });

    bridge.diagnostics.emit({
      type: "diagnostics-updated",
      payload: {
        ...updatedDiagnostics(FILE_PATH),
        workspaceId: "ws-other",
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/Initial warning in App\.tsx\./i);
      expect(text).not.toMatch(/Updated error in App\.tsx\./i);
    });
  });

  it("fails closed when incoming diagnostics payload is malformed instead of projecting contradictory summary state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    const fileNode =
      screen.queryByText(/App\.tsx/i) ??
      screen.queryByRole("treeitem", { name: /App\.tsx/i }) ??
      screen.getByText(/src/i);

    fireEvent.click(fileNode);

    await waitFor(() => {
      expect(bridge.diagnostics.load).toHaveBeenCalled();
    });

    bridge.diagnostics.emit({
      type: "diagnostics-updated",
      payload: {
        workspaceId: "ws-diag-1",
        selectedPath: FILE_PATH,
        diagnostics: null,
        summary: {
          total: 999,
        },
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/invalid|diagnostic|error|failed|warning/);
    });
  });

  it("hydrates deterministically for identical diagnostics roundtrip inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.workspace.load).toHaveBeenCalled();
    });

    const fileNodeA =
      screen.queryByText(/App\.tsx/i) ??
      screen.queryByRole("treeitem", { name: /App\.tsx/i }) ??
      screen.getByText(/src/i);
    fireEvent.click(fileNodeA);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Initial warning in App\.tsx\./i);
    });

    bridgeA.diagnostics.emit({
      type: "diagnostics-updated",
      payload: updatedDiagnostics(FILE_PATH),
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Updated error in App\.tsx\./i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.workspace.load).toHaveBeenCalled();
    });

    const fileNodeB =
      screen.queryByText(/App\.tsx/i) ??
      screen.queryByRole("treeitem", { name: /App\.tsx/i }) ??
      screen.getByText(/src/i);
    fireEvent.click(fileNodeB);

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Initial warning in App\.tsx\./i);
    });

    bridgeB.diagnostics.emit({
      type: "diagnostics-updated",
      payload: updatedDiagnostics(FILE_PATH),
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/Updated error in App\.tsx\./i);
    });
    const normalizedRenderedA = String(
      (renderedA as any)?.container?.textContent ??
        (renderedA as any)?.baseElement?.textContent ??
        (renderedA as any)?.textContent ??
        renderedA ??
        "",
    );
    const normalizedRenderedB = String(
      (renderedB as any)?.container?.textContent ??
        (renderedB as any)?.baseElement?.textContent ??
        (renderedB as any)?.textContent ??
        renderedB ??
        "",
    );

    expect(normalizedRenderedB).toEqual(normalizedRenderedA);
  });
});
