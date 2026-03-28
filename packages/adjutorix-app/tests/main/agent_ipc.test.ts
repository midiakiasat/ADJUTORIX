import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_ipc.test.ts
 *
 * Canonical agent-IPC contract suite.
 *
 * Purpose:
 * - verify that main-process agent IPC preserves one authoritative boundary for agent session,
 *   connect/reconnect/refresh/send flows, and message/tool/job/session event delivery to renderer surfaces
 * - verify that request/response contracts, optimistic send handling, stream fanout, subscription cleanup,
 *   policy gating, and error normalization remain deterministic
 * - verify that stale or malformed agent events cannot desynchronize renderer state from main-process session truth
 *
 * Test philosophy:
 * - no snapshots
 * - assert orchestration semantics, event routing, lifecycle guarantees, and limiting cases directly
 * - prefer stream ordering, cleanup, and shape-drift counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/ipc/agent_ipc exports the functions and types referenced below
 * - if the production module exports differ slightly, update adapters first rather than weakening intent
 */

import {
  createAgentIpc,
  type AgentIpcEnvironment,
  type AgentSessionSnapshot,
  type AgentMessage,
  type AgentToolRun,
  type AgentJob,
  type AgentEventPayload,
} from "../../../src/main/ipc/agent_ipc";

function message(partial: Partial<AgentMessage> & Pick<AgentMessage, "id" | "role" | "content">): AgentMessage {
  return {
    createdAtMs: 1711000000000,
    streamState: "completed",
    requestId: null,
    toolName: null,
    ...partial,
  } as AgentMessage;
}

function toolRun(partial: Partial<AgentToolRun> & Pick<AgentToolRun, "id" | "toolName" | "state">): AgentToolRun {
  return {
    startedAtMs: 1711000000000,
    endedAtMs: null,
    message: null,
    ...partial,
  } as AgentToolRun;
}

function job(partial: Partial<AgentJob> & Pick<AgentJob, "id" | "title" | "phase">): AgentJob {
  return {
    createdAtMs: 1711000000000,
    updatedAtMs: 1711000001000,
    requestId: null,
    metadata: {},
    ...partial,
  } as AgentJob;
}

function snapshot(overrides: Partial<AgentSessionSnapshot> = {}): AgentSessionSnapshot {
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
      message({ id: "msg-user-1", role: "user", content: "Explain replay blockers.", requestId: "req-1" }),
      message({ id: "msg-assistant-1", role: "assistant", content: "Replay mismatch blocks apply.", requestId: "req-1" }),
      message({ id: "msg-tool-1", role: "tool", content: "tool: ledger.lookup -> failed edge 18 -> 19", requestId: "req-1", toolName: "ledger.lookup" }),
    ],
    activeTools: [
      toolRun({ id: "tool-1", toolName: "ledger.lookup", state: "running", message: "Inspecting failed ledger edge." }),
    ],
    jobs: [
      job({ id: "job-1", title: "Verify patch-42", phase: "running", requestId: "req-1", metadata: { verifyId: "verify-42", patchId: "patch-42" } }),
      job({ id: "job-2", title: "Refresh index", phase: "queued", requestId: "req-2", metadata: { workspaceId: "ws-1" } }),
    ],
    ...overrides,
  } as AgentSessionSnapshot;
}

