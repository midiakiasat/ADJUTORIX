/**
 * ADJUTORIX APP — PRELOAD / exposed_api.ts
 *
 * Canonical exposed renderer API contract and facade utilities for the Adjutorix
 * preload bridge.
 *
 * Purpose:
 * - define the final renderer-facing API surface expected to exist on `window.adjutorix`
 * - provide stable facade helpers over normalized bridge envelopes
 * - separate ergonomic consumption types from preload implementation details
 * - encode versioning, compatibility, and capability-discovery semantics in one place
 * - keep renderer code coupled to one explicit public contract rather than directly to
 *   channel names, preload internals, or ad hoc envelope handling
 *
 * This layer is intentionally public-facing and renderer-centric.
 * It does not invoke Electron APIs and does not own IPC wiring.
 * It describes what UI/application code is allowed to rely on.
 *
 * Design principles:
 * - all async operations resolve to normalized envelopes
 * - public methods remain capability-oriented, not transport-oriented
 * - event subscriptions are explicit and disposable
 * - compatibility/version checks are first-class, not informal assumptions
 * - every surface is JSON-safe and governance-friendly
 *
 * Hard invariants:
 * - the exposed API is closed and explicitly typed
 * - compatibility is deterministic and version-based
 * - helper utilities do not erase error information
 * - facades never reintroduce privileged objects or ambient authority
 * - identical bridge envelopes normalize to identical facade outcomes
 * - outputs are serialization-stable where applicable
 *
 * NO PLACEHOLDERS.
 */

import type {
  AdjutorixBridge,
  AgentBridgeApi,
  AgentControlRequest,
  AgentEventPayload,
  AgentHealthResponse,
  AgentStatusResponse,
  BridgeEnvelope,
  BridgeErrorEnvelope,
  BridgeEventCallback,
  BridgeMeta,
  BridgeSuccessEnvelope,
  DiagnosticsBridgeApi,
  DiagnosticsCrashContextResponse,
  DiagnosticsEventPayload,
  DiagnosticsExportRequest,
  DiagnosticsExportResponse,
  DiagnosticsLogTailRequest,
  DiagnosticsLogTailResponse,
  DiagnosticsObservabilityResponse,
  DiagnosticsRuntimeResponse,
  DiagnosticsStartupResponse,
  JsonObject,
  JsonValue,
  LedgerBridgeApi,
  LedgerCurrentResponse,
  LedgerEntryRequest,
  LedgerEntryResponse,
  LedgerHeadsResponse,
  LedgerStatsResponse,
  LedgerTimelineRequest,
  LedgerTimelineResponse,
  PatchApproveRequest,
  PatchApproveResponse,
  PatchApplyRequest,
  PatchApplyResponse,
  PatchBridgeApi,
  PatchClearResponse,
  PatchEventPayload,
  PatchPreviewRequest,
  PatchPreviewResponse,
  RuntimeBridgeApi,
  RuntimeSnapshotResponse,
  Unsubscribe,
  VerifyBindRequest,
  VerifyBindResponse,
  VerifyBridgeApi,
  VerifyEventPayload,
  VerifyRunRequest,
  VerifyRunResponse,
  VerifyStatusRequest,
  VerifyStatusResponse,
  WorkspaceBridgeApi,
  WorkspaceCloseResponse,
  WorkspaceEventPayload,
  WorkspaceHealthResponse,
  WorkspaceOpenRequest,
  WorkspaceRevealRequest,
  WorkspaceTrustReadResponse,
  WorkspaceTrustSetRequest,
  WorkspaceTrustSetResponse,
} from "./bridge";

// -----------------------------------------------------------------------------
// PUBLIC VERSION / CAPABILITY MODEL
// -----------------------------------------------------------------------------

export const EXPOSED_API_VERSION = 1 as const;
export const EXPOSED_API_NAME = "adjutorix.exposed_api" as const;

