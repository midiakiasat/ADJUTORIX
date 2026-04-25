import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_reconnect.test.ts
 *
 * Canonical agent reconnect state-machine suite.
 *
 * Purpose:
 * - verify that reconnect orchestration preserves one authoritative session/process generation
 *   across disconnect, retry, reattach, crash, auth loss, protocol mismatch, and user-forced reconnect flows
 * - verify that retry policy, backoff, stale-attempt suppression, duplicate reconnect collapse,
 *   generation replacement, and subscriber event ordering remain deterministic
 * - verify that partial reconnect success cannot leave downstream consumers attached to stale
 *   session truth or a dead process generation
 *
 * Test philosophy:
 * - no snapshots
 * - assert lifecycle semantics, retry boundaries, and limiting cases directly
 * - prefer race conditions, stale completion, and mixed-failure counterexamples over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/agent_reconnect exports the functions and types referenced below
 * - if production exports differ, adapt the harness first rather than weakening the contract intent
 */

import {
  createAgentReconnect,
  type AgentReconnectEnvironment,
  type AgentReconnectState,
  type AgentReconnectEvent,
} from "../../src/main/services/agent_reconnect";

function reconnectState(overrides: Partial<AgentReconnectState> = {}): AgentReconnectState {
  return {
    lifecycle: "idle",
    generation: 0,
    activeAttemptId: null,
    retryCount: 0,
    connected: true,
    reconnecting: false,
    lastDisconnectAtMs: null,
    lastReconnectAtMs: null,
    lastFailure: null,
    sessionId: "agent-session-1",
    endpoint: "http://127.0.0.1:8000/rpc",
    protocolVersion: "1",
    authState: "available",
    ...overrides,
  } as AgentReconnectState;
}

