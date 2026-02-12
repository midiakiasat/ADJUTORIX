/**
 * Manages the lifecycle of the local Adjutorix agent.
 * Spawns run_agent.sh, waits for /health, streams logs to Output channel, kills on deactivate.
 */

import * as child_process from "child_process";
import { execSync } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import fetch from "node-fetch";
import { postJsonRpc } from "../client/transport";

export type AgentProcessState =
  | "stopped"
  | "starting"
  | "stopping"
  | "connected"
  | "failed";

/** User intent: what the extension should do. */
export type AgentMode = "auto" | "managed" | "external";

/** Observation: what actually happened this session. Ownership is a session inference from mode + reachability, not an OS-level guarantee (e.g. /health may still be served by a managed process during shutdown). */
export type AgentOwnership = "managed" | "external" | "unknown";

export interface AgentProcessStatus {
  state: AgentProcessState;
  mode: AgentMode;
  ownership: AgentOwnership;
  baseUrl: string;

  // Failures (connectivity / hard failures)
  lastError?: string;
  /** Raw error message for forensics; UI shows lastError only. */
  lastErrorRaw?: string;

  // Policy warnings (do not imply disconnect)
  warning?: string;
  warningRaw?: string;

  lastPingAt?: number;
  version?: string;
}

const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_POLL_MS = 500;
const HEALTH_RETRIES = Math.floor(HEALTH_TIMEOUT_MS / HEALTH_POLL_MS);
const HEALTH_REQUEST_MS = 5_000;

/**
 * Default script path relative to workspace root.
 */
const DEFAULT_SCRIPT_REL = path.join("tools", "dev", "run_agent.sh");

const DEFAULT_PORT = "7337";
const DAEMON_EXIT_GRACE_MS = 2_000;

/**
 * Classify failure for user-facing message: auth vs down vs timeout.
 */
export function classifyError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (lower.includes("401") || lower.includes("403") || msg.includes("Unauthorized") || msg.includes("Forbidden")) {
    return "Authentication error (check token)";
  }
  if (lower.includes("econnrefused") || lower.includes("connection refused")) {
    return "Agent not running";
  }
  if (lower.includes("timeout") || lower.includes("abort") || lower.includes("etimedout")) {
    return "Agent not responding (timeout)";
  }
  return msg;
}

/**
 * Normalize base URL: strip trailing slash and /rpc so we always hit /health on the base.
 */
export function normalizeBaseUrl(url: string): string {
  let s = url.trim().replace(/\/+$/, "");
  if (s.endsWith("/rpc")) s = s.slice(0, -4);
  return s || `http://127.0.0.1:${DEFAULT_PORT}`;
}

/**
 * Fetches agent health (no auth). Any 2xx + parseable JSON = alive.
 * Returns { ok: true, version? } or throws.
 */
async function fetchHealth(baseUrl: string): Promise<{ ok: true; version?: string }> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), HEALTH_REQUEST_MS);
  try {
    const res = await fetch(`${baseUrl}/health`, {
      method: "GET",
      signal: controller.signal as AbortSignal,
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`Health ${res.status}: ${res.statusText}`);
    const data = (await res.json()) as { status?: string; version?: string };
    return { ok: true, version: data.version };
  } finally {
    clearTimeout(t);
  }
}

function rawMessage(err: unknown): string {
  if (err && typeof err === "object") {
    const anyErr = err as { message?: string; code?: string };
    const code = anyErr.code ? ` code=${anyErr.code}` : "";
    const msg = anyErr.message ?? String(err);
    return `${msg}${code}`;
  }
  return String(err);
}

const MANAGED_DAEMON_MSG =
  "Agent script daemonized but mode=Managed requires a long-running child process.";

