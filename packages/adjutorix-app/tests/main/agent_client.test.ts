import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_client.test.ts
 *
 * Canonical agent-client transport and session contract suite.
 *
 * Purpose:
 * - verify that the main-process agent client preserves one authoritative transport surface for
 *   connect, session snapshot fetch, message send, polling/stream subscription, health checks,
 *   and graceful shutdown against the agent RPC boundary
 * - verify that request ids, timeout behavior, retry policy, response normalization, auth propagation,
 *   event ordering, and stale-response suppression remain deterministic
 * - verify that malformed replies, transport errors, partial success, and protocol drift fail closed
 *   instead of projecting false agent/session truth upward into IPC or process orchestration
 *
 * Test philosophy:
 * - no snapshots
 * - assert transport semantics, lifecycle guarantees, and limiting cases directly
 * - prefer race conditions, protocol mismatch, and stale-response counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/agent_client exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  createAgentClient,
  type AgentClientEnvironment,
  type AgentClientSessionSnapshot,
  type AgentClientMessage,
  type AgentClientToolRun,
  type AgentClientJob,
  type AgentClientEvent,
  type AgentClientHealth,
} from "../../../src/main/services/agent_client";

function message(partial: Partial<AgentClientMessage> & Pick<AgentClientMessage, "id" | "role" | "content">): AgentClientMessage {
  return {
    createdAtMs: 1711000000000,
    streamState: "completed",
    requestId: null,
    toolName: null,
    ...partial,
  } as AgentClientMessage;
}

function toolRun(partial: Partial<AgentClientToolRun> & Pick<AgentClientToolRun, "id" | "toolName" | "state">): AgentClientToolRun {
  return {
    startedAtMs: 1711000000000,
    endedAtMs: null,
    message: null,
    ...partial,
  } as AgentClientToolRun;
}

function job(partial: Partial<AgentClientJob> & Pick<AgentClientJob, "id" | "title" | "phase">): AgentClientJob {
  return {
    createdAtMs: 1711000000000,
    updatedAtMs: 1711000001000,
    requestId: null,
    metadata: {},
    ...partial,
  } as AgentClientJob;
}

function snapshot(overrides: Partial<AgentClientSessionSnapshot> = {}): AgentClientSessionSnapshot {
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
  } as AgentClientSessionSnapshot;
}

function health(overrides: Partial<AgentClientHealth> = {}): AgentClientHealth {
  return {
    level: "healthy",
    reasons: [],
    reachable: true,
    authenticated: true,
    protocolCompatible: true,
    ...overrides,
  } as AgentClientHealth;
}

function env(overrides: Partial<AgentClientEnvironment> = {}): AgentClientEnvironment {
  let eventListener: ((event: AgentClientEvent) => void) | null = null;

  return {
    transport: {
      request: vi.fn(async (payload: { method: string; params?: Record<string, unknown>; requestId: string }) => {
        switch (payload.method) {
          case "session.connect":
            return {
              ok: true,
              result: snapshot(),
            };
          case "session.snapshot":
            return {
              ok: true,
              result: snapshot({ health: { level: "healthy", reasons: ["refreshed"] } }),
            };
          case "message.send":
            return {
              ok: true,
              result: {
                requestId: "req-send-1",
                optimisticMessages: [
                  message({ id: "msg-user-send-1", role: "user", content: String(payload.params?.draft ?? ""), requestId: "req-send-1" }),
                ],
              },
            };
          case "health.ping":
            return {
              ok: true,
              result: health(),
            };
          case "session.shutdown":
            return {
              ok: true,
              result: { stopped: true },
            };
          default:
            return {
              ok: false,
              error: {
                code: "UNKNOWN_METHOD",
                message: payload.method,
              },
            };
        }
      }),
      subscribe: vi.fn((listener: (event: AgentClientEvent) => void) => {
        eventListener = listener;
        return () => {
          eventListener = null;
        };
      }),
      emit: (event: AgentClientEvent) => {
        eventListener?.(event);
      },
    },
    idGenerator: {
      nextRequestId: vi
        .fn()
        .mockReturnValueOnce("rpc-1")
        .mockReturnValueOnce("rpc-2")
        .mockReturnValueOnce("rpc-3")
        .mockReturnValueOnce("rpc-4")
        .mockReturnValue("rpc-x"),
    },
    clock: {
      now: vi.fn(() => 1711000000000),
    },
    scheduler: {
      setTimeout: vi.fn((fn: (...args: any[]) => void, _ms: number) => {
        return setTimeout(fn, 0);
      }),
      clearTimeout: vi.fn((id: ReturnType<typeof setTimeout>) => clearTimeout(id)),
    },
    policy: {
      requestTimeoutMs: 3000,
      maxRetries: 1,
      retryableErrorCodes: ["ETIMEDOUT", "ECONNRESET", "EPIPE", "TRANSPORT_UNAVAILABLE"],
      requireProtocolVersion: "1",
    },
    ...overrides,
  } as unknown as AgentClientEnvironment;
}