export type ExposedApiVersion = typeof EXPOSED_API_VERSION;

export type ExposedCapability =
  | "runtime.snapshot"
  | "workspace.open"
  | "workspace.close"
  | "workspace.reveal"
  | "workspace.health"
  | "workspace.trust.read"
  | "workspace.trust.set"
  | "patch.preview"
  | "patch.approve"
  | "patch.apply"
  | "patch.clear"
  | "verify.run"
  | "verify.status"
  | "verify.bind"
  | "ledger.current"
  | "ledger.timeline"
  | "ledger.entry"
  | "ledger.heads"
  | "ledger.stats"
  | "diagnostics.runtime"
  | "diagnostics.startup"
  | "diagnostics.observability"
  | "diagnostics.logTail"
  | "diagnostics.crashContext"
  | "diagnostics.export"
  | "agent.health"
  | "agent.status"
  | "agent.start"
  | "agent.stop"
  | "events.workspace"
  | "events.patch"
  | "events.verify"
  | "events.agent"
  | "events.diagnostics";

export type ExposedApiManifest = {
  version: ExposedApiVersion;
  name: typeof EXPOSED_API_NAME;
  bridgeVersion: number;
  bridgeName: string;
  capabilities: ExposedCapability[];
};

// -----------------------------------------------------------------------------
// PUBLIC FACADE RESULT TYPES
// -----------------------------------------------------------------------------

export type ExposedOk<T extends JsonValue = JsonValue> = {
  ok: true;
  data: T;
  meta: {
    channel: string;
    requestHash: string;
  };
};

export type ExposedErr = {
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

export type ExposedResult<T extends JsonValue = JsonValue> = ExposedOk<T> | ExposedErr;

export type EventSubscription<T extends JsonValue = JsonValue> = {
  active: boolean;
  unsubscribe: Unsubscribe;
  channel: string;
  lastPayload: T | null;
};

// -----------------------------------------------------------------------------
// PUBLIC API SECTIONS
// -----------------------------------------------------------------------------

export type ExposedRuntimeApi = {
  snapshot: () => Promise<ExposedResult<RuntimeSnapshotResponse>>;
};

export type ExposedWorkspaceApi = {
  open: (input: WorkspaceOpenRequest) => Promise<ExposedResult<JsonObject>>;
  close: () => Promise<ExposedResult<WorkspaceCloseResponse>>;
  reveal: (input: WorkspaceRevealRequest) => Promise<ExposedResult<JsonObject>>;
  health: () => Promise<ExposedResult<WorkspaceHealthResponse>>;
  trust: {
    read: () => Promise<ExposedResult<WorkspaceTrustReadResponse>>;
    set: (input: WorkspaceTrustSetRequest) => Promise<ExposedResult<WorkspaceTrustSetResponse>>;
  };
  events: {
    subscribe: (callback: BridgeEventCallback<WorkspaceEventPayload>) => EventSubscription<WorkspaceEventPayload>;
  };
};

export type ExposedPatchApi = {
  preview: (input: PatchPreviewRequest) => Promise<ExposedResult<PatchPreviewResponse>>;
  approve: (input: PatchApproveRequest) => Promise<ExposedResult<PatchApproveResponse>>;
  apply: (input: PatchApplyRequest) => Promise<ExposedResult<PatchApplyResponse>>;
  clear: () => Promise<ExposedResult<PatchClearResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<PatchEventPayload>) => EventSubscription<PatchEventPayload>;
  };
};

export type ExposedVerifyApi = {
  run: (input: VerifyRunRequest) => Promise<ExposedResult<VerifyRunResponse>>;
  status: (input?: VerifyStatusRequest) => Promise<ExposedResult<VerifyStatusResponse>>;
  bind: (input: VerifyBindRequest) => Promise<ExposedResult<VerifyBindResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<VerifyEventPayload>) => EventSubscription<VerifyEventPayload>;
  };
};

