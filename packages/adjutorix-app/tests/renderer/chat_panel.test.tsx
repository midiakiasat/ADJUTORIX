import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / chat_panel.test.tsx
 *
 * Canonical chat-panel renderer contract suite.
 *
 * Purpose:
 * - verify that ChatPanel preserves governed conversation truth around session identity,
 *   provider/model provenance, message role boundaries, request lineage, streaming posture,
 *   tool activity, send gating, and explicit send/stop/clear/reconnect actions
 * - verify that chat remains a projection of canonical agent state rather than a generic messenger UI
 * - verify that empty, loading, degraded, disconnected, and streaming states remain explicit
 *
 * Test philosophy:
 * - no snapshots
 * - assert operator-visible structure, conversation semantics, and callback routing
 * - prefer role/tool/request lineage contracts over implementation details
 *
 * Notes:
 * - this suite assumes ChatPanel exports a default React component from the renderer tree
 * - if the production prop surface evolves, update buildProps() first
 */

import ChatPanel from "../../../src/renderer/components/ChatPanel";

type ChatPanelProps = React.ComponentProps<typeof ChatPanel>;

function buildProps(overrides: Partial<ChatPanelProps> = {}): ChatPanelProps {
  return {
    title: "Chat",
    subtitle: "Governed agent conversation and tool-activity surface",
    loading: false,
    health: "healthy",
    connectionState: "connected",
    authState: "available",
    trustLevel: "trusted",
    sessionId: "agent-session-42",
    providerLabel: "Local Agent",
    modelLabel: "adjutorix-core",
    endpointLabel: "http://127.0.0.1:8000/rpc",
    streamState: "streaming",
    draft: "Summarize why apply is blocked.",
    selectedMessageId: "msg-assistant-2",
    pendingRequestCount: 1,
    messages: [
      {
        id: "msg-user-1",
        role: "user",
        content: "Explain the current verification blockers.",
        createdAtMs: 1711000000000,
        streamState: "completed",
        requestId: "req-42",
      },
      {
        id: "msg-assistant-1",
        role: "assistant",
        content: "Verification is partially complete. Replay mismatch and ledger continuity remain unresolved.",
        createdAtMs: 1711000001000,
        streamState: "completed",
        requestId: "req-42",
      },
      {
        id: "msg-tool-1",
        role: "tool",
        content: "tool: ledger.lookup -> found failed edge 18 -> 19",
        createdAtMs: 1711000001500,
        streamState: "completed",
        requestId: "req-42",
        toolName: "ledger.lookup",
      },
      {
        id: "msg-assistant-2",
        role: "assistant",
        content: "Apply remains blocked while rejected review files and failed replay checks still exist.",
        createdAtMs: 1711000002000,
        streamState: "streaming",
        requestId: "req-43",
      },
    ],
    activeTools: [
      {
        id: "tool-run-1",
        toolName: "ledger.lookup",
        state: "running",
        startedAtMs: 1711000001800,
        message: "Inspecting rollback lineage and failed verify edges.",
      },
      {
        id: "tool-run-2",
        toolName: "patch.review",
        state: "succeeded",
        startedAtMs: 1711000001200,
        endedAtMs: 1711000001700,
        message: "Patch review state retrieved.",
      },
    ],
    metrics: {
      totalMessages: 4,
      userMessages: 1,
      assistantMessages: 2,
      toolMessages: 1,
      activeTools: 1,
    },
    notes: [
      "Streaming assistant output remains tied to request req-43 and must not be merged with completed assistant turns.",
      "Tool activity remains visible so operator-visible provenance survives beyond plain assistant prose.",
    ],
    canSend: true,
    canStop: true,
    canClear: true,
    canReconnect: true,
    canRefresh: true,
    onDraftChange: vi.fn(),
    onSendRequested: vi.fn(),
    onStopRequested: vi.fn(),
    onClearRequested: vi.fn(),
    onReconnectRequested: vi.fn(),
    onRefreshRequested: vi.fn(),
    onSelectMessage: vi.fn(),
    ...overrides,
  } as ChatPanelProps;
}

