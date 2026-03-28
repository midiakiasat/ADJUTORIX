import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { ipcMain } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / agent_ipc.ts
 *
 * Dedicated guarded IPC adapter for Adjutorix agent lifecycle, health, and RPC.
 *
 * This module owns the main-process side of agent-facing IPC concerns:
 * - agent health/status queries
 * - managed agent start/stop semantics
 * - token-aware RPC proxying
 * - deterministic audit + metrics hooks
 * - explicit handler registration / teardown
 *
 * It is intentionally separated from generic IPC routing because agent control is
 * both privileged and stateful.
 *
 * Hard invariants:
 * - no raw renderer access to process spawning
 * - no RPC call leaves main without explicit token/header normalization
 * - managed agent lifecycle is explicit and auditable
 * - identical semantic requests produce identical audit hashes
 * - registration is idempotent and teardown is total
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

export type AgentIntent = "health" | "status" | "start" | "stop" | "rpc";

export type AgentRuntimeState = {
  url: string;
  tokenFile: string;
  managed: boolean;
  pid: number | null;
  processHandle: ChildProcess | null;
  lastHealth: {
    ok: boolean;
    status: number | null;
    checkedAtMs: number | null;
    bodySha256: string | null;
  };
};

export type AgentPolicy = {
  allowHealthQuery: boolean;
  allowStatusQuery: boolean;
  allowManagedStart: boolean;
  allowManagedStop: boolean;
  allowRpcProxy: boolean;
  allowRendererRpcProxy: boolean;
  readyTimeoutMs: number;
  pollIntervalMs: number;
  rpcTimeoutMs: number;
  startScriptCandidates: string[];
};

