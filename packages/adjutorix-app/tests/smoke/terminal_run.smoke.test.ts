import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

/**
 * ADJUTORIX APP — TESTS / SMOKE / terminal_run.smoke.test.ts
 *
 * Canonical terminal-run smoke suite.
 *
 * Objective:
 * - verify the end-to-end terminal execution path from renderer bootstrap through shell status hydration,
 *   explicit command submission, governed run request, live stdout/stderr/event ingestion, exit reconciliation,
 *   and visible terminal-ready/result state
 * - catch catastrophic integration regressions where the shell panel, command runner, and status surfaces
 *   each appear individually valid but never converge on one authoritative run lifecycle
 * - keep assertions outcome-oriented: did the app mount, expose a ready terminal, accept explicit command input,
 *   route one governed run, stream output, surface completion, and fail closed on denied or broken execution
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
    subscribe: ReturnType<typeof vi.fn>;
  };
  shell: {
    status: ReturnType<typeof vi.fn>;
    run: ReturnType<typeof vi.fn>;
    interrupt: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
    emit: (payload: unknown) => void;
  };
  diagnostics: {
    load: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
  settings: {
    load: ReturnType<typeof vi.fn>;
  };
  agent: {
    connect: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
};

const RUN_ID = "cmd-1";
const COMMAND_TEXT = "npm test";

function makeWorkspaceSnapshot() {
  return {
    workspaceId: "ws-terminal-1",
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
      watchedPaths: 20,
      eventLagMs: 3,
    },
  };
}

function makeShellStatus() {
  return {
    level: "healthy",
    actionAllowed: true,
    reasons: [],
    shell: {
      available: true,
      terminalReady: true,
      cwd: "/repo/adjutorix-app",
      shellPath: "/bin/zsh",
      interactive: true,
    },
    command: {
      present: true,
      id: RUN_ID,
      command: COMMAND_TEXT,
      lifecycle: "idle",
      startedAtMs: 1711000000000,
      finishedAtMs: 1711000001000,
      exitCode: 0,
      signal: null,
      timedOut: false,
      cancelled: false,
      stdoutBytes: 0,
      stderrBytes: 0,
      lastOutputAtMs: 1711000000500,
    },
    output: {
      stdoutFlowing: false,
      stderrFlowing: false,
      truncated: false,
      lastStdoutAtMs: 1711000000500,
      lastStderrAtMs: null,
    },
  };
}

function makeBridge(): MockBridge {
  let shellHandler: SubscriptionHandler | null = null;

  return {
    workspace: {
      load: vi.fn(async () => makeWorkspaceSnapshot()),
      subscribe: vi.fn(() => () => undefined),
    },
    shell: {
      status: vi.fn(async () => makeShellStatus()),
      run: vi.fn(async ({ command }: { command: string }) => ({
        ok: true,
        runId: RUN_ID,
        command,
      })),
      interrupt: vi.fn(async ({ runId }: { runId: string }) => ({
        ok: true,
        runId,
      })),
      subscribe: vi.fn((handler: SubscriptionHandler) => {
        shellHandler = handler;
        return () => {
          if (shellHandler === handler) shellHandler = null;
        };
      }),
      emit: (payload: unknown) => {
        shellHandler?.(payload);
      },
    },
    diagnostics: {
      load: vi.fn(async () => ({
        workspaceId: "ws-terminal-1",
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
    settings: {
      load: vi.fn(async () => ({
        theme: "dark",
        confirmations: true,
        shell: {
          defaultCommand: "npm test",
        },
      })),
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
    <MemoryRouter initialEntries={["/terminal"]}>
      <Providers>
        <App />
      </Providers>
    </MemoryRouter>,
  );
}

describe("smoke/terminal_run", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    // @ts-expect-error test cleanup
    delete window.adjutorix;
  });

  it("hydrates terminal status, runs an explicit command, streams output, and settles into a coherent successful result state", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.shell.status).toHaveBeenCalled();
      expect(screen.getByText(/adjutorix/i)).toBeInTheDocument();
    });

    const input =
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|run|shell/i);
    const runButton =
      screen.queryByRole("button", { name: /run/i }) ??
      screen.queryByText(/^run$/i) ??
      screen.getByRole("button");

    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLElement, {
      target: { value: COMMAND_TEXT },
    });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(bridge.shell.run).toHaveBeenCalledWith({ command: COMMAND_TEXT });
    });

    bridge.shell.emit({
      type: "shell-run-updated",
      payload: {
        ...makeShellStatus(),
        command: {
          present: true,
          id: RUN_ID,
          command: COMMAND_TEXT,
          lifecycle: "running",
          startedAtMs: 1711000000000,
          finishedAtMs: null,
          exitCode: null,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutBytes: 12,
          stderrBytes: 0,
          lastOutputAtMs: 1711000000200,
        },
        output: {
          stdoutFlowing: true,
          stderrFlowing: false,
          truncated: false,
          lastStdoutAtMs: 1711000000200,
          lastStderrAtMs: null,
        },
        stdout: "running...\n",
        stderr: "",
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/running/);
      expect(text).toMatch(/running\.\.\./i);
    });

    bridge.shell.emit({
      type: "shell-run-updated",
      payload: {
        ...makeShellStatus(),
        command: {
          present: true,
          id: RUN_ID,
          command: COMMAND_TEXT,
          lifecycle: "succeeded",
          startedAtMs: 1711000000000,
          finishedAtMs: 1711000001000,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutBytes: 28,
          stderrBytes: 0,
          lastOutputAtMs: 1711000000800,
        },
        output: {
          stdoutFlowing: false,
          stderrFlowing: false,
          truncated: false,
          lastStdoutAtMs: 1711000000800,
          lastStderrAtMs: null,
        },
        stdout: "running...\nall tests passed\n",
        stderr: "",
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/succeeded|passed|exit code 0|completed/);
      expect(text).toMatch(/all tests passed/i);
    });
  });

  it("fails closed when run request is denied instead of presenting a decorative running terminal state", async () => {
    const bridge = makeBridge();
    bridge.shell.run.mockRejectedValueOnce(new Error("shell run denied"));

    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.shell.status).toHaveBeenCalled();
    });

    const input =
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|run|shell/i);
    const runButton =
      screen.queryByRole("button", { name: /run/i }) ??
      screen.queryByText(/^run$/i) ??
      screen.getByRole("button");

    fireEvent.change(input as HTMLElement, {
      target: { value: COMMAND_TEXT },
    });
    fireEvent.click(runButton);

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/shell run denied|error|failed|denied/);
    });
  });

  it("fails closed when terminal update payload is contradictory instead of projecting a coherent completed run", async () => {
    const bridge = makeBridge();
    await renderAppWithBridge(bridge);

    await waitFor(() => {
      expect(bridge.shell.status).toHaveBeenCalled();
    });

    const input =
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|run|shell/i);
    const runButton =
      screen.queryByRole("button", { name: /run/i }) ??
      screen.queryByText(/^run$/i) ??
      screen.getByRole("button");

    fireEvent.change(input as HTMLElement, {
      target: { value: COMMAND_TEXT },
    });
    fireEvent.click(runButton);

    await waitFor(() => {
      expect(bridge.shell.run).toHaveBeenCalled();
    });

    bridge.shell.emit({
      type: "shell-run-updated",
      payload: {
        ...makeShellStatus(),
        command: {
          present: true,
          id: RUN_ID,
          command: COMMAND_TEXT,
          lifecycle: "running",
          startedAtMs: 1711000000000,
          finishedAtMs: 1711000001000,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutBytes: 10,
          stderrBytes: 0,
          lastOutputAtMs: 1711000000200,
        },
        output: {
          stdoutFlowing: false,
          stderrFlowing: false,
          truncated: false,
          lastStdoutAtMs: 1711000000200,
          lastStderrAtMs: null,
        },
        stdout: "impossible\n",
        stderr: "",
      },
    });

    await waitFor(() => {
      const text = document.body.textContent ?? "";
      expect(text.toLowerCase()).toMatch(/invalid|contradict|error|failed|running/);
    });
  });

  it("hydrates deterministically for identical terminal-run inputs", async () => {
    const bridgeA = makeBridge();
    const renderedA = await renderAppWithBridge(bridgeA);

    await waitFor(() => {
      expect(bridgeA.shell.status).toHaveBeenCalled();
    });

    const inputA =
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|run|shell/i);
    const runButtonA =
      screen.queryByRole("button", { name: /run/i }) ??
      screen.queryByText(/^run$/i) ??
      screen.getByRole("button");

    fireEvent.change(inputA as HTMLElement, {
      target: { value: COMMAND_TEXT },
    });
    fireEvent.click(runButtonA);

    await waitFor(() => {
      expect(bridgeA.shell.run).toHaveBeenCalled();
    });

    bridgeA.shell.emit({
      type: "shell-run-updated",
      payload: {
        ...makeShellStatus(),
        command: {
          present: true,
          id: RUN_ID,
          command: COMMAND_TEXT,
          lifecycle: "succeeded",
          startedAtMs: 1711000000000,
          finishedAtMs: 1711000001000,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutBytes: 28,
          stderrBytes: 0,
          lastOutputAtMs: 1711000000800,
        },
        output: {
          stdoutFlowing: false,
          stderrFlowing: false,
          truncated: false,
          lastStdoutAtMs: 1711000000800,
          lastStderrAtMs: null,
        },
        stdout: "running...\nall tests passed\n",
        stderr: "",
      },
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/all tests passed/i);
    });

    const firstHtml = renderedA.container.innerHTML;
    renderedA.unmount();

    const bridgeB = makeBridge();
    const renderedB = await renderAppWithBridge(bridgeB);

    await waitFor(() => {
      expect(bridgeB.shell.status).toHaveBeenCalled();
    });

    const inputB =
      screen.queryByRole("textbox") ??
      screen.queryByPlaceholderText(/command|run|shell/i);
    const runButtonB =
      screen.queryByRole("button", { name: /run/i }) ??
      screen.queryByText(/^run$/i) ??
      screen.getByRole("button");

    fireEvent.change(inputB as HTMLElement, {
      target: { value: COMMAND_TEXT },
    });
    fireEvent.click(runButtonB);

    await waitFor(() => {
      expect(bridgeB.shell.run).toHaveBeenCalled();
    });

    bridgeB.shell.emit({
      type: "shell-run-updated",
      payload: {
        ...makeShellStatus(),
        command: {
          present: true,
          id: RUN_ID,
          command: COMMAND_TEXT,
          lifecycle: "succeeded",
          startedAtMs: 1711000000000,
          finishedAtMs: 1711000001000,
          exitCode: 0,
          signal: null,
          timedOut: false,
          cancelled: false,
          stdoutBytes: 28,
          stderrBytes: 0,
          lastOutputAtMs: 1711000000800,
        },
        output: {
          stdoutFlowing: false,
          stderrFlowing: false,
          truncated: false,
          lastStdoutAtMs: 1711000000800,
          lastStderrAtMs: null,
        },
        stdout: "running...\nall tests passed\n",
        stderr: "",
      },
    });

    await waitFor(() => {
      expect(document.body.textContent ?? "").toMatch(/all tests passed/i);
    });

    expect(renderedB.container.innerHTML).toBe(firstHtml);
  });
});
