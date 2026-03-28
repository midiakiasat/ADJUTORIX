import crypto from "node:crypto";
import { ipcMain } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / verify_ipc.ts
 *
 * Dedicated verification IPC adapter for the Electron main process.
 *
 * Responsibilities:
 * - normalize and validate verify run / verify status IPC payloads
 * - create deterministic verification jobs and track local status mirrors
 * - bind verification outcomes to preview lineage hashes explicitly
 * - integrate with governed patch flow through verify-result callbacks
 * - expose explicit registration/teardown of verify IPC handlers
 * - emit structured audit records for each step in the verification lifecycle
 *
 * Hard invariants:
 * - verification jobs are explicit objects with stable ids and statuses
 * - preview lineage binding is hash-based, never implicit
 * - status queries never mutate verification state except bounded refresh
 * - identical semantic verify submissions produce identical request hashes
 * - final pass/fail state is terminal and monotonic
 * - registration and teardown are idempotent and total
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

export type VerifyActor = "renderer" | "menu" | "main" | "system";
export type VerifyStatus = "queued" | "running" | "passed" | "failed" | "cancelled";
export type VerifyIntent = "run" | "status" | "bind_result" | "clear";

export type VerifyRunPayload = {
  targets: string[];
  previewHash?: string;
  actor?: VerifyActor;
  trace_id?: string;
};

export type VerifyStatusPayload = {
  verifyId?: string;
  verify_id?: string;
};

export type VerifyResultBindingPayload = {
  verifyId: string;
  passed: boolean;
  summary?: Record<string, JsonValue>;
};

export type VerifyJob = {
  schema: 1;
  verifyId: string;
  requestHash: string;
  actor: VerifyActor;
  targets: string[];
  previewHash: string | null;
  status: VerifyStatus;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  summary: Record<string, JsonValue> | null;
};

export type VerifyRuntimeState = {
  jobs: Record<string, VerifyJob>;
  latestVerifyId: string | null;
  latestPassedPreviewHash: string | null;
};

export type VerifyPolicy = {
  allowRun: boolean;
  allowStatus: boolean;
  requireTargets: boolean;
  allowEmptyTargetsWhenPreviewBound: boolean;
  maxTargets: number;
  maxTargetLength: number;
};

export type VerifyAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: VerifyIntent;
  decision: "allow" | "deny";
  reason: string;
  verifyId?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type VerifyAuditFn = (record: VerifyAuditRecord) => void;

export type VerifyBoundaryHooks = {
  beforeRun?: (job: VerifyJob) => Promise<void> | void;
  afterRun?: (job: VerifyJob, result: JsonValue) => Promise<void> | void;
  beforeStatus?: (verifyId: string) => Promise<void> | void;
  afterBindResult?: (job: VerifyJob) => Promise<void> | void;
};

export type VerifyExecutionHandlers = {
  run: (job: VerifyJob) => Promise<JsonValue>;
  status?: (job: VerifyJob) => Promise<Partial<Pick<VerifyJob, "status" | "summary" | "startedAtMs" | "finishedAtMs">>>;
};

export type VerifyLineageHooks = {
  onPreviewVerified?: (previewHash: string, verifyId: string) => Promise<void> | void;
  onPreviewFailed?: (previewHash: string, verifyId: string) => Promise<void> | void;
};

export type VerifyIpcOptions = {
  state: VerifyRuntimeState;
  policy: VerifyPolicy;
  handlers: VerifyExecutionHandlers;
  audit?: VerifyAuditFn;
  boundary?: VerifyBoundaryHooks;
  lineage?: VerifyLineageHooks;
  channels?: {
    run?: string;
    status?: string;
    bindResult?: string;
    clear?: string;
  };
};

export type VerifyRunResult = {
  ok: true;
  verifyId: string;
  requestHash: string;
  status: VerifyStatus;
  previewHash: string | null;
  targets: string[];
  result: JsonValue;
};

export type VerifyStatusResult = {
  ok: true;
  verifyId: string;
  status: VerifyStatus;
  previewHash: string | null;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  summary: Record<string, JsonValue> | null;
};

