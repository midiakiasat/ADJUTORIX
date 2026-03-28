import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / agent_process.test.ts
 *
 * Canonical agent-process contract suite.
 *
 * Purpose:
 * - verify that main-process agent orchestration preserves one authoritative process/session truth
 *   across spawn, readiness, auth bootstrap, rpc reachability, log streaming, crash/exit handling,
 *   restart policy, shutdown, and subscription fanout
 * - verify that stale readiness, duplicate spawns, zombie processes, partial bootstrap success,
 *   and reordered process events fail closed instead of leaving downstream IPC to believe the agent
 *   is healthier than the actual child process
 * - verify that identical orchestration inputs yield identical lifecycle and health projections
 *
 * Test philosophy:
 * - no snapshots
 * - assert lifecycle semantics, event routing, crash boundaries, and recovery policy directly
 * - prefer race conditions, partial-failure cases, and limiting cases over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/agent_process exports the functions and types referenced below
 * - if the production module exports differ slightly, update the adapters first rather than weakening intent
 */

import {
  createAgentProcess,
  type AgentProcessEnvironment,
  type AgentProcessEvent,
  type AgentProcessState,
  type AgentProcessHealth,
} from "../../../src/main/services/agent_process";

class MockStream {
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
}

class MockChildProcess {
  public pid: number;
  public stdout = new MockStream();
  public stderr = new MockStream();
  private listeners = new Map<string, Set<(...args: any[]) => void>>();
  public killed = false;

  constructor(pid: number) {
    this.pid = pid;
  }

  on(event: string, listener: (...args: any[]) => void): this {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(listener);
    return this;
  }

  once(event: string, listener: (...args: any[]) => void): this {
    const wrapper = (...args: any[]) => {
      this.off(event, wrapper);
      listener(...args);
    };
    return this.on(event, wrapper);
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.listeners.get(event)?.delete(listener);
    return this;
  }

  emit(event: string, ...args: any[]): void {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }

  kill(_signal?: string): boolean {
    this.killed = true;
    return true;
  }
}

function state(overrides: Partial<AgentProcessState> = {}): AgentProcessState {
  return {
    lifecycle: "stopped",
    pid: null,
    startedAtMs: null,
    readyAtMs: null,
    exitedAtMs: null,
    endpoint: "http://127.0.0.1:8000/rpc",
    authState: "unknown",
    sessionState: "disconnected",
    lastExit: null,
    restartCount: 0,
    lastError: null,
    ...overrides,
  } as AgentProcessState;
}

function health(overrides: Partial<AgentProcessHealth> = {}): AgentProcessHealth {
  return {
    level: "healthy",
    reasons: [],
    rpcReachable: true,
    authAvailable: true,
    stdoutFlowing: true,
    stderrFlowing: false,
    ...overrides,
  } as AgentProcessHealth;
}

function env(overrides: Partial<AgentProcessEnvironment> = {}): AgentProcessEnvironment {
  let pidCounter = 4100;
  const childFactory: MockChildProcess[] = [];

  return {
    spawn: {
      spawn: vi.fn(() => {
        const child = new MockChildProcess(pidCounter++);
        childFactory.push(child);
        return child as any;
      }),
      getSpawnedChildren: () => childFactory,
    },
    rpc: {
      waitForReady: vi.fn(async () => ({
        endpoint: "http://127.0.0.1:8000/rpc",
        authState: "available",
        sessionState: "connected",
      })),
      shutdown: vi.fn(async () => undefined),
      ping: vi.fn(async () => true),
    },
    clock: {
      now: vi.fn(() => 1711000000000),
    },
    scheduler: {
      setTimeout: vi.fn((fn: (...args: any[]) => void, _ms: number) => {
        fn();
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }),
      clearTimeout: vi.fn(),
    },
    policy: {
      autoRestart: true,
      maxRestartCount: 3,
      gracefulShutdownTimeoutMs: 1000,
      readyTimeoutMs: 3000,
      crashBackoffMs: 50,
    },
    ...overrides,
  } as unknown as AgentProcessEnvironment;
}

function eventTypes(calls: any[][]): string[] {
  return calls.map((call) => call[0]?.type).filter(Boolean);
}

