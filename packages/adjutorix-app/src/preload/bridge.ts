/**
 * ADJUTORIX APP — PRELOAD / bridge.ts
 *
 * Canonical typed public bridge contract for the renderer-facing preload API.
 *
 * Purpose:
 * - define the full immutable public surface exposed by preload to the renderer
 * - separate type/system contract from Electron wiring implementation
 * - provide one stable source of truth for request envelopes, response envelopes,
 *   event payloads, and subscription semantics
 * - prevent drift between preload.ts, renderer callers, tests, and governance-facing IPC
 *
 * This file is intentionally declarative and transport-agnostic.
 * It describes what the renderer is allowed to see and call.
 * It does NOT call Electron APIs directly.
 *
 * Hard invariants:
 * - the bridge surface is explicit and closed, not index-signature based
 * - all payloads are JSON-serializable plain data
 * - all async calls resolve to normalized envelopes, never thrown transport exceptions
 * - event subscriptions return explicit unsubscribe functions only
 * - request/response schemas are stable and versionable
 * - bridge types never expose privileged Node/Electron objects
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// CORE JSON TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type Unsubscribe = () => void;

// -----------------------------------------------------------------------------
// ENVELOPES
// -----------------------------------------------------------------------------

export type BridgeSuccessEnvelope<T extends JsonValue = JsonValue> = {
  ok: true;
  data: T;
  meta: {
    channel: string;
    requestHash: string;
  };
};

export type BridgeErrorCode =
  | "IPC_INVOKE_FAILED"
  | "VALIDATION_FAILED"
  | "CHANNEL_NOT_ALLOWLISTED"
  | "PRELOAD_INTERNAL_ERROR"
  | "DENIED_BY_POLICY"
  | "UNKNOWN_ERROR";

export type BridgeErrorEnvelope = {
  ok: false;
  error: {
    code: BridgeErrorCode;
    message: string;
    detail?: JsonObject;
  };
  meta: {
    channel: string;
    requestHash: string;
  };
};

export type BridgeEnvelope<T extends JsonValue = JsonValue> =
  | BridgeSuccessEnvelope<T>
  | BridgeErrorEnvelope;

// -----------------------------------------------------------------------------
// EVENT TYPES
// -----------------------------------------------------------------------------

export type WorkspaceEventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

export type AgentEventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

export type DiagnosticsEventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

export type PatchEventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

export type VerifyEventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

export type BridgeEventCallback<T extends JsonValue = JsonValue> = (payload: T) => void;

// -----------------------------------------------------------------------------
// COMMON REQUEST TYPES
// -----------------------------------------------------------------------------

export type RendererActor = "renderer";

export type RuntimeSnapshotResponse = JsonObject;

export type WorkspaceOpenRequest = {
  schema: 1;
  actor: RendererActor;
  rootPath: string;
  source: "ipc" | "menu" | "startup" | "system" | "reopen";
};

export type WorkspaceCloseResponse = JsonObject;

export type WorkspaceRevealRequest = {
  schema: 1;
  actor: RendererActor;
  targetPath: string;
};

export type WorkspaceHealthResponse = JsonObject;

export type WorkspaceTrustReadResponse = JsonObject;

export type WorkspaceTrustSetRequest = {
  schema: 1;
  actor: RendererActor;
  workspacePath: string;
  level: "untrusted" | "restricted" | "trusted";
  reason: string;
  notes?: string;
};

export type WorkspaceTrustSetResponse = JsonObject;

export type PatchPreviewRequest = {
  schema: 1;
  actor: RendererActor;
  prompt: string;
  targetPaths: string[];
  traceId?: string;
};

export type PatchPreviewResponse = JsonObject;

export type PatchApproveRequest = {
  schema: 1;
  actor: RendererActor;
  patchId: string;
  previewHash: string;
};

export type PatchApproveResponse = JsonObject;

export type PatchApplyRequest = {
  schema: 1;
  actor: RendererActor;
  patchId: string;
  previewHash: string;
  requestHash: string;
  traceId?: string;
};

export type PatchApplyResponse = JsonObject;

export type PatchClearResponse = JsonObject;

export type VerifyRunRequest = {
  schema: 1;
  actor: RendererActor;
  targets: string[];
  previewHash?: string;
  trace_id?: string;
};

export type VerifyRunResponse = JsonObject;

export type VerifyStatusRequest = {
  verifyId?: string;
  verify_id?: string;
};

export type VerifyStatusResponse = JsonObject;

export type VerifyBindRequest = {
  schema: 1;
  verifyId: string;
  passed: boolean;
  summary?: JsonObject;
};

export type VerifyBindResponse = JsonObject;

export type LedgerCurrentResponse = JsonObject;

export type LedgerTimelineRequest = {
  startSeq?: number;
  endSeq?: number;
  limit?: number;
  kinds?: string[];
  reverse?: boolean;
};

export type LedgerTimelineResponse = JsonObject;

export type LedgerEntryRequest = {
  entryId?: string;
  seq?: number;
};

export type LedgerEntryResponse = JsonObject;
export type LedgerHeadsResponse = JsonObject;
export type LedgerStatsResponse = JsonObject;

export type DiagnosticsRuntimeResponse = JsonObject;
export type DiagnosticsStartupResponse = JsonObject;
export type DiagnosticsObservabilityResponse = JsonObject;

export type DiagnosticsLogTailRequest = {
  target: "main" | "observability" | "custom";
  lines?: number;
  bytes?: number;
  customFileName?: string;
};

export type DiagnosticsLogTailResponse = JsonObject;
export type DiagnosticsCrashContextResponse = JsonObject;

export type DiagnosticsExportRequest = {
  includeRuntimeSnapshot?: boolean;
  includeStartupReport?: boolean;
  includeObservability?: boolean;
  includeLogTail?: boolean;
  includeCrashContext?: boolean;
  logTailLines?: number;
  promptForPath?: boolean;
};

export type DiagnosticsExportResponse = JsonObject;

export type AgentHealthResponse = JsonObject;
export type AgentStatusResponse = JsonObject;

export type AgentControlRequest = {
  schema: 1;
  actor: RendererActor;
  reason?: string;
};

export type AgentControlResponse = JsonObject;

// -----------------------------------------------------------------------------
// API SECTION TYPES
// -----------------------------------------------------------------------------

export type RuntimeBridgeApi = {
  snapshot: () => Promise<BridgeEnvelope<RuntimeSnapshotResponse>>;
};

export type WorkspaceBridgeApi = {
  open: (input: WorkspaceOpenRequest) => Promise<BridgeEnvelope<JsonObject>>;
  close: () => Promise<BridgeEnvelope<WorkspaceCloseResponse>>;
  reveal: (input: WorkspaceRevealRequest) => Promise<BridgeEnvelope<JsonObject>>;
  health: () => Promise<BridgeEnvelope<WorkspaceHealthResponse>>;
  trust: {
    read: () => Promise<BridgeEnvelope<WorkspaceTrustReadResponse>>;
    set: (input: WorkspaceTrustSetRequest) => Promise<BridgeEnvelope<WorkspaceTrustSetResponse>>;
  };
  events: {
    subscribe: (callback: BridgeEventCallback<WorkspaceEventPayload>) => Unsubscribe;
  };
};

export type PatchBridgeApi = {
  preview: (input: PatchPreviewRequest) => Promise<BridgeEnvelope<PatchPreviewResponse>>;
  approve: (input: PatchApproveRequest) => Promise<BridgeEnvelope<PatchApproveResponse>>;
  apply: (input: PatchApplyRequest) => Promise<BridgeEnvelope<PatchApplyResponse>>;
  clear: () => Promise<BridgeEnvelope<PatchClearResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<PatchEventPayload>) => Unsubscribe;
  };
};

export type VerifyBridgeApi = {
  run: (input: VerifyRunRequest) => Promise<BridgeEnvelope<VerifyRunResponse>>;
  status: (input?: VerifyStatusRequest) => Promise<BridgeEnvelope<VerifyStatusResponse>>;
  bind: (input: VerifyBindRequest) => Promise<BridgeEnvelope<VerifyBindResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<VerifyEventPayload>) => Unsubscribe;
  };
};

export type LedgerBridgeApi = {
  current: () => Promise<BridgeEnvelope<LedgerCurrentResponse>>;
  timeline: (input?: LedgerTimelineRequest) => Promise<BridgeEnvelope<LedgerTimelineResponse>>;
  entry: (input: LedgerEntryRequest) => Promise<BridgeEnvelope<LedgerEntryResponse>>;
  heads: () => Promise<BridgeEnvelope<LedgerHeadsResponse>>;
  stats: () => Promise<BridgeEnvelope<LedgerStatsResponse>>;
};

export type DiagnosticsBridgeApi = {
  runtime: () => Promise<BridgeEnvelope<DiagnosticsRuntimeResponse>>;
  startup: () => Promise<BridgeEnvelope<DiagnosticsStartupResponse>>;
  observability: () => Promise<BridgeEnvelope<DiagnosticsObservabilityResponse>>;
  logTail: (input: DiagnosticsLogTailRequest) => Promise<BridgeEnvelope<DiagnosticsLogTailResponse>>;
  crashContext: () => Promise<BridgeEnvelope<DiagnosticsCrashContextResponse>>;
  export: (input?: DiagnosticsExportRequest) => Promise<BridgeEnvelope<DiagnosticsExportResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<DiagnosticsEventPayload>) => Unsubscribe;
  };
};

export type AgentBridgeApi = {
  health: () => Promise<BridgeEnvelope<AgentHealthResponse>>;
  status: () => Promise<BridgeEnvelope<AgentStatusResponse>>;
  start: (input?: AgentControlRequest) => Promise<BridgeEnvelope<AgentControlResponse>>;
  stop: (input?: AgentControlRequest) => Promise<BridgeEnvelope<AgentControlResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<AgentEventPayload>) => Unsubscribe;
  };
};

export type BridgeMeta = {
  version: 1;
  bridge: "adjutorix.preload";
};

export type AdjutorixBridge = {
  meta: Readonly<BridgeMeta>;
  runtime: Readonly<RuntimeBridgeApi>;
  workspace: Readonly<WorkspaceBridgeApi>;
  patch: Readonly<PatchBridgeApi>;
  verify: Readonly<VerifyBridgeApi>;
  ledger: Readonly<LedgerBridgeApi>;
  diagnostics: Readonly<DiagnosticsBridgeApi>;
  agent: Readonly<AgentBridgeApi>;
};

// -----------------------------------------------------------------------------
// CHANNEL CONTRACTS
// -----------------------------------------------------------------------------

export const BRIDGE_CHANNELS = {
  runtimeSnapshot: "adjutorix:runtime:snapshot",

  workspaceOpen: "adjutorix:workspace:open",
  workspaceClose: "adjutorix:workspace:close",
  workspaceReveal: "adjutorix:workspace:reveal",
  workspaceHealth: "adjutorix:workspace:health",
  workspaceTrustRead: "adjutorix:workspace:trust:read",
  workspaceTrustSet: "adjutorix:workspace:trust:set",

  patchPreview: "adjutorix:patch:preview",
  patchApprove: "adjutorix:patch:approve",
  patchApply: "adjutorix:patch:apply",
  patchClear: "adjutorix:patch:clear",

  verifyRun: "adjutorix:verify:run",
  verifyStatus: "adjutorix:verify:status",
  verifyBind: "adjutorix:verify:bindResult",

  ledgerCurrent: "adjutorix:ledger:current",
  ledgerTimeline: "adjutorix:ledger:timeline",
  ledgerEntry: "adjutorix:ledger:entry",
  ledgerHeads: "adjutorix:ledger:heads",
  ledgerStats: "adjutorix:ledger:stats",

  diagnosticsRuntime: "adjutorix:diagnostics:runtimeSnapshot",
  diagnosticsStartup: "adjutorix:diagnostics:startupReport",
  diagnosticsObservability: "adjutorix:diagnostics:observabilityBundle",
  diagnosticsLogTail: "adjutorix:diagnostics:logTail",
  diagnosticsCrash: "adjutorix:diagnostics:crashContext",
  diagnosticsExport: "adjutorix:diagnostics:exportBundle",

  agentHealth: "adjutorix:agent:health",
  agentStatus: "adjutorix:agent:status",
  agentStart: "adjutorix:agent:start",
  agentStop: "adjutorix:agent:stop",

  uiWorkspaceEvent: "adjutorix:event:workspace",
  uiAgentEvent: "adjutorix:event:agent",
  uiDiagnosticsEvent: "adjutorix:event:diagnostics",
  uiPatchEvent: "adjutorix:event:patch",
  uiVerifyEvent: "adjutorix:event:verify",
} as const;

export type BridgeInvokeChannel =
  | typeof BRIDGE_CHANNELS.runtimeSnapshot
  | typeof BRIDGE_CHANNELS.workspaceOpen
  | typeof BRIDGE_CHANNELS.workspaceClose
  | typeof BRIDGE_CHANNELS.workspaceReveal
  | typeof BRIDGE_CHANNELS.workspaceHealth
  | typeof BRIDGE_CHANNELS.workspaceTrustRead
  | typeof BRIDGE_CHANNELS.workspaceTrustSet
  | typeof BRIDGE_CHANNELS.patchPreview
  | typeof BRIDGE_CHANNELS.patchApprove
  | typeof BRIDGE_CHANNELS.patchApply
  | typeof BRIDGE_CHANNELS.patchClear
  | typeof BRIDGE_CHANNELS.verifyRun
  | typeof BRIDGE_CHANNELS.verifyStatus
  | typeof BRIDGE_CHANNELS.verifyBind
  | typeof BRIDGE_CHANNELS.ledgerCurrent
  | typeof BRIDGE_CHANNELS.ledgerTimeline
  | typeof BRIDGE_CHANNELS.ledgerEntry
  | typeof BRIDGE_CHANNELS.ledgerHeads
  | typeof BRIDGE_CHANNELS.ledgerStats
  | typeof BRIDGE_CHANNELS.diagnosticsRuntime
  | typeof BRIDGE_CHANNELS.diagnosticsStartup
  | typeof BRIDGE_CHANNELS.diagnosticsObservability
  | typeof BRIDGE_CHANNELS.diagnosticsLogTail
  | typeof BRIDGE_CHANNELS.diagnosticsCrash
  | typeof BRIDGE_CHANNELS.diagnosticsExport
  | typeof BRIDGE_CHANNELS.agentHealth
  | typeof BRIDGE_CHANNELS.agentStatus
  | typeof BRIDGE_CHANNELS.agentStart
  | typeof BRIDGE_CHANNELS.agentStop;

export type BridgeEventChannel =
  | typeof BRIDGE_CHANNELS.uiWorkspaceEvent
  | typeof BRIDGE_CHANNELS.uiAgentEvent
  | typeof BRIDGE_CHANNELS.uiDiagnosticsEvent
  | typeof BRIDGE_CHANNELS.uiPatchEvent
  | typeof BRIDGE_CHANNELS.uiVerifyEvent;

// -----------------------------------------------------------------------------
// TYPE GUARDS / VALIDATION HELPERS
// -----------------------------------------------------------------------------

export function isBridgeSuccessEnvelope<T extends JsonValue = JsonValue>(value: unknown): value is BridgeSuccessEnvelope<T> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.meta === "object" && v.meta !== null && "data" in v;
}

export function isBridgeErrorEnvelope(value: unknown): value is BridgeErrorEnvelope {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    v.ok === false &&
    typeof v.error === "object" &&
    v.error !== null &&
    typeof (v.error as Record<string, unknown>).code === "string" &&
    typeof (v.error as Record<string, unknown>).message === "string"
  );
}

export function isBridgeEnvelope<T extends JsonValue = JsonValue>(value: unknown): value is BridgeEnvelope<T> {
  return isBridgeSuccessEnvelope<T>(value) || isBridgeErrorEnvelope(value);
}

export function validateBridgeMeta(meta: BridgeMeta): void {
  if (meta.version !== 1) throw new Error("bridge_meta_version_invalid");
  if (meta.bridge !== "adjutorix.preload") throw new Error("bridge_meta_name_invalid");
}

export function validateBridgeEnvelope<T extends JsonValue = JsonValue>(envelope: BridgeEnvelope<T>): void {
  if (!isBridgeEnvelope<T>(envelope)) throw new Error("bridge_envelope_invalid");
  if (typeof envelope.meta.channel !== "string" || envelope.meta.channel.length === 0) throw new Error("bridge_meta_channel_invalid");
  if (typeof envelope.meta.requestHash !== "string" || envelope.meta.requestHash.length === 0) throw new Error("bridge_meta_requestHash_invalid");
}

// -----------------------------------------------------------------------------
// REQUEST HASHING / NORMALIZATION HELPERS
// -----------------------------------------------------------------------------

export function stableJson(value: unknown): string {
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

export function canonicalRequestIdentity(channel: string, payload: JsonValue): string {
  return stableJson({ channel, payload });
}

// -----------------------------------------------------------------------------
// WINDOW AUGMENTATION
// -----------------------------------------------------------------------------

declare global {
  interface Window {
    adjutorix: AdjutorixBridge;
  }
}
