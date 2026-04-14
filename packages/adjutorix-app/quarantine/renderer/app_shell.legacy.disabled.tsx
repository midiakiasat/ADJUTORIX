import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, within, cleanup, fireEvent } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / app_shell.test.tsx
 *
 * Canonical renderer-shell contract test suite.
 *
 * Purpose:
 * - verify that AppShell preserves the governed layout contract across header, navigation,
 *   workspace chrome, activity indicators, primary content regions, inspector regions,
 *   and command/status affordances
 * - verify that shell callbacks are wired explicitly and do not disappear behind purely visual render
 * - verify that state-critical badges and layout branches remain present under representative states
 *
 * Test philosophy:
 * - do not rely on fragile snapshots
 * - assert structural semantics, operator-visible state, and callback dispatch explicitly
 * - isolate the shell boundary by mocking child surfaces and focusing on composition invariants
 *
 * Notes:
 * - this suite assumes AppShell exports a default React component from the renderer components tree
 * - child components are mocked aggressively so the shell contract is tested rather than downstream UI
 * - if the production prop surface evolves, update the fixture builder first rather than scattering edits
 */

import AppShell from "../../../src/renderer/components/AppShell";

// -----------------------------------------------------------------------------
// CHILD SURFACE MOCKS
// -----------------------------------------------------------------------------

vi.mock("../../../src/renderer/components/WelcomeScreen", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="welcome-screen">
      <div>WelcomeScreen</div>
      <pre data-testid="welcome-screen-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/FileTreePane", () => ({
  default: (props: Record<string, unknown>) => (
    <aside data-testid="file-tree-pane">
      <div>FileTreePane</div>
      <pre data-testid="file-tree-pane-props">{JSON.stringify(props, null, 2)}</pre>
    </aside>
  ),
}));

vi.mock("../../../src/renderer/components/MonacoEditorPane", () => ({
  default: (props: Record<string, unknown>) => (
    <main data-testid="monaco-editor-pane">
      <div>MonacoEditorPane</div>
      <pre data-testid="monaco-editor-pane-props">{JSON.stringify(props, null, 2)}</pre>
    </main>
  ),
}));

vi.mock("../../../src/renderer/components/EditorTabs", () => ({
  default: (props: Record<string, unknown>) => (
    <nav data-testid="editor-tabs">
      <div>EditorTabs</div>
      <pre data-testid="editor-tabs-props">{JSON.stringify(props, null, 2)}</pre>
    </nav>
  ),
}));