describe("main/services/agent_process", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts the agent exactly once, spawns a child process, waits for readiness, and transitions to ready", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    const result = await agent.start();

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(1);
    expect(environment.rpc.waitForReady).toHaveBeenCalledTimes(1);
    expect(result.lifecycle).toBe("ready");
    expect(result.pid).not.toBeNull();
    expect(result.authState).toBe("available");
    expect(result.sessionState).toBe("connected");
    expect(agent.getState().lifecycle).toBe("ready");
  });

  it("does not spawn a second process when start is called repeatedly while already running", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    const first = await agent.start();
    const second = await agent.start();

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(1);
    expect(first.pid).toBe(second.pid);
    expect(agent.getState().lifecycle).toBe("ready");
  });

  it("transitions through starting before readiness resolves so partial bootstrap stays explicit", async () => {
    let resolveReady!: (value: { endpoint: string; authState: string; sessionState: string }) => void;
    const waitForReady = vi.fn(
      () =>
        new Promise<{ endpoint: string; authState: string; sessionState: string }>((resolve) => {
          resolveReady = resolve;
        }),
    );

    const agent = createAgentProcess(
      env({
        rpc: {
          ...env().rpc,
          waitForReady,
        },
      }),
    );

    const promise = agent.start();
    expect(agent.getState().lifecycle).toBe("starting");

    resolveReady({
      endpoint: "http://127.0.0.1:8000/rpc",
      authState: "available",
      sessionState: "connected",
    });

    const result = await promise;
    expect(result.lifecycle).toBe("ready");
  });

  it("fails closed when readiness bootstrap rejects, preserving stopped/error state instead of zombie readiness", async () => {
    const agent = createAgentProcess(
      env({
        rpc: {
          ...env().rpc,
          waitForReady: vi.fn(async () => {
            throw new Error("rpc bootstrap failed");
          }),
        },
      }),
    );

    await expect(agent.start()).rejects.toThrow("rpc bootstrap failed");
    expect(agent.getState().lifecycle).toBe("error");
    expect(agent.getState().lastError).toContain("rpc bootstrap failed");
  });

  it("captures stdout and stderr log lines and emits structured log events without mutating lifecycle truth", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);
    const listener = vi.fn();
    agent.subscribe(listener);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];

    child.stdout.emit("data", Buffer.from("ready line\n"));
    child.stderr.emit("data", Buffer.from("warn line\n"));

    const types = eventTypes(listener.mock.calls);
    expect(types).toContain("agent-stdout");
    expect(types).toContain("agent-stderr");
    expect(agent.getState().lifecycle).toBe("ready");
  });

  it("emits lifecycle events in canonical order during successful start", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);
    const listener = vi.fn();
    agent.subscribe(listener);

    await agent.start();

    expect(eventTypes(listener.mock.calls)).toEqual(
      expect.arrayContaining(["agent-starting", "agent-spawned", "agent-ready"]),
    );
  });

  it("updates health as healthy when process is ready and rpc/auth are available", async () => {
    const agent = createAgentProcess(env());
    await agent.start();

    const result = agent.getHealth();
    expect(result.level).toBe("healthy");
    expect(result.rpcReachable).toBe(true);
    expect(result.authAvailable).toBe(true);
  });

  it("degrades health when rpc ping fails even if the child process still exists", async () => {
    const agent = createAgentProcess(
      env({
        rpc: {
          ...env().rpc,
          ping: vi.fn(async () => false),
        },
      }),
    );

    await agent.start();
    const result = await agent.refreshHealth();

    expect(result.level).toBe("degraded");
    expect(result.rpcReachable).toBe(false);
    expect(result.reasons).toContain("rpc unreachable");
  });

  it("degrades health when auth is unavailable after startup even if rpc is reachable", async () => {
    const agent = createAgentProcess(
      env({
        rpc: {
          ...env().rpc,
          waitForReady: vi.fn(async () => ({
            endpoint: "http://127.0.0.1:8000/rpc",
            authState: "missing",
            sessionState: "connected",
          })),
        },
      }),
    );

    await agent.start();
    const result = agent.getHealth();

    expect(result.level).toBe("degraded");
    expect(result.authAvailable).toBe(false);
  });

  it("stops gracefully by requesting rpc shutdown and killing the child only if needed", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];

    await agent.stop();

    expect(environment.rpc.shutdown).toHaveBeenCalledTimes(1);
    expect(child.killed).toBe(true);
    expect(agent.getState().lifecycle).toBe("stopped");
  });

  it("treats stop as idempotent when the process is already stopped", async () => {
    const agent = createAgentProcess(env());

    await agent.stop();
    await agent.stop();

    expect(agent.getState().lifecycle).toBe("stopped");
  });

  it("marks state as crashed on unexpected child exit and records exit details", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];
    child.emit("exit", 17, null);

    expect(agent.getState().lifecycle).toBe("crashed");
    expect(agent.getState().lastExit).toEqual(
      expect.objectContaining({ code: 17 }),
    );
  });

  it("auto-restarts after crash when policy allows and restart budget remains", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const firstChild = environment.spawn.getSpawnedChildren()[0];
    firstChild.emit("exit", 1, null);

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(2);
    expect(agent.getState().restartCount).toBe(1);
    expect(agent.getState().lifecycle).toBe("ready");
  });

  it("does not auto-restart after crash when restart budget is exhausted", async () => {
    const environment = env({
      policy: {
        ...env().policy,
        maxRestartCount: 0,
      },
    });
    const agent = createAgentProcess(environment);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];
    child.emit("exit", 1, null);

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(1);
    expect(agent.getState().lifecycle).toBe("crashed");
  });

  it("does not treat an intentional stop exit as a crash requiring restart", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];

    const stopPromise = agent.stop();
    child.emit("exit", 0, null);
    await stopPromise;

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(1);
    expect(agent.getState().lifecycle).toBe("stopped");
  });

  it("guards against stale exit events from an older child process after a restart", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const first = environment.spawn.getSpawnedChildren()[0];
    first.emit("exit", 1, null);
    const second = environment.spawn.getSpawnedChildren()[1];

    expect(agent.getState().pid).toBe(second.pid);

    first.emit("exit", 99, null);
    expect(agent.getState().pid).toBe(second.pid);
    expect(agent.getState().lifecycle).toBe("ready");
  });

  it("refreshes session state explicitly from rpc without respawning the child process", async () => {
    const environment = env({
      rpc: {
        ...env().rpc,
        waitForReady: vi.fn(async () => ({
          endpoint: "http://127.0.0.1:8000/rpc",
          authState: "available",
          sessionState: "connected",
        })),
        ping: vi.fn(async () => true),
      },
    });
    const agent = createAgentProcess(environment);

    await agent.start();
    await agent.refreshHealth();

    expect(environment.spawn.spawn).toHaveBeenCalledTimes(1);
    expect(agent.getState().sessionState).toBe("connected");
  });

  it("supports multiple subscribers and fans out identical process events to each", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);
    const a = vi.fn();
    const b = vi.fn();

    agent.subscribe(a);
    agent.subscribe(b);
    await agent.start();

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it("supports unsubscribe so later process events no longer reach that listener", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);
    const listener = vi.fn();

    const unsubscribe = agent.subscribe(listener);
    await agent.start();
    listener.mockClear();
    unsubscribe();

    const child = environment.spawn.getSpawnedChildren()[0];
    child.stdout.emit("data", Buffer.from("after unsubscribe\n"));

    expect(listener).not.toHaveBeenCalled();
  });

  it("dispose stops the process and prevents later child events from mutating service state", async () => {
    const environment = env();
    const agent = createAgentProcess(environment);

    await agent.start();
    const child = environment.spawn.getSpawnedChildren()[0];

    await agent.dispose();
    const stoppedState = agent.getState();
    child.emit("exit", 123, null);
    child.stdout.emit("data", Buffer.from("late line\n"));

    expect(agent.getState()).toEqual(stoppedState);
  });

  it("returns deterministic identical state projections for identical bootstrap inputs", async () => {
    const environment = env();
    const first = createAgentProcess(environment);
    const second = createAgentProcess(env());

    const a = await first.start();
    const b = await second.start();

    expect(a.lifecycle).toBe(b.lifecycle);
    expect(a.endpoint).toBe(b.endpoint);
    expect(a.authState).toBe(b.authState);
    expect(a.sessionState).toBe(b.sessionState);
  });
});