describe("main/services/agent_client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("connects through the transport and returns a canonical session snapshot", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    const result = await client.connect();

    expect(environment.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.connect", requestId: "rpc-1" }),
    );
    expect(result.identity.sessionId).toBe("agent-session-1");
    expect(result.connectionState).toBe("connected");
    expect(client.getSessionSnapshot()?.identity.sessionId).toBe("agent-session-1");
  });

  it("fetches a fresh session snapshot and preserves canonical session identity", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    await client.connect();
    const refreshed = await client.fetchSessionSnapshot();

    expect(environment.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.snapshot", requestId: "rpc-2" }),
    );
    expect(refreshed.identity.sessionId).toBe("agent-session-1");
    expect(refreshed.health.reasons).toContain("refreshed");
  });

  it("sends a message with deterministic request id and returns optimistic user messages", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    const result = await client.sendMessage("Summarize apply blockers.");

    expect(environment.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "message.send",
        requestId: "rpc-1",
        params: expect.objectContaining({ draft: "Summarize apply blockers." }),
      }),
    );
    expect(result.requestId).toBe("req-send-1");
    expect(result.optimisticMessages[0].content).toBe("Summarize apply blockers.");
  });

  it("requests health over transport and normalizes the returned health record", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    const result = await client.pingHealth();

    expect(environment.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "health.ping", requestId: "rpc-1" }),
    );
    expect(result.level).toBe("healthy");
    expect(result.reachable).toBe(true);
  });

  it("requests graceful shutdown over transport and clears local connected posture", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    await client.connect();
    const result = await client.shutdown();

    expect(environment.transport.request).toHaveBeenCalledWith(
      expect.objectContaining({ method: "session.shutdown" }),
    );
    expect(result.stopped).toBe(true);
  });

  it("subscribes to transport events and fans out canonical message/tool/job/session events to listeners", async () => {
    const environment = env();
    const client = createAgentClient(environment);
    const listener = vi.fn();

    client.subscribe(listener);

    environment.transport.emit({
      type: "agent-message",
      message: message({ id: "msg-assistant-2", role: "assistant", content: "Apply remains blocked.", requestId: "req-2", streamState: "streaming" }),
    });
    environment.transport.emit({
      type: "agent-tool",
      tool: toolRun({ id: "tool-2", toolName: "patch.review", state: "running", message: "Loading review." }),
    });
    environment.transport.emit({
      type: "agent-job",
      job: job({ id: "job-3", title: "Run smoke suite", phase: "queued", requestId: "req-3" }),
    });
    environment.transport.emit({
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

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-message" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-tool" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-job" }));
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ type: "agent-session-state" }));
  });

  it("updates local session projection when a full snapshot event arrives", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    await client.connect();

    environment.transport.emit({
      type: "agent-snapshot",
      snapshot: snapshot({ identity: { ...snapshot().identity, sessionId: "agent-session-event" } }),
    });

    expect(client.getSessionSnapshot()?.identity.sessionId).toBe("agent-session-event");
  });

  it("fails closed on malformed transport success payloads instead of projecting fake readiness", async () => {
    const environment = env({
      transport: {
        ...env().transport,
        request: vi.fn(async () => ({ ok: true, result: { nonsense: true } })),
      },
    });
    const client = createAgentClient(environment);

    await expect(client.connect()).rejects.toThrow();
    expect(client.getSessionSnapshot()).toBeNull();
  });

  it("surfaces protocol errors as structured failures instead of inventing defaults", async () => {
    const environment = env({
      transport: {
        ...env().transport,
        request: vi.fn(async () => ({
          ok: false,
          error: { code: "AUTH_DENIED", message: "token invalid" },
        })),
      },
    });
    const client = createAgentClient(environment);

    await expect(client.connect()).rejects.toThrow(/token invalid/i);
  });

  it("retries retryable transport failures once when policy allows and succeeds on retry", async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockResolvedValueOnce({ ok: true, result: snapshot() });

    const environment = env({
      transport: {
        ...env().transport,
        request,
      },
    });
    const client = createAgentClient(environment);

    const result = await client.connect();

    expect(request).toHaveBeenCalledTimes(2);
    expect(result.identity.sessionId).toBe("agent-session-1");
  });

  it("does not retry non-retryable failures and fails immediately", async () => {
    const request = vi.fn().mockRejectedValueOnce(Object.assign(new Error("permission denied"), { code: "EPERM" }));

    const environment = env({
      transport: {
        ...env().transport,
        request,
      },
    });
    const client = createAgentClient(environment);

    await expect(client.connect()).rejects.toThrow(/permission denied/i);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("guards against stale overlapping snapshot requests so later success remains authoritative", async () => {
    let resolveA!: (value: unknown) => void;
    let resolveB!: (value: unknown) => void;
    const a = new Promise((resolve) => {
      resolveA = resolve;
    });
    const b = new Promise((resolve) => {
      resolveB = resolve;
    });

    const request = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, result: snapshot() })
      .mockImplementationOnce(() => a)
      .mockImplementationOnce(() => b);

    const environment = env({
      transport: {
        ...env().transport,
        request,
      },
      idGenerator: {
        nextRequestId: vi
          .fn()
          .mockReturnValueOnce("rpc-1")
          .mockReturnValueOnce("rpc-2")
          .mockReturnValueOnce("rpc-3"),
      },
    });
    const client = createAgentClient(environment);

    await client.connect();

    const first = client.fetchSessionSnapshot();
    const second = client.fetchSessionSnapshot();

    resolveB({ ok: true, result: snapshot({ identity: { ...snapshot().identity, sessionId: "newer" } }) });
    await second;

    resolveA({ ok: true, result: snapshot({ identity: { ...snapshot().identity, sessionId: "stale" } }) });
    await first;

    expect(client.getSessionSnapshot()?.identity.sessionId).toBe("newer");
  });

  it("preserves streaming message order from the transport for the same message id", async () => {
    const environment = env();
    const client = createAgentClient(environment);
    const listener = vi.fn();
    client.subscribe(listener);

    environment.transport.emit({
      type: "agent-message",
      message: message({ id: "msg-stream-1", role: "assistant", content: "Partial", requestId: "req-stream", streamState: "streaming", createdAtMs: 1711000005000 }),
    });
    environment.transport.emit({
      type: "agent-message",
      message: message({ id: "msg-stream-1", role: "assistant", content: "Partial completed", requestId: "req-stream", streamState: "completed", createdAtMs: 1711000005000 }),
    });

    expect(listener.mock.calls[0][0]).toEqual(
      expect.objectContaining({ type: "agent-message", message: expect.objectContaining({ content: "Partial", streamState: "streaming" }) }),
    );
    expect(listener.mock.calls[1][0]).toEqual(
      expect.objectContaining({ type: "agent-message", message: expect.objectContaining({ content: "Partial completed", streamState: "completed" }) }),
    );
  });

  it("degrades health when protocol version is incompatible even if the endpoint is reachable", async () => {
    const environment = env({
      transport: {
        ...env().transport,
        request: vi.fn(async (payload: { method: string; requestId: string }) => {
          if (payload.method === "health.ping") {
            return {
              ok: true,
              result: health({ protocolCompatible: false, level: "degraded", reasons: ["protocol mismatch"] }),
            };
          }
          return {
            ok: true,
            result: snapshot({ identity: { ...snapshot().identity, protocolVersion: "999" } }),
          };
        }),
      },
    });
    const client = createAgentClient(environment);

    const result = await client.pingHealth();
    expect(result.level).toBe("degraded");
    expect(result.protocolCompatible).toBe(false);
  });

  it("supports unsubscribe so later transport events no longer reach that listener", async () => {
    const environment = env();
    const client = createAgentClient(environment);
    const listener = vi.fn();

    const unsubscribe = client.subscribe(listener);
    unsubscribe();

    environment.transport.emit({
      type: "agent-message",
      message: message({ id: "msg-1", role: "assistant", content: "after unsubscribe" }),
    });

    expect(listener).not.toHaveBeenCalled();
  });

  it("disposes the transport subscription and prevents later events from mutating local state", async () => {
    const environment = env();
    const client = createAgentClient(environment);

    await client.connect();
    await client.dispose();

    environment.transport.emit({
      type: "agent-snapshot",
      snapshot: snapshot({ identity: { ...snapshot().identity, sessionId: "late" } }),
    });

    expect(client.getSessionSnapshot()?.identity.sessionId).toBe("agent-session-1");
  });

  it("returns deterministic identical projections for identical connect payloads", async () => {
    const a = createAgentClient(env());
    const b = createAgentClient(env());

    const first = await a.connect();
    const second = await b.connect();

    expect(second.identity).toEqual(first.identity);
    expect(second.connectionState).toBe(first.connectionState);
  });
});
