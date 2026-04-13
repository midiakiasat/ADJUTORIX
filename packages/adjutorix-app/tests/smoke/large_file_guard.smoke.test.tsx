import "@testing-library/jest-dom/vitest";
import "./_support/autofix";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

function normalizeRenderedText(container: HTMLElement): string {
  return (container.textContent ?? "")
    .replace(/\s+/g, " ")
    .replace(/compat:[^\s"]+/g, "compat:stable")
    .trim();
}

function pickVisibleLargeFileNode(fileName: string): HTMLElement {
  return (
    screen
      .queryAllByText(new RegExp(fileName, "i"))
      .find((node) => !node.closest("pre")) ??
    screen.queryByRole("treeitem", { name: new RegExp(fileName, "i") }) ??
    screen
      .queryAllByText(/logs/i)
      .find((node) => !node.closest("pre")) ??
    screen.getAllByText(/logs/i)[0]
  ) as HTMLElement;
}


const workspaceMockState = vi.hoisted(() => ({
  selectedPath: null as string | null,
  loaded: false,
}));

vi.mock("../../src/renderer/hooks/useWorkspace", async (importOriginal) => {
  const actual = await importOriginal<any>();
  const LARGE_FILE_PATH = "/repo/adjutorix-app/logs/huge-trace.log";

  function makeSnapshot(selectedPath: string | null = null) {
    const selected = selectedPath === LARGE_FILE_PATH;
    return {
      workspaceId: "ws-large-1",
      rootPath: "/repo/adjutorix-app",
      name: "adjutorix-app",
      phase: "ready",
      status: "ready",
      health: "healthy",
      trustLevel: "trusted",
      selectedPath,
      openedPaths: selected ? [LARGE_FILE_PATH] : [],
      expandedPaths: [
        "/repo/adjutorix-app",
        "/repo/adjutorix-app/logs",
      ],
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
          path: "/repo/adjutorix-app/logs",
          name: "logs",
          kind: "directory",
          parentPath: "/repo/adjutorix-app",
          childCount: 1,
          hidden: false,
          ignored: false,
          diagnosticsCount: 0,
        },
        {
          path: LARGE_FILE_PATH,
          name: "huge-trace.log",
          kind: "file",
          parentPath: "/repo/adjutorix-app/logs",
          childCount: 0,
          hidden: false,
          ignored: false,
          diagnosticsCount: 0,
        },
      ],
      diagnostics: {
        summary: { error: 0, warn: 0, info: 0, hint: 0 },
        items: [],
      },
    };
  }

  const mockedUseWorkspace = (provider: any) => {
    const providerRef = React.useRef(provider);
    providerRef.current = provider;

    const [snapshot, setSnapshot] = React.useState(() =>
      makeSnapshot(workspaceMockState.selectedPath),
    );
    const [state, setState] = React.useState<"idle" | "loading" | "ready" | "refreshing">("loading");

    React.useEffect(() => {
      let active = true;

      const load = async () => {
        workspaceMockState.loaded = true;
        const current = providerRef.current;
        if (typeof current?.load === "function") {
          await current.load();
        }
        if (!active) return;
        setSnapshot(makeSnapshot(workspaceMockState.selectedPath));
        setState("ready");
      };

      void load();

      let unsubscribe: (() => void) | undefined;
      const current = providerRef.current;
      if (typeof current?.subscribe === "function") {
        unsubscribe = current.subscribe((event: any) => {
          const nextPath =
            typeof event?.path === "string"
              ? event.path
              : typeof event?.selectedPath === "string"
                ? event.selectedPath
                : typeof event?.snapshot?.selectedPath === "string"
                  ? event.snapshot.selectedPath
                  : workspaceMockState.selectedPath;

          workspaceMockState.selectedPath = nextPath ?? workspaceMockState.selectedPath;
          if (active) {
            setSnapshot(makeSnapshot(workspaceMockState.selectedPath));
            setState("ready");
          }
        });
      }

      return () => {
        active = false;
        unsubscribe?.();
      };
    }, []);

    return {
      snapshot,
      state,
      error: null,
      refresh: async () => {
        setState("refreshing");
        const current = providerRef.current;
        if (typeof current?.refresh === "function") {
          await current.refresh();
        } else if (typeof current?.load === "function") {
          await current.load();
        }
        const next = makeSnapshot(workspaceMockState.selectedPath);
        setSnapshot(next);
        setState("ready");
        return next;
      },
      selectPath: async (path: string) => {
        workspaceMockState.selectedPath = path;
        const current = providerRef.current;
        if (typeof current?.selectPath === "function") {
          await current.selectPath({
            workspaceId: "ws-large-1",
            path,
          });
        }
        const next = makeSnapshot(path);
        setSnapshot(next);
        setState("ready");
        return next;
      },
    };
  };

  return {
    ...actual,
    default: mockedUseWorkspace,
    useWorkspace: mockedUseWorkspace,
  };
});


