import crypto from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * ADJUTORIX APP — MAIN / AGENT / agent_reconnect.ts
 *
 * Canonical reconnection orchestrator for the Adjutorix agent.
 *
 * Purpose:
 * - coordinate reconnect behavior across process supervision, auth refresh, client probes,
 *   and health degradation without duplicating retry logic in multiple modules
 * - impose explicit retry/backoff/jitter/escalation semantics
 * - distinguish recoverable transient failures from hard-stop conditions
 * - expose deterministic reconnect state, attempts, schedules, and audit artifacts
 *
 * Scope:
 * - transport reconnect attempts after probe/RPC failures
 * - optional auth refresh on auth-related failures
 * - optional process restart escalation when client reconnect alone is insufficient
 * - bounded retry windows and cooldown phases
 * - user-visible state transitions for diagnostics and UI
 *
 * Hard invariants:
 * - at most one scheduled reconnect attempt exists at a time per orchestrator instance
 * - reconnect policy is explicit, bounded, and auditable
 * - identical observable state yields identical snapshot hashes
 * - fatal stop conditions suppress further retries immediately
 * - reconnect orchestration is timer-safe: stop()/dispose() clear pending work
 * - reconnect decisions are serialization-stable and side-effect boundaries are explicit
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

export type AgentReconnectHealth = "idle" | "scheduled" | "reconnecting" | "cooldown" | "suspended" | "stopped" | "error";
export type AgentReconnectFailureKind =
  | "transport"
  | "timeout"
  | "http"
  | "auth"
  | "protocol"
  | "rpc"
  | "invalid-response"
  | "process-exit"
  | "probe"
  | "manual";

export type AgentReconnectAction =
  | "schedule"
  | "attempt"
  | "success"
  | "failure"
  | "auth_refresh"
  | "process_restart"
  | "suspend"
  | "resume"
  | "stop"
  | "dispose";

export type AgentReconnectTrigger = {
  kind: AgentReconnectFailureKind;
  atMs: number;
  message: string;
  detail: Record<string, JsonValue>;
};

export type AgentReconnectAttemptRecord = {
  attempt: number;
  startedAtMs: number;
  endedAtMs: number | null;
  triggerKind: AgentReconnectFailureKind;
  authRefreshTried: boolean;
  processRestartTried: boolean;
  success: boolean;
  message: string;
};

export type AgentReconnectState = {
  health: AgentReconnectHealth;
  enabled: boolean;
  suspended: boolean;
  stopped: boolean;
  activeAttempt: number;
  totalAttempts: number;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  lastTrigger: AgentReconnectTrigger | null;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  nextAttemptAtMs: number | null;
  lastAttempt: AgentReconnectAttemptRecord | null;
  history: AgentReconnectAttemptRecord[];
};

export type AgentReconnectSnapshot = {
  schema: 1;
  policy: {
    enabled: boolean;
    maxAttempts: number;
    baseBackoffMs: number;
    maxBackoffMs: number;
    authRefreshOnAuthFailure: boolean;
    restartProcessAfterFailures: number;
    cooldownMs: number;
    jitterRatio: number;
  };
  state: AgentReconnectState;
  hash: string;
};

export type AgentReconnectPolicy = {
  enabled: boolean;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  authRefreshOnAuthFailure: boolean;
  restartProcessAfterFailures: number;
  cooldownMs: number;
  jitterRatio: number;
  historyLimit: number;
  resetFailureCountAfterSuccessMs: number;
};

export type AgentReconnectRuntime = {
  probeHealth: () => Promise<{ ok: boolean; message?: string }>;
  refreshAuth?: () => Promise<{ ok: boolean; message?: string }>;
  restartProcess?: () => Promise<{ ok: boolean; message?: string }>;
};

export type AgentReconnectAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: AgentReconnectAction;
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AgentReconnectAuditFn = (record: AgentReconnectAuditRecord) => void;

export type AgentReconnectHooks = {
  onScheduled?: (snapshot: AgentReconnectSnapshot) => Promise<void> | void;
  onSuccess?: (snapshot: AgentReconnectSnapshot) => Promise<void> | void;
  onFailure?: (snapshot: AgentReconnectSnapshot) => Promise<void> | void;
  onSuspended?: (snapshot: AgentReconnectSnapshot) => Promise<void> | void;
};

