import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / terminal_panel.test.tsx
 *
 * Canonical terminal-panel renderer contract suite.
 *
 * Purpose:
 * - verify that TerminalPanel preserves governed terminal truth around command identity,
 *   shell/environment posture, running/idle/error state, stream visibility, guarded execution,
 *   and explicit run/cancel/clear/reveal actions
 * - verify that the terminal remains an operator control surface rather than an unsafe generic log box
 * - verify that readiness, trust, environment fingerprint, and process output remain visible under
 *   loading, degraded, running, and empty-history states
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, execution semantics, and callback routing
 * - prefer explicit process-state contracts over implementation details or terminal emulator internals
 *
 * Notes:
 * - this suite assumes TerminalPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import TerminalPanel from "../../../src/renderer/components/TerminalPanel";

type TerminalPanelProps = React.ComponentProps<typeof TerminalPanel>;

function buildProps(overrides: Partial<TerminalPanelProps> = {}): TerminalPanelProps {
  return {
    title: "Terminal",
    subtitle: "Governed shell execution and output surface",
    loading: false,
    health: "healthy",
    trustLevel: "restricted",
    shellStatus: "ready",
    runState: "idle",
    commandInput: "npm test -- --runInBand",
    cwd: "/repo/adjutorix-app",
    shellLabel: "/bin/zsh",
    environmentFingerprint: {
      platform: "darwin-arm64",
      nodeVersion: "v22.4.0",
      npmVersion: "10.8.1",
      workspaceHash: "env-fp-123",
    },
    activeCommand: {
      id: "cmd-1",
      command: "npm test -- --runInBand",
      launchedAtMs: 1711000000000,
      guarded: true,
      requiresConfirmation: true,
    },
    history: [
      {
        id: "line-1",
        stream: "stdin",
        text: "$ npm test -- --runInBand",
        createdAtMs: 1711000000000,
      },
      {
        id: "line-2",
        stream: "stdout",
        text: " RUN  v3.0.0 /repo/adjutorix-app",
        createdAtMs: 1711000001000,
      },
      {
        id: "line-3",
        stream: "stdout",
        text: " ✓ packages/adjutorix-app/tests/renderer/app_shell.test.tsx (15 tests)",
        createdAtMs: 1711000002000,
      },
      {
        id: "line-4",
        stream: "stderr",
        text: " warning: terminal running with restricted shell policy",
        createdAtMs: 1711000003000,
      },
      {
        id: "line-5",
        stream: "system",
        text: " process exited with code 0",
        createdAtMs: 1711000004000,
      },
    ],
    metrics: {
      totalLines: 5,
      stdoutLines: 2,
      stderrLines: 1,
      systemLines: 1,
      stdinLines: 1,
    },
    canRun: true,
    canCancel: true,
    canClear: true,
    canRevealLog: true,
    onCommandInputChange: vi.fn(),
    onRunRequested: vi.fn(),
    onCancelRequested: vi.fn(),
    onClearRequested: vi.fn(),
    onRevealLogRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    ...overrides,
  } as TerminalPanelProps;
}

