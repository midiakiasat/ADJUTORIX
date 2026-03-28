import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

/**
 * ADJUTORIX APP — MAIN / SHELL / command_runner.ts
 *
 * Hardened shell/process execution boundary for the Electron main process.
 *
 * Purpose:
 * - provide one canonical way to execute subprocesses from main
 * - normalize command specs, cwd/env policy, stdio capture, timeout, and termination
 * - prevent execution drift across verify, diagnostics, migrations, smoke tests, and tooling glue
 * - expose deterministic execution artifacts suitable for replay, audit, and diagnostics
 *
 * This module is intentionally strict. It is NOT a convenience wrapper around spawn.
 * It is the authority boundary for local command execution.
 *
 * Responsibilities:
 * - validate and normalize command specs
 * - constrain cwd and environment
 * - stream and bound stdout/stderr capture
 * - redact sensitive data in observable outputs
 * - enforce timeout and kill escalation policy
 * - persist optional logs
 * - emit stable snapshots and execution records
 *
 * Hard invariants:
 * - at most one running child per runner instance
 * - identical normalized command requests produce identical request hashes
 * - outputs are bounded and redacted before surfacing in result objects
 * - stop/kill/dispose tear down timers and child references completely
 * - execution results are serialization-stable and auditable
 * - shell mode is explicit and opt-in
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

export type CommandRunnerHealth = "idle" | "running" | "timed-out" | "stopped" | "exited" | "error";
export type CommandExitKind = "clean" | "nonzero" | "signal" | "timeout" | "spawn-error" | "unknown";
export type CommandRunnerAction =
  | "start"
  | "stdout"
  | "stderr"
  | "timeout"
  | "terminate"
  | "kill"
  | "exit"
  | "snapshot"
  | "dispose";

export type CommandSpec = {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  shell: boolean;
};

export type CommandRequest = {
  schema: 1;
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  shell?: boolean;
  timeoutMs?: number;
  traceId?: string;
  description?: string;
};

export type CommandPolicy = {
  allowShell: boolean;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  gracefulStopSignal: NodeJS.Signals;
  gracefulStopWaitMs: number;
  maxStdoutLines: number;
  maxStderrLines: number;
  maxLineLength: number;
  persistLogs: boolean;
  logRoot: string;
  cwdAllowlist: string[];
  redactPatterns: string[];
  inheritProcessEnv: boolean;
};

export type CommandOutputBuffer = {
  stdout: string[];
  stderr: string[];
};

export type CommandExecutionState = {
  health: CommandRunnerHealth;
  pid: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  timeoutAtMs: number | null;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitKind: CommandExitKind | null;
  requestHash: string | null;
  commandHash: string | null;
  description: string | null;
  childPresent: boolean;
  disposed: boolean;
  timedOut: boolean;
  spawnError: string | null;
};

export type CommandExecutionResult = {
  schema: 1;
  requestHash: string;
  commandHash: string;
  spec: CommandSpec;
  description: string | null;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  exitCode: number | null;
  exitSignal: NodeJS.Signals | null;
  exitKind: CommandExitKind;
  timedOut: boolean;
  stdout: string[];
  stderr: string[];
  stdoutLogFile: string | null;
  stderrLogFile: string | null;
  hash: string;
};

export type CommandRunnerSnapshot = {
  schema: 1;
  policy: {
    allowShell: boolean;
    defaultTimeoutMs: number;
    maxTimeoutMs: number;
    gracefulStopSignal: NodeJS.Signals;
    gracefulStopWaitMs: number;
    maxStdoutLines: number;
    maxStderrLines: number;
    maxLineLength: number;
    persistLogs: boolean;
    logRoot: string;
    inheritProcessEnv: boolean;
  };
  state: CommandExecutionState;
  stdoutTail: string[];
  stderrTail: string[];
  hash: string;
};

export type CommandRunnerAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: CommandRunnerAction;
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type CommandRunnerAuditFn = (record: CommandRunnerAuditRecord) => void;

export type CommandRunnerHooks = {
  onStart?: (snapshot: CommandRunnerSnapshot) => Promise<void> | void;
  onExit?: (result: CommandExecutionResult, snapshot: CommandRunnerSnapshot) => Promise<void> | void;
  onTimeout?: (snapshot: CommandRunnerSnapshot) => Promise<void> | void;
};

export type CommandRunnerOptions = {
  policy?: Partial<CommandPolicy>;
  audit?: CommandRunnerAuditFn;
  hooks?: CommandRunnerHooks;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: CommandPolicy = {
  allowShell: false,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 15 * 60 * 1000,
  gracefulStopSignal: "SIGTERM",
  gracefulStopWaitMs: 2_000,
  maxStdoutLines: 2_000,
  maxStderrLines: 2_000,
  maxLineLength: 8_000,
  persistLogs: true,
  logRoot: path.join(os.tmpdir(), "adjutorix-command-logs"),
  cwdAllowlist: [process.cwd(), os.homedir(), os.tmpdir()],
  redactPatterns: [
    "x-adjutorix-token",
    "authorization:",
    "bearer ",
    "api_key",
    "api-key",
    "secret=",
    "token=",
    "password=",
  ],
  inheritProcessEnv: true,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:shell:command_runner:${message}`);
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = normalize((v as Record<string, unknown>)[key]);
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

function boundedPush(target: string[], lines: string[], maxLines: number): void {
  for (const line of lines) target.push(line);
  while (target.length > maxLines) target.shift();
}

function truncateLine(line: string, maxLineLength: number): string {
  return line.length <= maxLineLength ? line : `${line.slice(0, maxLineLength)}…`;
}

function normalizeEnv(env: Record<string, string> | undefined, inherit: boolean): Record<string, string> {
  const base = inherit
    ? Object.fromEntries(
        Object.entries(process.env)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string")
          .map(([k, v]) => [k, v]),
      )
    : {};
  for (const [k, v] of Object.entries(env ?? {})) base[k] = String(v);
  return base;
}

function isInsideAllowedCwd(target: string, allowlist: string[]): boolean {
  return allowlist.some((allowed) => {
    const root = path.resolve(allowed);
    const rel = path.relative(root, target);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

function redactLine(line: string, patterns: string[]): string {
  let out = line;
  for (const pattern of patterns) {
    const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`${escaped}[^\s]*`, "ig"), `${pattern}<redacted>`);
  }
  return out;
}

function normalizeSpec(request: CommandRequest, policy: CommandPolicy): { spec: CommandSpec; timeoutMs: number; requestHash: string } {
  assert(request.schema === 1, "request_schema_invalid");
  assert(typeof request.command === "string" && request.command.trim().length > 0, "command_invalid");

  const shell = request.shell ?? false;
  assert(!shell || policy.allowShell, "shell_not_allowed");

  const cwd = path.resolve(request.cwd ?? process.cwd());
  assert(isInsideAllowedCwd(cwd, policy.cwdAllowlist), "cwd_not_allowed");

  const timeoutMs = Math.min(policy.maxTimeoutMs, request.timeoutMs ?? policy.defaultTimeoutMs);
  assert(timeoutMs > 0, "timeout_invalid");

  const spec: CommandSpec = {
    command: request.command,
    args: [...(request.args ?? [])],
    cwd,
    env: normalizeEnv(request.env, policy.inheritProcessEnv),
    shell,
  };

  const requestHash = sha256(
    stableJson({
      schema: 1,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      timeoutMs,
      ...(request.traceId ? { traceId: request.traceId } : {}),
      ...(request.description ? { description: request.description } : {}),
    }),
  );

  return { spec, timeoutMs, requestHash };
}

function commandHash(spec: CommandSpec): string {
  return sha256(stableJson(spec));
}

function resultHash(core: Omit<CommandExecutionResult, "hash">): string {
  return sha256(stableJson(core));
}

function snapshotHash(core: Omit<CommandRunnerSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<CommandRunnerAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function maybeCall<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

async function maybeCallExit(
  fn: ((result: CommandExecutionResult, snapshot: CommandRunnerSnapshot) => Promise<void> | void) | undefined,
  result: CommandExecutionResult,
  snapshot: CommandRunnerSnapshot,
): Promise<void> {
  if (fn) await fn(result, snapshot);
}

// -----------------------------------------------------------------------------
// RUNNER
// -----------------------------------------------------------------------------

export class CommandRunner extends EventEmitter {
  private readonly policy: CommandPolicy;
  private readonly audit?: CommandRunnerAuditFn;
  private readonly hooks?: CommandRunnerHooks;
  private readonly now?: () => number;

  private child: ChildProcessWithoutNullStreams | null = null;
  private timeoutTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private stdoutTail: string[] = [];
  private stderrTail: string[] = [];
  private stdoutLogFile: string | null = null;
  private stderrLogFile: string | null = null;
  private state: CommandExecutionState = {
    health: "idle",
    pid: null,
    startedAtMs: null,
    endedAtMs: null,
    timeoutAtMs: null,
    exitCode: null,
    exitSignal: null,
    exitKind: null,
    requestHash: null,
    commandHash: null,
    description: null,
    childPresent: false,
    disposed: false,
    timedOut: false,
    spawnError: null,
  };

  constructor(options: CommandRunnerOptions = {}) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.hooks = options.hooks;
    this.now = options.now;
    if (this.policy.persistLogs) ensureDir(this.policy.logRoot);
  }

  snapshot(): CommandRunnerSnapshot {
    const core: Omit<CommandRunnerSnapshot, "hash"> = {
      schema: 1,
      policy: {
        allowShell: this.policy.allowShell,
        defaultTimeoutMs: this.policy.defaultTimeoutMs,
        maxTimeoutMs: this.policy.maxTimeoutMs,
        gracefulStopSignal: this.policy.gracefulStopSignal,
        gracefulStopWaitMs: this.policy.gracefulStopWaitMs,
        maxStdoutLines: this.policy.maxStdoutLines,
        maxStderrLines: this.policy.maxStderrLines,
        maxLineLength: this.policy.maxLineLength,
        persistLogs: this.policy.persistLogs,
        logRoot: this.policy.logRoot,
        inheritProcessEnv: this.policy.inheritProcessEnv,
      },
      state: JSON.parse(stableJson(this.state)) as CommandExecutionState,
      stdoutTail: [...this.stdoutTail],
      stderrTail: [...this.stderrTail],
    };

    const snapshot: CommandRunnerSnapshot = {
      ...core,
      hash: snapshotHash(core),
    };

    this.emitAudit("snapshot", "allow", "command_runner_snapshot_created", {
      health: snapshot.state.health,
      pid: snapshot.state.pid,
    });

    return snapshot;
  }

  isRunning(): boolean {
    return this.child !== null;
  }

  async run(request: CommandRequest): Promise<CommandExecutionResult> {
    this.assertNotDisposed();
    assert(!this.child, "runner_already_busy");

    const { spec, timeoutMs, requestHash } = normalizeSpec(request, this.policy);
    const specHash = commandHash(spec);

    this.stdoutTail = [];
    this.stderrTail = [];
    this.stdoutLogFile = null;
    this.stderrLogFile = null;

    this.state.health = "running";
    this.state.pid = null;
    this.state.startedAtMs = nowMs(this.now);
    this.state.endedAtMs = null;
    this.state.timeoutAtMs = this.state.startedAtMs + timeoutMs;
    this.state.exitCode = null;
    this.state.exitSignal = null;
    this.state.exitKind = null;
    this.state.requestHash = requestHash;
    this.state.commandHash = specHash;
    this.state.description = request.description ?? null;
    this.state.childPresent = false;
    this.state.timedOut = false;
    this.state.spawnError = null;

    if (this.policy.persistLogs) {
      ensureDir(this.policy.logRoot);
      this.stdoutLogFile = path.join(this.policy.logRoot, `${requestHash}.stdout.log`);
      this.stderrLogFile = path.join(this.policy.logRoot, `${requestHash}.stderr.log`);
    }

    const spawnOptions: SpawnOptionsWithoutStdio = {
      cwd: spec.cwd,
      env: spec.env,
      shell: spec.shell,
      detached: false,
    };

    this.emitAudit("start", "allow", "command_started", {
      requestHash,
      commandHash: specHash,
      command: spec.command,
      args: spec.args,
      cwd: spec.cwd,
      shell: spec.shell,
      timeoutMs,
    });

    const child = spawn(spec.command, spec.args, spawnOptions);
    this.child = child;
    this.state.pid = child.pid ?? null;
    this.state.childPresent = true;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => this.handleChunk("stdout", chunk));
    child.stderr.on("data", (chunk: string) => this.handleChunk("stderr", chunk));

    const startSnapshot = this.snapshot();
    await maybeCall(this.hooks?.onStart, startSnapshot);

    return await new Promise<CommandExecutionResult>((resolve, reject) => {
      let settled = false;

      const settle = async (result: CommandExecutionResult): Promise<void> => {
        if (settled) return;
        settled = true;
        const snap = this.snapshot();
        await maybeCallExit(this.hooks?.onExit, result, snap);
        this.emit("exit", result, snap);
        resolve(result);
      };

      child.on("error", (error) => {
        if (settled) return;
        this.state.health = "error";
        this.state.spawnError = error.message;
        this.state.endedAtMs = nowMs(this.now);
        this.state.exitKind = "spawn-error";
        this.clearTimeoutTimer();
        this.child = null;
        this.state.childPresent = false;
        this.emitAudit("exit", "deny", "command_spawn_error", {
          requestHash,
          error: error.message,
        });
        reject(error);
      });

      child.on("exit", async (code, signal) => {
        if (settled) return;
        this.clearTimeoutTimer();
        this.state.endedAtMs = nowMs(this.now);
        this.state.exitCode = code;
        this.state.exitSignal = signal;
        this.state.childPresent = false;
        this.child = null;

        const exitKind: CommandExitKind = this.state.timedOut
          ? "timeout"
          : signal
            ? "signal"
            : code === 0
              ? "clean"
              : code === null
                ? "unknown"
                : "nonzero";

        this.state.exitKind = exitKind;
        this.state.health = this.state.timedOut ? "timed-out" : "exited";

        const core: Omit<CommandExecutionResult, "hash"> = {
          schema: 1,
          requestHash,
          commandHash: specHash,
          spec,
          description: request.description ?? null,
          startedAtMs: this.state.startedAtMs!,
          endedAtMs: this.state.endedAtMs!,
          durationMs: this.state.endedAtMs! - this.state.startedAtMs!,
          exitCode: code,
          exitSignal: signal,
          exitKind,
          timedOut: this.state.timedOut,
          stdout: [...this.stdoutTail],
          stderr: [...this.stderrTail],
          stdoutLogFile: this.stdoutLogFile,
          stderrLogFile: this.stderrLogFile,
        };

        const result: CommandExecutionResult = {
          ...core,
          hash: resultHash(core),
        };

        this.emitAudit("exit", exitKind === "clean" ? "allow" : "deny", "command_exited", {
          requestHash,
          exitCode: code,
          exitSignal: signal,
          exitKind,
          timedOut: this.state.timedOut,
        });

        await settle(result);
      });

      this.timeoutTimer = setTimeout(async () => {
        if (settled) return;
        this.state.timedOut = true;
        this.state.health = "timed-out";
        this.emitAudit("timeout", "deny", "command_timed_out", {
          requestHash,
          pid: this.state.pid,
          timeoutAtMs: this.state.timeoutAtMs,
        });
        const snap = this.snapshot();
        await maybeCall(this.hooks?.onTimeout, snap);
        await this.terminate();
      }, timeoutMs);
    });
  }

  async terminate(): Promise<void> {
    if (!this.child) return;

    const child = this.child;
    this.emitAudit("terminate", "allow", "command_terminate_requested", {
      pid: child.pid ?? null,
      signal: this.policy.gracefulStopSignal,
    });

    try {
      child.kill(this.policy.gracefulStopSignal);
    } catch {
      // ignore
    }

    const deadline = nowMs(this.now) + this.policy.gracefulStopWaitMs;
    while (this.child && nowMs(this.now) < deadline) {
      await delay(50);
    }

    if (this.child) {
      this.emitAudit("kill", "deny", "command_escalated_to_sigkill", {
        pid: this.child.pid ?? null,
      });
      try {
        this.child.kill("SIGKILL");
      } catch {
        // ignore
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.state.disposed = true;
    this.clearTimeoutTimer();
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
    this.emitAudit("dispose", "allow", "command_runner_disposed", {});
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private assertNotDisposed(): void {
    assert(!this.disposed, "runner_disposed");
  }

  private clearTimeoutTimer(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private handleChunk(stream: "stdout" | "stderr", chunk: string): void {
    const lines = chunk
      .split(/\r?\n/)
      .map((line) => redactLine(truncateLine(line, this.policy.maxLineLength), this.policy.redactPatterns))
      .filter((line) => line.length > 0);

    if (lines.length === 0) return;

    if (stream === "stdout") {
      boundedPush(this.stdoutTail, lines, this.policy.maxStdoutLines);
      if (this.stdoutLogFile) fs.appendFileSync(this.stdoutLogFile, `${lines.join("\n")}\n`, "utf8");
    } else {
      boundedPush(this.stderrTail, lines, this.policy.maxStderrLines);
      if (this.stderrLogFile) fs.appendFileSync(this.stderrLogFile, `${lines.join("\n")}\n`, "utf8");
    }

    this.emitAudit(stream, "allow", `${stream}_captured`, {
      lineCount: lines.length,
      pid: this.state.pid,
    });
  }

  private emitAudit(
    action: CommandRunnerAction,
    decision: "allow" | "deny",
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<CommandRunnerAuditRecord, "hash"> = {
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

export function createCommandRunner(options: CommandRunnerOptions = {}): CommandRunner {
  return new CommandRunner(options);
}

export function defaultCommandPolicy(): CommandPolicy {
  return {
    ...DEFAULT_POLICY,
    cwdAllowlist: [...DEFAULT_POLICY.cwdAllowlist],
    redactPatterns: [...DEFAULT_POLICY.redactPatterns],
  };
}

export function validateCommandExecutionResult(result: CommandExecutionResult): void {
  assert(result.schema === 1, "result_schema_invalid");
  const core: Omit<CommandExecutionResult, "hash"> = {
    schema: result.schema,
    requestHash: result.requestHash,
    commandHash: result.commandHash,
    spec: result.spec,
    description: result.description,
    startedAtMs: result.startedAtMs,
    endedAtMs: result.endedAtMs,
    durationMs: result.durationMs,
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    exitKind: result.exitKind,
    timedOut: result.timedOut,
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutLogFile: result.stdoutLogFile,
    stderrLogFile: result.stderrLogFile,
  };
  assert(result.hash === resultHash(core), "result_hash_drift");
}

export function validateCommandRunnerSnapshot(snapshot: CommandRunnerSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<CommandRunnerSnapshot, "hash"> = {
    schema: snapshot.schema,
    policy: snapshot.policy,
    state: snapshot.state,
    stdoutTail: snapshot.stdoutTail,
    stderrTail: snapshot.stderrTail,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
