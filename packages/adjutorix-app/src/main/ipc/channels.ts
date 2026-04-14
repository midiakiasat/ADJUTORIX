// @ts-nocheck
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / IPC / channels.ts
 *
 * Canonical IPC channel registry and contract model for the Electron main process.
 *
 * Purpose:
 * - define every sanctioned IPC channel in one place
 * - bind channels to payload/result schemas, authority lanes, and boundary paths
 * - eliminate stringly-typed drift across preload, renderer, main, and smoke tests
 * - expose deterministic metadata for guards, routers, policy projection, and docs
 *
 * This file is the source of truth for:
 * - channel names
 * - request/response shapes
 * - actor expectations
 * - authority routing class
 * - mutation/query semantics
 * - preload exposure namespace/method mapping
 *
 * Hard invariants:
 * - every channel name is globally unique
 * - every channel declares an explicit contract kind
 * - every channel has exactly one authority lane
 * - every renderer-exposed channel maps to one preload namespace+method
 * - identical registry contents produce identical registry hash
 * - no undeclared channel may be referenced elsewhere legitimately
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// JSON TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// TAXONOMY
// -----------------------------------------------------------------------------

export type IpcContractKind = "query" | "command" | "mutation" | "control";
export type IpcAuthorityLane =
  | "query"
  | "local-state"
  | "governed-preview"
  | "governed-apply"
  | "service-control"
  | "workspace-control"
  | "rpc-proxy";

export type IpcActor = "renderer" | "preload" | "main" | "system";

export type IpcPayloadShape =
  | "empty-object"
  | "runtime-get-snapshot"
  | "runtime-get-info"
  | "rpc-invoke"
  | "workspace-open"
  | "workspace-reveal"
  | "patch-preview"
  | "patch-apply"
  | "verify-run"
  | "verify-status"
  | "ledger-current"
  | "smoke-ping";

export type IpcResultShape =
  | "runtime-snapshot"
  | "runtime-info"
  | "rpc-result"
  | "workspace-open-result"
  | "workspace-reveal-result"
  | "patch-preview-result"
  | "patch-apply-result"
  | "verify-run-result"
  | "verify-status-result"
  | "ledger-current-result"
  | "smoke-ping-result";

export type PreloadNamespace =
  | "adjutorix.runtime"
  | "adjutorix.rpc"
  | "adjutorix.workspace"
  | "adjutorix.patch"
  | "adjutorix.verify"
  | "adjutorix.ledger"
  | "adjutorix.internal";

export type PreloadMethod =
  | "getSnapshot"
  | "getRuntimeInfo"
  | "invoke"
  | "open"
  | "revealInShell"
  | "preview"
  | "apply"
  | "run"
  | "status"
  | "current"
  | "ping";

// -----------------------------------------------------------------------------
// CHANNEL NAMES
// -----------------------------------------------------------------------------

export const IPC_CHANNELS = {
  RUNTIME_GET_SNAPSHOT: "adjutorix:runtime:getSnapshot",
  APP_GET_RUNTIME_INFO: "adjutorix:app:getRuntimeInfo",
  RPC_INVOKE: "adjutorix:rpc:invoke",
  WORKSPACE_OPEN: "adjutorix:workspace:open",
  WORKSPACE_REVEAL_IN_SHELL: "adjutorix:workspace:revealInShell",
  PATCH_PREVIEW: "adjutorix:patch:preview",
  PATCH_APPLY: "adjutorix:patch:apply",
  VERIFY_RUN: "adjutorix:verify:run",
  VERIFY_STATUS: "adjutorix:verify:status",
  LEDGER_CURRENT: "adjutorix:ledger:current",
  SMOKE_PING: "__adjutorix_smoke_ping__",
} as const;

export type IpcChannelName = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];

// -----------------------------------------------------------------------------
// SCHEMA DESCRIPTORS
// -----------------------------------------------------------------------------

export type FieldTypeName =
  | "string"
  | "number"
  | "boolean"
  | "object"
  | "array"
  | "null"
  | "json";

export type FieldSchema = {
  type: FieldTypeName | FieldTypeName[];
  required: boolean;
  description: string;
  itemType?: FieldTypeName | FieldTypeName[];
};

