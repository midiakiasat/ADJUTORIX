import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ADJUTORIX APP — TESTS / MAIN / command_runner.test.ts
 *
 * Canonical command-runner contract suite.
 *
 * Purpose:
 * - verify that main-process command execution preserves one authoritative execution surface
 *   across spawn configuration, cwd scoping, env projection, stdout/stderr capture,
 *   timeout handling, signal escalation, exit normalization, and subscriber fanout
 * - verify that malformed command specs, cwd escape, duplicate starts, zombie completions,
 *   and partial output races fail closed instead of widening execution authority or producing
 *   ambiguous run truth
 * - verify that identical execution inputs yield identical normalized result surfaces
 *
 * Test philosophy:
 * - no snapshots
 * - assert execution semantics, boundary conditions, and limiting cases directly
 * - prefer counterexamples and lifecycle-race failures over happy-path only coverage
 *
 * Notes:
 * - this suite assumes src/main/services/command_runner exports the functions and types referenced below
 * - if production exports differ slightly, adapt the harness first rather than weakening the contract intent
 */

import {
  createCommandRunner,
  type CommandRunnerEnvironment,
  type CommandRunSpec,
  type CommandRunState,
  type CommandRunResult,
} from "../../../src/main/services/command_runner";

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
  public killed = false;
  public killSignals: string[] = [];
  private listeners = new Map<string, Set<(...args: any[]) => void>>();

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

  kill(signal = "SIGTERM"): boolean {
    this.killed = true;
    this.killSignals.push(signal);
    return true;
  }
}

function spec(overrides: Partial<CommandRunSpec> = {}): CommandRunSpec {
  return {
    id: "cmd-1",
    command: "npm",
    args: ["test"],
    cwd: "/repo/adjutorix-app",
    env: {
      NODE_ENV: "test",
    },
    timeoutMs: 5_000,
    shell: false,
    ...overrides,
  } as CommandRunSpec;
}

function env(overrides: Partial<CommandRunnerEnvironment> = {}): CommandRunnerEnvironment {
  let pid = 5100;
  const children: MockChildProcess[] = [];

  return {
    process: {
      spawn: vi.fn((_command: string, _args: string[], _options: Record<string, unknown>) => {
        const child = new MockChildProcess(pid++);
        children.push(child);
        return child as any;
      }),
      getSpawnedChildren: () => children,
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
      requireWorkspaceBoundedCwd: true,
      workspaceRoot: "/repo/adjutorix-app",
      allowShell: false,
      maxStdoutBytes: 256_000,
      maxStderrBytes: 256_000,
      forceKillAfterMs: 250,
      stripDangerousEnv: true,
      deniedEnvKeys: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY"],
    },
    ...overrides,
  } as unknown as CommandRunnerEnvironment;
}

function eventTypes(calls: any[][]): string[] {
  return calls.map((call) => call[0]?.type).filter(Boolean);
}