export type ExposedLedgerApi = {
  current: () => Promise<ExposedResult<LedgerCurrentResponse>>;
  timeline: (input?: LedgerTimelineRequest) => Promise<ExposedResult<LedgerTimelineResponse>>;
  entry: (input: LedgerEntryRequest) => Promise<ExposedResult<LedgerEntryResponse>>;
  heads: () => Promise<ExposedResult<LedgerHeadsResponse>>;
  stats: () => Promise<ExposedResult<LedgerStatsResponse>>;
};

export type ExposedDiagnosticsApi = {
  runtime: () => Promise<ExposedResult<DiagnosticsRuntimeResponse>>;
  startup: () => Promise<ExposedResult<DiagnosticsStartupResponse>>;
  observability: () => Promise<ExposedResult<DiagnosticsObservabilityResponse>>;
  logTail: (input: DiagnosticsLogTailRequest) => Promise<ExposedResult<DiagnosticsLogTailResponse>>;
  crashContext: () => Promise<ExposedResult<DiagnosticsCrashContextResponse>>;
  export: (input?: DiagnosticsExportRequest) => Promise<ExposedResult<DiagnosticsExportResponse>>;
  events: {
    subscribe: (callback: BridgeEventCallback<DiagnosticsEventPayload>) => EventSubscription<DiagnosticsEventPayload>;
  };
};

export type ExposedAgentApi = {
  health: () => Promise<ExposedResult<AgentHealthResponse>>;
  status: () => Promise<ExposedResult<AgentStatusResponse>>;
  start: (input?: AgentControlRequest) => Promise<ExposedResult<JsonObject>>;
  stop: (input?: AgentControlRequest) => Promise<ExposedResult<JsonObject>>;
  events: {
    subscribe: (callback: BridgeEventCallback<AgentEventPayload>) => EventSubscription<AgentEventPayload>;
  };
};

export type ExposedCompatibilityApi = {
  manifest: () => ExposedApiManifest;
  isCompatibleBridgeMeta: (meta: BridgeMeta) => boolean;
  assertCompatibleBridgeMeta: (meta: BridgeMeta) => void;
  hasCapability: (capability: ExposedCapability) => boolean;
  listCapabilities: () => ExposedCapability[];
};

export type ExposedApi = {
  readonly manifest: ExposedApiManifest;
  readonly runtime: Readonly<ExposedRuntimeApi>;
  readonly workspace: Readonly<ExposedWorkspaceApi>;
  readonly patch: Readonly<ExposedPatchApi>;
  readonly verify: Readonly<ExposedVerifyApi>;
  readonly ledger: Readonly<ExposedLedgerApi>;
  readonly diagnostics: Readonly<ExposedDiagnosticsApi>;
  readonly agent: Readonly<ExposedAgentApi>;
  readonly compatibility: Readonly<ExposedCompatibilityApi>;
};

// -----------------------------------------------------------------------------
// CAPABILITY MANIFEST
// -----------------------------------------------------------------------------

export const EXPOSED_CAPABILITIES: readonly ExposedCapability[] = Object.freeze([
  "runtime.snapshot",
  "workspace.open",
  "workspace.close",
  "workspace.reveal",
  "workspace.health",
  "workspace.trust.read",
  "workspace.trust.set",
  "patch.preview",
  "patch.approve",
  "patch.apply",
  "patch.clear",
  "verify.run",
  "verify.status",
  "verify.bind",
  "ledger.current",
  "ledger.timeline",
  "ledger.entry",
  "ledger.heads",
  "ledger.stats",
  "diagnostics.runtime",
  "diagnostics.startup",
  "diagnostics.observability",
  "diagnostics.logTail",
  "diagnostics.crashContext",
  "diagnostics.export",
  "agent.health",
  "agent.status",
  "agent.start",
  "agent.stop",
  "events.workspace",
  "events.patch",
  "events.verify",
  "events.agent",
  "events.diagnostics",
] as const);