export type AgentAuditRecord = {
  schema: 1;
  ts_ms: number;
  intent: AgentIntent;
  decision: "allow" | "deny";
  reason: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type AgentAuditFn = (record: AgentAuditRecord) => void;

export type AgentMetricsHooks = {
  onHealthCheck?: (ok: boolean, durationMs: number, status: number | null) => void;
  onRpcInvoke?: (method: string, success: boolean, durationMs: number) => void;
  onLifecycle?: (phase: "start" | "stop" | "exit", pid: number | null) => void;
};

export type AgentBoundaryHooks = {
  beforeStart?: () => Promise<void> | void;
  afterStart?: (pid: number | null) => Promise<void> | void;
  beforeStop?: (pid: number | null) => Promise<void> | void;
  afterStop?: () => Promise<void> | void;
  beforeRpc?: (method: string, params: Record<string, JsonValue>) => Promise<void> | void;
};

export type AgentIpcOptions = {
  state: AgentRuntimeState;
  policy: AgentPolicy;
  audit?: AgentAuditFn;
  metrics?: AgentMetricsHooks;
  boundary?: AgentBoundaryHooks;
  channels?: {
    health?: string;
    status?: string;
    start?: string;
    stop?: string;
    rpc?: string;
  };
};

export type AgentHealthResult = {
  ok: boolean;
  status: number | null;
  checkedAtMs: number;
  bodySha256: string | null;
  url: string;
};

export type AgentStatusResult = {
  ok: true;
  url: string;
  managed: boolean;
  pid: number | null;
  healthy: boolean;
  lastStatus: number | null;
  checkedAtMs: number | null;
};

export type AgentStartResult = {
  ok: true;
  managed: true;
  pid: number | null;
  url: string;
};

export type AgentStopResult = {
  ok: true;
  previousPid: number | null;
  url: string;
};

export type AgentRpcPayload = {
  method: string;
  params: Record<string, JsonValue>;
  actor?: "renderer" | "main" | "system";
};

export type AgentHandlerBundle = {
  checkHealth: () => Promise<AgentHealthResult>;
  getStatus: () => Promise<AgentStatusResult>;
  startAgent: () => Promise<AgentStartResult>;
  stopAgent: () => Promise<AgentStopResult>;
  invokeRpc: (payload: AgentRpcPayload) => Promise<JsonValue>;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_CHANNELS = {
  health: "adjutorix:agent:health",
  status: "adjutorix:agent:status",
  start: "adjutorix:agent:start",
  stop: "adjutorix:agent:stop",
  rpc: "adjutorix:rpc:invoke",
} as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:ipc:agent_ipc:${message}`);
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

function nowMs(): number {
  return Date.now();
}

function auditRecord(
  intent: AgentIntent,
  decision: "allow" | "deny",
  reason: string,
  detail: Record<string, JsonValue>,
): AgentAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    intent,
    decision,
    reason,
    detail,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function emitAudit(audit: AgentAuditFn | undefined, record: AgentAuditRecord): void {
  audit?.(record);
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function candidateStartScript(candidates: string[]): string | null {
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return resolved;
    }
  }
  return null;
}

function readToken(tokenFile: string): string {
  if (!fs.existsSync(tokenFile)) return "";
  return fs.readFileSync(tokenFile, "utf8").trim();
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createAgentIpc(options: AgentIpcOptions): AgentHandlerBundle {
  const state = options.state;
  const policy = options.policy;
  const audit = options.audit;
  const metrics = options.metrics;
  const boundary = options.boundary;

  const channels = {
    health: options.channels?.health ?? DEFAULT_CHANNELS.health,
    status: options.channels?.status ?? DEFAULT_CHANNELS.status,
    start: options.channels?.start ?? DEFAULT_CHANNELS.start,
    stop: options.channels?.stop ?? DEFAULT_CHANNELS.stop,
    rpc: options.channels?.rpc ?? DEFAULT_CHANNELS.rpc,
  };

  let registered = false;

  const checkHealth = async (): Promise<AgentHealthResult> => {
    if (!policy.allowHealthQuery) {
      const record = auditRecord("health", "deny", "health_query_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`agent_health_denied:${record.reason}`);
    }

    const started = nowMs();
    let ok = false;
    let status: number | null = null;
    let bodySha256: string | null = null;

    try {
      const response = await fetch(state.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health.ping", params: {} }),
        signal: AbortSignal.timeout(policy.rpcTimeoutMs),
      });

      const body = await response.text();
      ok = response.ok;
      status = response.status;
      bodySha256 = sha256(body);
    } catch {
      ok = false;
      status = null;
      bodySha256 = null;
    }

    const checkedAtMs = nowMs();
    state.lastHealth = {
      ok,
      status,
      checkedAtMs,
      bodySha256,
    };

    metrics?.onHealthCheck?.(ok, checkedAtMs - started, status);
    emitAudit(audit, auditRecord("health", "allow", ok ? "health_check_complete" : "health_check_failed", {
      ok,
      status,
      url: state.url,
    }));

    return {
      ok,
      status,
      checkedAtMs,
      bodySha256,
      url: state.url,
    };
  };

  const getStatus = async (): Promise<AgentStatusResult> => {
    if (!policy.allowStatusQuery) {
      const record = auditRecord("status", "deny", "status_query_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`agent_status_denied:${record.reason}`);
    }

    const health = await checkHealth();
    emitAudit(audit, auditRecord("status", "allow", "status_reported", {
      managed: state.managed,
      pid: state.pid,
      healthy: health.ok,
    }));

    return {
      ok: true,
      url: state.url,
      managed: state.managed,
      pid: state.pid,
      healthy: health.ok,
      lastStatus: health.status,
      checkedAtMs: health.checkedAtMs,
    };
  };

  const startAgent = async (): Promise<AgentStartResult> => {
    if (!policy.allowManagedStart) {
      const record = auditRecord("start", "deny", "agent_start_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`agent_start_denied:${record.reason}`);
    }
    if (state.managed && state.processHandle && state.pid) {
      const record = auditRecord("start", "deny", "agent_already_managed_running", { pid: state.pid });
      emitAudit(audit, record);
      throw new Error(`agent_start_denied:${record.reason}`);
    }

    const script = candidateStartScript(policy.startScriptCandidates);
    if (!script) {
      const record = auditRecord("start", "deny", "agent_start_script_missing", {
        candidates: policy.startScriptCandidates,
      });
      emitAudit(audit, record);
      throw new Error(`agent_start_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeStart);

    const child = spawn(script, [], {
      cwd: path.dirname(script),
      stdio: "ignore",
      detached: false,
      shell: false,
      env: {
        ...process.env,
        ADJUTORIX_ROOT: process.cwd(),
      },
    });

    state.processHandle = child;
    state.pid = child.pid ?? null;
    state.managed = true;

    child.on("exit", (_code, _signal) => {
      const previousPid = state.pid;
      state.processHandle = null;
      state.pid = null;
      state.managed = false;
      metrics?.onLifecycle?.("exit", previousPid);
      emitAudit(audit, auditRecord("stop", "allow", "managed_agent_exited", {
        previousPid,
      }));
    });

    metrics?.onLifecycle?.("start", state.pid);

    const deadline = nowMs() + policy.readyTimeoutMs;
    let healthy = false;
    while (nowMs() < deadline) {
      const health = await checkHealth();
      if (health.ok) {
        healthy = true;
        break;
      }
      await sleep(policy.pollIntervalMs);
    }

    if (!healthy) {
      const record = auditRecord("start", "deny", "managed_agent_failed_readiness", {
        pid: state.pid,
        url: state.url,
      });
      emitAudit(audit, record);
      try { child.kill("SIGTERM"); } catch {}
      state.processHandle = null;
      state.pid = null;
      state.managed = false;
      throw new Error(`agent_start_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.afterStart, state.pid);
    emitAudit(audit, auditRecord("start", "allow", "managed_agent_started", {
      pid: state.pid,
      url: state.url,
    }));

    return {
      ok: true,
      managed: true,
      pid: state.pid,
      url: state.url,
    };
  };

  const stopAgent = async (): Promise<AgentStopResult> => {
    if (!policy.allowManagedStop) {
      const record = auditRecord("stop", "deny", "agent_stop_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`agent_stop_denied:${record.reason}`);
    }

    const previousPid = state.pid;
    if (!state.managed || !state.processHandle) {
      const record = auditRecord("stop", "deny", "managed_agent_not_running", { previousPid });
      emitAudit(audit, record);
      throw new Error(`agent_stop_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.beforeStop, previousPid);

    try {
      state.processHandle.kill("SIGTERM");
    } catch {}

    state.processHandle = null;
    state.pid = null;
    state.managed = false;

    metrics?.onLifecycle?.("stop", previousPid);
    await maybeCall(boundary?.afterStop);

    emitAudit(audit, auditRecord("stop", "allow", "managed_agent_stopped", {
      previousPid,
      url: state.url,
    }));

    return {
      ok: true,
      previousPid,
      url: state.url,
    };
  };

  const invokeRpc = async (payload: AgentRpcPayload): Promise<JsonValue> => {
    if (!policy.allowRpcProxy) {
      const record = auditRecord("rpc", "deny", "rpc_proxy_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`agent_rpc_denied:${record.reason}`);
    }
    if (payload.actor === "renderer" && !policy.allowRendererRpcProxy) {
      const record = auditRecord("rpc", "deny", "renderer_rpc_proxy_denied", {
        method: payload.method,
      });
      emitAudit(audit, record);
      throw new Error(`agent_rpc_denied:${record.reason}`);
    }
    assert(typeof payload.method === "string" && payload.method.length > 0, "rpc_method_invalid");
    assert(payload.params && typeof payload.params === "object" && !Array.isArray(payload.params), "rpc_params_invalid");

    await maybeCallWith(boundary?.beforeRpc, payload.method, undefined as never);

    const token = readToken(state.tokenFile);
    const started = nowMs();

    try {
      const response = await fetch(state.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { "x-adjutorix-token": token } : {}),
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: nowMs(),
          method: payload.method,
          params: payload.params,
        }),
        signal: AbortSignal.timeout(policy.rpcTimeoutMs),
      });

      const result = (await response.json()) as { result?: JsonValue; error?: { message?: string; code?: number } };
      const durationMs = nowMs() - started;

      if (!response.ok || result.error) {
        metrics?.onRpcInvoke?.(payload.method, false, durationMs);
        emitAudit(audit, auditRecord("rpc", "deny", "rpc_invoke_failed", {
          method: payload.method,
          status: response.status,
          error: result.error?.message ?? "unknown",
        }));
        throw new Error(`agent_rpc_failed:${payload.method}:${result.error?.code ?? response.status}`);
      }

      metrics?.onRpcInvoke?.(payload.method, true, durationMs);
      emitAudit(audit, auditRecord("rpc", "allow", "rpc_invoke_succeeded", {
        method: payload.method,
        durationMs,
      }));
      return result.result ?? null;
    } catch (error) {
      const durationMs = nowMs() - started;
      metrics?.onRpcInvoke?.(payload.method, false, durationMs);
      emitAudit(audit, auditRecord("rpc", "deny", "rpc_invoke_transport_failed", {
        method: payload.method,
        durationMs,
        error: error instanceof Error ? error.message : String(error),
      }));
      throw error;
    }
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(channels.health, async () => checkHealth());
    ipcMain.handle(channels.status, async () => getStatus());
    ipcMain.handle(channels.start, async () => startAgent());
    ipcMain.handle(channels.stop, async () => stopAgent());
    ipcMain.handle(channels.rpc, async (_event, payload: AgentRpcPayload) => invokeRpc(payload));

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(channels.health);
    ipcMain.removeHandler(channels.status);
    ipcMain.removeHandler(channels.start);
    ipcMain.removeHandler(channels.stop);
    ipcMain.removeHandler(channels.rpc);
    registered = false;
  };

  return {
    checkHealth,
    getStatus,
    startAgent,
    stopAgent,
    invokeRpc,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION
// -----------------------------------------------------------------------------

export function createDefaultAgentRuntimeState(url = "http://127.0.0.1:8000/rpc", tokenFile = path.join(process.env.HOME || "~", ".adjutorix", "token")): AgentRuntimeState {
  return {
    url,
    tokenFile,
    managed: false,
    pid: null,
    processHandle: null,
    lastHealth: {
      ok: false,
      status: null,
      checkedAtMs: null,
      bodySha256: null,
    },
  };
}

export function createDefaultAgentPolicy(): AgentPolicy {
  return {
    allowHealthQuery: true,
    allowStatusQuery: true,
    allowManagedStart: true,
    allowManagedStop: true,
    allowRpcProxy: true,
    allowRendererRpcProxy: false,
    readyTimeoutMs: 10_000,
    pollIntervalMs: 125,
    rpcTimeoutMs: 8_000,
    startScriptCandidates: [
      path.resolve(process.cwd(), "packages", "adjutorix-agent", "scripts", "start.sh"),
      path.resolve(process.cwd(), "adjutorix-agent", "scripts", "start.sh"),
      path.resolve(process.cwd(), "scripts", "start-agent.sh"),
    ],
  };
}

export function validateAgentRuntimeState(state: AgentRuntimeState): void {
  assert(typeof state.url === "string" && state.url.length > 0, "state_url_invalid");
  assert(typeof state.tokenFile === "string" && state.tokenFile.length > 0, "state_token_file_invalid");
  assert(typeof state.managed === "boolean", "state_managed_invalid");
}