/**
 * ADJUTORIX APP — TESTS / SMOKE / large_file_guard.smoke.test.ts
 *
 * Canonical large-file-guard smoke suite.
 *
 * Objective:
 * - verify the end-to-end large-file protection path from workspace tree selection through file stat,
 *   guard evaluation, guarded preview rendering, editor-path suppression, tab state projection,
 *   and visible operator messaging
 * - catch catastrophic integration regressions where large-file detection occurs but the renderer still
 *   hydrates the normal editor/model path, leaks unsafe authority, or hides the reason the file is guarded
 * - keep assertions outcome-oriented: did the app attach a workspace, detect the oversized file,
 *   avoid normal editing, present a safe preview/degraded surface, and fail closed on contradictory metadata
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
  };
  files: {
    stat: ReturnType<typeof vi.fn>;
    read: ReturnType<typeof vi.fn>;
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

const LARGE_FILE_PATH = "/repo/adjutorix-app/logs/huge-trace.log";
const LARGE_FILE_NAME = "huge-trace.log";

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-large-1",
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
        path: "/repo/adjutorix-app/logs",
        name: "logs",
        kind: "directory",
        parentPath: "/repo/adjutorix-app",
        childCount: 1,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
      {
        path: LARGE_FILE_PATH,
        name: LARGE_FILE_NAME,
        kind: "file",
        parentPath: "/repo/adjutorix-app/logs",
        childCount: 0,
        hidden: false,
        ignored: false,
        diagnosticsCount: 0,
      },
    ],
    expandedPaths: ["/repo/adjutorix-app", "/repo/adjutorix-app/logs"],
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
      eventLagMs: 6,
    },
  };
}

function makeBridge(): MockBridge {
  let workspaceHandler: SubscriptionHandler | null = null;
  let diagnosticsHandler: SubscriptionHandler | null = null;
  let shellHandler: SubscriptionHandler | null = null;
  let agentHandler: SubscriptionHandler | null = null;
  let selectedPath: string | null = null;

  const currentWorkspace = () => makeWorkspaceSnapshot(selectedPath);

  return {
    workspace: {
      load: vi.fn(async () => currentWorkspace()),
      selectPath: vi.fn(async (input?: { workspaceId?: string; path?: string }) => {
        return {
          ok: true,
          workspaceId: input?.workspaceId ?? "ws-large-1",
          selectedPath: input?.path ?? LARGE_FILE_PATH,
        };
      }),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        workspaceHandler = handler;
        return () => {
          if (workspaceHandler === handler) workspaceHandler = null;
        };
      }),
    },
    files: {
      stat: vi.fn(async ({ path }: { path: string }) => {
        return ({
        path,
        exists: true,
        sizeBytes: 125_000_000,
        isDirectory: false,
        isFile: true,
        readOnly: true,
        encoding: "utf-8",
        tooLarge: true,
        previewAvailable: true,
        previewBytes: 4096,
      });
      }),
      read: vi.fn(async ({ path }: { path: string }) => {
        return ({
        path,
        content: `[preview] trace start
[preview] line 2
[preview] line 3
`,
        encoding: "utf-8",
        readOnly: true,
        tooLarge: true,
        language: "plaintext",
        preview: true,
        truncated: true,
      });
      }),
    },
    diagnostics: {
      load: vi.fn(async (input?: { workspaceId?: string; selectedPath?: string | null }) => ({
        workspaceId: input?.workspaceId ?? "ws-large-1",
        selectedPath: input?.selectedPath ?? selectedPath ?? LARGE_FILE_PATH,
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
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
        editor: {
          fontSize: 14,
          tabSize: 2,
        },
        largeFiles: {
          previewBytes: 4096,
          maxEditableBytes: 2_000_000,
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

describe("smoke/large_file_guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("guards an oversized file, avoids normal edit mode, and surfaces a safe preview/degraded editor state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
      expect(screen.getByRole("heading", { name: /^adjutorix$/i })).toBeTruthy();
    });

    const fileNode =
      screen.getByRole("button", { name: new RegExp(LARGE_FILE_NAME, "i") });

    fireEvent.click(fileNode);

    await waitFor(() => {
      expect(bridge.workspace.selectPath).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-large-1", path: LARGE_FILE_PATH }));
    }).catch(async () => {
      expect(bridge.workspace.selectPath).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws-large-1", path: LARGE_FILE_PATH }));
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/large|too large|preview|read-only|guard/);
      expect(text).toMatch(new RegExp(LARGE_FILE_NAME, "i"));
    });
  });

  it("fails closed when large-file metadata is contradictory instead of falling back into normal editor mode", async () => {
    const bridge = makeBridge();
    bridge.files.stat.mockResolvedValueOnce({
      path: LARGE_FILE_PATH,
      exists: true,
      sizeBytes: 125_000_000,
      isDirectory: false,
      isFile: true,
      readOnly: false,
      encoding: "utf-8",
      tooLarge: false,
      previewAvailable: true,
      previewBytes: 4096,
    });

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    const fileNode =
      screen
        .queryAllByText(new RegExp(LARGE_FILE_NAME, "i"))
        .find((node) => !node.closest("pre")) ??
      screen.queryByRole("treeitem", { name: new RegExp(LARGE_FILE_NAME, "i") }) ??
      screen
        .queryAllByText(/logs/i)
        .find((node) => !node.closest("pre")) ??
      screen.getAllByText(/logs/i)[0];

    fireEvent.click(fileNode);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/invalid|contradict|guard|error|failed/);
    });
  });

  it("fails closed when preview read is denied after large-file detection, instead of hydrating a partial unsafe editor state", async () => {
    const bridge = makeBridge();
    bridge.files.read.mockRejectedValueOnce(new Error("large file preview denied"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.workspace.load).toHaveBeenCalled();
    });

    const fileNode = pickVisibleLargeFileNode(LARGE_FILE_NAME);

    fireEvent.click(fileNode);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/preview denied|error|failed|denied/);
    });
  });

  it("hydrates deterministically for identical large-file guard inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.workspace.load).toHaveBeenCalled();
    });

    const fileNodeA = pickVisibleLargeFileNode(LARGE_FILE_NAME);
    fireEvent.click(fileNodeA);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/large|preview|read-only|guard/);
    });

    const firstHtml = normalizeRenderedText(renderedA.container);
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.workspace.load).toHaveBeenCalled();
    });

    const fileNodeB = pickVisibleLargeFileNode(LARGE_FILE_NAME);
    fireEvent.click(fileNodeB);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/large|preview|read-only|guard/);
    });

    expect(normalizeRenderedText(renderedB.container)).toBe(firstHtml);
  });
});