export function createExposedApiManifest(meta: BridgeMeta): ExposedApiManifest {
  return Object.freeze({
    version: EXPOSED_API_VERSION,
    name: EXPOSED_API_NAME,
    bridgeVersion: meta.version,
    bridgeName: meta.bridge,
    capabilities: [...EXPOSED_CAPABILITIES].sort((a, b) => a.localeCompare(b)),
  });
}

// -----------------------------------------------------------------------------
// NORMALIZATION HELPERS
// -----------------------------------------------------------------------------

export function isExposedOk<T extends JsonValue = JsonValue>(value: unknown): value is ExposedOk<T> {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.meta === "object" && v.meta !== null && "data" in v;
}

export function isExposedErr(value: unknown): value is ExposedErr {
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

export function isExposedResult<T extends JsonValue = JsonValue>(value: unknown): value is ExposedResult<T> {
  return isExposedOk<T>(value) || isExposedErr(value);
}

export function normalizeBridgeEnvelope<T extends JsonValue = JsonValue>(envelope: BridgeEnvelope<T>): ExposedResult<T> {
  if (envelope.ok) {
    const ok: ExposedOk<T> = {
      ok: true,
      data: envelope.data,
      meta: {
        channel: envelope.meta.channel,
        requestHash: envelope.meta.requestHash,
      },
    };
    return deepFreeze(ok);
  }

  const err: ExposedErr = {
    ok: false,
    error: {
      code: envelope.error.code,
      message: envelope.error.message,
      ...(envelope.error.detail ? { detail: envelope.error.detail } : {}),
    },
    meta: {
      channel: envelope.meta.channel,
      requestHash: envelope.meta.requestHash,
    },
  };
  return deepFreeze(err);
}

export function unwrapOrThrow<T extends JsonValue = JsonValue>(result: ExposedResult<T>): T {
  if (result.ok) return result.data;
  throw new Error(`${result.error.code}:${result.error.message}`);
}

export function getErrorOrNull<T extends JsonValue = JsonValue>(result: ExposedResult<T>): ExposedErr["error"] | null {
  return result.ok ? null : result.error;
}

export function getDataOrNull<T extends JsonValue = JsonValue>(result: ExposedResult<T>): T | null {
  return result.ok ? result.data : null;
}

// -----------------------------------------------------------------------------
// SUBSCRIPTION HELPERS
// -----------------------------------------------------------------------------

export function createEventSubscription<T extends JsonValue = JsonValue>(
  channel: string,
  rawUnsubscribe: Unsubscribe,
): EventSubscription<T> {
  let active = true;
  let lastPayload: T | null = null;

  const subscription: EventSubscription<T> = {
    get active() {
      return active;
    },
    get lastPayload() {
      return lastPayload;
    },
    channel,
    unsubscribe: () => {
      if (!active) return;
      active = false;
      rawUnsubscribe();
    },
  };

  return subscription;
}

export function bindTrackedSubscription<T extends JsonValue = JsonValue>(
  channel: string,
  subscribeFn: (callback: BridgeEventCallback<T>) => Unsubscribe,
  callback: BridgeEventCallback<T>,
): EventSubscription<T> {
  let active = true;
  let lastPayload: T | null = null;

  const wrapped: BridgeEventCallback<T> = (payload) => {
    lastPayload = payload;
    callback(payload);
  };

  const unsubscribeRaw = subscribeFn(wrapped);

  const subscription: EventSubscription<T> = {
    get active() {
      return active;
    },
    get lastPayload() {
      return lastPayload;
    },
    channel,
    unsubscribe: () => {
      if (!active) return;
      active = false;
      unsubscribeRaw();
    },
  };

  return subscription;
}

// -----------------------------------------------------------------------------
// COMPATIBILITY HELPERS
// -----------------------------------------------------------------------------

export function isCompatibleBridgeMeta(meta: BridgeMeta): boolean {
  return meta.version === 1 && meta.bridge === "adjutorix.preload";
}

export function assertCompatibleBridgeMeta(meta: BridgeMeta): void {
  if (!isCompatibleBridgeMeta(meta)) {
    throw new Error(`incompatible_bridge_meta:${meta.bridge}:${meta.version}`);
  }
}

export function hasCapability(capability: ExposedCapability): boolean {
  return EXPOSED_CAPABILITIES.includes(capability);
}

export function listCapabilities(): ExposedCapability[] {
  return [...EXPOSED_CAPABILITIES].sort((a, b) => a.localeCompare(b));
}

// -----------------------------------------------------------------------------
// FACADE CONSTRUCTORS
// -----------------------------------------------------------------------------

export function createRuntimeFacade(runtime: RuntimeBridgeApi): ExposedRuntimeApi {
  return deepFreeze({
    snapshot: async () => normalizeBridgeEnvelope(await runtime.snapshot()),
  });
}

export function createWorkspaceFacade(workspace: WorkspaceBridgeApi): ExposedWorkspaceApi {
  return deepFreeze({
    open: async (input) => normalizeBridgeEnvelope(await workspace.open(input)),
    close: async () => normalizeBridgeEnvelope(await workspace.close()),
    reveal: async (input) => normalizeBridgeEnvelope(await workspace.reveal(input)),
    health: async () => normalizeBridgeEnvelope(await workspace.health()),
    trust: deepFreeze({
      read: async () => normalizeBridgeEnvelope(await workspace.trust.read()),
      set: async (input) => normalizeBridgeEnvelope(await workspace.trust.set(input)),
    }),
    events: deepFreeze({
      subscribe: (callback) => bindTrackedSubscription("workspace", workspace.events.subscribe, callback),
    }),
  });
}

export function createPatchFacade(patch: PatchBridgeApi): ExposedPatchApi {
  return deepFreeze({
    preview: async (_input) => { throw new Error("agent_method_not_exposed:patch.preview"); },
    approve: async (input) => normalizeBridgeEnvelope(await patch.approve(input)),
    apply: async (_input) => { throw new Error("agent_method_not_exposed:patch.apply"); },
    clear: async () => normalizeBridgeEnvelope(await patch.clear()),
    events: deepFreeze({
      subscribe: (callback) => bindTrackedSubscription("patch", patch.events.subscribe, callback),
    }),
  });
}

export function createVerifyFacade(verify: VerifyBridgeApi): ExposedVerifyApi {
  return deepFreeze({
    run: async (input) => normalizeBridgeEnvelope(await verify.run(input)),
    status: async (_input) => { throw new Error("agent_method_not_exposed:verify.status"); },
    bind: async (input) => normalizeBridgeEnvelope(await verify.bind(input)),
    events: deepFreeze({
      subscribe: (callback) => bindTrackedSubscription("verify", verify.events.subscribe, callback),
    }),
  });
}

export function createLedgerFacade(ledger: LedgerBridgeApi): ExposedLedgerApi {
  return deepFreeze({
    current: async () => { throw new Error("agent_method_not_exposed:ledger.current"); },
    timeline: async (input) => normalizeBridgeEnvelope(await ledger.timeline(input)),
    entry: async (input) => normalizeBridgeEnvelope(await ledger.entry(input)),
    heads: async () => normalizeBridgeEnvelope(await ledger.heads()),
    stats: async () => normalizeBridgeEnvelope(await ledger.stats()),
  });
}

export function createDiagnosticsFacade(diagnostics: DiagnosticsBridgeApi): ExposedDiagnosticsApi {
  return deepFreeze({
    runtime: async () => normalizeBridgeEnvelope(await diagnostics.runtime()),
    startup: async () => normalizeBridgeEnvelope(await diagnostics.startup()),
    observability: async () => normalizeBridgeEnvelope(await diagnostics.observability()),
    logTail: async (input) => normalizeBridgeEnvelope(await diagnostics.logTail(input)),
    crashContext: async () => normalizeBridgeEnvelope(await diagnostics.crashContext()),
    export: async (input) => normalizeBridgeEnvelope(await diagnostics.export(input)),
    events: deepFreeze({
      subscribe: (callback) => bindTrackedSubscription("diagnostics", diagnostics.events.subscribe, callback),
    }),
  });
}

export function createAgentFacade(agent: AgentBridgeApi): ExposedAgentApi {
  return deepFreeze({
    health: async () => normalizeBridgeEnvelope(await agent.health()),
    status: async () => normalizeBridgeEnvelope(await agent.status()),
    start: async (input) => normalizeBridgeEnvelope(await agent.start(input)),
    stop: async (input) => normalizeBridgeEnvelope(await agent.stop(input)),
    events: deepFreeze({
      subscribe: (callback) => bindTrackedSubscription("agent", agent.events.subscribe, callback),
    }),
  });
}

export function createCompatibilityFacade(meta: BridgeMeta): ExposedCompatibilityApi {
  const manifest = createExposedApiManifest(meta);
  return deepFreeze({
    manifest: () => manifest,
    isCompatibleBridgeMeta,
    assertCompatibleBridgeMeta,
    hasCapability,
    listCapabilities,
  });
}

export function createExposedApi(bridge: AdjutorixBridge): ExposedApi {
  assertCompatibleBridgeMeta(bridge.meta);
  const manifest = createExposedApiManifest(bridge.meta);

  return deepFreeze({
    manifest,
    runtime: createRuntimeFacade(bridge.runtime),
    workspace: createWorkspaceFacade(bridge.workspace),
    patch: createPatchFacade(bridge.patch),
    verify: createVerifyFacade(bridge.verify),
    ledger: createLedgerFacade(bridge.ledger),
    diagnostics: createDiagnosticsFacade(bridge.diagnostics),
    agent: createAgentFacade(bridge.agent),
    compatibility: createCompatibilityFacade(bridge.meta),
  });
}

// -----------------------------------------------------------------------------
// VALIDATION / FREEZING HELPERS
// -----------------------------------------------------------------------------

export function validateManifest(manifest: ExposedApiManifest): void {
  if (manifest.version !== EXPOSED_API_VERSION) throw new Error("manifest_version_invalid");
  if (manifest.name !== EXPOSED_API_NAME) throw new Error("manifest_name_invalid");
  if (manifest.bridgeVersion !== 1) throw new Error("bridge_version_invalid");
  if (manifest.bridgeName !== "adjutorix.preload") throw new Error("bridge_name_invalid");
}

export function validateExposedApi(api: ExposedApi): void {
  validateManifest(api.manifest);
  if (typeof api.runtime.snapshot !== "function") throw new Error("runtime_snapshot_missing");
  if (typeof api.workspace.open !== "function") throw new Error("workspace_open_missing");
  if (typeof api.patch.preview !== "function") throw new Error("patch_preview_missing");
  if (typeof api.verify.run !== "function") throw new Error("verify_run_missing");
  if (typeof api.ledger.current !== "function") throw new Error("ledger_current_missing");
  if (typeof api.diagnostics.runtime !== "function") throw new Error("diagnostics_runtime_missing");
  if (typeof api.agent.health !== "function") throw new Error("agent_health_missing");
}

export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value as Record<string, unknown>)) {
      const nested = (value as Record<string, unknown>)[key];
      if (nested && typeof nested === "object") deepFreeze(nested);
    }
  }
  return value;
}

// -----------------------------------------------------------------------------
// WINDOW AUGMENTATION
// -----------------------------------------------------------------------------

declare global {
  interface Window {
    adjutorix: AdjutorixBridge;
    adjutorixApi: ExposedApi;
  }
}