describe("TerminalPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical terminal shell with title, subtitle, shell identity, cwd, and command input", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/Terminal/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed shell execution and output surface/i)).toBeInTheDocument();
    expect(screen.getByText(/\/bin\/zsh/i)).toBeInTheDocument();
    expect(screen.getByText(/\/repo\/adjutorix-app/i)).toBeInTheDocument();
    expect(screen.getByDisplayValue("npm test -- --runInBand")).toBeInTheDocument();
  });

  it("surfaces trust and shell-readiness posture explicitly instead of presenting an unqualified console", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/restricted/i)).toBeInTheDocument();
    expect(screen.getByText(/ready/i)).toBeInTheDocument();
  });

  it("surfaces active command identity explicitly so execution context is operator-visible", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/npm test -- --runInBand/i)).toBeInTheDocument();
    expect(screen.getByText(/requires confirmation/i)).toBeInTheDocument();
  });

  it("renders stdin, stdout, stderr, and system lines as distinct stream classes instead of flattening all output", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/\$ npm test -- --runInBand/i)).toBeInTheDocument();
    expect(screen.getByText(/RUN  v3.0.0/i)).toBeInTheDocument();
    expect(screen.getByText(/warning: terminal running with restricted shell policy/i)).toBeInTheDocument();
    expect(screen.getByText(/process exited with code 0/i)).toBeInTheDocument();
  });

  it("keeps environment fingerprint visible as a governed execution fact", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/darwin-arm64/i)).toBeInTheDocument();
    expect(screen.getByText(/v22\.4\.0/i)).toBeInTheDocument();
    expect(screen.getByText(/10\.8\.1/i)).toBeInTheDocument();
    expect(screen.getByText(/env-fp-123/i)).toBeInTheDocument();
  });

  it("wires command-input changes to the explicit callback instead of mutating local shadow state", () => {
    const props = buildProps();
    render(<TerminalPanel {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "npm run verify" } });

    expect(props.onCommandInputChange).toHaveBeenCalledTimes(1);
    expect(props.onCommandInputChange).toHaveBeenCalledWith("npm run verify");
  });

  it("wires run, cancel, clear, reveal-log, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<TerminalPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const runButton = buttons.find((button) => /run/i.test(button.textContent ?? ""));
    const cancelButton = buttons.find((button) => /cancel/i.test(button.textContent ?? ""));
    const clearButton = buttons.find((button) => /clear/i.test(button.textContent ?? ""));
    const revealButton = buttons.find((button) => /reveal/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(runButton).toBeDefined();
    expect(cancelButton).toBeDefined();
    expect(clearButton).toBeDefined();
    expect(revealButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(runButton!);
    fireEvent.click(cancelButton!);
    fireEvent.click(clearButton!);
    fireEvent.click(revealButton!);
    fireEvent.click(refreshButton!);

    expect(props.onRunRequested).toHaveBeenCalledTimes(1);
    expect(props.onCancelRequested).toHaveBeenCalledTimes(1);
    expect(props.onClearRequested).toHaveBeenCalledTimes(1);
    expect(props.onRevealLogRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("surfaces running posture explicitly instead of reusing idle-shell assumptions", () => {
    render(
      <TerminalPanel
        {...buildProps({
          runState: "running",
          activeCommand: {
            ...buildProps().activeCommand,
            requiresConfirmation: false,
          },
        })}
      />,
    );

    expect(screen.getByText(/running/i)).toBeInTheDocument();
  });

  it("surfaces failed shell posture explicitly when execution is not healthy", () => {
    render(
      <TerminalPanel
        {...buildProps({
          health: "degraded",
          shellStatus: "failed",
          history: [
            {
              id: "err-1",
              stream: "stderr",
              text: " shell bootstrap failed: missing token or invalid environment",
              createdAtMs: 1711000005000,
            },
          ],
          metrics: {
            totalLines: 1,
            stdoutLines: 0,
            stderrLines: 1,
            systemLines: 0,
            stdinLines: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/failed/i)).toBeInTheDocument();
    expect(screen.getByText(/missing token or invalid environment/i)).toBeInTheDocument();
  });

  it("does not advertise run as enabled when canRun is false", () => {
    render(
      <TerminalPanel
        {...buildProps({
          canRun: false,
        })}
      />,
    );

    const runButton = screen.getAllByRole("button").find((button) => /run/i.test(button.textContent ?? ""));
    expect(runButton).toBeDisabled();
  });

  it("does not advertise cancel as enabled when no cancellable execution exists", () => {
    render(
      <TerminalPanel
        {...buildProps({
          canCancel: false,
          runState: "idle",
        })}
      />,
    );

    const cancelButton = screen.getAllByRole("button").find((button) => /cancel/i.test(button.textContent ?? ""));
    expect(cancelButton).toBeDisabled();
  });

  it("supports empty-history posture explicitly without dropping shell identity", () => {
    render(
      <TerminalPanel
        {...buildProps({
          history: [],
          metrics: {
            totalLines: 0,
            stdoutLines: 0,
            stderrLines: 0,
            systemLines: 0,
            stdinLines: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/Terminal/i)).toBeInTheDocument();
    expect(screen.queryByText(/RUN  v3\.0\.0/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the terminal shell contract", () => {
    render(
      <TerminalPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Terminal/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed shell execution and output surface/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about stream composition", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/stdout/i)).toBeInTheDocument();
    expect(screen.getByText(/stderr/i)).toBeInTheDocument();
    expect(screen.getByText(/system/i)).toBeInTheDocument();
    expect(screen.getByText(/stdin/i)).toBeInTheDocument();
  });

  it("preserves guarded-execution semantics explicitly instead of flattening all commands into the same run posture", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByText(/guarded/i)).toBeInTheDocument();
    expect(screen.getByText(/requires confirmation/i)).toBeInTheDocument();
  });

  it("does not collapse terminal shell into only an output log; input, controls, metrics, and execution context remain distinct surfaces", () => {
    render(<TerminalPanel {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(4);
    expect(screen.getByText(/darwin-arm64/i)).toBeInTheDocument();
    expect(screen.getByText(/RUN  v3\.0\.0/i)).toBeInTheDocument();
  });
});