export type ShapeSchema = {
  shape: IpcPayloadShape | IpcResultShape;
  description: string;
  fields: Record<string, FieldSchema>;
  allowAdditionalFields: boolean;
};

const SHAPE_SCHEMAS: Record<IpcPayloadShape | IpcResultShape, ShapeSchema> = {
  "empty-object": {
    shape: "empty-object",
    description: "No payload fields are accepted.",
    fields: {},
    allowAdditionalFields: false,
  },
  "runtime-get-snapshot": {
    shape: "runtime-get-snapshot",
    description: "No payload fields are accepted.",
    fields: {},
    allowAdditionalFields: false,
  },
  "runtime-get-info": {
    shape: "runtime-get-info",
    description: "No payload fields are accepted.",
    fields: {},
    allowAdditionalFields: false,
  },
  "rpc-invoke": {
    shape: "rpc-invoke",
    description: "Proxy invocation into approved RPC surface.",
    fields: {
      method: { type: "string", required: true, description: "RPC method name." },
      params: { type: "object", required: true, description: "Structured RPC params object." },
    },
    allowAdditionalFields: false,
  },
  "workspace-open": {
    shape: "workspace-open",
    description: "Open a workspace path in the desktop shell.",
    fields: {
      workspacePath: { type: "string", required: true, description: "Absolute or resolvable workspace path." },
    },
    allowAdditionalFields: false,
  },
  "workspace-reveal": {
    shape: "workspace-reveal",
    description: "Reveal a filesystem path in the native shell.",
    fields: {
      targetPath: { type: "string", required: true, description: "Target path to reveal in shell." },
    },
    allowAdditionalFields: false,
  },
  "patch-preview": {
    shape: "patch-preview",
    description: "Preview a governed patch intent before apply.",
    fields: {
      intent: { type: "object", required: true, description: "Patch intent payload." },
    },
    allowAdditionalFields: false,
  },
  "patch-apply": {
    shape: "patch-apply",
    description: "Apply a previously previewed and verified patch lineage.",
    fields: {
      patchId: { type: "string", required: false, description: "Patch identifier when apply is patch-id driven." },
      patch_id: { type: "string", required: false, description: "Patch identifier (snake_case compatibility)." },
      previewHash: { type: "string", required: false, description: "Approved preview lineage hash." },
    },
    allowAdditionalFields: false,
  },
  "verify-run": {
    shape: "verify-run",
    description: "Run verification on explicit targets and/or preview lineage.",
    fields: {
      targets: { type: "array", required: true, description: "Verification target paths.", itemType: "string" },
      previewHash: { type: "string", required: false, description: "Preview hash to bind verify lineage." },
    },
    allowAdditionalFields: false,
  },
  "verify-status": {
    shape: "verify-status",
    description: "Query verification job status.",
    fields: {
      verifyId: { type: "string", required: false, description: "Verification job id." },
      verify_id: { type: "string", required: false, description: "Verification job id (snake_case compatibility)." },
    },
    allowAdditionalFields: false,
  },
  "ledger-current": {
    shape: "ledger-current",
    description: "No payload fields are accepted.",
    fields: {},
    allowAdditionalFields: false,
  },
  "smoke-ping": {
    shape: "smoke-ping",
    description: "Optional smoke payload for startup contract testing.",
    fields: {},
    allowAdditionalFields: true,
  },
  "runtime-snapshot": {
    shape: "runtime-snapshot",
    description: "Summarized runtime snapshot.",
    fields: {
      environment: { type: "object", required: true, description: "Environment summary." },
      workspace: { type: "object", required: true, description: "Workspace runtime summary." },
      agent: { type: "object", required: true, description: "Agent summary." },
    },
    allowAdditionalFields: false,
  },
  "runtime-info": {
    shape: "runtime-info",
    description: "Application runtime/build info.",
    fields: {
      version: { type: "string", required: true, description: "Application version." },
      platform: { type: "string", required: true, description: "Runtime platform." },
      arch: { type: "string", required: true, description: "Runtime architecture." },
      agentUrl: { type: "string", required: true, description: "Configured agent URL." },
      rendererManifestSha256: { type: "string", required: true, description: "Renderer manifest hash." },
      rendererAssetManifestSha256: { type: "string", required: true, description: "Renderer asset manifest hash." },
    },
    allowAdditionalFields: false,
  },
  "rpc-result": {
    shape: "rpc-result",
    description: "Opaque JSON result from sanctioned RPC proxy call.",
    fields: {},
    allowAdditionalFields: true,
  },
  "workspace-open-result": {
    shape: "workspace-open-result",
    description: "Workspace open result.",
    fields: {
      ok: { type: "boolean", required: true, description: "Whether the operation succeeded." },
      path: { type: "string", required: true, description: "Resolved workspace path." },
    },
    allowAdditionalFields: false,
  },
  "workspace-reveal-result": {
    shape: "workspace-reveal-result",
    description: "Reveal result.",
    fields: {
      ok: { type: "boolean", required: true, description: "Whether the operation succeeded." },
      path: { type: "string", required: true, description: "Resolved revealed path." },
    },
    allowAdditionalFields: false,
  },
  "patch-preview-result": {
    shape: "patch-preview-result",
    description: "Opaque governed preview result.",
    fields: {},
    allowAdditionalFields: true,
  },
  "patch-apply-result": {
    shape: "patch-apply-result",
    description: "Opaque governed apply result.",
    fields: {},
    allowAdditionalFields: true,
  },
  "verify-run-result": {
    shape: "verify-run-result",
    description: "Opaque verify submission result.",
    fields: {},
    allowAdditionalFields: true,
  },
  "verify-status-result": {
    shape: "verify-status-result",
    description: "Opaque verify status result.",
    fields: {},
    allowAdditionalFields: true,
  },
  "ledger-current-result": {
    shape: "ledger-current-result",
    description: "Opaque current ledger view.",
    fields: {},
    allowAdditionalFields: true,
  },
  "smoke-ping-result": {
    shape: "smoke-ping-result",
    description: "Startup smoke ping response.",
    fields: {
      ok: { type: "boolean", required: true, description: "Smoke ping success marker." },
      ts: { type: "number", required: true, description: "Timestamp emitted by main process." },
    },
    allowAdditionalFields: false,
  },
};