export type AgentReconnectOptions = {
  runtime: AgentReconnectRuntime;
  policy?: Partial<AgentReconnectPolicy>;
  audit?: AgentReconnectAuditFn;
  hooks?: AgentReconnectHooks;
  now?: () => number;
  random?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: AgentReconnectPolicy = {
  enabled: true,
  maxAttempts: 8,
  baseBackoffMs: 500,
  maxBackoffMs: 30_000,
  authRefreshOnAuthFailure: true,
  restartProcessAfterFailures: 3,
  cooldownMs: 10_000,
  jitterRatio: 0.15,
  historyLimit: 128,
  resetFailureCountAfterSuccessMs: 5 * 60 * 1000,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:agent:agent_reconnect:${message}`);
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

function snapshotHash(core: Omit<AgentReconnectSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<AgentReconnectAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function boundedBackoff(attempt: number, policy: AgentReconnectPolicy, random?: () => number): number {
  const exp = Math.min(policy.maxBackoffMs, policy.baseBackoffMs * Math.pow(2, Math.max(0, attempt - 1)));
  const jitterBase = random ? random() : 0.5;
  const jitter = exp * policy.jitterRatio * (jitterBase * 2 - 1);
  return Math.max(0, Math.floor(exp + jitter));
}

async function maybeCall<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// ORCHESTRATOR
// -----------------------------------------------------------------------------

export class AgentReconnectOrchestrator extends EventEmitter {
  private readonly runtime: AgentReconnectRuntime;
  private readonly policy: AgentReconnectPolicy;
  private readonly audit?: AgentReconnectAuditFn;
  private readonly hooks?: AgentReconnectHooks;
  private readonly now?: () => number;
  private readonly random?: () => number;

  private timer: NodeJS.Timeout | null = null;
  private disposed = false;
  private state: AgentReconnectState = {
    health: "idle",
    enabled: true,
    suspended: false,
    stopped: false,
    activeAttempt: 0,
    totalAttempts: 0,
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
    lastTrigger: null,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    nextAttemptAtMs: null,
    lastAttempt: null,
    history: [],
  };

  constructor(options: AgentReconnectOptions) {
    super();
    this.runtime = options.runtime;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.hooks = options.hooks;
    this.now = options.now;
    this.random = options.random;
    this.state.enabled = this.policy.enabled;
  }

  snapshot(): AgentReconnectSnapshot {
    const core: Omit<AgentReconnectSnapshot, "hash"> = {
      schema: 1,
      policy: {
        enabled: this.policy.enabled,
        maxAttempts: this.policy.maxAttempts,
        baseBackoffMs: this.policy.baseBackoffMs,
        maxBackoffMs: this.policy.maxBackoffMs,
        authRefreshOnAuthFailure: this.policy.authRefreshOnAuthFailure,
        restartProcessAfterFailures: this.policy.restartProcessAfterFailures,
        cooldownMs: this.policy.cooldownMs,
        jitterRatio: this.policy.jitterRatio,
      },
      state: JSON.parse(stableJson(this.state)) as AgentReconnectState,
    };

    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  schedule(trigger: AgentReconnectTrigger): void {
    this.assertNotDisposed();

    if (!this.policy.enabled || this.state.stopped) {
      this.emitAudit("schedule", "deny", "reconnect_disabled_or_stopped", {
        triggerKind: trigger.kind,
      });
      return;
    }

    if (this.state.suspended) {
      this.emitAudit("schedule", "deny", "reconnect_suspended", {
        triggerKind: trigger.kind,
      });
      return;
    }

    if (this.timer) {
      this.emitAudit("schedule", "deny", "reconnect_already_scheduled", {
        triggerKind: trigger.kind,
        nextAttemptAtMs: this.state.nextAttemptAtMs,
      });
      return;
    }

    this.resetFailureCountIfStale();

    const nextAttemptNumber = this.state.consecutiveFailures + 1;
    if (nextAttemptNumber > this.policy.maxAttempts) {
      this.suspend("max_attempts_exceeded", { triggerKind: trigger.kind, attempts: nextAttemptNumber });
      return;
    }

    const delayMs = boundedBackoff(nextAttemptNumber, this.policy, this.random);
    const at = nowMs(this.now) + delayMs;

    this.state.health = "scheduled";
    this.state.lastTrigger = trigger;
    this.state.nextAttemptAtMs = at;

    this.timer = setTimeout(() => {
      void this.runAttempt(trigger);
    }, delayMs);

    this.emitAudit("schedule", "allow", "reconnect_scheduled", {
      triggerKind: trigger.kind,
      delayMs,
      nextAttemptAtMs: at,
      nextAttemptNumber,
    });
    void maybeCall(this.hooks?.onScheduled, this.snapshot());
    this.emit("scheduled", this.snapshot());
  }

  async force(trigger: AgentReconnectTrigger): Promise<void> {
    this.assertNotDisposed();
    this.clearTimer();
    await this.runAttempt(trigger);
  }

  suspend(reason = "manual_suspend", detail: Record<string, JsonValue> = {}): void {
    this.assertNotDisposed();
    this.clearTimer();
    this.state.suspended = true;
    this.state.health = "suspended";
    this.state.nextAttemptAtMs = null;
    this.emitAudit("suspend", "allow", reason, detail);
    void maybeCall(this.hooks?.onSuspended, this.snapshot());
    this.emit("suspended", this.snapshot());
  }

  resume(): void {
    this.assertNotDisposed();
    this.state.suspended = false;
    this.state.health = this.state.stopped ? "stopped" : "idle";
    this.emitAudit("resume", "allow", "reconnect_resumed", {});
    this.emit("resumed", this.snapshot());
  }

  stop(reason = "manual_stop"): void {
    this.assertNotDisposed();
    this.clearTimer();
    this.state.stopped = true;
    this.state.health = "stopped";
    this.state.nextAttemptAtMs = null;
    this.emitAudit("stop", "allow", reason, {});
    this.emit("stopped", this.snapshot());
  }

  dispose(): void {
    if (this.disposed) return;
    this.clearTimer();
    this.disposed = true;
    this.state.stopped = true;
    this.state.health = "stopped";
    this.emitAudit("dispose", "allow", "reconnect_disposed", {});
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private assertNotDisposed(): void {
    assert(!this.disposed, "orchestrator_disposed");
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private resetFailureCountIfStale(): void {
    if (!this.state.lastSuccessAtMs) return;
    const age = nowMs(this.now) - this.state.lastSuccessAtMs;
    if (age >= this.policy.resetFailureCountAfterSuccessMs) {
      this.state.consecutiveFailures = 0;
      this.state.consecutiveAuthFailures = 0;
    }
  }

  private async runAttempt(trigger: AgentReconnectTrigger): Promise<void> {
    this.clearTimer();
    if (this.state.stopped || this.state.suspended || !this.policy.enabled) return;

    const startedAtMs = nowMs(this.now);
    const attemptNo = this.state.consecutiveFailures + 1;
    this.state.activeAttempt = attemptNo;
    this.state.totalAttempts += 1;
    this.state.health = "reconnecting";
    this.state.nextAttemptAtMs = null;

    let authRefreshTried = false;
    let processRestartTried = false;
    let success = false;
    let message = "reconnect_failed";

    this.emitAudit("attempt", "allow", "reconnect_attempt_started", {
      attempt: attemptNo,
      triggerKind: trigger.kind,
    });

    try {
      if (trigger.kind === "auth" && this.policy.authRefreshOnAuthFailure && this.runtime.refreshAuth) {
        authRefreshTried = true;
        const authResult = await this.runtime.refreshAuth();
        this.emitAudit("auth_refresh", authResult.ok ? "allow" : "deny", authResult.ok ? "auth_refresh_ok" : "auth_refresh_failed", {
          attempt: attemptNo,
          message: authResult.message ?? null,
        });
        if (!authResult.ok) {
          this.state.consecutiveAuthFailures += 1;
        }
      }

      const probeResult = await this.runtime.probeHealth();
      success = probeResult.ok;
      message = probeResult.message ?? (success ? "reconnect_probe_ok" : "reconnect_probe_failed");

      if (!success && this.runtime.restartProcess && this.state.consecutiveFailures + 1 >= this.policy.restartProcessAfterFailures) {
        processRestartTried = true;
        const restart = await this.runtime.restartProcess();
        this.emitAudit("process_restart", restart.ok ? "allow" : "deny", restart.ok ? "process_restart_ok" : "process_restart_failed", {
          attempt: attemptNo,
          message: restart.message ?? null,
        });

        if (restart.ok) {
          const postRestartProbe = await this.runtime.probeHealth();
          success = postRestartProbe.ok;
          message = postRestartProbe.message ?? (success ? "reconnect_post_restart_ok" : "reconnect_post_restart_failed");
        }
      }
    } catch (error) {
      success = false;
      message = error instanceof Error ? error.message : String(error);
    }

    const record: AgentReconnectAttemptRecord = {
      attempt: attemptNo,
      startedAtMs,
      endedAtMs: nowMs(this.now),
      triggerKind: trigger.kind,
      authRefreshTried,
      processRestartTried,
      success,
      message,
    };

    this.state.lastAttempt = record;
    this.state.history.push(record);
    while (this.state.history.length > this.policy.historyLimit) {
      this.state.history.shift();
    }

    if (success) {
      this.state.health = "cooldown";
      this.state.consecutiveFailures = 0;
      this.state.consecutiveAuthFailures = 0;
      this.state.lastSuccessAtMs = nowMs(this.now);
      this.state.lastFailureAtMs = null;
      this.state.activeAttempt = 0;

      this.emitAudit("success", "allow", "reconnect_succeeded", {
        attempt: attemptNo,
        triggerKind: trigger.kind,
        authRefreshTried,
        processRestartTried,
      });
      await maybeCall(this.hooks?.onSuccess, this.snapshot());
      this.emit("success", this.snapshot());

      const cooldownUntil = nowMs(this.now) + this.policy.cooldownMs;
      this.state.nextAttemptAtMs = cooldownUntil;
      this.timer = setTimeout(() => {
        this.clearTimer();
        if (!this.state.stopped && !this.state.suspended) {
          this.state.health = "idle";
          this.state.nextAttemptAtMs = null;
          this.emit("idle", this.snapshot());
        }
      }, this.policy.cooldownMs);
      return;
    }

    this.state.health = "error";
    this.state.consecutiveFailures += 1;
    this.state.lastFailureAtMs = nowMs(this.now);
    this.state.activeAttempt = 0;

    this.emitAudit("failure", "deny", "reconnect_failed", {
      attempt: attemptNo,
      triggerKind: trigger.kind,
      authRefreshTried,
      processRestartTried,
      message,
      consecutiveFailures: this.state.consecutiveFailures,
    });
    await maybeCall(this.hooks?.onFailure, this.snapshot());
    this.emit("failure", this.snapshot());

    if (this.state.consecutiveFailures >= this.policy.maxAttempts) {
      this.suspend("reconnect_failure_budget_exhausted", {
        consecutiveFailures: this.state.consecutiveFailures,
        triggerKind: trigger.kind,
      });
      return;
    }

    this.schedule({
      kind: trigger.kind,
      atMs: nowMs(this.now),
      message,
      detail: {
        retriedFromAttempt: attemptNo,
      },
    });
  }

  private emitAudit(
    action: AgentReconnectAction,
    decision: "allow" | "deny",
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<AgentReconnectAuditRecord, "hash"> = {
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

export function createAgentReconnectOrchestrator(options: AgentReconnectOptions): AgentReconnectOrchestrator {
  return new AgentReconnectOrchestrator(options);
}

export function defaultAgentReconnectPolicy(): AgentReconnectPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateAgentReconnectSnapshot(snapshot: AgentReconnectSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<AgentReconnectSnapshot, "hash"> = {
    schema: snapshot.schema,
    policy: snapshot.policy,
    state: snapshot.state,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