vi.mock("../../../src/renderer/components/SearchPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="search-panel">
      <div>SearchPanel</div>
      <pre data-testid="search-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/OutlinePanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="outline-panel">
      <div>OutlinePanel</div>
      <pre data-testid="outline-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/DiagnosticsPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="diagnostics-panel">
      <div>DiagnosticsPanel</div>
      <pre data-testid="diagnostics-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/TerminalPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="terminal-panel">
      <div>TerminalPanel</div>
      <pre data-testid="terminal-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/DiffViewerPane", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="diff-viewer-pane">
      <div>DiffViewerPane</div>
      <pre data-testid="diff-viewer-pane-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/PatchReviewPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="patch-review-panel">
      <div>PatchReviewPanel</div>
      <pre data-testid="patch-review-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/VerifyPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="verify-panel">
      <div>VerifyPanel</div>
      <pre data-testid="verify-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/LedgerPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="ledger-panel">
      <div>LedgerPanel</div>
      <pre data-testid="ledger-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/TransactionGraphPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="transaction-graph-panel">
      <div>TransactionGraphPanel</div>
      <pre data-testid="transaction-graph-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/JobPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="job-panel">
      <div>JobPanel</div>
      <pre data-testid="job-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/ChatPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="chat-panel">
      <div>ChatPanel</div>
      <pre data-testid="chat-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/ProviderStatus", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="provider-status">
      <div>ProviderStatus</div>
      <pre data-testid="provider-status-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/IndexHealthPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="index-health-panel">
      <div>IndexHealthPanel</div>
      <pre data-testid="index-health-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/CommandPalette", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="command-palette">
      <div>CommandPalette</div>
      <pre data-testid="command-palette-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/SettingsPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="settings-panel">
      <div>SettingsPanel</div>
      <pre data-testid="settings-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

vi.mock("../../../src/renderer/components/AboutPanel", () => ({
  default: (props: Record<string, unknown>) => (
    <section data-testid="about-panel">
      <div>AboutPanel</div>
      <pre data-testid="about-panel-props">{JSON.stringify(props, null, 2)}</pre>
    </section>
  ),
}));

// -----------------------------------------------------------------------------
// FIXTURE BUILDER
// -----------------------------------------------------------------------------

type AppShellProps = React.ComponentProps<typeof AppShell>;

function buildProps(overrides: Partial<AppShellProps> = {}): AppShellProps {
  const onOpenWorkspace = vi.fn();
  const onToggleCommandPalette = vi.fn();
  const onToggleSettings = vi.fn();
  const onToggleAbout = vi.fn();
  const onRefreshWorkspace = vi.fn();

  return {
    title: "ADJUTORIX",
    subtitle: "Governed workspace shell",
    workspace: {
      state: "ready",
      snapshot: {
        workspaceId: "ws-1",
        rootPath: "/repo/adjutorix",
        name: "adjutorix",
        trustLevel: "trusted",
        entries: [
          {
            path: "/repo/adjutorix/src/App.tsx",
            name: "App.tsx",
            kind: "file",
            parentPath: "/repo/adjutorix/src",
          },
          {
            path: "/repo/adjutorix/src",
            name: "src",
            kind: "directory",
            parentPath: "/repo/adjutorix",
          },
        ],
        selectedPath: "/repo/adjutorix/src/App.tsx",
        openedPaths: ["/repo/adjutorix/src/App.tsx"],
        recentPaths: ["/repo/adjutorix/src/App.tsx"],
        diagnostics: {
          total: 4,
          fatalCount: 0,
          errorCount: 1,
          warningCount: 2,
          infoCount: 1,
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
      },
      derived: {
        totalEntries: 2,
        totalFiles: 1,
        totalDirectories: 1,
        visibleEntries: 2,
        hiddenEntries: 0,
        ignoredEntries: 0,
        selectedEntry: {
          path: "/repo/adjutorix/src/App.tsx",
          name: "App.tsx",
          kind: "file",
          parentPath: "/repo/adjutorix/src",
        },
        openedEntrySet: new Set(["/repo/adjutorix/src/App.tsx"]),
        recentEntrySet: new Set(["/repo/adjutorix/src/App.tsx"]),
        byPath: new Map([
          [
            "/repo/adjutorix/src/App.tsx",
            {
              path: "/repo/adjutorix/src/App.tsx",
              name: "App.tsx",
              kind: "file",
              parentPath: "/repo/adjutorix/src",
            },
          ],
        ]),
        treeRoots: [
          {
            path: "/repo/adjutorix/src",
            name: "src",
            kind: "directory",
            parentPath: "/repo/adjutorix",
          },
        ],
      },
      error: null,
      isReady: true,
      isBusy: false,
      reload: vi.fn(),
      refresh: vi.fn(),
      selectPath: vi.fn(),
      setSnapshot: vi.fn(),
    },
    agent: {
      state: "ready",
      snapshot: {
        identity: {
          sessionId: "agent-session-1",
          providerLabel: "Local Agent",
          modelLabel: "adjutorix-core",
          endpointLabel: "http://127.0.0.1:8000/rpc",
        },
        connectionState: "connected",
        authState: "available",
        trustLevel: "trusted",
        health: { level: "healthy", reasons: [] },
        streamState: "idle",
        messages: [],
        activeTools: [],
        jobs: [],
        pendingRequestCount: 0,
      },
      derived: {
        totalMessages: 0,
        totalAssistantMessages: 0,
        totalUserMessages: 0,
        totalToolMessages: 0,
        activeToolCount: 0,
        runningJobCount: 0,
        lastMessage: null,
        messagesById: new Map(),
        activeToolMap: new Map(),
        jobsById: new Map(),
      },
      error: null,
      sendError: null,
      isReady: true,
      isBusy: false,
      isSending: false,
      connect: vi.fn(),
      refresh: vi.fn(),
      reconnect: vi.fn(),
      disconnect: vi.fn(),
      sendMessage: vi.fn(),
      setSnapshot: vi.fn(),
    },
    patchReview: {
      state: "ready",
      snapshot: {
        patchId: "patch-1",
        title: "Refactor renderer shell",
        status: "in-review",
        selectedFileId: "file-1",
        selectedHunkId: "hunk-1",
        files: [
          {
            id: "file-1",
            path: "/repo/adjutorix/src/renderer/components/AppShell.tsx",
            kind: "modify",
            status: "commented",
            addedLineCount: 20,
            deletedLineCount: 7,
            hunks: [
              {
                id: "hunk-1",
                header: "@@ -1,3 +1,8 @@",
                oldRange: { startLine: 1, endLine: 3 },
                newRange: { startLine: 1, endLine: 8 },
                lines: [],
              },
            ],
            comments: [],
          },
        ],
        comments: [],
        verifyEvidence: [
          {
            verifyId: "verify-1",
            status: "passed",
            summary: "Verify passed",
          },
        ],
        applyReadiness: "warning",
      },
      derived: {
        totalFiles: 1,
        totalHunks: 1,
        totalComments: 0,
        acceptedFiles: 0,
        rejectedFiles: 0,
        commentedFiles: 1,
        selectedFile: {
          id: "file-1",
          path: "/repo/adjutorix/src/renderer/components/AppShell.tsx",
          kind: "modify",
          status: "commented",
          addedLineCount: 20,
          deletedLineCount: 7,
          hunks: [],
          comments: [],
        },
        selectedHunk: {
          id: "hunk-1",
          header: "@@ -1,3 +1,8 @@",
          oldRange: { startLine: 1, endLine: 3 },
          newRange: { startLine: 1, endLine: 8 },
          lines: [],
        },
        filesById: new Map(),
        hunksById: new Map(),
        commentsById: new Map(),
        isApplyBlocked: false,
        isVerifyPassing: true,
      },
      error: null,
      isReady: true,
      isBusy: false,
      reload: vi.fn(),
      refresh: vi.fn(),
      selectFile: vi.fn(),
      selectHunk: vi.fn(),
      setSnapshot: vi.fn(),
    },
    ledger: {
      state: "ready",
      snapshot: {
        ledgerId: "ledger-1",
        headSeq: 10,
        selectedSeq: 10,
        entries: [
          {
            seq: 10,
            id: "entry-10",
            type: "patch-reviewed",
            status: "succeeded",
            title: "Patch reviewed",
            createdAtMs: 1000,
          },
        ],
        edges: [],
        health: { level: "healthy", reasons: [] },
        replayable: true,
      },
      derived: {
        totalEntries: 1,
        totalEdges: 0,
        pendingEntries: 0,
        failedEntries: 0,
        selectedEntry: {
          seq: 10,
          id: "entry-10",
          type: "patch-reviewed",
          status: "succeeded",
          title: "Patch reviewed",
          createdAtMs: 1000,
        },
        selectedIncomingEdges: [],
        selectedOutgoingEdges: [],
        entriesBySeq: new Map(),
        entriesById: new Map(),
        edgesByFromSeq: new Map(),
        edgesByToSeq: new Map(),
        latestEntry: {
          seq: 10,
          id: "entry-10",
          type: "patch-reviewed",
          status: "succeeded",
          title: "Patch reviewed",
          createdAtMs: 1000,
        },
      },
      error: null,
      isReady: true,
      isBusy: false,
      reload: vi.fn(),
      refresh: vi.fn(),
      selectSeq: vi.fn(),
      setSnapshot: vi.fn(),
    },
    commandPalette: {
      isOpen: false,
      query: "",
      selectedCategory: "all",
      commands: [],
      selectedCommandId: null,
      health: "healthy",
      trustLevel: "trusted",
      loading: false,
      onQueryChange: vi.fn(),
      onSelectCommand: vi.fn(),
      onRunCommand: vi.fn(),
      onClose: onToggleCommandPalette,
      onSelectedCategoryChange: vi.fn(),
    },
    settings: {
      isOpen: false,
      title: "Settings",
      subtitle: "Governed settings",
      health: "healthy",
      loading: false,
      settings: [],
      dirty: false,
      readOnly: false,
      onRefreshRequested: vi.fn(),
      onSaveRequested: vi.fn(),
      onResetRequested: vi.fn(),
      onDraftValueChange: vi.fn(),
    },
    about: {
      isOpen: false,
      health: "healthy",
      trustLevel: "trusted",
      loading: false,
      appName: "ADJUTORIX",
      version: "0.1.0",
      buildChannel: "dev",
      buildHash: "abc123",
      protocolVersion: "1",
      onRefreshRequested: vi.fn(),
      onOpenLinkRequested: vi.fn(),
    },
    shell: {
      activeCenterPanel: "editor",
      rightRailMode: "chat",
      bottomPanelMode: "terminal",
      showLeftSidebar: true,
      showRightRail: true,
      showBottomPanel: true,
      showStatusBar: true,
      showWelcomeWhenEmpty: true,
    },
    actions: {
      onOpenWorkspace,
      onToggleCommandPalette,
      onToggleSettings,
      onToggleAbout,
      onRefreshWorkspace,
    },
    ...overrides,
  } as AppShellProps;
}

// -----------------------------------------------------------------------------
// TESTS
// -----------------------------------------------------------------------------

describe("AppShell", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the governed shell frame with primary structural regions", () => {
    render(<AppShell {...buildProps()} />);

    expect(screen.getByText(/ADJUTORIX/i)).toBeInTheDocument();
    expect(screen.getByTestId("file-tree-pane")).toBeInTheDocument();
    expect(screen.getByTestId("editor-tabs")).toBeInTheDocument();
    expect(screen.getByTestId("monaco-editor-pane")).toBeInTheDocument();
    expect(screen.getByTestId("provider-status")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();
  });

  it("surfaces welcome flow instead of editor center when shell is empty and welcome mode is enabled", () => {
    render(
      <AppShell
        {...buildProps({
          workspace: {
            ...buildProps().workspace,
            snapshot: {
              ...buildProps().workspace.snapshot,
              openedPaths: [],
              selectedPath: null,
            },
          },
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "welcome",
            showWelcomeWhenEmpty: true,
          },
        })}
      />,
    );

    expect(screen.getByTestId("welcome-screen")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-editor-pane")).not.toBeInTheDocument();
  });

  it("routes right-rail mode to chat surface when selected", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            rightRailMode: "chat",
          },
        })}
      />,
    );

    expect(screen.getByTestId("chat-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("diagnostics-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("index-health-panel")).not.toBeInTheDocument();
  });

  it("routes right-rail mode to diagnostics surface when selected", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            rightRailMode: "diagnostics",
          },
        })}
      />,
    );

    expect(screen.getByTestId("diagnostics-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
  });

  it("routes right-rail mode to index-health surface when selected", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            rightRailMode: "index-health",
          },
        })}
      />,
    );

    expect(screen.getByTestId("index-health-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
  });

  it("routes bottom panel to terminal by default and swaps to verify when selected", () => {
    const { rerender } = render(<AppShell {...buildProps()} />);
    expect(screen.getByTestId("terminal-panel")).toBeInTheDocument();

    rerender(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            bottomPanelMode: "verify",
          },
        })}
      />,
    );

    expect(screen.getByTestId("verify-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
  });

  it("routes bottom panel to ledger and graph surfaces under alternate modes", () => {
    const { rerender } = render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            bottomPanelMode: "ledger",
          },
        })}
      />,
    );

    expect(screen.getByTestId("ledger-panel")).toBeInTheDocument();

    rerender(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            bottomPanelMode: "transaction-graph",
          },
        })}
      />,
    );

    expect(screen.getByTestId("transaction-graph-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("ledger-panel")).not.toBeInTheDocument();
  });

  it("renders patch review and diff center modes explicitly instead of collapsing to editor", () => {
    const { rerender } = render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "patch-review",
          },
        })}
      />,
    );

    expect(screen.getByTestId("patch-review-panel")).toBeInTheDocument();
    expect(screen.queryByTestId("monaco-editor-pane")).not.toBeInTheDocument();

    rerender(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "diff",
          },
        })}
      />,
    );

    expect(screen.getByTestId("diff-viewer-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("patch-review-panel")).not.toBeInTheDocument();
  });

  it("opens command palette, settings, and about overlays only when explicitly enabled", () => {
    const { rerender } = render(<AppShell {...buildProps()} />);

    expect(screen.queryByTestId("command-palette")).not.toBeInTheDocument();
    expect(screen.queryByTestId("settings-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("about-panel")).not.toBeInTheDocument();

    rerender(
      <AppShell
        {...buildProps({
          commandPalette: {
            ...buildProps().commandPalette,
            isOpen: true,
          },
          settings: {
            ...buildProps().settings,
            isOpen: true,
          },
          about: {
            ...buildProps().about,
            isOpen: true,
          },
        })}
      />,
    );

    expect(screen.getByTestId("command-palette")).toBeInTheDocument();
    expect(screen.getByTestId("settings-panel")).toBeInTheDocument();
    expect(screen.getByTestId("about-panel")).toBeInTheDocument();
  });

  it("wires top-level shell actions to explicit operator controls", () => {
    const props = buildProps();
    render(<AppShell {...props} />);

    const buttons = screen.getAllByRole("button");
    const labels = buttons.map((button) => button.textContent ?? "");

    const openWorkspaceButton = buttons.find((button) => /open workspace/i.test(button.textContent ?? ""));
    const commandPaletteButton = buttons.find((button) => /command/i.test(button.textContent ?? "") || /palette/i.test(button.textContent ?? ""));
    const settingsButton = buttons.find((button) => /settings/i.test(button.textContent ?? ""));
    const aboutButton = buttons.find((button) => /about/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(labels.join(" | ")).not.toEqual("");
    expect(openWorkspaceButton).toBeDefined();
    expect(commandPaletteButton).toBeDefined();
    expect(settingsButton).toBeDefined();
    expect(aboutButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(openWorkspaceButton!);
    fireEvent.click(commandPaletteButton!);
    fireEvent.click(settingsButton!);
    fireEvent.click(aboutButton!);
    fireEvent.click(refreshButton!);

    expect(props.actions.onOpenWorkspace).toHaveBeenCalledTimes(1);
    expect(props.actions.onToggleCommandPalette).toHaveBeenCalledTimes(1);
    expect(props.actions.onToggleSettings).toHaveBeenCalledTimes(1);
    expect(props.actions.onToggleAbout).toHaveBeenCalledTimes(1);
    expect(props.actions.onRefreshWorkspace).toHaveBeenCalledTimes(1);
  });

  it("passes normalized workspace truth into file tree and editor tabs instead of local shadow state", () => {
    render(<AppShell {...buildProps()} />);

    const fileTreeProps = JSON.parse(screen.getByTestId("file-tree-pane-props").textContent ?? "{}");
    const editorTabsProps = JSON.parse(screen.getByTestId("editor-tabs-props").textContent ?? "{}");

    expect(JSON.stringify(fileTreeProps)).toMatch(/adjutorix/);
    expect(JSON.stringify(fileTreeProps)).toMatch(/App\.tsx/);
    expect(JSON.stringify(editorTabsProps)).toMatch(/App\.tsx/);
  });

  it("surfaces provider and index status simultaneously instead of collapsing one into the other", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            rightRailMode: "index-health",
          },
        })}
      />,
    );

    expect(screen.getByTestId("provider-status")).toBeInTheDocument();
    expect(screen.getByTestId("index-health-panel")).toBeInTheDocument();
  });

  it("keeps shell render stable when sidebar, right rail, and bottom panel are independently suppressed", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            showLeftSidebar: false,
            showRightRail: false,
            showBottomPanel: false,
          },
        })}
      />,
    );

    expect(screen.queryByTestId("file-tree-pane")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel")).not.toBeInTheDocument();
    expect(screen.queryByTestId("terminal-panel")).not.toBeInTheDocument();
    expect(screen.getByTestId("monaco-editor-pane")).toBeInTheDocument();
  });

  it("renders job surface when center mode or rail mode requests operational job visibility", () => {
    const { rerender } = render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "jobs",
          },
        })}
      />,
    );

    expect(screen.getByTestId("job-panel")).toBeInTheDocument();

    rerender(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "editor",
            rightRailMode: "jobs",
          },
        })}
      />,
    );

    expect(screen.getByTestId("job-panel")).toBeInTheDocument();
  });

  it("does not hide diagnostics-bearing shell state when workspace is degraded", () => {
    render(
      <AppShell
        {...buildProps({
          workspace: {
            ...buildProps().workspace,
            snapshot: {
              ...buildProps().workspace.snapshot,
              health: {
                level: "degraded",
                reasons: ["watch lag rising", "index stale"],
              },
              diagnostics: {
                total: 12,
                fatalCount: 1,
                errorCount: 4,
                warningCount: 5,
                infoCount: 2,
              },
              indexStatus: {
                state: "stale",
                progressPct: 100,
                issueCount: 3,
              },
            },
          },
          shell: {
            ...buildProps().shell,
            rightRailMode: "diagnostics",
          },
        })}
      />,
    );

    expect(screen.getByTestId("diagnostics-panel")).toBeInTheDocument();
    expect(screen.getByTestId("provider-status")).toBeInTheDocument();
  });

  it("preserves explicit review and verify surfaces when patch review is loaded with passing evidence", () => {
    render(
      <AppShell
        {...buildProps({
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "patch-review",
            bottomPanelMode: "verify",
          },
        })}
      />,
    );

    expect(screen.getByTestId("patch-review-panel")).toBeInTheDocument();
    expect(screen.getByTestId("verify-panel")).toBeInTheDocument();

    const patchReviewProps = JSON.parse(screen.getByTestId("patch-review-panel-props").textContent ?? "{}");
    expect(JSON.stringify(patchReviewProps)).toMatch(/patch-1/);
    expect(JSON.stringify(patchReviewProps)).toMatch(/verify-1/);
  });

  it("keeps about/settings/palette overlays structurally separate from core shell content", () => {
    render(
      <AppShell
        {...buildProps({
          commandPalette: { ...buildProps().commandPalette, isOpen: true },
          settings: { ...buildProps().settings, isOpen: true },
          about: { ...buildProps().about, isOpen: true },
        })}
      />,
    );

    const commandPalette = screen.getByTestId("command-palette");
    const settings = screen.getByTestId("settings-panel");
    const about = screen.getByTestId("about-panel");
    const editor = screen.getByTestId("monaco-editor-pane");

    expect(commandPalette).not.toContainElement(editor);
    expect(settings).not.toContainElement(editor);
    expect(about).not.toContainElement(editor);
  });

  it("does not drop the selected workspace path when editor and file tree are both present", () => {
    render(<AppShell {...buildProps()} />);

    const treeProps = JSON.parse(screen.getByTestId("file-tree-pane-props").textContent ?? "{}");
    const editorProps = JSON.parse(screen.getByTestId("monaco-editor-pane-props").textContent ?? "{}");

    expect(JSON.stringify(treeProps)).toMatch(/\/repo\/adjutorix\/src\/App\.tsx/);
    expect(JSON.stringify(editorProps)).toMatch(/\/repo\/adjutorix\/src\/App\.tsx/);
  });

  it("renders without implicit welcome fallback when shell is explicitly directed to editor mode", () => {
    render(
      <AppShell
        {...buildProps({
          workspace: {
            ...buildProps().workspace,
            snapshot: {
              ...buildProps().workspace.snapshot,
              openedPaths: [],
            },
          },
          shell: {
            ...buildProps().shell,
            activeCenterPanel: "editor",
            showWelcomeWhenEmpty: false,
          },
        })}
      />,
    );

    expect(screen.getByTestId("monaco-editor-pane")).toBeInTheDocument();
    expect(screen.queryByTestId("welcome-screen")).not.toBeInTheDocument();
  });
});