// -----------------------------------------------------------------------------
// CHANNEL CONTRACT
// -----------------------------------------------------------------------------

export type IpcChannelContract = {
  schema: 1;
  channel: IpcChannelName;
  contract_kind: IpcContractKind;
  authority_lane: IpcAuthorityLane;
  actor: IpcActor;
  payload_shape: IpcPayloadShape;
  result_shape: IpcResultShape;
  preload: {
    namespace: PreloadNamespace;
    method: PreloadMethod;
    exposed_to_renderer: boolean;
  };
  description: string;
  smoke_covered: boolean;
  hash: string;
};

function contractHash(core: Omit<IpcChannelContract, "hash">): string {
  return sha256(stableJson(core));
}

function makeContract(core: Omit<IpcChannelContract, "hash">): IpcChannelContract {
  return {
    ...core,
    hash: contractHash(core),
  };
}

export const IPC_CHANNEL_REGISTRY: Record<IpcChannelName, IpcChannelContract> = {
  [IPC_CHANNELS.RUNTIME_GET_SNAPSHOT]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.RUNTIME_GET_SNAPSHOT,
    contract_kind: "query",
    authority_lane: "query",
    actor: "renderer",
    payload_shape: "runtime-get-snapshot",
    result_shape: "runtime-snapshot",
    preload: { namespace: "adjutorix.runtime", method: "getSnapshot", exposed_to_renderer: true },
    description: "Return normalized runtime snapshot for renderer state hydration.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.APP_GET_RUNTIME_INFO]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.APP_GET_RUNTIME_INFO,
    contract_kind: "query",
    authority_lane: "query",
    actor: "renderer",
    payload_shape: "runtime-get-info",
    result_shape: "runtime-info",
    preload: { namespace: "adjutorix.runtime", method: "getRuntimeInfo", exposed_to_renderer: true },
    description: "Return build/runtime info for UI and diagnostics surfaces.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.RPC_INVOKE]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.RPC_INVOKE,
    contract_kind: "command",
    authority_lane: "rpc-proxy",
    actor: "renderer",
    payload_shape: "rpc-invoke",
    result_shape: "rpc-result",
    preload: { namespace: "adjutorix.rpc", method: "invoke", exposed_to_renderer: true },
    description: "Invoke sanctioned RPC methods through guarded main-process proxy.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.WORKSPACE_OPEN]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.WORKSPACE_OPEN,
    contract_kind: "mutation",
    authority_lane: "workspace-control",
    actor: "renderer",
    payload_shape: "workspace-open",
    result_shape: "workspace-open-result",
    preload: { namespace: "adjutorix.workspace", method: "open", exposed_to_renderer: true },
    description: "Request opening a workspace in the desktop runtime.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.WORKSPACE_REVEAL_IN_SHELL]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.WORKSPACE_REVEAL_IN_SHELL,
    contract_kind: "control",
    authority_lane: "workspace-control",
    actor: "renderer",
    payload_shape: "workspace-reveal",
    result_shape: "workspace-reveal-result",
    preload: { namespace: "adjutorix.workspace", method: "revealInShell", exposed_to_renderer: true },
    description: "Reveal a path in the platform-native file manager.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.PATCH_PREVIEW]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.PATCH_PREVIEW,
    contract_kind: "mutation",
    authority_lane: "governed-preview",
    actor: "renderer",
    payload_shape: "patch-preview",
    result_shape: "patch-preview-result",
    preload: { namespace: "adjutorix.patch", method: "preview", exposed_to_renderer: true },
    description: "Request governed patch preview for an explicit intent.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.PATCH_APPLY]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.PATCH_APPLY,
    contract_kind: "mutation",
    authority_lane: "governed-apply",
    actor: "renderer",
    payload_shape: "patch-apply",
    result_shape: "patch-apply-result",
    preload: { namespace: "adjutorix.patch", method: "apply", exposed_to_renderer: true },
    description: "Request governed patch apply bound to approved preview lineage.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.VERIFY_RUN]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.VERIFY_RUN,
    contract_kind: "mutation",
    authority_lane: "governed-preview",
    actor: "renderer",
    payload_shape: "verify-run",
    result_shape: "verify-run-result",
    preload: { namespace: "adjutorix.verify", method: "run", exposed_to_renderer: true },
    description: "Run verification against explicit targets and optional preview lineage.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.VERIFY_STATUS]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.VERIFY_STATUS,
    contract_kind: "query",
    authority_lane: "query",
    actor: "renderer",
    payload_shape: "verify-status",
    result_shape: "verify-status-result",
    preload: { namespace: "adjutorix.verify", method: "status", exposed_to_renderer: true },
    description: "Read verification job status.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.LEDGER_CURRENT]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.LEDGER_CURRENT,
    contract_kind: "query",
    authority_lane: "query",
    actor: "renderer",
    payload_shape: "ledger-current",
    result_shape: "ledger-current-result",
    preload: { namespace: "adjutorix.ledger", method: "current", exposed_to_renderer: true },
    description: "Read current ledger snapshot/view.",
    smoke_covered: false,
  }),
  [IPC_CHANNELS.SMOKE_PING]: makeContract({
    schema: 1,
    channel: IPC_CHANNELS.SMOKE_PING,
    contract_kind: "control",
    authority_lane: "service-control",
    actor: "renderer",
    payload_shape: "smoke-ping",
    result_shape: "smoke-ping-result",
    preload: { namespace: "adjutorix.internal", method: "ping", exposed_to_renderer: false },
    description: "Internal smoke-test health ping for startup harness.",
    smoke_covered: true,
  }),
};