describe("ChatPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the canonical chat shell with title, subtitle, session identity, provider, and messages", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByText(/Chat/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed agent conversation and tool-activity surface/i)).toBeInTheDocument();
    expect(screen.getByText(/agent-session-42/i)).toBeInTheDocument();
    expect(screen.getByText(/Local Agent/i)).toBeInTheDocument();
    expect(screen.getByText(/adjutorix-core/i)).toBeInTheDocument();
    expect(screen.getByText(/http:\/\/127\.0\.0\.1:8000\/rpc/i)).toBeInTheDocument();
    expect(screen.getByText(/Explain the current verification blockers/i)).toBeInTheDocument();
  });

  it("preserves role boundaries explicitly so user, assistant, and tool messages do not collapse", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByText(/user/i)).toBeInTheDocument();
    expect(screen.getAllByText(/assistant/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/tool/i)).toBeInTheDocument();
    expect(screen.getByText(/tool: ledger\.lookup/i)).toBeInTheDocument();
  });

  it("surfaces connection, auth, trust, and stream posture explicitly instead of presenting an unqualified chat log", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByText(/connected/i)).toBeInTheDocument();
    expect(screen.getByText(/available/i)).toBeInTheDocument();
    expect(screen.getByText(/trusted/i)).toBeInTheDocument();
    expect(screen.getByText(/streaming/i)).toBeInTheDocument();
  });

  it("surfaces request lineage explicitly so completed and streaming turns remain attributable", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getAllByText(/req-42/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/req-43/i).length).toBeGreaterThanOrEqual(1);
  });

  it("surfaces active tool activity explicitly instead of hiding provenance behind assistant paraphrase", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getAllByText(/ledger\.lookup/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Inspecting rollback lineage and failed verify edges/i)).toBeInTheDocument();
    expect(screen.getByText(/Patch review state retrieved/i)).toBeInTheDocument();
  });

  it("keeps metrics operator-visible as facts about message roles and active tools", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByText(/total/i)).toBeInTheDocument();
    expect(screen.getAllByText(/assistant/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText(/tool/i).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/active/i)).toBeInTheDocument();
  });

  it("surfaces notes explicitly so stream/request and tool provenance constraints remain visible", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByText(/must not be merged with completed assistant turns/i)).toBeInTheDocument();
    expect(screen.getByText(/Tool activity remains visible/i)).toBeInTheDocument();
  });

  it("wires draft input changes to the explicit callback instead of mutating local shadow state", () => {
    const props = buildProps();
    render(<ChatPanel {...props} />);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Explain rollback lineage next." } });

    expect(props.onDraftChange).toHaveBeenCalledTimes(1);
    expect(props.onDraftChange).toHaveBeenCalledWith("Explain rollback lineage next.");
  });

  it("wires send, stop, clear, reconnect, and refresh actions explicitly", () => {
    const props = buildProps();
    render(<ChatPanel {...props} />);

    const buttons = screen.getAllByRole("button");
    const sendButton = buttons.find((button) => /send/i.test(button.textContent ?? ""));
    const stopButton = buttons.find((button) => /stop/i.test(button.textContent ?? ""));
    const clearButton = buttons.find((button) => /clear/i.test(button.textContent ?? ""));
    const reconnectButton = buttons.find((button) => /reconnect/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(sendButton).toBeDefined();
    expect(stopButton).toBeDefined();
    expect(clearButton).toBeDefined();
    expect(reconnectButton).toBeDefined();
    expect(refreshButton).toBeDefined();

    fireEvent.click(sendButton!);
    fireEvent.click(stopButton!);
    fireEvent.click(clearButton!);
    fireEvent.click(reconnectButton!);
    fireEvent.click(refreshButton!);

    expect(props.onSendRequested).toHaveBeenCalledTimes(1);
    expect(props.onStopRequested).toHaveBeenCalledTimes(1);
    expect(props.onClearRequested).toHaveBeenCalledTimes(1);
    expect(props.onReconnectRequested).toHaveBeenCalledTimes(1);
    expect(props.onRefreshRequested).toHaveBeenCalledTimes(1);
  });

  it("wires message selection to the explicit callback instead of silently mutating focused turn state", () => {
    const props = buildProps();
    render(<ChatPanel {...props} />);

    fireEvent.click(screen.getByText(/Apply remains blocked while rejected review files/i));

    expect(props.onSelectMessage).toHaveBeenCalledTimes(1);
    expect(props.onSelectMessage).toHaveBeenCalledWith("msg-assistant-2");
  });

  it("does not advertise send, stop, clear, reconnect, or refresh as enabled when capability gates are closed", () => {
    render(
      <ChatPanel
        {...buildProps({
          canSend: false,
          canStop: false,
          canClear: false,
          canReconnect: false,
          canRefresh: false,
        })}
      />,
    );

    const buttons = screen.getAllByRole("button");
    const sendButton = buttons.find((button) => /send/i.test(button.textContent ?? ""));
    const stopButton = buttons.find((button) => /stop/i.test(button.textContent ?? ""));
    const clearButton = buttons.find((button) => /clear/i.test(button.textContent ?? ""));
    const reconnectButton = buttons.find((button) => /reconnect/i.test(button.textContent ?? ""));
    const refreshButton = buttons.find((button) => /refresh/i.test(button.textContent ?? ""));

    expect(sendButton).toBeDisabled();
    expect(stopButton).toBeDisabled();
    expect(clearButton).toBeDisabled();
    expect(reconnectButton).toBeDisabled();
    expect(refreshButton).toBeDisabled();
  });

  it("surfaces disconnected posture explicitly instead of reusing connected-shell assumptions", () => {
    render(
      <ChatPanel
        {...buildProps({
          connectionState: "disconnected",
          streamState: "idle",
          notes: ["Agent connection is down; reconnect before issuing new requests."],
        })}
      />,
    );

    expect(screen.getByText(/disconnected/i)).toBeInTheDocument();
    expect(screen.getByText(/Agent connection is down/i)).toBeInTheDocument();
  });

  it("surfaces degraded health posture explicitly instead of assuming conversation freshness", () => {
    render(
      <ChatPanel
        {...buildProps({
          health: "degraded",
        })}
      />,
    );

    expect(screen.getByText(/degraded/i)).toBeInTheDocument();
  });

  it("supports empty conversation posture explicitly when no messages have been recorded yet", () => {
    render(
      <ChatPanel
        {...buildProps({
          messages: [],
          selectedMessageId: null,
          activeTools: [],
          pendingRequestCount: 0,
          notes: ["No conversation messages have been recorded yet."],
          metrics: {
            totalMessages: 0,
            userMessages: 0,
            assistantMessages: 0,
            toolMessages: 0,
            activeTools: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/No conversation messages have been recorded yet/i)).toBeInTheDocument();
    expect(screen.queryByText(/Explain the current verification blockers/i)).not.toBeInTheDocument();
  });

  it("renders loading posture explicitly without dropping the chat shell contract", () => {
    render(
      <ChatPanel
        {...buildProps({
          loading: true,
        })}
      />,
    );

    expect(screen.getByText(/Chat/i)).toBeInTheDocument();
    expect(screen.getByText(/Governed agent conversation and tool-activity surface/i)).toBeInTheDocument();
  });

  it("supports idle completed posture explicitly when no active streaming remains", () => {
    render(
      <ChatPanel
        {...buildProps({
          streamState: "completed",
          pendingRequestCount: 0,
          activeTools: [],
          metrics: {
            totalMessages: 4,
            userMessages: 1,
            assistantMessages: 2,
            toolMessages: 1,
            activeTools: 0,
          },
        })}
      />,
    );

    expect(screen.getByText(/completed/i)).toBeInTheDocument();
  });

  it("does not collapse the chat shell into only a message log; draft input, controls, metrics, and provenance remain distinct", () => {
    render(<ChatPanel {...buildProps()} />);

    expect(screen.getByRole("textbox")).toBeInTheDocument();
    expect(screen.getAllByRole("button").length).toBeGreaterThanOrEqual(5);
    expect(screen.getByText(/agent-session-42/i)).toBeInTheDocument();
    expect(screen.getByText(/tool: ledger\.lookup/i)).toBeInTheDocument();
  });
});