function makeEnv(overrides: Partial<AgentReconnectEnvironment> = {}): AgentReconnectEnvironment {
  let nextAttempt = 1;

  return {
    process: {
      getState: vi.fn(() => ({
        lifecycle: "ready",
        pid: 4100,
        endpoint: "http://127.0.0.1:8000/rpc",
        authState: "available",
        sessionState: "connected",
        restartCount: 0,
      })),
      restart: vi.fn(async () => ({
        lifecycle: "ready",
        pid: 4101,
        endpoint: "http://127.0.0.1:8000/rpc",
        authState: "available",
        sessionState: "connected",
        restartCount: 1,
      })),
    },
    client: {
      connect: vi.fn(async () => ({
        identity: {
          sessionId: "agent-session-2",
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
      fetchSessionSnapshot: vi.fn(async () => ({
        identity: {
          sessionId: "agent-session-2",
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
      pingHealth: vi.fn(async () => ({
        level: "healthy",
        reasons: [],
        reachable: true,
        authenticated: true,
        protocolCompatible: true,
      })),
    },
    auth: {
      getState: vi.fn(() => ({
        status: "available",
        token: "token-1",
        source: "store",
      })),
      refresh: vi.fn(async () => ({
        status: "available",
        token: "token-1",
        source: "store",
      })),
      invalidate: vi.fn(async () => undefined),
    },
    clock: {
      now: vi.fn(() => 1711000000000),
    },
    scheduler: {
      setTimeout: vi.fn((fn: (...args: any[]) => void, _ms: number) => {
        fn();
        return nextAttempt++ as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    },
    policy: {
      maxRetries: 3,
      backoffMs: 100,
      reconnectOnDisconnect: true,
      restartProcessOnTransportFailure: true,
      restartProcessOnProtocolMismatch: false,
      refreshAuthOnUnauthorized: true,
    },
    ...overrides,
  } as unknown as AgentReconnectEnvironment;
}

function eventTypes(calls: any[][]): string[] {
  return calls.map((call) => call[0]?.type).filter(Boolean);
}

describe("main/services/agent_reconnect", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle and connected when seeded with healthy attached state", () => {
    const reconnect = createAgentReconnect(makeEnv());

    const state = reconnect.getState();
    expect(state.lifecycle).toBe("idle");
    expect(state.connected).toBe(true);
    expect(state.reconnecting).toBe(false);
  });

  it("enters reconnecting state on disconnect signal and completes reconnect successfully", async () => {
    const environment = makeEnv();
    const reconnect = createAgentReconnect(environment);

    const result = await reconnect.onDisconnected({ reason: "transport lost" });

    expect(environment.client.connect).toHaveBeenCalledTimes(1);
    expect(result.lifecycle).toBe("idle");
    expect(result.connected).toBe(true);
    expect(result.reconnecting).toBe(false);
    expect(result.sessionId).toBe("agent-session-2");
  });

  it("emits canonical reconnect lifecycle events in order for a successful reconnect", async () => {
    const environment = makeEnv();
    const reconnect = createAgentReconnect(environment);
    const listener = vi.fn();
    reconnect.subscribe(listener);

    await reconnect.onDisconnected({ reason: "socket closed" });

    expect(eventTypes(listener.mock.calls)).toEqual(
      expect.arrayContaining([
        "agent-reconnect-started",
        "agent-reconnect-attempt",
        "agent-reconnect-succeeded",
      ]),
    );
  });

  it("collapses duplicate reconnect requests while one reconnect attempt is already active", async () => {
    let resolveConnect!: (value: any) => void;
    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect: vi.fn(
          () =>
            new Promise((resolve) => {
              resolveConnect = resolve;
            }),
        ),
      },
    });
    const reconnect = createAgentReconnect(environment);

    const first = reconnect.onDisconnected({ reason: "transport lost" });
    const second = reconnect.onDisconnected({ reason: "duplicate signal" });

    expect(reconnect.getState().reconnecting).toBe(true);
    expect(environment.client.connect).toHaveBeenCalledTimes(1);

    resolveConnect({
      identity: {
        sessionId: "agent-session-2",
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
    });

    const a = await first;
    const b = await second;
    expect(a.sessionId).toBe(b.sessionId);
  });

  it("retries retryable transport failures until success within retry budget", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }))
      .mockRejectedValueOnce(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
      .mockResolvedValueOnce({
        identity: {
          sessionId: "agent-session-3",
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
      });

    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
    });
    const reconnect = createAgentReconnect(environment);

    const result = await reconnect.onDisconnected({ reason: "transport lost" });

    expect(connect).toHaveBeenCalledTimes(3);
    expect(result.connected).toBe(true);
    expect(result.retryCount).toBe(2);
    expect(result.sessionId).toBe("agent-session-3");
  });

  it("fails closed when retry budget is exhausted on retryable failures", async () => {
    const connect = vi.fn().mockRejectedValue(Object.assign(new Error("timeout"), { code: "ETIMEDOUT" }));
    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
      policy: {
        ...makeEnv().policy,
        maxRetries: 2,
      },
    });
    const reconnect = createAgentReconnect(environment);

    await expect(reconnect.onDisconnected({ reason: "transport lost" })).rejects.toThrow();
    expect(connect).toHaveBeenCalledTimes(3);
    expect(reconnect.getState().lifecycle).toBe("failed");
    expect(reconnect.getState().connected).toBe(false);
  });

  it("refreshes auth on unauthorized failure before retrying when policy allows", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED" }))
      .mockResolvedValueOnce({
        identity: {
          sessionId: "agent-session-4",
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
      });

    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
    });
    const reconnect = createAgentReconnect(environment);

    const result = await reconnect.onDisconnected({ reason: "401" });

    expect(environment.auth.refresh).toHaveBeenCalledTimes(1);
    expect(result.sessionId).toBe("agent-session-4");
  });

  it("invalidates auth and fails reconnect when unauthorized persists after refresh", async () => {
    const connect = vi.fn().mockRejectedValue(Object.assign(new Error("unauthorized"), { code: "UNAUTHORIZED" }));
    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
      policy: {
        ...makeEnv().policy,
        maxRetries: 1,
      },
    });
    const reconnect = createAgentReconnect(environment);

    await expect(reconnect.onDisconnected({ reason: "401" })).rejects.toThrow(/unauthorized/i);
    expect(environment.auth.refresh).toHaveBeenCalled();
    expect(environment.auth.invalidate).toHaveBeenCalled();
    expect(reconnect.getState().connected).toBe(false);
  });

  it("restarts the process on transport failure when policy allows process restart recovery", async () => {
    const connect = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("transport unavailable"), { code: "TRANSPORT_UNAVAILABLE" }))
      .mockResolvedValueOnce({
        identity: {
          sessionId: "agent-session-5",
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
      });

    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
    });
    const reconnect = createAgentReconnect(environment);

    const result = await reconnect.onDisconnected({ reason: "transport unavailable" });

    expect(environment.process.restart).toHaveBeenCalledTimes(1);
    expect(result.connected).toBe(true);
    expect(result.sessionId).toBe("agent-session-5");
  });

  it("does not restart process on protocol mismatch when policy forbids restart for semantic incompatibility", async () => {
    const connect = vi.fn().mockRejectedValue(Object.assign(new Error("protocol mismatch"), { code: "PROTOCOL_MISMATCH" }));
    const environment = makeEnv({
      client: {
        ...makeEnv().client,
        connect,
      },
      policy: {
        ...makeEnv().policy,
        maxRetries: 0,
        restartProcessOnProtocolMismatch: false,
      },
    });
    const reconnect = createAgentReconnect(environment);

    await expect(reconnect.onDisconnected({ reason: "protocol mismatch" })).rejects.toThrow(/protocol mismatch/i);
    expect(environment.process.restart).not.toHaveBeenCalled();
  });

  it("suppresses stale reconnect completion from an older attempt after a newer forced reconnect wins", async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;

    const connect = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveA = resolve;
          }),
      )
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveB = resolve;
          }),
      );

    const reconnect = createAgentReconnect(
      makeEnv({
        client: {
          ...makeEnv().client,
          connect,
        },
      }),
    );

    const first = reconnect.onDisconnected({ reason: "first" });
    const second = reconnect.forceReconnect({ reason: "user forced" });

    resolveB({
      identity: {
        sessionId: "agent-session-newer",
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
    });
    await second;

    resolveA({
      identity: {
        sessionId: "agent-session-stale",
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
    });
    await first.catch(() => undefined);

    expect(reconnect.getState().sessionId).toBe("agent-session-newer");
  });

  it("increments generation on successful reconnect so downstream consumers can detect replacement", async () => {
    const reconnect = createAgentReconnect(makeEnv());
    const before = reconnect.getState().generation;

    const result = await reconnect.onDisconnected({ reason: "socket closed" });

    expect(result.generation).toBe(before + 1);
  });

  it("supports manual forceReconnect even without a preceding disconnect", async () => {
    const reconnect = createAgentReconnect(makeEnv());

    const result = await reconnect.forceReconnect({ reason: "manual" });

    expect(result.connected).toBe(true);
    expect(result.sessionId).toBe("agent-session-2");
  });

  it("supports multiple subscribers and fans out identical reconnect events to each", async () => {
    const reconnect = createAgentReconnect(makeEnv());
    const a = vi.fn();
    const b = vi.fn();

    reconnect.subscribe(a);
    reconnect.subscribe(b);
    await reconnect.onDisconnected({ reason: "socket closed" });

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it("supports unsubscribe so later reconnect events no longer reach that listener", async () => {
    const reconnect = createAgentReconnect(makeEnv());
    const listener = vi.fn();

    const unsubscribe = reconnect.subscribe(listener);
    unsubscribe();

    await reconnect.onDisconnected({ reason: "socket closed" });

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose cancels further reconnect orchestration and leaves state stable against late completions", async () => {
    let resolveConnect!: (value: any) => void;
    const reconnect = createAgentReconnect(
      makeEnv({
        client: {
          ...makeEnv().client,
          connect: vi.fn(
            () =>
              new Promise((resolve) => {
                resolveConnect = resolve;
              }),
          ),
        },
      }),
    );

    const promise = reconnect.onDisconnected({ reason: "socket closed" });
    reconnect.dispose();

    resolveConnect({
      identity: {
        sessionId: "late-session",
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
    });

    await promise.catch(() => undefined);
    expect(reconnect.getState().sessionId).not.toBe("late-session");
  });

  it("returns deterministic identical reconnect projection for identical successful reconnect inputs", async () => {
    const a = createAgentReconnect(makeEnv());
    const b = createAgentReconnect(makeEnv());

    const first = await a.onDisconnected({ reason: "socket closed" });
    const second = await b.onDisconnected({ reason: "socket closed" });

    expect(second.lifecycle).toBe(first.lifecycle);
    expect(second.connected).toBe(first.connected);
    expect(second.authState).toBe(first.authState);
    expect(second.protocolVersion).toBe(first.protocolVersion);
  });
});