function env(overrides: Partial<AgentIpcEnvironment> = {}): AgentIpcEnvironment {
  const listeners = new Set<(payload: AgentEventPayload) => void>();

  return {
    agentService: {
      connect: vi.fn(async () => snapshot()),
      refresh: vi.fn(async () => snapshot({ health: { level: "healthy", reasons: ["refreshed"] } })),
      reconnect: vi.fn(async () => snapshot({ connectionState: "connected", pendingRequestCount: 0 })),
      disconnect: vi.fn(async () => undefined),
      sendMessage: vi.fn(async (draft: string) => ({
        requestId: "req-send-1",
        optimisticMessages: [
          message({ id: "msg-user-send-1", role: "user", content: draft, requestId: "req-send-1" }),
        ],
      })),
      subscribe: vi.fn((listener: (payload: AgentEventPayload) => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      emit: (payload: AgentEventPayload) => {
        listeners.forEach((listener) => listener(payload));
      },
    },
    policy: {
      evaluate: vi.fn(() => ({ allowed: true, violations: [] })),
    },
    sender: {
      sendToWebContents: vi.fn(),
    },
    ...overrides,
  } as unknown as AgentIpcEnvironment;
}

describe("main/ipc/agent_ipc", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects to agent session through IPC with canonical response shape", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleConnect({
      requestId: "req-connect-1",
      payload: {},
      webContentsId: 7,
    });

    expect(environment.agentService.connect).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.result.identity.sessionId).toBe("agent-session-1");
    expect(result.result.connectionState).toBe("connected");
  });

  it("refreshes agent session through IPC without changing canonical session identity", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleRefresh({
      requestId: "req-refresh-1",
      payload: {},
      webContentsId: 7,
    });

    expect(environment.agentService.refresh).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.result.identity.sessionId).toBe("agent-session-1");
    expect(result.result.health.reasons).toContain("refreshed");
  });

  it("reconnects agent session through IPC and returns normalized success", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleReconnect({
      requestId: "req-reconnect-1",
      payload: {},
      webContentsId: 7,
    });

    expect(environment.agentService.reconnect).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    expect(result.result.connectionState).toBe("connected");
  });

  it("disconnects agent session through IPC and returns normalized success", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleDisconnect({
      requestId: "req-disconnect-1",
      payload: {},
      webContentsId: 7,
    });

    expect(environment.agentService.disconnect).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
  });

  it("sends a chat draft through IPC and returns optimistic user messages with request identity", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleSendMessage({
      requestId: "req-send-outer-1",
      payload: {
        draft: "Summarize why apply is blocked.",
      },
      webContentsId: 7,
    });

    expect(environment.agentService.sendMessage).toHaveBeenCalledWith("Summarize why apply is blocked.");
    expect(result.ok).toBe(true);
    expect(result.result.requestId).toBe("req-send-1");
    expect(result.result.optimisticMessages).toEqual([
      expect.objectContaining({
        id: "msg-user-send-1",
        role: "user",
        content: "Summarize why apply is blocked.",
      }),
    ]);
  });

  it("rejects policy-denied connect requests before reaching the agent service", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "AUTHORITY_DENIED" }] })),
      },
    });
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleConnect({
      requestId: "req-connect-2",
      payload: {},
      webContentsId: 7,
    });

    expect(environment.agentService.connect).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AGENT_IPC_POLICY_DENIED");
  });

  it("rejects malformed send-message payloads without reaching the agent service", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleSendMessage({
      requestId: "req-send-outer-2",
      payload: {} as { draft: string },
      webContentsId: 7,
    });

    expect(environment.agentService.sendMessage).not.toHaveBeenCalled();
    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("INVALID_AGENT_REQUEST");
  });

  it("normalizes agent-service failures into structured IPC errors instead of leaking raw exceptions", async () => {
    const environment = env({
      agentService: {
        ...env().agentService,
        connect: vi.fn(async () => {
          throw new Error("agent unavailable");
        }),
      },
    });
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleConnect({
      requestId: "req-connect-3",
      payload: {},
      webContentsId: 7,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AGENT_IPC_HANDLER_FAILED");
    expect(result.error.message).toContain("agent unavailable");
  });

  it("subscribes a renderer to agent events and fans out snapshot events to the correct webContents", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const sub = await ipc.handleSubscribe({
      requestId: "req-sub-1",
      payload: {},
      webContentsId: 7,
    });

    expect(sub.ok).toBe(true);
    expect(environment.agentService.subscribe).toHaveBeenCalledWith(expect.any(Function));

    environment.agentService.emit({
      type: "agent-snapshot",
      snapshot: snapshot({ identity: { ...snapshot().identity, sessionId: "agent-session-event" } }),
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      7,
      "agent:event",
      expect.objectContaining({
        type: "agent-snapshot",
        snapshot: expect.objectContaining({
          identity: expect.objectContaining({ sessionId: "agent-session-event" }),
        }),
      }),
    );
  });

  it("fans out message, tool, job, and session-state events without mutating their semantic shape", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-2",
      payload: {},
      webContentsId: 9,
    });

    environment.agentService.emit({
      type: "agent-message",
      message: message({
        id: "msg-assistant-2",
        role: "assistant",
        content: "Apply remains blocked.",
        requestId: "req-2",
        streamState: "streaming",
      }),
    });
    environment.agentService.emit({
      type: "agent-tool",
      tool: toolRun({
        id: "tool-2",
        toolName: "patch.review",
        state: "running",
        message: "Loading patch review.",
      }),
    });
    environment.agentService.emit({
      type: "agent-job",
      job: job({
        id: "job-3",
        title: "Run smoke suite",
        phase: "queued",
        requestId: "req-3",
      }),
    });
    environment.agentService.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "connected",
        authState: "available",
        trustLevel: "trusted",
        health: { level: "degraded", reasons: ["latency rising"] },
        streamState: "streaming",
        pendingRequestCount: 1,
      },
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 9 && call[1] === "agent:event")
      .map((call) => call[2]);

    expect(payloads).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "agent-message", message: expect.objectContaining({ id: "msg-assistant-2", content: "Apply remains blocked." }) }),
        expect.objectContaining({ type: "agent-tool", tool: expect.objectContaining({ id: "tool-2", toolName: "patch.review" }) }),
        expect.objectContaining({ type: "agent-job", job: expect.objectContaining({ id: "job-3", title: "Run smoke suite" }) }),
        expect.objectContaining({ type: "agent-session-state", patch: expect.objectContaining({ streamState: "streaming", pendingRequestCount: 1 }) }),
      ]),
    );
  });

  it("fans out streaming updates in order so the renderer can preserve request lineage", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-3",
      payload: {},
      webContentsId: 10,
    });

    environment.agentService.emit({
      type: "agent-message",
      message: message({
        id: "msg-stream-1",
        role: "assistant",
        content: "Partial",
        requestId: "req-stream",
        streamState: "streaming",
        createdAtMs: 1711000001000,
      }),
    });
    environment.agentService.emit({
      type: "agent-message",
      message: message({
        id: "msg-stream-1",
        role: "assistant",
        content: "Partial completed",
        requestId: "req-stream",
        streamState: "completed",
        createdAtMs: 1711000001000,
      }),
    });

    const payloads = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 10 && call[1] === "agent:event")
      .map((call) => call[2]);

    expect(payloads[0]).toEqual(expect.objectContaining({ type: "agent-message", message: expect.objectContaining({ content: "Partial", streamState: "streaming" }) }));
    expect(payloads[1]).toEqual(expect.objectContaining({ type: "agent-message", message: expect.objectContaining({ content: "Partial completed", streamState: "completed" }) }));
  });

  it("supports multiple subscribers and fans out identical agent events to each subscribed renderer", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-4",
      payload: {},
      webContentsId: 11,
    });
    await ipc.handleSubscribe({
      requestId: "req-sub-5",
      payload: {},
      webContentsId: 12,
    });

    environment.agentService.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "invalid",
        trustLevel: "restricted",
        health: { level: "degraded", reasons: ["token expired"] },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      11,
      "agent:event",
      expect.objectContaining({ type: "agent-session-state" }),
    );
    expect(environment.sender.sendToWebContents).toHaveBeenCalledWith(
      12,
      "agent:event",
      expect.objectContaining({ type: "agent-session-state" }),
    );
  });

  it("treats duplicate subscribe requests from the same renderer idempotently", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-6",
      payload: {},
      webContentsId: 13,
    });
    await ipc.handleSubscribe({
      requestId: "req-sub-7",
      payload: {},
      webContentsId: 13,
    });

    environment.agentService.emit({
      type: "agent-job",
      job: job({ id: "job-4", title: "Index refresh", phase: "running" }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls.filter(
      (call) => call[0] === 13 && call[1] === "agent:event",
    );

    expect(calls).toHaveLength(1);
  });

  it("unsubscribes deterministically so later agent events no longer reach that renderer", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const sub = await ipc.handleSubscribe({
      requestId: "req-sub-8",
      payload: {},
      webContentsId: 14,
    });

    expect(sub.ok).toBe(true);

    const unsub = await ipc.handleUnsubscribe({
      requestId: "req-unsub-1",
      payload: {},
      webContentsId: 14,
    });

    expect(unsub.ok).toBe(true);

    environment.agentService.emit({
      type: "agent-message",
      message: message({ id: "msg-after-unsub", role: "assistant", content: "should not arrive" }),
    });

    const calls = (environment.sender.sendToWebContents as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.some((call) => call[0] === 14)).toBe(false);
  });

  it("rejects subscribe requests denied by policy before wiring listeners", async () => {
    const environment = env({
      policy: {
        evaluate: vi.fn(() => ({ allowed: false, violations: [{ code: "TRUST_DENIED" }] })),
      },
    });
    const ipc = createAgentIpc(environment);

    const result = await ipc.handleSubscribe({
      requestId: "req-sub-9",
      payload: {},
      webContentsId: 15,
    });

    expect(result.ok).toBe(false);
    expect(result.error.code).toBe("AGENT_IPC_POLICY_DENIED");
    expect(environment.agentService.subscribe).not.toHaveBeenCalled();
  });

  it("normalizes malformed emitted events instead of forwarding invalid shapes directly to renderer", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-10",
      payload: {},
      webContentsId: 16,
    });

    environment.agentService.emit({
      type: "agent-message",
      message: null,
    } as unknown as AgentEventPayload);

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("cleans up all subscriptions on dispose so later emissions cannot leak into dead registries", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    await ipc.handleSubscribe({
      requestId: "req-sub-11",
      payload: {},
      webContentsId: 17,
    });

    ipc.dispose();

    environment.agentService.emit({
      type: "agent-session-state",
      patch: {
        connectionState: "disconnected",
        authState: "invalid",
        trustLevel: "restricted",
        health: { level: "degraded", reasons: ["disposed registry should stay silent"] },
        streamState: "idle",
        pendingRequestCount: 0,
      },
    });

    expect(environment.sender.sendToWebContents).not.toHaveBeenCalled();
  });

  it("returns deterministic identical request verdicts for identical connect calls", async () => {
    const environment = env();
    const ipc = createAgentIpc(environment);

    const a = await ipc.handleConnect({
      requestId: "req-connect-4a",
      payload: {},
      webContentsId: 7,
    });
    const b = await ipc.handleConnect({
      requestId: "req-connect-4b",
      payload: {},
      webContentsId: 7,
    });

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.result).toEqual(b.result);
  });
});
