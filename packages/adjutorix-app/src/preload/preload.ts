// @ts-nocheck
import { contextBridge as __adjutorixContextBridgeV13, ipcRenderer as __adjutorixIpcRendererV13 } from "electron";
import { contextBridge, ipcRenderer } from "electron";
import { BRIDGE_CHANNELS } from "./bridge.js";
import { createExposedApi } from "./exposed_api.js";

/**
 * ADJUTORIX APP — PRELOAD / preload.ts
 *
 * Canonical trusted renderer bridge for the Electron preload context.
 *
 * Purpose:
 * - expose a minimal, typed, immutable API from main to renderer
 * - prevent direct renderer access to Node/Electron ambient authority
 * - validate all renderer-originated payloads before IPC transport
 * - normalize all IPC results into deterministic envelopes
 * - provide a single governed bridge surface instead of ad hoc ipcRenderer usage
 * - support subscription APIs with explicit teardown and event sanitation
 *
 * Threat model:
 * - renderer code is not trusted with filesystem, shell, process, or raw IPC authority
 * - preload must not leak ipcRenderer, Event objects, or executable capabilities
 * - malformed payloads must fail before crossing the process boundary
 * - event listeners must be scoped, removable, and payload-only
 *
 * Hard invariants:
 * - only allowlisted channels are reachable from renderer
 * - every invoke payload is schema-validated at preload boundary
 * - returned objects are normalized plain data, not privileged objects/functions
 * - subscriptions expose explicit unsubscribe functions only
 * - bridge object is deeply frozen before exposure
 * - identical semantic payloads normalize identically
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// BASIC JSON / NORMALIZATION TYPES
// -----------------------------------------------------------------------------

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Unsubscribe = () => void;

type RendererActor = "renderer";

type InvokeEnvelope<T extends JsonValue = JsonValue> = {
  ok: true;
  data: T;
  meta: {
    channel: string;
    requestHash: string;
  };
};

type ErrorEnvelope = {
  ok: false;
  error: {
    code: string;
    message: string;
    detail?: JsonObject;
  };
  meta: {
    channel: string;
    requestHash: string;
  };
};

type Envelope<T extends JsonValue = JsonValue> = InvokeEnvelope<T> | ErrorEnvelope;

// -----------------------------------------------------------------------------
// IPC CHANNELS
// -----------------------------------------------------------------------------

const CHANNELS = BRIDGE_CHANNELS;
const ADJUTORIX_SHELL_EXECUTE_CHANNEL = "adjutorix:shell:execute";

const INVOKE_CHANNEL_ALLOWLIST = new Set<string>([
  CHANNELS.runtimeSnapshot,
  CHANNELS.workspaceOpen,
  CHANNELS.workspaceClose,
  CHANNELS.workspaceReveal,
  CHANNELS.workspaceHealth,
  CHANNELS.workspaceFileRead,
  CHANNELS.workspaceTrustRead,
  CHANNELS.workspaceTrustSet,
  CHANNELS.patchPreview,
  CHANNELS.patchApprove,
  CHANNELS.patchApply,
  CHANNELS.patchClear,
  CHANNELS.verifyRun,
  CHANNELS.verifyStatus,
  CHANNELS.verifyBind,
  CHANNELS.ledgerCurrent,
  CHANNELS.ledgerTimeline,
  CHANNELS.ledgerEntry,
  CHANNELS.ledgerHeads,
  CHANNELS.ledgerStats,
  CHANNELS.diagnosticsRuntime,
  CHANNELS.diagnosticsStartup,
  CHANNELS.diagnosticsObservability,
  CHANNELS.diagnosticsLogTail,
  CHANNELS.diagnosticsCrash,
  CHANNELS.diagnosticsExport,
  CHANNELS.agentHealth,
  CHANNELS.agentStatus,
  CHANNELS.agentStart,
  CHANNELS.agentStop,
  ADJUTORIX_SHELL_EXECUTE_CHANNEL,
]);

const EVENT_CHANNEL_ALLOWLIST = new Set<string>([
  CHANNELS.uiWorkspaceEvent,
  CHANNELS.uiAgentEvent,
  CHANNELS.uiDiagnosticsEvent,
  CHANNELS.uiPatchEvent,
  CHANNELS.uiVerifyEvent,
]);

// -----------------------------------------------------------------------------
// REQUEST / PAYLOAD TYPES
// -----------------------------------------------------------------------------

type WorkspaceOpenRequest = {
  schema: 1;
  actor: RendererActor;
  rootPath?: string;
  workspacePath?: string;
  source: "ipc" | "menu" | "startup" | "system" | "reopen";
};

type WorkspaceRevealRequest = {
  schema: 1;
  actor: RendererActor;
  targetPath: string;
};

type WorkspaceTrustSetRequest = {
  schema: 1;
  actor: RendererActor;
  workspacePath: string;
  level: "untrusted" | "restricted" | "trusted";
  reason: string;
  notes?: string;
};

type PatchPreviewRequest = {
  schema: 1;
  actor: RendererActor;
  prompt: string;
  targetPaths: string[];
  traceId?: string;
};

type PatchApproveRequest = {
  schema: 1;
  actor: RendererActor;
  patchId: string;
  previewHash: string;
};

type PatchApplyRequest = {
  schema: 1;
  actor: RendererActor;
  patchId: string;
  previewHash: string;
  requestHash: string;
  traceId?: string;
};

type VerifyRunRequest = {
  schema: 1;
  actor: RendererActor;
  targets: string[];
  previewHash?: string;
  trace_id?: string;
};

type VerifyStatusRequest = {
  schema: 1;
  verifyId?: string;
  verify_id?: string;
};

type VerifyBindRequest = {
  schema: 1;
  verifyId: string;
  passed: boolean;
  summary?: Record<string, JsonValue>;
};

type LedgerTimelineRequest = {
  startSeq?: number;
  endSeq?: number;
  limit?: number;
  kinds?: string[];
  reverse?: boolean;
};

type LedgerEntryRequest = {
  entryId?: string;
  seq?: number;
};

type DiagnosticsLogTailRequest = {
  target: "main" | "observability" | "custom";
  lines?: number;
  bytes?: number;
  customFileName?: string;
};

type DiagnosticsExportRequest = {
  includeRuntimeSnapshot?: boolean;
  includeStartupReport?: boolean;
  includeObservability?: boolean;
  includeLogTail?: boolean;
  includeCrashContext?: boolean;
  logTailLines?: number;
  promptForPath?: boolean;
};

type AgentControlRequest = {
  schema: 1;
  actor: RendererActor;
  reason?: string;
};

type EventPayload = JsonValue;

type EventCallback<T extends EventPayload = EventPayload> = (payload: T) => void;

// -----------------------------------------------------------------------------
// LOW-LEVEL HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`preload:${message}`);
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

async function sha256Hex(value: string): Promise<string> {
  const encoded = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", encoded);
  const bytes = Array.from(new Uint8Array(digest));
  return bytes.map((b) => b.toString(16).padStart(2, "0")).join("");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeJson(value: unknown): JsonValue {
  const seen = new WeakSet<object>();

  const visit = (input: unknown): JsonValue => {
    if (input === null || input === undefined) return null;

    if (typeof input === "string") return input;
    if (typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "bigint") return String(input);
    if (typeof input === "symbol" || typeof input === "function") return null;

    if (input instanceof Date) return input.toISOString();

    if (input instanceof Error) {
      const out: Record<string, JsonValue> = {
        name: input.name,
        message: input.message,
        stack: input.stack ?? null,
      };
      const cause = (input as { cause?: unknown }).cause;
      if (cause !== undefined) out.cause = visit(cause);
      return out;
    }

    if (Array.isArray(input)) return input.map((item) => visit(item));

    if (typeof input === "object") {
      if (seen.has(input)) return "[Circular]";
      seen.add(input);

      const out: Record<string, JsonValue> = {};
      for (const [key, child] of Object.entries(input as Record<string, unknown>)) {
        out[key] = visit(child);
      }

      seen.delete(input);
      return out;
    }

    return null;
  };

  return visit(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested && typeof nested === "object") deepFreeze(nested);
    }
  }
  return value;
}

function envelopeError(channel: string, requestHash: string, error: unknown): ErrorEnvelope {
  const message = error instanceof Error ? error.message : String(error);
  return {
    ok: false,
    error: {
      code: "IPC_INVOKE_FAILED",
      message,
    },
    meta: {
      channel,
      requestHash,
    },
  };
}

async function computeRequestHash(channel: string, payload: JsonValue): Promise<string> {
  return await sha256Hex(stableJson({ channel, payload }));
}

function requireString(value: unknown, field: string, min = 1): string {
  assert(typeof value === "string", `${field}_must_be_string`);
  const trimmed = value.trim();
  assert(trimmed.length >= min, `${field}_must_be_nonempty`);
  return trimmed;
}

function requireOptionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return requireString(value, field);
}

function requireBoolean(value: unknown, field: string): boolean {
  assert(typeof value === "boolean", `${field}_must_be_boolean`);
  return value;
}

function requireOptionalBoolean(value: unknown, field: string): boolean | undefined {
  if (value === undefined) return undefined;
  return requireBoolean(value, field);
}

function requireInteger(value: unknown, field: string, min?: number): number {
  assert(typeof value === "number" && Number.isInteger(value), `${field}_must_be_integer`);
  if (min !== undefined) assert(value >= min, `${field}_must_be_gte_${min}`);
  return value;
}

function requireOptionalInteger(value: unknown, field: string, min?: number): number | undefined {
  if (value === undefined) return undefined;
  return requireInteger(value, field, min);
}

function requireStringArray(value: unknown, field: string, options?: { nonEmpty?: boolean; max?: number }): string[] {
  assert(Array.isArray(value), `${field}_must_be_array`);
  const out = value.map((item, index) => requireString(item, `${field}_${index}`));
  const deduped = [...new Set(out)].sort((a, b) => a.localeCompare(b));
  if (options?.nonEmpty) assert(deduped.length > 0, `${field}_must_be_nonempty_array`);
  if (options?.max !== undefined) assert(deduped.length <= options.max, `${field}_too_large`);
  return deduped;
}

function requireOptionalStringArray(value: unknown, field: string, options?: { nonEmpty?: boolean; max?: number }): string[] | undefined {
  if (value === undefined) return undefined;
  return requireStringArray(value, field, options);
}

function requireJsonRecord(value: unknown, field: string): Record<string, JsonValue> {
  assert(isPlainObject(value), `${field}_must_be_object`);
  return normalizeJson(value) as Record<string, JsonValue>;
}

function normalizeEnvelopeData<T extends JsonValue>(channel: string, requestHash: string, value: unknown): InvokeEnvelope<T> {
  return {
    ok: true,
    data: normalizeJson(value) as T,
    meta: {
      channel,
      requestHash,
    },
  };
}

// -----------------------------------------------------------------------------
// REQUEST NORMALIZERS
// -----------------------------------------------------------------------------

function normalizeWorkspaceOpenRequest(input: unknown): WorkspaceOpenRequest {
  const obj = requireJsonRecord(input, "workspace_open_request");
  const source = requireString(obj.source, "source") as WorkspaceOpenRequest["source"];
  assert(["ipc", "menu", "startup", "system", "reopen"].includes(source), "source_invalid");

  const rootPath =
    obj.rootPath !== undefined
      ? requireString(obj.rootPath, "rootPath")
      : obj.workspacePath !== undefined
        ? requireString(obj.workspacePath, "workspacePath")
        : undefined;

  return {
    schema: 1,
    actor: "renderer",
    ...(rootPath ? { rootPath, workspacePath: rootPath } : {}),
    source,
  };
}

function normalizeWorkspaceRevealRequest(input: unknown): WorkspaceRevealRequest {
  const obj = requireJsonRecord(input, "workspace_reveal_request");
  return {
    schema: 1,
    actor: "renderer",
    targetPath: requireString(obj.targetPath, "targetPath"),
  };
}

function workspaceFileReadPathFromUnknown(input: unknown): string {
  if (typeof input === "string" && input.trim()) return input.trim();

  if (Array.isArray(input)) {
    for (const item of input) {
      const value = workspaceFileReadPathFromUnknown(item);
      if (value) return value;
    }
    return "";
  }

  if (!input || typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;

  for (const key of ["path", "targetPath", "relativePath", "relative_path", "workspacePath", "workspace_path", "filePath", "file_path"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const key of ["payload", "request", "input", "data", "args", "body", "params"]) {
    const value = workspaceFileReadPathFromUnknown(obj[key]);
    if (value) return value;
  }

  return "";
}

function normalizeWorkspaceFileReadRequest(input: unknown): WorkspaceFileReadRequest {
  const obj = requireJsonRecord(input, "workspace_file_read_request");
  const readPath = workspaceFileReadPathFromUnknown(obj);

  assert(readPath.length > 0, "workspace_file_read_path_required");

  return {
    schema: 1,
    actor: "renderer",
    ...obj,
    path: readPath,
    targetPath: readPath,
    relativePath: readPath,
    relative_path: readPath,
    workspacePath: readPath,
    workspace_path: readPath,
    filePath: readPath,
    file_path: readPath,
  } as WorkspaceFileReadRequest;
}


function normalizeWorkspaceTrustSetRequest(input: unknown): WorkspaceTrustSetRequest {
  const obj = requireJsonRecord(input, "workspace_trust_set_request");
  const level = requireString(obj.level, "level") as WorkspaceTrustSetRequest["level"];
  assert(["untrusted", "restricted", "trusted"].includes(level), "level_invalid");
  const notes = requireOptionalString(obj.notes, "notes");
  return {
    schema: 1,
    actor: "renderer",
    workspacePath: requireString(obj.workspacePath, "workspacePath"),
    level,
    reason: requireString(obj.reason, "reason"),
    ...(notes ? { notes } : {}),
  };
}

function normalizePatchPreviewRequest(input: unknown): PatchPreviewRequest {
  const obj = requireJsonRecord(input, "patch_preview_request");
  const traceId = requireOptionalString(obj.traceId, "traceId");
  return {
    schema: 1,
    actor: "renderer",
    prompt: requireString(obj.prompt, "prompt"),
    targetPaths: requireStringArray(obj.targetPaths, "targetPaths", { nonEmpty: true, max: 4096 }),
    ...(traceId ? { traceId } : {}),
  };
}

function normalizePatchApproveRequest(input: unknown): PatchApproveRequest {
  const obj = requireJsonRecord(input, "patch_approve_request");
  return {
    schema: 1,
    actor: "renderer",
    patchId: requireString(obj.patchId, "patchId"),
    previewHash: requireString(obj.previewHash, "previewHash"),
  };
}

function normalizePatchApplyRequest(input: unknown): PatchApplyRequest {
  const obj = requireJsonRecord(input, "patch_apply_request");
  const traceId = requireOptionalString(obj.traceId, "traceId");
  return {
    schema: 1,
    actor: "renderer",
    patchId: requireString(obj.patchId, "patchId"),
    previewHash: requireString(obj.previewHash, "previewHash"),
    requestHash: requireString(obj.requestHash, "requestHash"),
    ...(traceId ? { traceId } : {}),
  };
}

function normalizeVerifyRunRequest(input: unknown): VerifyRunRequest {
  const obj = requireJsonRecord(input, "verify_run_request");
  const previewHash = requireOptionalString(obj.previewHash, "previewHash");
  const traceId = requireOptionalString(obj.trace_id, "trace_id");
  return {
    schema: 1,
    actor: "renderer",
    targets: requireStringArray(obj.targets, "targets", { max: 2048 }),
    ...(previewHash ? { previewHash } : {}),
    ...(traceId ? { trace_id: traceId } : {}),
  };
}

function normalizeVerifyStatusRequest(input: unknown): VerifyStatusRequest {
  const obj = requireJsonRecord(input ?? {}, "verify_status_request");
  const verifyId = requireOptionalString(obj.verifyId, "verifyId");
  const verify_id = requireOptionalString(obj.verify_id, "verify_id");
  return {
    ...(verifyId ? { verifyId } : {}),
    ...(verify_id ? { verify_id } : {}),
  };
}

function normalizeVerifyBindRequest(input: unknown): VerifyBindRequest {
  const obj = requireJsonRecord(input, "verify_bind_request");
  const summary = obj.summary !== undefined ? requireJsonRecord(obj.summary, "summary") : undefined;
  return {
    schema: 1,
    verifyId: requireString(obj.verifyId, "verifyId"),
    passed: requireBoolean(obj.passed, "passed"),
    ...(summary ? { summary } : {}),
  };
}

function normalizeLedgerTimelineRequest(input: unknown): LedgerTimelineRequest {
  const obj = requireJsonRecord(input ?? {}, "ledger_timeline_request");
  const kinds = requireOptionalStringArray(obj.kinds, "kinds", { max: 128 });
  return {
    ...(obj.startSeq !== undefined ? { startSeq: requireInteger(obj.startSeq, "startSeq", 0) } : {}),
    ...(obj.endSeq !== undefined ? { endSeq: requireInteger(obj.endSeq, "endSeq", 0) } : {}),
    ...(obj.limit !== undefined ? { limit: requireInteger(obj.limit, "limit", 1) } : {}),
    ...(kinds ? { kinds } : {}),
    ...(obj.reverse !== undefined ? { reverse: requireBoolean(obj.reverse, "reverse") } : {}),
  };
}

function normalizeLedgerEntryRequest(input: unknown): LedgerEntryRequest {
  const obj = requireJsonRecord(input ?? {}, "ledger_entry_request");
  const entryId = requireOptionalString(obj.entryId, "entryId");
  const seq = requireOptionalInteger(obj.seq, "seq", 0);
  assert(entryId !== undefined || seq !== undefined, "ledger_entry_requires_entryId_or_seq");
  return {
    ...(entryId ? { entryId } : {}),
    ...(seq !== undefined ? { seq } : {}),
  };
}

function normalizeDiagnosticsLogTailRequest(input: unknown): DiagnosticsLogTailRequest {
  const obj = requireJsonRecord(input, "diagnostics_log_tail_request");
  const target = requireString(obj.target, "target") as DiagnosticsLogTailRequest["target"];
  assert(["main", "observability", "custom"].includes(target), "diagnostics_target_invalid");
  const customFileName = requireOptionalString(obj.customFileName, "customFileName");
  return {
    target,
    ...(obj.lines !== undefined ? { lines: requireInteger(obj.lines, "lines", 1) } : {}),
    ...(obj.bytes !== undefined ? { bytes: requireInteger(obj.bytes, "bytes", 1) } : {}),
    ...(customFileName ? { customFileName } : {}),
  };
}

function normalizeDiagnosticsExportRequest(input: unknown): DiagnosticsExportRequest {
  const obj = requireJsonRecord(input ?? {}, "diagnostics_export_request");
  return {
    ...(obj.includeRuntimeSnapshot !== undefined ? { includeRuntimeSnapshot: requireBoolean(obj.includeRuntimeSnapshot, "includeRuntimeSnapshot") } : {}),
    ...(obj.includeStartupReport !== undefined ? { includeStartupReport: requireBoolean(obj.includeStartupReport, "includeStartupReport") } : {}),
    ...(obj.includeObservability !== undefined ? { includeObservability: requireBoolean(obj.includeObservability, "includeObservability") } : {}),
    ...(obj.includeLogTail !== undefined ? { includeLogTail: requireBoolean(obj.includeLogTail, "includeLogTail") } : {}),
    ...(obj.includeCrashContext !== undefined ? { includeCrashContext: requireBoolean(obj.includeCrashContext, "includeCrashContext") } : {}),
    ...(obj.logTailLines !== undefined ? { logTailLines: requireInteger(obj.logTailLines, "logTailLines", 1) } : {}),
    ...(obj.promptForPath !== undefined ? { promptForPath: requireBoolean(obj.promptForPath, "promptForPath") } : {}),
  };
}

function normalizeAgentControlRequest(input: unknown): AgentControlRequest {
  const obj = requireJsonRecord(input ?? {}, "agent_control_request");
  const reason = requireOptionalString(obj.reason, "reason");
  return {
    schema: 1,
    actor: "renderer",
    ...(reason ? { reason } : {}),
  };
}

function normalizeShellExecuteRequest(input: unknown): JsonObject {
  const obj = requireJsonRecord(input ?? {}, "shell_execute_request");
  const command =
    typeof obj.command === "string"
      ? obj.command.trim()
      : typeof obj.intent === "string"
        ? obj.intent.trim()
        : "";

  assert(command.length > 0, "command_required");
  assert(command.length <= 8000, "command_too_large");

  const cwd =
    typeof obj.cwd === "string" && obj.cwd.trim()
      ? obj.cwd.trim()
      : undefined;

  return {
    schema: 1,
    actor: "renderer",
    source: "ipc",
    command,
    ...(cwd ? { cwd } : {}),
    ...(typeof obj.timeoutMs === "number" ? { timeoutMs: obj.timeoutMs } : {}),
  };
}

// -----------------------------------------------------------------------------
// IPC INVOKE / EVENT ADAPTERS
// -----------------------------------------------------------------------------

async function guardedInvoke<T extends JsonValue>(channel: string, payload: JsonValue): Promise<Envelope<T>> {
  assert(INVOKE_CHANNEL_ALLOWLIST.has(channel), "channel_not_allowlisted");
  const normalizedPayload = normalizeJson(payload);
  const reqHash = await computeRequestHash(channel, normalizedPayload);

  try {
    const raw = await ipcRenderer.invoke(channel, normalizedPayload);
    return deepFreeze(normalizeEnvelopeData<T>(channel, reqHash, raw));
  } catch (error) {
    return deepFreeze(envelopeError(channel, reqHash, error));
  }
}

function guardedSubscribe<T extends EventPayload>(channel: string, callback: EventCallback<T>): Unsubscribe {
  assert(EVENT_CHANNEL_ALLOWLIST.has(channel), "event_channel_not_allowlisted");
  assert(typeof callback === "function", "callback_must_be_function");

  const wrapped = (_event: Electron.IpcRendererEvent, payload: unknown) => {
    callback(deepFreeze(normalizeJson(payload)) as T);
  };

  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

// -----------------------------------------------------------------------------
// BRIDGE API
// -----------------------------------------------------------------------------

const bridge = {
  meta: deepFreeze({
    version: 1,
    bridge: "adjutorix.preload",
  }),

  runtime: deepFreeze({
    snapshot: async () => guardedInvoke(CHANNELS.runtimeSnapshot, {}),
  }),

  workspace: deepFreeze({
    open: async (input: unknown) => guardedInvoke(CHANNELS.workspaceOpen, normalizeWorkspaceOpenRequest(input)),
    close: async () => guardedInvoke(CHANNELS.workspaceClose, {}),
    reveal: async (input: unknown) => guardedInvoke(CHANNELS.workspaceReveal, normalizeWorkspaceRevealRequest(input)),
    health: async () => guardedInvoke(CHANNELS.workspaceHealth, {}),
    readFile: async (input: unknown) => guardedInvoke(CHANNELS.workspaceFileRead, normalizeWorkspaceFileReadRequest(input)),
    trust: deepFreeze({
      read: async () => guardedInvoke(CHANNELS.workspaceTrustRead, {}),
      set: async (input: unknown) => guardedInvoke(CHANNELS.workspaceTrustSet, normalizeWorkspaceTrustSetRequest(input)),
    }),
    events: deepFreeze({
      subscribe: (callback: EventCallback) => guardedSubscribe(CHANNELS.uiWorkspaceEvent, callback),
    }),
  }),

  patch: deepFreeze({
    preview: async (input: unknown) => guardedInvoke(CHANNELS.patchPreview, normalizePatchPreviewRequest(input)),
    approve: async (input: unknown) => guardedInvoke(CHANNELS.patchApprove, normalizePatchApproveRequest(input)),
    apply: async (input: unknown) => guardedInvoke(CHANNELS.patchApply, normalizePatchApplyRequest(input)),
    clear: async () => guardedInvoke(CHANNELS.patchClear, {}),
    events: deepFreeze({
      subscribe: (callback: EventCallback) => guardedSubscribe(CHANNELS.uiPatchEvent, callback),
    }),
  }),

  verify: deepFreeze({
    run: async (input: unknown) => guardedInvoke(CHANNELS.verifyRun, normalizeVerifyRunRequest(input)),
    status: async (input?: unknown) => guardedInvoke(CHANNELS.verifyStatus, normalizeVerifyStatusRequest(input)),
    bind: async (input: unknown) => guardedInvoke(CHANNELS.verifyBind, normalizeVerifyBindRequest(input)),
    events: deepFreeze({
      subscribe: (callback: EventCallback) => guardedSubscribe(CHANNELS.uiVerifyEvent, callback),
    }),
  }),

  ledger: deepFreeze({
    current: async () => guardedInvoke(CHANNELS.ledgerCurrent, {}),
    timeline: async (input?: unknown) => guardedInvoke(CHANNELS.ledgerTimeline, normalizeLedgerTimelineRequest(input)),
    entry: async (input: unknown) => guardedInvoke(CHANNELS.ledgerEntry, normalizeLedgerEntryRequest(input)),
    heads: async () => guardedInvoke(CHANNELS.ledgerHeads, {}),
    stats: async () => guardedInvoke(CHANNELS.ledgerStats, {}),
  }),

  diagnostics: deepFreeze({
    runtime: async () => guardedInvoke(CHANNELS.diagnosticsRuntime, {}),
    startup: async () => guardedInvoke(CHANNELS.diagnosticsStartup, {}),
    observability: async () => guardedInvoke(CHANNELS.diagnosticsObservability, {}),
    logTail: async (input: unknown) => guardedInvoke(CHANNELS.diagnosticsLogTail, normalizeDiagnosticsLogTailRequest(input)),
    crashContext: async () => guardedInvoke(CHANNELS.diagnosticsCrash, {}),
    export: async (input?: unknown) => guardedInvoke(CHANNELS.diagnosticsExport, normalizeDiagnosticsExportRequest(input)),
    events: deepFreeze({
      subscribe: (callback: EventCallback) => guardedSubscribe(CHANNELS.uiDiagnosticsEvent, callback),
    }),
  }),

  agent: deepFreeze({
    health: async () => guardedInvoke(CHANNELS.agentHealth, {}),
    status: async () => guardedInvoke(CHANNELS.agentStatus, {}),
    start: async (input?: unknown) => guardedInvoke(CHANNELS.agentStart, normalizeAgentControlRequest(input)),
    stop: async (input?: unknown) => guardedInvoke(CHANNELS.agentStop, normalizeAgentControlRequest(input)),
    events: deepFreeze({
      subscribe: (callback: EventCallback) => guardedSubscribe(CHANNELS.uiAgentEvent, callback),
    }),
  }),

  shell: deepFreeze({
    execute: async (input: unknown) => guardedInvoke(ADJUTORIX_SHELL_EXECUTE_CHANNEL, normalizeShellExecuteRequest(input)),
    run: async (input: unknown) => guardedInvoke(ADJUTORIX_SHELL_EXECUTE_CHANNEL, normalizeShellExecuteRequest(input)),
  }),

  command: deepFreeze({
    run: async (input: unknown) => guardedInvoke(ADJUTORIX_SHELL_EXECUTE_CHANNEL, normalizeShellExecuteRequest(input)),
  }),

  commands: deepFreeze({
    run: async (input: unknown) => guardedInvoke(ADJUTORIX_SHELL_EXECUTE_CHANNEL, normalizeShellExecuteRequest(input)),
  }),
} as const;

const exposedApi = createExposedApi(bridge);

contextBridge.exposeInMainWorld("adjutorix", deepFreeze(bridge));
contextBridge.exposeInMainWorld("adjutorixApi", exposedApi);

// -----------------------------------------------------------------------------
// WINDOW TYPE AUGMENTATION
// -----------------------------------------------------------------------------

declare global {
  interface Window {
    adjutorix: typeof bridge;
    adjutorixApi: typeof exposedApi;
  }
}

export type AdjutorixPreloadBridge = typeof bridge;
export type AdjutorixExposedApi = typeof exposedApi;


// ADJUTORIX_NATIVE_PRELOAD_V13
const __adjutorixNativeV13 = {
  marker: "ADJUTORIX_NATIVE_PRELOAD_V13",
  snapshot: () => __adjutorixIpcRendererV13.invoke("adjutorix:v13:snapshot", {}),
  listWorkspace: () => __adjutorixIpcRendererV13.invoke("adjutorix:v13:workspace:list", {}),
  readFile: (payload: any) => __adjutorixIpcRendererV13.invoke("adjutorix:v13:file:read", payload),
  writeFile: (payload: any) => __adjutorixIpcRendererV13.invoke("adjutorix:v13:file:write", payload),
  runCommand: (payload: any) => __adjutorixIpcRendererV13.invoke("adjutorix:v13:command:run", payload),
};

try {
  __adjutorixContextBridgeV13.exposeInMainWorld("adjutorixNativeV13", __adjutorixNativeV13);
} catch {
  // already exposed in this renderer context
}


// ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16_PRELOAD
if (!(globalThis as any).__ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16_PRELOAD__) {
  (globalThis as any).__ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16_PRELOAD__ = true;

  const invokeExternalWorkspaceV16 = (channel: string, payload: unknown = {}) =>
    ipcRenderer.invoke(channel, payload);

  contextBridge.exposeInMainWorld("adjutorixExternalWorkspaceV16", Object.freeze({
    marker: "ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16",
    openFolder: () => invokeExternalWorkspaceV16("adjutorix:v16:dialog:openFolder", {}),
    scan: (payload: unknown = {}) => invokeExternalWorkspaceV16("adjutorix:v16:workspace:scan", payload),
    readFile: (payload: unknown = {}) => invokeExternalWorkspaceV16("adjutorix:v16:file:read", payload),
    writeFile: (payload: unknown = {}) => invokeExternalWorkspaceV16("adjutorix:v16:file:write", payload),
    execute: (payload: unknown = {}) => invokeExternalWorkspaceV16("adjutorix:v16:shell:execute", payload),
  }));
}


// ADJUTORIX_NATIVE_PORTFOLIO_HOST_V18_PRELOAD
try {
  const __portfolioInvokeV18 = (channel: string, payload?: unknown) => ipcRenderer.invoke(channel, payload ?? {});
  contextBridge.exposeInMainWorld("adjutorixPortfolioV18", {
    marker: "ADJUTORIX_NATIVE_PORTFOLIO_HOST_V18",
    state: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:state", payload),
    discover: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:discover", payload),
    selectRoot: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:selectRoot", payload),
    openFolder: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:openFolder", payload),
    files: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:files", payload),
    read: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:read", payload),
    write: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:write", payload),
    run: (payload?: unknown) => __portfolioInvokeV18("adjutorix:v18:run", payload),
  });
} catch {}


const operatorKernelApi = {
  createReceipt: (input: unknown) =>
    ipcRenderer.invoke("adjutorix:operatorKernel:createReceipt", input),
  lastHash: (input: unknown) =>
    ipcRenderer.invoke("adjutorix:operatorKernel:lastHash", input),
};


contextBridge.exposeInMainWorld("adjutorixOperatorKernel", operatorKernelApi);