export class AgentProcessManager {
  private process: child_process.ChildProcess | null = null;
  private state: AgentProcessState = "stopped";
  private mode: AgentMode;
  private ownership: AgentOwnership = "unknown";
  private daemonCandidate = false;
  private stopRequested = false;
  private lastError: string | undefined;
  private lastErrorRaw: string | undefined;
  private warning: string | undefined;
  private warningRaw: string | undefined;
  private lastPingAt: number | undefined;
  private version: string | undefined;
  private baseUrl: string;
  private readonly cwd: string;
  private readonly scriptPath: string;
  private readonly out: vscode.OutputChannel;
  private readonly listeners = new Set<(status: AgentProcessStatus) => void>();
  /** Incremented on endpoint or mode change; async continuations must check gen to avoid stale updates. */
  private gen = 0;
  /** Invalidation epoch for stop timers; incremented on stop() and at start of start(). Timer only sets stopped if seq still matches. */
  private stopTimerEpoch = 0;
  /** When set and (startInFlightGen, startInFlightAttemptEpoch) still match current epochs, start() returns this promise instead of running a concurrent probe. */
  private startInFlight: Promise<void> | null = null;
  /** Configuration epoch for reuse: same gen => same mode/baseUrl. */
  private startInFlightGen = 0;
  /** Only start() and invalidateStartLatch() may advance this. Monotonic attempt epoch; finally clears startInFlight only when epoch still matches (so Stop→Start doesn't let old finally clobber new run). */
  private startAttemptEpoch = 0;
  private startInFlightAttemptEpoch = 0;
  private lastHealthLoggedAt = 0;
  private lastHealthSig: string | undefined;