export type VerifyHandlerBundle = {
  runVerify: (payload: VerifyRunPayload) => Promise<VerifyRunResult>;
  getVerifyStatus: (payload: VerifyStatusPayload) => Promise<VerifyStatusResult>;
  bindVerifyResult: (payload: VerifyResultBindingPayload) => Promise<void>;
  clearVerifyState: () => void;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_CHANNELS = {
  run: "adjutorix:verify:run",
  status: "adjutorix:verify:status",
  bindResult: "adjutorix:verify:bindResult",
  clear: "adjutorix:verify:clearState",
} as const;

const TERMINAL_VERIFY_STATES: VerifyStatus[] = ["passed", "failed", "cancelled"];

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:ipc:verify_ipc:${message}`);
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowMs(): number {
  return Date.now();
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    assert(Number.isFinite(value), "non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    return out;
  }
  return String(value);
}

function normalizeTargets(targets: unknown, maxTargets: number, maxTargetLength: number): string[] {
  assert(Array.isArray(targets), "targets_invalid");
  const normalized = [...new Set(targets.map((target) => {
    assert(typeof target === "string" && target.trim().length > 0, "target_invalid");
    const clean = target.trim();
    assert(clean.length <= maxTargetLength, "target_too_long");
    return clean;
  }))].sort((a, b) => a.localeCompare(b));

  assert(normalized.length <= maxTargets, "too_many_targets");
  return normalized;
}

function requestHash(actor: VerifyActor, targets: string[], previewHash: string | null): string {
  return sha256(stableJson({ schema: 1, actor, targets, previewHash }));
}

function verifyId(hash: string): string {
  return `verify_${hash.slice(0, 20)}`;
}

function auditRecord(
  action: VerifyIntent,
  decision: "allow" | "deny",
  reason: string,
  detail: Record<string, JsonValue>,
  verifyIdValue?: string,
): VerifyAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    action,
    decision,
    reason,
    ...(verifyIdValue ? { verifyId: verifyIdValue } : {}),
    detail,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function emitAudit(audit: VerifyAuditFn | undefined, record: VerifyAuditRecord): void {
  audit?.(record);
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

function isTerminal(status: VerifyStatus): boolean {
  return TERMINAL_VERIFY_STATES.includes(status);
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createVerifyIpc(options: VerifyIpcOptions): VerifyHandlerBundle {
  const state = options.state;
  const policy = options.policy;
  const handlers = options.handlers;
  const audit = options.audit;
  const boundary = options.boundary;
  const lineage = options.lineage;

  const channels = {
    run: options.channels?.run ?? DEFAULT_CHANNELS.run,
    status: options.channels?.status ?? DEFAULT_CHANNELS.status,
    bindResult: options.channels?.bindResult ?? DEFAULT_CHANNELS.bindResult,
    clear: options.channels?.clear ?? DEFAULT_CHANNELS.clear,
  };

  let registered = false;

  const runVerify = async (payload: VerifyRunPayload): Promise<VerifyRunResult> => {
    if (!policy.allowRun) {
      const record = auditRecord("run", "deny", "verify_run_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`verify_run_denied:${record.reason}`);
    }

    const actor: VerifyActor = payload.actor ?? "renderer";
    const targets = normalizeTargets(payload.targets, policy.maxTargets, policy.maxTargetLength);
    const previewHash = payload.previewHash ?? null;

    if (policy.requireTargets && targets.length === 0 && !(policy.allowEmptyTargetsWhenPreviewBound && previewHash)) {
      const record = auditRecord("run", "deny", "verify_targets_required", {
        previewHash,
      });
      emitAudit(audit, record);
      throw new Error(`verify_run_denied:${record.reason}`);
    }

    const reqHash = requestHash(actor, targets, previewHash);
    const id = verifyId(reqHash);

    const existing = state.jobs[id];
    if (existing) {
      emitAudit(audit, auditRecord("run", "allow", "verify_job_reused", {
        status: existing.status,
      }, existing.verifyId));
      return {
        ok: true,
        verifyId: existing.verifyId,
        requestHash: existing.requestHash,
        status: existing.status,
        previewHash: existing.previewHash,
        targets: existing.targets,
        result: normalizeJson(existing.summary ?? {}),
      };
    }

    const job: VerifyJob = {
      schema: 1,
      verifyId: id,
      requestHash: reqHash,
      actor,
      targets,
      previewHash,
      status: "queued",
      createdAtMs: nowMs(),
      startedAtMs: null,
      finishedAtMs: null,
      summary: null,
    };

    state.jobs[id] = job;
    state.latestVerifyId = id;

    await maybeCallWith(boundary?.beforeRun, job);

    job.status = "running";
    job.startedAtMs = nowMs();
    const executionResult = normalizeJson(await handlers.run(job));

    if (!isTerminal(job.status)) {
      job.summary = executionResult && typeof executionResult === "object" && !Array.isArray(executionResult)
        ? (executionResult as Record<string, JsonValue>)
        : { result: executionResult };
    }

    await maybeCallWith(boundary?.afterRun, job, undefined as never);

    emitAudit(audit, auditRecord("run", "allow", "verify_job_started", {
      actor,
      targets,
      previewHash,
      status: job.status,
    }, job.verifyId));

    return {
      ok: true,
      verifyId: job.verifyId,
      requestHash: job.requestHash,
      status: job.status,
      previewHash: job.previewHash,
      targets: job.targets,
      result: executionResult,
    };
  };

  const getVerifyStatus = async (payload: VerifyStatusPayload): Promise<VerifyStatusResult> => {
    if (!policy.allowStatus) {
      const record = auditRecord("status", "deny", "verify_status_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`verify_status_denied:${record.reason}`);
    }

    const id = payload.verifyId ?? payload.verify_id ?? state.latestVerifyId;
    assert(typeof id === "string" && id.length > 0, "verify_id_missing");

    const job = state.jobs[id];
    if (!job) {
      const record = auditRecord("status", "deny", "verify_job_not_found", { verifyId: id }, id);
      emitAudit(audit, record);
      throw new Error(`verify_status_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.beforeStatus, id);

    if (handlers.status && !isTerminal(job.status)) {
      const patch = await handlers.status(job);
      if (patch.status) {
        if (job.status === "queued" && patch.status === "running") {
          job.startedAtMs = patch.startedAtMs ?? job.startedAtMs ?? nowMs();
        }
        job.status = patch.status;
      }
      if (patch.summary) {
        job.summary = normalizeJson(patch.summary) as Record<string, JsonValue>;
      }
      if (patch.startedAtMs !== undefined) job.startedAtMs = patch.startedAtMs;
      if (patch.finishedAtMs !== undefined) job.finishedAtMs = patch.finishedAtMs;
    }

    if (isTerminal(job.status) && job.finishedAtMs === null) {
      job.finishedAtMs = nowMs();
    }

    emitAudit(audit, auditRecord("status", "allow", "verify_status_returned", {
      status: job.status,
      previewHash: job.previewHash,
    }, job.verifyId));

    return {
      ok: true,
      verifyId: job.verifyId,
      status: job.status,
      previewHash: job.previewHash,
      startedAtMs: job.startedAtMs,
      finishedAtMs: job.finishedAtMs,
      summary: job.summary,
    };
  };

  const bindVerifyResult = async (payload: VerifyResultBindingPayload): Promise<void> => {
    const job = state.jobs[payload.verifyId];
    if (!job) {
      const record = auditRecord("bind_result", "deny", "verify_job_not_found", {
        verifyId: payload.verifyId,
      }, payload.verifyId);
      emitAudit(audit, record);
      throw new Error(`verify_bind_denied:${record.reason}`);
    }

    if (isTerminal(job.status)) {
      const record = auditRecord("bind_result", "deny", "verify_job_already_terminal", {
        status: job.status,
      }, job.verifyId);
      emitAudit(audit, record);
      throw new Error(`verify_bind_denied:${record.reason}`);
    }

    job.status = payload.passed ? "passed" : "failed";
    job.finishedAtMs = nowMs();
    job.summary = normalizeJson(payload.summary ?? {}) as Record<string, JsonValue>;

    if (payload.passed && job.previewHash) {
      state.latestPassedPreviewHash = job.previewHash;
      await maybeCallWith(lineage?.onPreviewVerified, job.previewHash, undefined as never);
    }
    if (!payload.passed && job.previewHash) {
      await maybeCallWith(lineage?.onPreviewFailed, job.previewHash, undefined as never);
    }

    await maybeCallWith(boundary?.afterBindResult, job);

    emitAudit(audit, auditRecord("bind_result", "allow", payload.passed ? "verify_marked_passed" : "verify_marked_failed", {
      previewHash: job.previewHash,
      status: job.status,
    }, job.verifyId));
  };

  const clearVerifyState = (): void => {
    const previousCount = Object.keys(state.jobs).length;
    state.jobs = {};
    state.latestVerifyId = null;
    state.latestPassedPreviewHash = null;

    emitAudit(audit, auditRecord("clear", "allow", "verify_state_cleared", {
      previousCount,
    }));
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(channels.run, async (_event, payload: VerifyRunPayload) => runVerify(payload));
    ipcMain.handle(channels.status, async (_event, payload: VerifyStatusPayload) => getVerifyStatus(payload));
    ipcMain.handle(channels.bindResult, async (_event, payload: VerifyResultBindingPayload) => {
      await bindVerifyResult(payload);
      return { ok: true };
    });
    ipcMain.handle(channels.clear, async () => {
      clearVerifyState();
      return { ok: true };
    });

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(channels.run);
    ipcMain.removeHandler(channels.status);
    ipcMain.removeHandler(channels.bindResult);
    ipcMain.removeHandler(channels.clear);
    registered = false;
  };

  return {
    runVerify,
    getVerifyStatus,
    bindVerifyResult,
    clearVerifyState,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION
// -----------------------------------------------------------------------------

export function createDefaultVerifyRuntimeState(): VerifyRuntimeState {
  return {
    jobs: {},
    latestVerifyId: null,
    latestPassedPreviewHash: null,
  };
}

export function createDefaultVerifyPolicy(): VerifyPolicy {
  return {
    allowRun: true,
    allowStatus: true,
    requireTargets: true,
    allowEmptyTargetsWhenPreviewBound: true,
    maxTargets: 256,
    maxTargetLength: 4096,
  };
}

export function validateVerifyRuntimeState(state: VerifyRuntimeState): void {
  assert(typeof state.jobs === "object" && state.jobs !== null, "jobs_invalid");
  if (state.latestVerifyId !== null) {
    assert(typeof state.latestVerifyId === "string" && state.latestVerifyId.length > 0, "latest_verify_id_invalid");
  }
}
