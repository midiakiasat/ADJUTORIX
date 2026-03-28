import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / editor_open_file.smoke.test.ts
 *
 * Canonical editor-open-file smoke suite.
 *
 * Objective:
 * - verify the end-to-end file-open path from workspace tree selection through governed file read,
 *   editor model hydration, tab creation, diagnostics attachment, large-file/read-only policy,
 *   and visible editor-ready projection
 * - catch catastrophic integration regressions where the file tree, editor pane, and diagnostics
 *   all appear individually valid but the app never reaches one coherent opened-file state
 * - keep assertions outcome-oriented: did the app attach a workspace, open a real file, hydrate
 *   visible content into the editor surface, track it in tabs, and fail closed on denied or oversized files
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
    selectPath: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  files: {
    read: ReturnType<typeof vi.fn>;
    stat: ReturnType<typeof vi.fn>;
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
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

const FILE_PATH = "/repo/adjutorix-app/src/renderer/App.tsx";
const FILE_CONTENT = `import React from "react";

export default function App(): JSX.Element {
  return <div>ADJUTORIX</div>;
}
`;

function makeWorkspaceSnapshot() {
  return {
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
        name: "App.tsx",
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
      watchedPaths: 24,
      eventLagMs: 5,
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
      load: vi.fn(async ({ workspaceId, selectedPath }: { workspaceId: string; selectedPath?: string | null }) => ({
        workspaceId,
        selectedPath: selectedPath ?? FILE_PATH,
        diagnostics: [
          {
            id: "diag-1",
            severity: "warning",
            message: "Example warning attached to opened file.",
            filePath: FILE_PATH,
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
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        diagnosticsHandler = handler;
        return () => {
          if (diagnosticsHandler === handler) diagnosticsHandler = null;
        };
      }),
    },
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
        editor: {
          fontSize: 14,
          tabSize: 2,
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

describe("smoke/editor_open_file", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("opens a workspace file into the editor, hydrates content, creates a tab, and attaches diagnostics", async () => {
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
        workspaceId: "ws-1",
        path: FILE_PATH,
      });
      expect(bridge.files.stat).toHaveBeenCalledWith({ path: FILE_PATH });
      expect(bridge.files.read).toHaveBeenCalledWith({ path: FILE_PATH });
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text).toMatch(/App\.tsx/);
      expect(text).toMatch(/ADJUTORIX/);
    });

    expect(bridge.diagnostics.load).toHaveBeenCalledWith({
      workspaceId: "ws-1",
      selectedPath: FILE_PATH,
    });
    expect(bridge.workspace.subscribe).toHaveBeenCalled();
    expect(bridge.diagnostics.subscribe).toHaveBeenCalled();
  });

  it("fails closed when file stat or read is denied instead of presenting a false opened editor state", async () => {
    const bridge = makeBridge();
    bridge.files.read.mockRejectedValueOnce(new Error("file read denied"));

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
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/file read denied|error|failed|denied/);
    });
  });

  it("fails closed on large-file guard instead of hydrating oversized content into the normal editor path", async () => {
    const bridge = makeBridge();
    bridge.files.stat.mockResolvedValueOnce({
      path: FILE_PATH,
      exists: true,
      sizeBytes: 50_000_000,
      isDirectory: false,
      isFile: true,
      readOnly: true,
      encoding: "utf-8",
      tooLarge: true,
    });
    bridge.files.read.mockResolvedValueOnce({
      path: FILE_PATH,
      content: "",
      encoding: "utf-8",
      readOnly: true,
      tooLarge: true,
      language: "plaintext",
    });

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
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/large|too large|read-only|preview/);
    });
  });

  it("hydrates deterministically for identical file-open inputs", async () => {
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
      expect(document.body.textContent ?? "").toMatch(/ADJUTORIX/);
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
      expect(document.body.textContent ?? "").toMatch(/ADJUTORIX/);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