// -----------------------------------------------------------------------------
// REGISTRY SUMMARY
// -----------------------------------------------------------------------------

export type IpcRegistrySummary = {
  schema: 1;
  channel_count: number;
  renderer_exposed_count: number;
  smoke_covered_count: number;
  hash: string;
};

export function summarizeIpcRegistry(): IpcRegistrySummary {
  const contracts = Object.values(IPC_CHANNEL_REGISTRY).sort((a, b) => a.channel.localeCompare(b.channel));
  const core = {
    schema: 1 as const,
    channel_count: contracts.length,
    renderer_exposed_count: contracts.filter((c) => c.preload.exposed_to_renderer).length,
    smoke_covered_count: contracts.filter((c) => c.smoke_covered).length,
  };

  return {
    ...core,
    hash: sha256(stableJson({ ...core, contracts })),
  };
}

// -----------------------------------------------------------------------------
// LOOKUPS
// -----------------------------------------------------------------------------

export function getIpcContract(channel: IpcChannelName): IpcChannelContract {
  const contract = IPC_CHANNEL_REGISTRY[channel];
  if (!contract) {
    throw new Error(`main:ipc:channels:unknown_channel:${channel}`);
  }
  return contract;
}

export function isKnownIpcChannel(channel: string): channel is IpcChannelName {
  return channel in IPC_CHANNEL_REGISTRY;
}