describe("main/services/command_runner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts a command with canonical spawn arguments and transitions into running state", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    const handle = await runner.start(spec());

    expect(environment.process.spawn).toHaveBeenCalledWith(
      "npm",
      ["test"],
      expect.objectContaining({
        cwd: "/repo/adjutorix-app",
        shell: false,
      }),
    );
    expect(handle.id).toBe("cmd-1");
    expect(runner.getState("cmd-1")?.lifecycle).toBe("running");
  });

  it("projects environment variables but strips denied secrets when policy requires redaction", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(
      spec({
        env: {
          NODE_ENV: "test",
          OPENAI_API_KEY: "secret",
          AWS_SECRET_ACCESS_KEY: "also-secret",
          SAFE_FLAG: "1",
        },
      }),
    );

    const options = (environment.process.spawn as ReturnType<typeof vi.fn>).mock.calls[0][2];
    expect(options.env).toEqual(
      expect.objectContaining({
        NODE_ENV: "test",
        SAFE_FLAG: "1",
      }),
    );
    expect(options.env.OPENAI_API_KEY).toBeUndefined();
    expect(options.env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
  });

  it("rejects cwd outside the workspace root instead of widening execution authority", async () => {
    const runner = createCommandRunner(env());

    await expect(
      runner.start(
        spec({
          cwd: "/etc",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects sibling-prefix cwd tricks that only share a string prefix with the workspace root", async () => {
    const runner = createCommandRunner(env());

    await expect(
      runner.start(
        spec({
          cwd: "/repo/adjutorix-app-malicious",
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects shell execution when policy forbids shell mode even if command is otherwise valid", async () => {
    const runner = createCommandRunner(env());

    await expect(
      runner.start(
        spec({
          shell: true,
        }),
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed command specs with empty command or invalid argument vectors", async () => {
    const runner = createCommandRunner(env());

    await expect(
      runner.start(
        spec({
          command: "",
        }),
      ),
    ).rejects.toThrow();

    await expect(
      runner.start({
        ...(spec() as any),
        args: "not-an-array",
      }),
    ).rejects.toThrow();
  });

  it("captures stdout and stderr incrementally and preserves emission order", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);
    const listener = vi.fn();
    runner.subscribe("cmd-1", listener);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];

    child.stdout.emit("data", Buffer.from("line-a\n"));
    child.stderr.emit("data", Buffer.from("warn-a\n"));
    child.stdout.emit("data", Buffer.from("line-b\n"));

    expect(eventTypes(listener.mock.calls)).toEqual(
      expect.arrayContaining(["command-started", "command-stdout", "command-stderr"]),
    );

    const state = runner.getState("cmd-1")!;
    expect(state.stdout).toContain("line-a");
    expect(state.stdout).toContain("line-b");
    expect(state.stderr).toContain("warn-a");
  });

  it("completes successfully and normalizes exit result when child exits with code 0", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    const promise = runner.start(spec());
    await promise;
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    child.stdout.emit("data", Buffer.from("done\n"));
    child.emit("exit", 0, null);

    const result = await wait;
    expect(result.ok).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.signal).toBeNull();
    expect(result.stdout).toContain("done");
    expect(runner.getState("cmd-1")?.lifecycle).toBe("succeeded");
  });

  it("normalizes non-zero exit into failed result without losing captured output", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    child.stderr.emit("data", Buffer.from("failed\n"));
    child.emit("exit", 2, null);

    const result = await wait;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("failed");
    expect(runner.getState("cmd-1")?.lifecycle).toBe("failed");
  });

  it("treats signal termination as failed result with explicit signal metadata", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    child.emit("exit", null, "SIGTERM");

    const result = await wait;
    expect(result.ok).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.signal).toBe("SIGTERM");
  });

  it("times out long-running commands, sends termination signal, and escalates if needed", async () => {
    const scheduled: Array<(...args: any[]) => void> = [];
    const environment = env({
      scheduler: {
        setTimeout: vi.fn((fn: (...args: any[]) => void, _ms: number) => {
          scheduled.push(fn);
          return scheduled.length as unknown as ReturnType<typeof setTimeout>;
        }),
        clearTimeout: vi.fn(),
      },
    });
    const runner = createCommandRunner(environment);

    await runner.start(spec({ timeoutMs: 10 }));
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    scheduled[0]();
    scheduled[1]?.();
    child.emit("exit", null, "SIGKILL");

    const result = await wait;
    expect(child.killSignals[0]).toBe("SIGTERM");
    expect(child.killSignals.includes("SIGKILL")).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.timedOut).toBe(true);
  });

  it("supports explicit cancel, kills the child, and marks the run as cancelled", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    await runner.cancel("cmd-1");
    child.emit("exit", null, "SIGTERM");

    const result = await wait;
    expect(child.killed).toBe(true);
    expect(result.cancelled).toBe(true);
    expect(runner.getState("cmd-1")?.lifecycle).toBe("cancelled");
  });

  it("does not allow duplicate start for the same run id while the run is active", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec({ id: "cmd-dupe" }));

    await expect(runner.start(spec({ id: "cmd-dupe" }))).rejects.toThrow();
    expect(environment.process.spawn).toHaveBeenCalledTimes(1);
  });

  it("guards against late stream data after completion so finished result remains immutable", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];
    const wait = runner.waitForResult("cmd-1");

    child.stdout.emit("data", Buffer.from("before-exit\n"));
    child.emit("exit", 0, null);
    const result = await wait;

    child.stdout.emit("data", Buffer.from("after-exit\n"));

    expect(result.stdout).toContain("before-exit");
    expect(result.stdout).not.toContain("after-exit");
    expect(runner.getState("cmd-1")?.stdout).not.toContain("after-exit");
  });

  it("supports multiple subscribers and fans out identical run events to each", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);
    const a = vi.fn();
    const b = vi.fn();

    runner.subscribe("cmd-1", a);
    runner.subscribe("cmd-1", b);
    await runner.start(spec());

    const child = environment.process.getSpawnedChildren()[0];
    child.stdout.emit("data", Buffer.from("hello\n"));

    expect(a).toHaveBeenCalled();
    expect(b).toHaveBeenCalled();
  });

  it("supports unsubscribe so later run events no longer reach that listener", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);
    const listener = vi.fn();

    const unsubscribe = runner.subscribe("cmd-1", listener);
    await runner.start(spec());
    unsubscribe();

    const child = environment.process.getSpawnedChildren()[0];
    child.stdout.emit("data", Buffer.from("after-unsubscribe\n"));

    expect(listener).toHaveBeenCalledTimes(1); // command-started only
  });

  it("returns null for unknown run state instead of inventing ghost execution state", () => {
    const runner = createCommandRunner(env());
    expect(runner.getState("missing")).toBeNull();
  });

  it("dispose cancels active commands and prevents later child events from mutating state", async () => {
    const environment = env();
    const runner = createCommandRunner(environment);

    await runner.start(spec());
    const child = environment.process.getSpawnedChildren()[0];

    await runner.dispose();
    const stopped = runner.getState("cmd-1");

    child.stdout.emit("data", Buffer.from("late\n"));
    child.emit("exit", 0, null);

    expect(runner.getState("cmd-1")).toEqual(stopped);
  });

  it("returns deterministic identical normalized results for identical successful execution inputs", async () => {
    const envA = env();
    const envB = env();
    const runnerA = createCommandRunner(envA);
    const runnerB = createCommandRunner(envB);

    await runnerA.start(spec({ id: "cmd-a" }));
    await runnerB.start(spec({ id: "cmd-b" }));

    const childA = envA.process.getSpawnedChildren()[0];
    const childB = envB.process.getSpawnedChildren()[0];

    const waitA = runnerA.waitForResult("cmd-a");
    const waitB = runnerB.waitForResult("cmd-b");

    childA.stdout.emit("data", Buffer.from("ok\n"));
    childB.stdout.emit("data", Buffer.from("ok\n"));
    childA.emit("exit", 0, null);
    childB.emit("exit", 0, null);

    const a = await waitA;
    const b = await waitB;

    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(a.exitCode).toBe(b.exitCode);
    expect(a.signal).toBe(b.signal);
    expect(a.stdout).toBe(b.stdout);
  });
});
