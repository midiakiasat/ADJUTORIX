import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / RENDERER / use_agent.test.ts
 *
 * Canonical useAgent hook contract suite.
 *
 * Purpose:
 * - verify that useAgent preserves one authoritative renderer-side projection of agent session truth
 * - verify that connect/reconnect/refresh/send flows are sequence-guarded so stale async completions
 *   never overwrite newer session, stream, tool, or job state
 * - verify that event-driven message/tool/job/session updates remain deterministic and derive stable
 *   indexes and counts from canonical session snapshots
 * - verify that idle, connecting, ready, reconnecting, streaming, disconnected, degraded, and error
 *   states remain explicit
 *
 * Test philosophy:
 * - no implementation snapshots
 * - assert hook contract, state transitions, race guarantees, and derived-data invariants directly
 * - prefer stream lineage, event ordering, and canonical projection guarantees over shallow happy-path checks
 *
 * Notes:
 * - this suite assumes useAgent exports both a named and default hook from the renderer hooks tree
 * - if the production hook signature evolves, update fixture builders first
 */

import useAgent, {
  type AgentEvent,
  type AgentMessage,
  type AgentProvider,
  type AgentSessionSnapshot,
  type AgentToolRun,
  type AgentJob,
  type AgentHealth,
} from "../../../src/hooks/useAgent";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function health(level: AgentHealth["level"], reasons: string[] = []): AgentHealth {
  return { level, reasons };
}

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
    health: health("healthy"),
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

function makeProvider(overrides: Partial<AgentProvider> = {}): AgentProvider {
  return {
    connect: vi.fn(async () => snapshot()),
    refresh: vi.fn(async () => snapshot({ health: health("healthy", ["refreshed"]) })),
    reconnect: vi.fn(async () => snapshot({ connectionState: "connected", pendingRequestCount: 0 })),
    disconnect: vi.fn(async () => undefined),
    sendMessage: vi.fn(async (_draft: string) => ({
      requestId: "req-send-1",
      optimisticMessages: [message({ id: "msg-user-send-1", role: "user", content: _draft, requestId: "req-send-1" })],
    })),
    subscribe: vi.fn(() => () => undefined),
    ...overrides,
  };
}