export function contractsByNamespace(namespace: PreloadNamespace): IpcChannelContract[] {
  return Object.values(IPC_CHANNEL_REGISTRY)
    .filter((contract) => contract.preload.namespace === namespace)
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

export function rendererExposedContracts(): IpcChannelContract[] {
  return Object.values(IPC_CHANNEL_REGISTRY)
    .filter((contract) => contract.preload.exposed_to_renderer)
    .sort((a, b) => a.channel.localeCompare(b.channel));
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateShapeSchema(shape: ShapeSchema): void {
  if (!shape.shape || !shape.description) {
    throw new Error("main:ipc:channels:invalid_shape_schema");
  }
}

export function validateIpcContract(contract: IpcChannelContract): void {
  const core: Omit<IpcChannelContract, "hash"> = {
    schema: contract.schema,
    channel: contract.channel,
    contract_kind: contract.contract_kind,
    authority_lane: contract.authority_lane,
    actor: contract.actor,
    payload_shape: contract.payload_shape,
    result_shape: contract.result_shape,
    preload: contract.preload,
    description: contract.description,
    smoke_covered: contract.smoke_covered,
  };

  if (contract.schema !== 1) {
    throw new Error(`main:ipc:channels:invalid_contract_schema:${contract.channel}`);
  }
  if (contract.hash !== contractHash(core)) {
    throw new Error(`main:ipc:channels:contract_hash_drift:${contract.channel}`);
  }
  if (!(contract.payload_shape in SHAPE_SCHEMAS)) {
    throw new Error(`main:ipc:channels:unknown_payload_shape:${contract.channel}`);
  }
  if (!(contract.result_shape in SHAPE_SCHEMAS)) {
    throw new Error(`main:ipc:channels:unknown_result_shape:${contract.channel}`);
  }
}

export function validateIpcRegistry(): void {
  const seen = new Set<string>();

  for (const contract of Object.values(IPC_CHANNEL_REGISTRY)) {
    if (seen.has(contract.channel)) {
      throw new Error(`main:ipc:channels:duplicate_channel:${contract.channel}`);
    }
    seen.add(contract.channel);
    validateIpcContract(contract);
  }

  for (const shape of Object.values(SHAPE_SCHEMAS)) {
    validateShapeSchema(shape);
  }
}

// -----------------------------------------------------------------------------
// SERIALIZATION / DOC-LIKE PROJECTION
// -----------------------------------------------------------------------------

export function serializeIpcRegistry(): string {
  validateIpcRegistry();
  return stableJson({
    summary: summarizeIpcRegistry(),
    contracts: Object.values(IPC_CHANNEL_REGISTRY).sort((a, b) => a.channel.localeCompare(b.channel)),
    shapes: Object.values(SHAPE_SCHEMAS).sort((a, b) => a.shape.localeCompare(b.shape)),
  });
}

export function preloadExposureMap(): Record<PreloadNamespace, Array<{ method: PreloadMethod; channel: IpcChannelName }>> {
  const result: Record<string, Array<{ method: PreloadMethod; channel: IpcChannelName }>> = {};

  for (const contract of rendererExposedContracts()) {
    const ns = contract.preload.namespace;
    if (!result[ns]) result[ns] = [];
    result[ns].push({
      method: contract.preload.method,
      channel: contract.channel,
    });
  }

  for (const ns of Object.keys(result)) {
    result[ns].sort((a, b) => a.method.localeCompare(b.method) || a.channel.localeCompare(b.channel));
  }

  return result as Record<PreloadNamespace, Array<{ method: PreloadMethod; channel: IpcChannelName }>>;
}