  constructor(options: {
    baseUrl: string;
    workspaceRoot: string;
    scriptPath?: string;
    out: vscode.OutputChannel;
    initialMode?: AgentMode;
  }) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.cwd = options.workspaceRoot;
    this.scriptPath = options.scriptPath ?? path.join(this.cwd, DEFAULT_SCRIPT_REL);
    this.out = options.out;
    this.mode = options.initialMode ?? "auto";
  }

  getMode(): AgentMode {
    return this.mode;
  }

  setMode(mode: AgentMode): void {
    if (this.mode === mode) return;
    this.gen++;
    this.mode = mode;
    this.clearMetadata();
    this.ownership = "unknown";
    this.daemonCandidate = false;
    this.invalidateStartLatch();

    if (mode === "external") {
      if (this.hasManagedProcess()) this.stop();
      // No auto start: mode change ≠ lifecycle. User clicks Retry → start().
    }
    if (mode === "managed") {
      this.setState("stopped");
    }
    this.emitStatus();
  }

  private clearMetadata(): void {
    this.lastError = undefined;
    this.lastErrorRaw = undefined;
    this.warning = undefined;
    this.warningRaw = undefined;
    this.version = undefined;
    this.lastPingAt = undefined;
  }

  /** True only if we have a live child process we own (managed semantics). */
  private hasManagedProcess(): boolean {
    return this.process != null && !this.process.killed;
  }

  private emitStatus(): void {
    const status = this.getStatus();
    this.listeners.forEach((fn) => fn(status));
  }

  /** Null the in-flight start promise and stamp (gen, attempt) so invariants stay explicit. Call from stop/setMode/setBaseUrl only. */
  private invalidateStartLatch(): void {
    this.startInFlight = null;
    this.startInFlightGen = this.gen;
    this.startInFlightAttemptEpoch = ++this.startAttemptEpoch;
  }

  /** Increment stop-timer epoch; returns new value. Call from start() (ignore return) and stop() (use return as timer seq) so old stop-timers never overwrite fresh starts. */
  private nextStopTimerEpoch(): number {
    return ++this.stopTimerEpoch;
  }

  setBaseUrl(url: string): void {
    const next = normalizeBaseUrl(url);
    if (next !== this.baseUrl) {
      this.gen++;
      this.baseUrl = next;
      this.ownership = "unknown";
      this.daemonCandidate = false;
      this.clearMetadata();
      this.invalidateStartLatch();
      if (this.state === "starting" || this.state === "connected") {
        this.setState("stopped");
      } else {
        this.emitStatus();
      }
    }
  }

  getStatus(): AgentProcessStatus {
    return {
      state: this.state,
      mode: this.mode,
      ownership: this.ownership,
      baseUrl: this.baseUrl,
      lastError: this.lastError,
      lastErrorRaw: this.lastErrorRaw,
      warning: this.warning,
      warningRaw: this.warningRaw,
      lastPingAt: this.lastPingAt,
      version: this.version,
    };
  }

  onStatusChange(listener: (status: AgentProcessStatus) => void): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }

  private setState(state: AgentProcessState, userError?: string, rawError?: string) {
    const wasFailed = this.state === "failed";
    this.state = state;
    if (userError !== undefined) this.lastError = userError;
    if (rawError !== undefined) this.lastErrorRaw = rawError;
if (state === "connected") {
  this.lastPingAt = Date.now();
  this.warning = undefined;
  this.warningRaw = undefined;
}
    if (state === "failed" && !wasFailed && rawError !== undefined) {
      const now = Date.now();
      const sig = rawError;
      const shouldLog = sig !== this.lastHealthSig || now - this.lastHealthLoggedAt > 30_000;
      if (shouldLog) {
        this.out.appendLine(`[health] failed: ${userError ?? this.lastError} (raw: ${rawError})`);
        this.lastHealthSig = sig;
        this.lastHealthLoggedAt = now;
      }
    }
    this.emitStatus();
  }

  /** True if we believe the agent is reachable: we own the process, or ownership is external and we're connected. */
  isRunning(): boolean {
    return (
      (this.process != null && !this.process.killed) ||
      (this.ownership === "external" && this.state === "connected")
    );
  }

  isExternalConfirmed(): boolean {
    return this.ownership === "external";
  }

  /**
   * Start the agent. Behavior depends on mode: external = health only; managed = spawn only (daemon = fail); auto = preflight health or spawn with daemon allowed.
   * Do not call startExternal/startManaged/startAuto/startSpawn directly; always go through start() so the in-flight latch applies.
   * Reuse predicate: startAttemptEpoch is the current attempt token; invalidation bumps it, so reuse only applies when nothing invalidated since the in-flight start was created.
   */
  async start(): Promise<void> {
    if (
      this.startInFlight &&
      this.startInFlightGen === this.gen &&
      this.startInFlightAttemptEpoch === this.startAttemptEpoch
    ) {
      return this.startInFlight;
    }

    const g = this.gen;
    const attemptEpoch = ++this.startAttemptEpoch;
    this.nextStopTimerEpoch();
    const run = (async () => {
      if (this.mode === "external") {
        if (this.state !== "starting") this.setState("starting");
        return this.startExternal(g);
      }
      if (this.mode === "managed") return this.startManaged(g);
      return this.startAuto(g);
    })();

    this.startInFlightGen = g;
    this.startInFlightAttemptEpoch = attemptEpoch;
    this.startInFlight = run.finally(() => {
      if (this.startInFlightGen === g && this.startInFlightAttemptEpoch === attemptEpoch) {
        this.startInFlight = null;
      }
    });
    return this.startInFlight;
  }

  private async startExternal(g: number): Promise<void> {
    const res = await this.waitForHealth();
    if (g !== this.gen) return;
    if (res.ok) {
      this.version = res.version;
      this.ownership = "external";
      this.setState("connected");
    } else {
      this.setState("failed", "Agent not responding", "health check failed (external mode)");
    }
  }

  private async startManaged(g: number): Promise<void> {
    if (this.hasManagedProcess()) {
      const res = await this.waitForHealth();
      if (g !== this.gen) return;
      if (res.ok) {
        this.version = res.version;
        this.ownership = "managed";
        this.setState("connected");
      }
      return;
    }

    const pre = await this.waitForHealth();
    if (g !== this.gen) return;
    if (pre.ok) {
      const port = this.portFromBaseUrl(this.baseUrl);
      this.out.appendLine(
        `[managed] takeover: port ${port} in use; killing external agent`
      );
      this.killProcessOnPort(port);
      await new Promise((r) => setTimeout(r, 1500));

      const pre2 = await this.waitForHealth();
      if (g !== this.gen) return;
      if (pre2.ok) {
        const msg = `Managed takeover failed: agent still reachable at ${this.baseUrl}`;
        this.setState("failed", msg, `takeover failed baseUrl=${this.baseUrl}`);
        return;
      }
      return this.startSpawn(false);
    }

    return this.startSpawn(false);
  }

  private killProcessOnPort(port: string): void {
    try {
      const out = execSync(`lsof -t -i :${port} 2>/dev/null || true`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      })
        .trim();
      if (!out) return;
      const pids = Array.from(new Set(out.split(/\s+/).filter(Boolean)));
      for (const pid of pids) {
        try {
          execSync(`kill ${pid}`, { stdio: "ignore" });
        } catch {}
      }
      // Grace then hard kill if still present
      try {
        const out2 = execSync(`lsof -t -i :${port} 2>/dev/null || true`, {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        })
          .trim();
        const pids2 = Array.from(new Set(out2.split(/\s+/).filter(Boolean)));
        for (const pid of pids2) {
          try {
            execSync(`kill -9 ${pid}`, { stdio: "ignore" });
          } catch {}
        }
      } catch {}
    } catch {}
  }

  private async startAuto(g: number): Promise<void> {
    if (this.ownership === "external" && this.process === null) {
      const alreadyExternalConnected =
        this.state === "connected" && this.ownership === "external" && this.process === null;
      if (!alreadyExternalConnected) this.setState("starting");
      const res = await this.waitForHealth();
      if (g !== this.gen) return;
      if (res.ok) {
        this.version = res.version;
        this.setState("connected");
      } else {
        this.setState("failed", "Agent not responding", "health check failed after external");
      }
      return;
    }
    if (this.isRunning()) {
      const res = await this.waitForHealth();
      if (g !== this.gen) return;
      if (res.ok) {
        this.version = res.version;
        this.ownership = this.hasManagedProcess() ? "managed" : "external";
        this.setState("connected");
      }
      return;
    }
    const res = await this.waitForHealth();
    if (g !== this.gen) return;
    if (res.ok) {
      this.version = res.version;
      this.ownership = this.hasManagedProcess() ? "managed" : "external";
      this.setState("connected");
      return;
    }
    return this.startSpawn(true);
  }

  private isLoopback(baseUrl: string): boolean {
    try {
      const h = new URL(baseUrl).hostname;
      return h === "127.0.0.1" || h === "localhost" || h === "::1";
    } catch {
      return false;
    }
  }

  private async startSpawn(allowDaemon: boolean): Promise<void> {
    this.stopRequested = false;
    this.daemonCandidate = false;

    const fs = await import("fs/promises");
    try {
      await fs.access(this.scriptPath);
    } catch {
      const err = `Agent script not found: ${this.scriptPath}`;
      this.out.appendLine(`[AgentProcessManager] ${err}`);
      this.setState("failed", err, err);
      throw new Error(err);
    }

    this.setState("starting");
    this.out.appendLine(`[AgentProcessManager] spawning: ${this.scriptPath} (cwd=${this.cwd})`);

    const startGen = this.gen;
    return new Promise((resolve, reject) => {
      let settled = false;
      const doneOk = () => {
        if (!settled) {
          settled = true;
          resolve();
        }
      };
      const doneErr = (e: unknown) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };

      const spawnTime = Date.now();
      const proc = child_process.spawn(this.scriptPath, [], {
        cwd: this.cwd,
        shell: true,
        env: {
          ...process.env,
          ADJUTORIX_HOST: this.hostFromBaseUrl(this.baseUrl),
          ADJUTORIX_PORT: this.portFromBaseUrl(this.baseUrl),
        },
      });

      this.process = proc;

      proc.stdout?.on("data", (chunk: Buffer) => {
        this.out.append(chunk.toString());
      });
      proc.stderr?.on("data", (chunk: Buffer) => {
        this.out.append(chunk.toString());
      });

      proc.on("error", (err) => {
        if (startGen !== this.gen) {
          doneOk();
          return;
        }
        if (settled) return;
        const raw = rawMessage(err);
        this.out.appendLine(`[AgentProcessManager] process error: ${raw}`);
        this.setState("failed", classifyError(err), raw);
        this.process = null;
        doneErr(err);
      });

      proc.on("exit", (code, signal) => {
        if (startGen !== this.gen) {
          doneOk();
          return;
        }
        this.process = null;
        if (this.stopRequested) {
          this.setState("stopped");
          return;
        }
        if (Date.now() - spawnTime < DAEMON_EXIT_GRACE_MS) {
          if (!allowDaemon) {
            this.out.appendLine(`[AgentProcessManager] ${MANAGED_DAEMON_MSG}`);
            this.setState("failed", MANAGED_DAEMON_MSG, "daemon exit");
            doneErr(new Error(MANAGED_DAEMON_MSG));
            return;
          }
          this.out.appendLine("[AgentProcessManager] script exited quickly (daemon?); health check will decide");
          this.daemonCandidate = true;
          return;
        }
        if (this.state === "starting" || this.state === "connected") {
          const msg = code != null ? `exit ${code}` : `signal ${signal}`;
          this.out.appendLine(`[AgentProcessManager] process exited: ${msg}`);
          this.setState("failed", `Process exited: ${msg}`, msg);
        } else {
          this.setState("stopped");
        }
      });

      this.waitForHealth()
        .then((res) => {
          if (startGen !== this.gen) {
            doneOk();
            return;
          }
          if (settled) return;
          if (this.stopRequested) {
            doneOk();
            return;
          }
          if (res.ok) {
            this.version = res.version;
            if (this.process === null && this.daemonCandidate) {
              if (!allowDaemon) {
                this.setState("failed", MANAGED_DAEMON_MSG, "daemon exit");
                doneErr(new Error(MANAGED_DAEMON_MSG));
                return;
              }
              this.ownership = "external";
              const port = this.portFromBaseUrl(this.baseUrl);
              this.out.appendLine(
                `[AgentProcessManager] agent reachable without process → ownership=${this.ownership}`
              );
              this.out.appendLine(`[AgentProcessManager] reachable at ${this.baseUrl} (port ${port})`);
              this.setState("connected");
              doneOk();
              return;
            }
            if (this.process === null && !allowDaemon) {
              this.setState("failed", MANAGED_DAEMON_MSG, "daemon exit");
              doneErr(new Error(MANAGED_DAEMON_MSG));
              return;
            }
            this.ownership = "managed";
            this.setState("connected");
            doneOk();
          } else {
            const raw = "Health check timeout";
            this.setState("failed", classifyError(new Error(raw)), raw);
            this.stop();
            doneErr(new Error(raw));
          }
        })
        .catch((err) => {
          if (startGen !== this.gen) {
            doneOk();
            return;
          }
          if (settled) return;
          this.setState("failed", classifyError(err), rawMessage(err));
          this.stop();
          doneErr(err);
        });
    });
  }

  private hostFromBaseUrl(baseUrl: string): string {
    try {
      const u = new URL(baseUrl);
      return u.hostname || "127.0.0.1";
    } catch {
      return "127.0.0.1";
    }
  }

  private portFromBaseUrl(baseUrl: string): string {
    try {
      const u = new URL(baseUrl);
      if (u.port) return u.port;
      return DEFAULT_PORT;
    } catch {
      return DEFAULT_PORT;
    }
  }

  /** Side-effect-free: returns result only; callers assign this.version in guarded blocks. */
  private async waitForHealth(): Promise<{ ok: true; version?: string } | { ok: false }> {
    for (let i = 0; i < HEALTH_RETRIES; i++) {
      try {
        const data = await fetchHealth(this.baseUrl);
        return { ok: true, version: data.version };
      } catch {
        await new Promise((r) => setTimeout(r, HEALTH_POLL_MS));
      }
    }
    return { ok: false };
  }

  /**
   * Stop the agent process (SIGTERM then SIGKILL). Captures process reference
   * so SIGKILL runs even after we null out this.process.
   * Invalidates any in-flight start so a subsequent Start is a fresh attempt.
   */
  stop(): void {
    this.invalidateStartLatch();
    if (this.ownership === "external") {
      const wasConnected = this.state === "connected";
      this.setState("stopped");
      if (wasConnected && this.mode !== "managed") {
        const port = this.portFromBaseUrl(this.baseUrl);
        this.out.appendLine(`[external] Agent is external at ${this.baseUrl}`);
        this.out.appendLine(`[external] To stop: lsof -t -i :${port} | xargs kill -9`);
        vscode.window.showInformationMessage(
          "Agent is external. See Output → Adjutorix for stop instructions."
        );
      }
      return;
    }
    const proc = this.process;
    if (!proc) {
      this.setState("stopped");
      return;
    }
    const seq = this.nextStopTimerEpoch();
    this.stopRequested = true;
    this.setState("stopping");
    this.out.appendLine("[AgentProcessManager] stopping process");
    this.process = null;

    try {
      proc.kill("SIGTERM");
    } catch (e) {
      this.out.appendLine(`[AgentProcessManager] SIGTERM error: ${e}`);
    }

    setTimeout(() => {
      if (seq !== this.stopTimerEpoch) return;
      if (this.state !== "stopping") return;
      try {
        if (!proc.killed) proc.kill("SIGKILL");
      } catch (e) {
        this.out.appendLine(`[AgentProcessManager] SIGKILL error: ${e}`);
      }
      this.setState("stopped");
    }, 3000);
  }

  /**
   * Restart: stop then start.
   */
  async restart(): Promise<void> {
    this.stop();
    await new Promise((r) => setTimeout(r, 1500));
    await this.start();
  }

  /**
   * Ping via authenticated RPC (POST /rpc, method "ping"). Connected = RPC ping OK.
   * No /health for liveness; if RPC ping fails → disconnected/failed.
   */
  async ping(): Promise<boolean> {
    const rpcUrl = `${this.baseUrl}/rpc`;
    try {
      const res = await postJsonRpc(rpcUrl, {
        jsonrpc: "2.0",
        id: 1,
        method: "ping",
        params: {},
      });
      const result = res.result as { ok?: boolean; engine?: { fingerprint?: string; version?: string } } | undefined;
      if (!result || !result.ok) {
        if (this.state === "connected") {
          this.setState("failed", "Agent RPC ping failed", "ping result not ok");
        }
        return false;
      }
      this.lastPingAt = Date.now();
      this.version = result.engine?.fingerprint ?? result.engine?.version ?? "";
      // successful ping: clear warning, keep failures unless we explicitly recover below
      this.warning = undefined;
      this.warningRaw = undefined;

      // Ownership inference (fact)
      if (this.mode === "external") this.ownership = "external";
      else if (this.hasManagedProcess()) this.ownership = "managed";
      else this.ownership = "external";

      // Managed-mode policy (not connectivity failure)
      if (this.mode === "managed" && !this.hasManagedProcess()) {
        this.warning =
          "External agent detected while mode=Managed (switch to Auto/External or click Retry to take over).";
        this.warningRaw = "managed policy: ping ok but no child process";
      }
      // Recovery policy:
      // - FAILED stays sticky in managed/auto (requires explicit Retry).
      // - STOPPED is not sticky: if ping succeeds, we can show connected (especially in auto, where we don't own lifecycle).
      const canRecoverFromStopped =
        this.state === "stopped" && (this.mode === "external" || this.mode === "auto");

      const canRecoverFromFailed =
        this.state === "failed" && this.mode === "external"; // only external may clear FAILED via ping

      if (canRecoverFromStopped || canRecoverFromFailed) {
        // recovery means prior failure is no longer true
        this.lastError = undefined;
        this.lastErrorRaw = undefined;
        this.setState("connected");
      } else {
        this.emitStatus();
      }
      return true;
    } catch (err) {
      if (this.state === "connected") {
        this.setState("failed", classifyError(err), rawMessage(err));
      }
      return false;
    }
  }
}