describe("useAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hydrates from provider connect into ready state with canonical snapshot and derived indexes", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));

    expect(result.current.state).toBe("connecting");
    expect(result.current.isBusy).toBe(true);

    await waitFor(() => expect(result.current.state).toBe("ready"));

    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(result.current.snapshot?.identity.sessionId).toBe("agent-session-1");
    expect(result.current.snapshot?.connectionState).toBe("connected");
    expect(result.current.derived.totalMessages).toBe(3);
    expect(result.current.derived.totalUserMessages).toBe(1);
    expect(result.current.derived.totalAssistantMessages).toBe(1);
    expect(result.current.derived.totalToolMessages).toBe(1);
    expect(result.current.derived.activeToolCount).toBe(1);
    expect(result.current.derived.runningJobCount).toBe(1);
    expect(result.current.derived.lastMessage?.id).toBe("msg-tool-1");
    expect(result.current.derived.messagesById.get("msg-assistant-1")?.content).toContain("Replay mismatch");
    expect(result.current.derived.activeToolMap.get("tool-1")?.toolName).toBe("ledger.lookup");
    expect(result.current.derived.jobsById.get("job-1")?.title).toBe("Verify patch-42");
  });

  it("stays idle without autoConnect and only transitions after explicit connect", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: false }));

    expect(result.current.state).toBe("idle");
    expect(provider.connect).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.connect();
    });

    expect(provider.connect).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
  });

  it("uses refresh during refresh and preserves ready semantics after completion", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      const promise = result.current.refresh();
      expect(result.current.state).toBe("refreshing");
      await promise;
    });

    expect(provider.refresh).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
    expect(result.current.snapshot?.health.reasons).toContain("refreshed");
  });

  it("uses reconnect during reconnect and preserves ready state after completion", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      const promise = result.current.reconnect();
      expect(result.current.state).toBe("reconnecting");
      await promise;
    });

    expect(provider.reconnect).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("ready");
  });

  it("guards against stale async connect completion overwriting newer reconnect results", async () => {
    const first = deferred<AgentSessionSnapshot>();
    const second = deferred<AgentSessionSnapshot>();

    const provider = makeProvider({
      connect: vi.fn(() => first.promise),
      reconnect: vi.fn(() => second.promise),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));

    await act(async () => {
      const reconnectPromise = result.current.reconnect();
      second.resolve(snapshot({ identity: { ...snapshot().identity, sessionId: "agent-session-new" } }));
      await reconnectPromise;
    });

    expect(result.current.snapshot?.identity.sessionId).toBe("agent-session-new");

    await act(async () => {
      first.resolve(snapshot({ identity: { ...snapshot().identity, sessionId: "agent-session-stale" } }));
      await Promise.resolve();
    });

    expect(result.current.snapshot?.identity.sessionId).toBe("agent-session-new");
  });

  it("exposes error state on failing connect and preserves no snapshot truth", async () => {
    const provider = makeProvider({
      connect: vi.fn(async () => {
        throw new Error("agent connect failed");
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));

    await waitFor(() => expect(result.current.state).toBe("error"));

    expect(result.current.error?.message).toBe("agent connect failed");
    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalMessages).toBe(0);
    expect(result.current.isReady).toBe(false);
  });

  it("sends message through provider, appends optimistic user message, and marks sending state explicitly", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      const promise = result.current.sendMessage("Summarize apply blockers.");
      expect(result.current.isSending).toBe(true);
      await promise;
    });

    expect(provider.sendMessage).toHaveBeenCalledWith("Summarize apply blockers.");
    expect(result.current.isSending).toBe(false);
    expect(result.current.derived.totalMessages).toBe(4);
    expect(result.current.derived.messagesById.get("msg-user-send-1")?.content).toBe("Summarize apply blockers.");
    expect(result.current.snapshot?.pendingRequestCount).toBeGreaterThanOrEqual(1);
  });

  it("preserves sendError and state when provider send fails", async () => {
    const provider = makeProvider({
      sendMessage: vi.fn(async () => {
        throw new Error("send denied");
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await expect(
      act(async () => {
        await result.current.sendMessage("hello");
      }),
    ).rejects.toThrow("send denied");

    expect(result.current.sendError?.message).toBe("send denied");
    expect(result.current.derived.totalMessages).toBe(3);
  });

  it("disconnects through provider and moves to disconnected state without mutating prior message truth", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(provider.disconnect).toHaveBeenCalledTimes(1);
    expect(result.current.state).toBe("disconnected");
    expect(result.current.snapshot?.messages).toHaveLength(3);
  });

  it("replaces snapshot explicitly through setSnapshot and rebuilds derived indexes", () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: false }));

    const next = snapshot({
      identity: { ...snapshot().identity, sessionId: "agent-session-replaced" },
      messages: [message({ id: "m1", role: "assistant", content: "single" })],
      activeTools: [],
      jobs: [],
    });

    act(() => {
      result.current.setSnapshot(next);
    });

    expect(result.current.snapshot?.identity.sessionId).toBe("agent-session-replaced");
    expect(result.current.derived.totalMessages).toBe(1);
    expect(result.current.derived.totalAssistantMessages).toBe(1);
    expect(result.current.derived.activeToolCount).toBe(0);
    expect(result.current.derived.runningJobCount).toBe(0);
  });

  it("subscribes to provider events and applies full snapshot replacement events canonically", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const unsubscribe = vi.fn();
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return unsubscribe;
      }),
    });

    const { result, unmount } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-snapshot",
        snapshot: snapshot({ identity: { ...snapshot().identity, sessionId: "agent-session-event" } }),
      });
    });

    expect(result.current.snapshot?.identity.sessionId).toBe("agent-session-event");

    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("applies message events by upserting canonical message truth and maintaining order", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-message",
        message: message({
          id: "msg-assistant-2",
          role: "assistant",
          content: "Second assistant turn.",
          requestId: "req-2",
          createdAtMs: 1711000005000,
        }),
      });
    });

    expect(result.current.derived.totalMessages).toBe(4);
    expect(result.current.derived.lastMessage?.id).toBe("msg-assistant-2");
    expect(result.current.derived.messagesById.get("msg-assistant-2")?.content).toBe("Second assistant turn.");
  });

  it("applies streaming message updates by replacing message content for the same id instead of duplicating", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-message",
        message: message({
          id: "msg-stream-1",
          role: "assistant",
          content: "Partial",
          requestId: "req-stream",
          streamState: "streaming",
          createdAtMs: 1711000005000,
        }),
      });
    });

    act(() => {
      listener?.({
        type: "agent-message",
        message: message({
          id: "msg-stream-1",
          role: "assistant",
          content: "Partial completed",
          requestId: "req-stream",
          streamState: "completed",
          createdAtMs: 1711000005000,
        }),
      });
    });

    expect(result.current.derived.messagesById.get("msg-stream-1")?.content).toBe("Partial completed");
    expect(result.current.snapshot?.messages.filter((m) => m.id === "msg-stream-1")).toHaveLength(1);
  });

  it("applies tool events by upserting active tool runs and derived activeToolCount", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-tool",
        tool: toolRun({ id: "tool-2", toolName: "patch.review", state: "running", message: "Loading patch review." }),
      });
    });

    expect(result.current.derived.activeToolCount).toBe(2);
    expect(result.current.derived.activeToolMap.get("tool-2")?.toolName).toBe("patch.review");

    act(() => {
      listener?.({
        type: "agent-tool",
        tool: toolRun({ id: "tool-2", toolName: "patch.review", state: "succeeded", endedAtMs: 1711000006000, message: "Patch review loaded." }),
      });
    });

    expect(result.current.derived.activeToolCount).toBe(1);
    expect(result.current.derived.activeToolMap.get("tool-2")?.state).toBe("succeeded");
  });

  it("applies job events by upserting jobs and recomputing running job count", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-job",
        job: job({ id: "job-3", title: "Run smoke suite", phase: "running", requestId: "req-3" }),
      });
    });

    expect(result.current.derived.runningJobCount).toBe(2);
    expect(result.current.derived.jobsById.get("job-3")?.title).toBe("Run smoke suite");

    act(() => {
      listener?.({
        type: "agent-job",
        job: job({ id: "job-3", title: "Run smoke suite", phase: "succeeded", requestId: "req-3" }),
      });
    });

    expect(result.current.derived.runningJobCount).toBe(1);
    expect(result.current.derived.jobsById.get("job-3")?.phase).toBe("succeeded");
  });

  it("applies session-state events and preserves degraded connection/auth posture explicitly", async () => {
    let listener: ((event: AgentEvent) => void) | null = null;
    const provider = makeProvider({
      subscribe: vi.fn((cb) => {
        listener = cb;
        return () => undefined;
      }),
    });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    act(() => {
      listener?.({
        type: "agent-session-state",
        patch: {
          connectionState: "disconnected",
          authState: "invalid",
          trustLevel: "restricted",
          health: health("degraded", ["token expired", "endpoint unreachable"]),
          streamState: "idle",
          pendingRequestCount: 0,
        },
      });
    });

    expect(result.current.snapshot?.connectionState).toBe("disconnected");
    expect(result.current.snapshot?.authState).toBe("invalid");
    expect(result.current.snapshot?.trustLevel).toBe("restricted");
    expect(result.current.snapshot?.health.level).toBe("degraded");
  });

  it("returns empty derived truth when snapshot is null", () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: false }));

    expect(result.current.snapshot).toBeNull();
    expect(result.current.derived.totalMessages).toBe(0);
    expect(result.current.derived.activeToolCount).toBe(0);
    expect(result.current.derived.runningJobCount).toBe(0);
    expect(result.current.derived.lastMessage).toBeNull();
  });

  it("does not mutate state after unmount when async connect resolves late", async () => {
    const gate = deferred<AgentSessionSnapshot>();
    const provider = makeProvider({ connect: vi.fn(() => gate.promise) });

    const { unmount } = renderHook(() => useAgent({ provider, autoConnect: true }));
    unmount();

    await act(async () => {
      gate.resolve(snapshot({ identity: { ...snapshot().identity, sessionId: "late-session" } }));
      await Promise.resolve();
    });

    expect(provider.connect).toHaveBeenCalledTimes(1);
  });

  it("tracks busy, ready, and sending flags consistently across connect and send phases", async () => {
    const gate = deferred<AgentSessionSnapshot>();
    const provider = makeProvider({ connect: vi.fn(() => gate.promise) });

    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    expect(result.current.isBusy).toBe(true);
    expect(result.current.isReady).toBe(false);

    await act(async () => {
      gate.resolve(snapshot());
      await gate.promise;
    });

    await waitFor(() => expect(result.current.state).toBe("ready"));
    expect(result.current.isBusy).toBe(false);
    expect(result.current.isReady).toBe(true);

    await act(async () => {
      const promise = result.current.sendMessage("hello");
      expect(result.current.isSending).toBe(true);
      await promise;
    });

    expect(result.current.isSending).toBe(false);
  });

  it("preserves disconnected but truth-bearing snapshot state after explicit disconnect", async () => {
    const provider = makeProvider();
    const { result } = renderHook(() => useAgent({ provider, autoConnect: true }));
    await waitFor(() => expect(result.current.state).toBe("ready"));

    await act(async () => {
      await result.current.disconnect();
    });

    expect(result.current.state).toBe("disconnected");
    expect(result.current.snapshot?.identity.providerLabel).toBe("Local Agent");
    expect(result.current.derived.totalMessages).toBe(3);
  });
});
