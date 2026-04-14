// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio,
} from "node:child_process";
import { EventEmitter } from "node:events";

/**
 * ADJUTORIX APP — MAIN / AGENT / agent_process.ts
 *
 * Managed Adjutorix agent process supervisor for the Electron main process.
 *
 * Purpose:
 * - own the full child-process lifecycle for the local agent
 * - separate process supervision from IPC request handling
 * - provide deterministic spawn/restart/stop/readiness semantics
 * - normalize stdout/stderr capture and structured process telemetry
 * - enforce explicit restart policy instead of implicit background behavior
 * - produce auditable snapshots suitable for diagnostics and tests
 *
 * Responsibilities:
 * - resolve the agent launch command deterministically
 * - spawn the process with controlled environment and cwd
 * - tail stdout/stderr with bounded in-memory buffers and optional log sinks
 * - perform readiness probing against the configured agent URL
 * - supervise unexpected exits and optional restart policy
 * - expose snapshots, health state, and lifecycle events to the runtime
 * - tear down process, timers, streams, and state completely on stop/dispose
 *
 * Hard invariants:
 * - at most one managed agent child process exists per supervisor instance
 * - identical observable state yields identical supervisor snapshot hashes
 * - restart attempts are explicit, bounded, and auditable
 * - readiness is not assumed from spawn success; it is probed
 * - stop() and dispose() clear timers, listeners, and child references
 * - stdout/stderr buffering is bounded to prevent silent memory growth
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type AgentProcessHealth = "idle" | "starting" | "ready" | "degraded" | "stopped" | "error";
export type AgentProcessExitKind = "clean" | "signal" | "crash" | "unknown";
export type AgentProcessAction =
  | "start"
  | "ready"
  | "stop"
  | "restart"
  | "probe"
  | "stdout"
  | "stderr"
  | "exit"
  | "dispose";

export type AgentCommand = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

export type AgentReadinessProbeResult = {
  ok: boolean;
  status: number | null;
  bodyHash: string | null;
  checkedAtMs: number;
  durationMs: number;
  error: string | null;
};

export type AgentProcessBuffers = {
  stdout: string[];
  stderr: string[];
};

export type AgentProcessState = {
  health: AgentProcessHealth;
  pid: number | null;
  startedAtMs: number | null;
  readyAtMs: number | null;
  stoppedAtMs: number | null;
  lastExitCode: number | null;
  lastExitSignal: NodeJS.Signals | null;
  lastExitKind: AgentProcessExitKind | null;
  restartCount: number;
  consecutiveProbeFailures: number;
  lastProbe: AgentReadinessProbeResult | null;
  commandHash: string | null;
  childPresent: boolean;
  disposed: boolean;
};

export type AgentProcessSnapshot = {
  schema: 1;
  agentUrl: string;
  tokenFile: string;
  command: AgentCommand | null;
  state: AgentProcessState;
  stdoutTail: string[];
  stderrTail: string[];
  hash: string;
};

export type AgentProcessPolicy = {
  autoRestart: boolean;
  maxRestartAttempts: number;
  restartBackoffMs: number;
  readyTimeoutMs: number;
  probeIntervalMs: number;
  probeTimeoutMs: number;
  maxStdoutLines: number;
  maxStderrLines: number;
  maxLineLength: number;
  persistLogsToFiles: boolean;
  gracefulStopSignal: NodeJS.Signals;
  gracefulStopTimeoutMs: number;
  useShell: boolean;
};

export type AgentProcessPaths = {
  logRoot: string;
  stdoutLogFile: string;
  stderrLogFile: string;
};

export type AgentProcessAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: AgentProcessAction;
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AgentProcessAuditFn = (record: AgentProcessAuditRecord) => void;

export type AgentProcessHooks = {
  onReady?: (snapshot: AgentProcessSnapshot) => Promise<void> | void;
  onExit?: (snapshot: AgentProcessSnapshot) => Promise<void> | void;
  onRestart?: (snapshot: AgentProcessSnapshot) => Promise<void> | void;
  onProbe?: (probe: AgentReadinessProbeResult, snapshot: AgentProcessSnapshot) => Promise<void> | void;
};

export type AgentProcessOptions = {
  agentUrl: string;
  tokenFile: string;
  command: {
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
  };
  policy?: Partial<AgentProcessPolicy>;
  paths?: Partial<AgentProcessPaths>;
  audit?: AgentProcessAuditFn;
  hooks?: AgentProcessHooks;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: AgentProcessPolicy = {
  autoRestart: true,
  maxRestartAttempts: 3,
  restartBackoffMs: 750,
  readyTimeoutMs: 10_000,
  probeIntervalMs: 2_500,
  probeTimeoutMs: 5_000,
  maxStdoutLines: 500,
  maxStderrLines: 500,
  maxLineLength: 4_000,
  persistLogsToFiles: true,
  gracefulStopSignal: "SIGTERM",
  gracefulStopTimeoutMs: 5_000,
  useShell: false,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:agent:agent_process:${message}`);
  }
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function commandHash(command: AgentCommand): string {
  return sha256(stableJson(command));
}

function snapshotHash(core: Omit<AgentProcessSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<AgentProcessAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function truncateLine(line: string, maxLineLength: number): string {
  if (line.length <= maxLineLength) return line;
  return `${line.slice(0, maxLineLength)}…`;
}

function pushBounded(target: string[], lines: string[], maxLines: number): void {
  for (const line of lines) target.push(line);
  while (target.length > maxLines) target.shift();
}

function normalizeEnv(env: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env ?? {})) {
    out[key] = String(value);
  }
  return out;
}

function normalizeCommand(options: AgentProcessOptions): AgentCommand {
  assert(options.command.command.trim().length > 0, "command_missing");
  const cwd = path.resolve(options.command.cwd ?? process.cwd());
  return {
    command: options.command.command,
    args: [...(options.command.args ?? [])],
    cwd,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([k, v]) => [k, v]),
      ),
      ...normalizeEnv(options.command.env),
    },
  };
}

function readToken(tokenFile: string): string {
  try {
    return fs.readFileSync(tokenFile, "utf8").trim();
  } catch {
    return "";
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeCall<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// SUPERVISOR
// -----------------------------------------------------------------------------

export class AgentProcessSupervisor extends EventEmitter {
  private readonly agentUrl: string;
  private readonly tokenFile: string;
  private readonly policy: AgentProcessPolicy;
  private readonly paths: AgentProcessPaths;
  private readonly audit?: AgentProcessAuditFn;
  private readonly hooks?: AgentProcessHooks;
  private readonly now?: () => number;
  private readonly commandSpec: AgentCommand;

  private child: ChildProcessWithoutNullStreams | null = null;
  private probeTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private stopping = false;
  private stdoutTail: string[] = [];
  private stderrTail: string[] = [];
  private state: AgentProcessState = {
    health: "idle",
    pid: null,
    startedAtMs: null,
    readyAtMs: null,
    stoppedAtMs: null,
    lastExitCode: null,
    lastExitSignal: null,
    lastExitKind: null,
    restartCount: 0,
    consecutiveProbeFailures: 0,
    lastProbe: null,
    commandHash: null,
    childPresent: false,
    disposed: false,
  };

  constructor(options: AgentProcessOptions) {
    super();
    this.agentUrl = options.agentUrl;
    this.tokenFile = path.resolve(options.tokenFile);
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.paths = {
      logRoot: path.resolve(options.paths?.logRoot ?? path.join(os.tmpdir(), "adjutorix-agent-logs")),
      stdoutLogFile: path.resolve(options.paths?.stdoutLogFile ?? path.join(options.paths?.logRoot ?? path.join(os.tmpdir(), "adjutorix-agent-logs"), "agent.stdout.log")),
      stderrLogFile: path.resolve(options.paths?.stderrLogFile ?? path.join(options.paths?.logRoot ?? path.join(os.tmpdir(), "adjutorix-agent-logs"), "agent.stderr.log")),
    };
    this.audit = options.audit;
    this.hooks = options.hooks;
    this.now = options.now;
    this.commandSpec = normalizeCommand(options);
    this.state.commandHash = commandHash(this.commandSpec);

    if (this.policy.persistLogsToFiles) {
      ensureDir(this.paths.logRoot);
    }
  }

  snapshot(): AgentProcessSnapshot {
    const core: Omit<AgentProcessSnapshot, "hash"> = {
      schema: 1,
      agentUrl: this.agentUrl,
      tokenFile: this.tokenFile,
      command: this.commandSpec,
      state: JSON.parse(stableJson(this.state)) as AgentProcessState,
      stdoutTail: [...this.stdoutTail],
      stderrTail: [...this.stderrTail],
    };

    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async start(): Promise<AgentProcessSnapshot> {
    this.assertNotDisposed();
    if (this.child) return this.snapshot();

    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: this.commandSpec.cwd,
      env: this.commandSpec.env,
      shell: this.policy.useShell,
      detached: false,
    };

    this.state.health = "starting";
    this.state.startedAtMs = nowMs(this.now);
    this.state.readyAtMs = null;
    this.state.stoppedAtMs = null;
    this.stopping = false;

    this.emitAudit("start", "allow", "agent_process_starting", {
      command: this.commandSpec.command,
      args: this.commandSpec.args,
      cwd: this.commandSpec.cwd,
    });

    const child = spawn(this.commandSpec.command, this.commandSpec.args, spawnOptions);
    this.child = child;
    this.state.pid = child.pid ?? null;
    this.state.childPresent = true;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStream("stdout", chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.handleStream("stderr", chunk);
    });
    child.on("exit", (code, signal) => {
      void this.handleExit(code, signal);
    });
    child.on("error", (error) => {
      this.state.health = "error";
      this.emitAudit("exit", "deny", "child_process_error", { error: error.message });
      this.emit("error", error, this.snapshot());
    });

    await this.awaitReadiness();
    this.startProbeLoop();

    const snap = this.snapshot();
    await maybeCall(this.hooks?.onReady, snap);
    this.emit("ready", snap);
    return snap;
  }

  async stop(reason = "explicit_stop"): Promise<AgentProcessSnapshot> {
    this.assertNotDisposed();
    this.stopping = true;
    this.clearTimers();

    if (!this.child) {
      this.state.health = "stopped";
      this.state.stoppedAtMs = nowMs(this.now);
      this.emitAudit("stop", "allow", "agent_process_already_stopped", { reason });
      return this.snapshot();
    }

    const child = this.child;
    const pid = child.pid ?? null;
    this.emitAudit("stop", "allow", "agent_process_stopping", {
      reason,
      pid,
      signal: this.policy.gracefulStopSignal,
    });

    try {
      child.kill(this.policy.gracefulStopSignal);
    } catch {
      // ignore; exit handling will reconcile state
    }

    const deadline = nowMs(this.now) + this.policy.gracefulStopTimeoutMs;
    while (this.child && nowMs(this.now) < deadline) {
      await delay(50);
    }

    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }

    this.child = null;
    this.state.childPresent = false;
    this.state.pid = null;
    this.state.health = "stopped";
    this.state.stoppedAtMs = nowMs(this.now);

    const snap = this.snapshot();
    this.emit("stopped", snap);
    return snap;
  }

  async restart(reason = "explicit_restart"): Promise<AgentProcessSnapshot> {
    this.assertNotDisposed();
    this.emitAudit("restart", "allow", "agent_process_restarting", { reason });
    await this.stop(reason);
    this.state.restartCount += 1;
    const snap = await this.start();
    await maybeCall(this.hooks?.onRestart, snap);
    this.emit("restarted", snap);
    return snap;
  }

  async probe(): Promise<AgentReadinessProbeResult> {
    this.assertNotDisposed();
    const started = nowMs(this.now);
    const token = readToken(this.tokenFile);

    try {
      const response = await fetch(this.agentUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-adjutorix-token": token } : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: started, method: "health.ping", params: {} }),
        signal: AbortSignal.timeout(this.policy.probeTimeoutMs),
      });

      const body = await response.text();
      const result: AgentReadinessProbeResult = {
        ok: response.ok,
        status: response.status,
        bodyHash: sha256(body),
        checkedAtMs: nowMs(this.now),
        durationMs: nowMs(this.now) - started,
        error: null,
      };
      this.afterProbe(result);
      return result;
    } catch (error) {
      const result: AgentReadinessProbeResult = {
        ok: false,
        status: null,
        bodyHash: null,
        checkedAtMs: nowMs(this.now),
        durationMs: nowMs(this.now) - started,
        error: error instanceof Error ? error.message : String(error),
      };
      this.afterProbe(result);
      return result;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state.disposed = true;
    this.clearTimers();
    if (this.child) {
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
    this.child = null;
    this.state.childPresent = false;
    this.state.pid = null;
    this.state.health = "stopped";
    this.state.stoppedAtMs = nowMs(this.now);
    this.emitAudit("dispose", "allow", "agent_process_disposed", {});
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private assertNotDisposed(): void {
    assert(!this.disposed, "supervisor_disposed");
  }

  private async awaitReadiness(): Promise<void> {
    const deadline = nowMs(this.now) + this.policy.readyTimeoutMs;

    while (nowMs(this.now) < deadline) {
      const result = await this.probe();
      if (result.ok) {
        this.state.health = "ready";
        this.state.readyAtMs = result.checkedAtMs;
        this.emitAudit("ready", "allow", "agent_ready", {
          status: result.status,
          durationMs: result.durationMs,
        });
        return;
      }
      await delay(Math.min(this.policy.probeIntervalMs, 250));
    }

    this.state.health = "error";
    this.emitAudit("ready", "deny", "agent_readiness_timeout", {
      readyTimeoutMs: this.policy.readyTimeoutMs,
      lastProbe: this.state.lastProbe,
    });
    throw new Error("agent_readiness_timeout");
  }

  private startProbeLoop(): void {
    this.clearProbeTimer();
    this.probeTimer = setInterval(() => {
      void this.probe();
    }, this.policy.probeIntervalMs);
  }

  private afterProbe(result: AgentReadinessProbeResult): void {
    this.state.lastProbe = result;
    if (result.ok) {
      this.state.consecutiveProbeFailures = 0;
      if (this.child) this.state.health = this.state.readyAtMs ? "ready" : "starting";
    } else {
      this.state.consecutiveProbeFailures += 1;
      if (this.child && this.state.readyAtMs) this.state.health = "degraded";
    }

    this.emitAudit("probe", result.ok ? "allow" : "deny", result.ok ? "probe_ok" : "probe_failed", {
      status: result.status,
      durationMs: result.durationMs,
      error: result.error,
      consecutiveProbeFailures: this.state.consecutiveProbeFailures,
    });

    const snap = this.snapshot();
    void maybeCall(this.hooks?.onProbe, result as any);
    this.emit("probe", result, snap);
  }

  private handleStream(stream: "stdout" | "stderr", chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => truncateLine(line, this.policy.maxLineLength))
      .filter((line) => line.length > 0);

    if (lines.length === 0) return;

    if (stream === "stdout") {
      pushBounded(this.stdoutTail, lines, this.policy.maxStdoutLines);
      if (this.policy.persistLogsToFiles) {
        ensureDir(this.paths.logRoot);
        fs.appendFileSync(this.paths.stdoutLogFile, `${lines.join("\n")}\n`, "utf8");
      }
    } else {
      pushBounded(this.stderrTail, lines, this.policy.maxStderrLines);
      if (this.policy.persistLogsToFiles) {
        ensureDir(this.paths.logRoot);
        fs.appendFileSync(this.paths.stderrLogFile, `${lines.join("\n")}\n`, "utf8");
      }
    }

    this.emitAudit(stream, "allow", `${stream}_captured`, {
      lineCount: lines.length,
      pid: this.state.pid,
    });
  }

  private async handleExit(code: number | null, signal: NodeJS.Signals | null): Promise<void> {
    this.clearTimers();
    const unexpected = !this.stopping;

    this.state.lastExitCode = code;
    this.state.lastExitSignal = signal;
    this.state.lastExitKind = signal ? "signal" : code === 0 ? "clean" : code === null ? "unknown" : "crash";
    this.state.stoppedAtMs = nowMs(this.now);
    this.state.childPresent = false;
    this.state.pid = null;
    this.child = null;
    this.state.health = unexpected ? "error" : "stopped";

    const snap = this.snapshot();
    this.emitAudit("exit", unexpected ? "deny" : "allow", unexpected ? "agent_exited_unexpectedly" : "agent_exited_cleanly", {
      code,
      signal,
      exitKind: this.state.lastExitKind,
      restartCount: this.state.restartCount,
    });

    await maybeCall(this.hooks?.onExit, snap);
    this.emit("exit", snap);

    if (unexpected && this.policy.autoRestart && this.state.restartCount < this.policy.maxRestartAttempts && !this.disposed) {
      this.state.restartCount += 1;
      this.restartTimer = setTimeout(() => {
        void this.start().then(async (restartSnap) => {
          await maybeCall(this.hooks?.onRestart, restartSnap);
        }).catch((error) => {
          this.state.health = "error";
          this.emit("error", error, this.snapshot());
        });
      }, this.policy.restartBackoffMs);
    }
  }

  private clearProbeTimer(): void {
    if (this.probeTimer) {
      clearInterval(this.probeTimer);
      this.probeTimer = null;
    }
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearProbeTimer();
    this.clearRestartTimer();
  }

  private emitAudit(
    action: AgentProcessAction,
    decision: "allow" | "deny",
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<AgentProcessAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
      reason,
      detail,
    };
    this.audit({
      ...core,
      hash: auditHash(core),
    });
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createAgentProcessSupervisor(options: AgentProcessOptions): AgentProcessSupervisor {
  return new AgentProcessSupervisor(options);
}

export function defaultAgentProcessPolicy(): AgentProcessPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateAgentProcessSnapshot(snapshot: AgentProcessSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<AgentProcessSnapshot, "hash"> = {
    schema: snapshot.schema,
    agentUrl: snapshot.agentUrl,
    tokenFile: snapshot.tokenFile,
    command: snapshot.command,
    state: snapshot.state,
    stdoutTail: snapshot.stdoutTail,
    stderrTail: snapshot.stderrTail,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
