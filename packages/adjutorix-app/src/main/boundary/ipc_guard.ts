import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / ipc_guard.ts
 *
 * Hard IPC ingress guard for the Electron main process.
 *
 * This module sits *before* application handlers and mutation boundaries.
 * Its job is not to execute business logic, but to:
 * - validate channel identity
 * - validate payload envelope shape
 * - enforce allow-listed IPC contracts
 * - normalize renderer-origin metadata deterministically
 * - block privilege escalation through malformed or undeclared channels
 * - emit explicit allow/deny audit decisions
 *
 * Position in the stack:
 *
 *   renderer -> preload bridge -> ipc_guard -> handler routing -> mutation_boundary
 *
 * Hard invariants:
 * - deny by default for unknown channels
 * - payload must be object-shaped unless explicitly declared otherwise
 * - every allowed channel has a declared contract kind
 * - no raw Electron event object crosses the guard boundary
 * - identical semantic requests produce identical normalized request hashes
 * - guard decisions are auditable and serialization-stable
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

export type IpcActor = "renderer" | "preload" | "main";
export type IpcDecision = "allow" | "deny";
export type IpcContractKind = "query" | "command" | "mutation" | "control";

export type RawIpcRequest = {
  channel: string;
  payload?: unknown;
  actor?: string;
  trace_id?: string;
  request_id?: string;
  frame_url?: string;
};

export type CanonicalIpcRequest = {
  schema: 1;
  channel: AllowedIpcChannel;
  contract_kind: IpcContractKind;
  actor: IpcActor;
  payload: Record<string, JsonValue>;
  trace_id?: string;
  request_id?: string;
  frame_url?: string;
  hash: string;
};

export type IpcGuardAuditRecord = {
  schema: 1;
  ts_ms: number;
  decision: IpcDecision;
  channel?: AllowedIpcChannel | string;
  contract_kind?: IpcContractKind;
  actor?: IpcActor;
  reason: string;
  request_hash?: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type IpcGuardContext = {
  now?: () => number;
  allowExternalNavigation?: boolean;
  allowedFrameOrigins?: string[];
  audit?: (record: IpcGuardAuditRecord) => void;
};

export type RoutedIpcRequest = {
  request: CanonicalIpcRequest;
  route: string;
};

export type AllowedIpcChannel =
  | "adjutorix:runtime:getSnapshot"
  | "adjutorix:rpc:invoke"
  | "adjutorix:workspace:open"
  | "adjutorix:workspace:revealInShell"
  | "adjutorix:patch:preview"
  | "adjutorix:patch:apply"
  | "adjutorix:verify:run"
  | "adjutorix:verify:status"
  | "adjutorix:ledger:current"
  | "adjutorix:app:getRuntimeInfo"
  | "__adjutorix_smoke_ping__";

// -----------------------------------------------------------------------------
// REGISTRY
// -----------------------------------------------------------------------------

type ChannelSpec = {
  contract_kind: IpcContractKind;
  route: string;
  payload_shape: "object" | "empty-object";
  allow_from_external_frame: boolean;
};

const CHANNEL_SPECS: Record<AllowedIpcChannel, ChannelSpec> = {
  "adjutorix:runtime:getSnapshot": {
    contract_kind: "query",
    route: "runtime.snapshot",
    payload_shape: "empty-object",
    allow_from_external_frame: false,
  },
  "adjutorix:rpc:invoke": {
    contract_kind: "command",
    route: "rpc.invoke",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:workspace:open": {
    contract_kind: "mutation",
    route: "workspace.open",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:workspace:revealInShell": {
    contract_kind: "control",
    route: "workspace.reveal_in_shell",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:patch:preview": {
    contract_kind: "mutation",
    route: "patch.preview",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:patch:apply": {
    contract_kind: "mutation",
    route: "patch.apply",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:verify:run": {
    contract_kind: "mutation",
    route: "verify.run",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:verify:status": {
    contract_kind: "query",
    route: "verify.status",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
  "adjutorix:ledger:current": {
    contract_kind: "query",
    route: "ledger.current",
    payload_shape: "empty-object",
    allow_from_external_frame: false,
  },
  "adjutorix:app:getRuntimeInfo": {
    contract_kind: "query",
    route: "app.runtime_info",
    payload_shape: "empty-object",
    allow_from_external_frame: false,
  },
  "__adjutorix_smoke_ping__": {
    contract_kind: "control",
    route: "smoke.ping",
    payload_shape: "object",
    allow_from_external_frame: false,
  },
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:boundary:ipc_guard:${message}`);
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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isAllowedChannel(value: string): value is AllowedIpcChannel {
  return value in CHANNEL_SPECS;
}

function isActor(value: string): value is IpcActor {
  return value === "renderer" || value === "preload" || value === "main";
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
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return String(value);
}

function normalizePayload(payload: unknown, shape: ChannelSpec["payload_shape"]): Record<string, JsonValue> {
  if (payload === undefined) {
    assert(shape === "empty-object", "payload_missing_for_nonempty_channel");
    return {};
  }

  assert(typeof payload === "object" && payload !== null && !Array.isArray(payload), "payload_not_object");
  const normalized = normalizeJson(payload) as Record<string, JsonValue>;

  if (shape === "empty-object") {
    assert(Object.keys(normalized).length === 0, "payload_must_be_empty_object");
  }

  return normalized;
}

function buildRequestHash(
  channel: AllowedIpcChannel,
  contract_kind: IpcContractKind,
  actor: IpcActor,
  payload: Record<string, JsonValue>,
  trace_id?: string,
  request_id?: string,
  frame_url?: string,
): string {
  return sha256(
    stableJson({
      schema: 1,
      channel,
      contract_kind,
      actor,
      payload,
      ...(trace_id ? { trace_id } : {}),
      ...(request_id ? { request_id } : {}),
      ...(frame_url ? { frame_url } : {}),
    }),
  );
}

function buildAuditHash(record: Omit<IpcGuardAuditRecord, "hash">): string {
  return sha256(stableJson(record));
}

function emitAudit(
  ctx: IpcGuardContext | undefined,
  record: Omit<IpcGuardAuditRecord, "hash">,
): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...record,
    hash: buildAuditHash(record),
  });
}

function originAllowed(frame_url: string | undefined, ctx: IpcGuardContext | undefined): boolean {
  if (!frame_url) return true;

  const allowExternal = ctx?.allowExternalNavigation ?? false;
  if (allowExternal) return true;

  const allowedOrigins = ctx?.allowedFrameOrigins ?? ["file://"];
  return allowedOrigins.some((origin) => frame_url.startsWith(origin));
}

// -----------------------------------------------------------------------------
// NORMALIZATION
// -----------------------------------------------------------------------------

export function normalizeIpcRequest(raw: RawIpcRequest, ctx?: IpcGuardContext): CanonicalIpcRequest {
  assert(typeof raw.channel === "string" && raw.channel.length > 0, "channel_missing");
  assert(isAllowedChannel(raw.channel), `channel_not_allowed:${raw.channel}`);

  const spec = CHANNEL_SPECS[raw.channel];
  const actorRaw = raw.actor ?? "renderer";
  assert(typeof actorRaw === "string" && isActor(actorRaw), `actor_not_allowed:${String(actorRaw)}`);

  const trace_id = raw.trace_id && String(raw.trace_id).length > 0 ? String(raw.trace_id) : undefined;
  const request_id = raw.request_id && String(raw.request_id).length > 0 ? String(raw.request_id) : undefined;
  const frame_url = raw.frame_url && String(raw.frame_url).length > 0 ? String(raw.frame_url) : undefined;
  const payload = normalizePayload(raw.payload, spec.payload_shape);

  const request: CanonicalIpcRequest = {
    schema: 1,
    channel: raw.channel,
    contract_kind: spec.contract_kind,
    actor: actorRaw,
    payload,
    ...(trace_id ? { trace_id } : {}),
    ...(request_id ? { request_id } : {}),
    ...(frame_url ? { frame_url } : {}),
    hash: buildRequestHash(raw.channel, spec.contract_kind, actorRaw, payload, trace_id, request_id, frame_url),
  };

  emitAudit(ctx, {
    schema: 1,
    ts_ms: (ctx?.now ?? Date.now)(),
    decision: "allow",
    channel: request.channel,
    contract_kind: request.contract_kind,
    actor: request.actor,
    reason: "request_normalized",
    request_hash: request.hash,
    detail: {
      payload_keys: Object.keys(request.payload).sort(),
    },
  });

  return request;
}

// -----------------------------------------------------------------------------
// AUTHORIZATION / ROUTING
// -----------------------------------------------------------------------------

export function guardAndRouteIpcRequest(raw: RawIpcRequest, ctx?: IpcGuardContext): RoutedIpcRequest {
  const now = ctx?.now ?? Date.now;

  const deny = (
    reason: string,
    detail: Record<string, JsonValue>,
    channel?: string,
    actor?: IpcActor,
    contract_kind?: IpcContractKind,
    request_hash?: string,
  ): never => {
    emitAudit(ctx, {
      schema: 1,
      ts_ms: now(),
      decision: "deny",
      ...(channel ? { channel } : {}),
      ...(contract_kind ? { contract_kind } : {}),
      ...(actor ? { actor } : {}),
      reason,
      ...(request_hash ? { request_hash } : {}),
      detail,
    });
    throw new Error(`ipc_guard_denied:${reason}`);
  };

  if (!(typeof raw.channel === "string" && raw.channel.length > 0)) {
    deny("channel_missing", {});
  }
  if (!isAllowedChannel(raw.channel)) {
    deny("channel_not_allowlisted", { attemptedChannel: raw.channel }, raw.channel);
  }

  const request = normalizeIpcRequest(raw, ctx);
  const spec = CHANNEL_SPECS[request.channel];

  if (!originAllowed(request.frame_url, ctx)) {
    deny(
      "frame_origin_not_allowed",
      { frame_url: request.frame_url ?? "<unknown>" },
      request.channel,
      request.actor,
      request.contract_kind,
      request.hash,
    );
  }

  if (!spec.allow_from_external_frame && request.frame_url && !originAllowed(request.frame_url, ctx)) {
    deny(
      "channel_forbidden_for_frame_origin",
      { frame_url: request.frame_url },
      request.channel,
      request.actor,
      request.contract_kind,
      request.hash,
    );
  }

  // Contract-specific shape checks
  switch (request.channel) {
    case "adjutorix:rpc:invoke": {
      const method = request.payload.method;
      const params = request.payload.params;
      if (!(typeof method === "string" && method.length > 0)) {
        deny("rpc_method_invalid", { method: method as JsonValue }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      if (!(params && typeof params === "object" && !Array.isArray(params))) {
        deny("rpc_params_invalid", { paramsType: Array.isArray(params) ? "array" : typeof params }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:workspace:open": {
      const workspacePath = request.payload.workspacePath;
      if (!(typeof workspacePath === "string" && workspacePath.length > 0)) {
        deny("workspace_path_invalid", { workspacePath: workspacePath as JsonValue }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:workspace:revealInShell": {
      const targetPath = request.payload.targetPath;
      if (!(typeof targetPath === "string" && targetPath.length > 0)) {
        deny("reveal_target_path_invalid", { targetPath: targetPath as JsonValue }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:patch:preview": {
      const intent = request.payload.intent;
      if (!(intent && typeof intent === "object" && !Array.isArray(intent))) {
        deny("patch_preview_intent_invalid", { intentType: Array.isArray(intent) ? "array" : typeof intent }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:patch:apply": {
      const patchId = request.payload.patchId ?? request.payload.patch_id;
      if (!(typeof patchId === "string" && patchId.length > 0)) {
        deny("patch_id_invalid", { patchId: patchId as JsonValue }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:verify:run": {
      const targets = request.payload.targets;
      if (!Array.isArray(targets)) {
        deny("verify_targets_invalid", { targetsType: typeof targets }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:verify:status": {
      const verifyId = request.payload.verifyId ?? request.payload.verify_id;
      if (!(typeof verifyId === "string" && verifyId.length > 0)) {
        deny("verify_id_invalid", { verifyId: verifyId as JsonValue }, request.channel, request.actor, request.contract_kind, request.hash);
      }
      break;
    }

    case "adjutorix:runtime:getSnapshot":
    case "adjutorix:ledger:current":
    case "adjutorix:app:getRuntimeInfo":
    case "__adjutorix_smoke_ping__":
      break;

    default: {
      const exhaustive: never = request.channel;
      deny("unhandled_channel", { channel: exhaustive as never }, request.channel, request.actor, request.contract_kind, request.hash);
    }
  }

  emitAudit(ctx, {
    schema: 1,
    ts_ms: now(),
    decision: "allow",
    channel: request.channel,
    contract_kind: request.contract_kind,
    actor: request.actor,
    reason: "request_guarded_and_routed",
    request_hash: request.hash,
    detail: {
      route: spec.route,
    },
  });

  return {
    request,
    route: spec.route,
  };
}

// -----------------------------------------------------------------------------
// SERIALIZATION / VALIDATION
// -----------------------------------------------------------------------------

export function validateCanonicalIpcRequest(request: CanonicalIpcRequest): void {
  assert(request.schema === 1, "request_schema_invalid");
  assert(isAllowedChannel(request.channel), `request_channel_invalid:${request.channel}`);
  assert(isActor(request.actor), `request_actor_invalid:${request.actor}`);
  assert(typeof request.hash === "string" && request.hash.length > 0, "request_hash_invalid");

  const spec = CHANNEL_SPECS[request.channel];
  assert(request.contract_kind === spec.contract_kind, "request_contract_kind_mismatch");

  const expectedHash = buildRequestHash(
    request.channel,
    request.contract_kind,
    request.actor,
    request.payload,
    request.trace_id,
    request.request_id,
    request.frame_url,
  );
  assert(expectedHash === request.hash, "request_hash_drift");
}

export function serializeCanonicalIpcRequest(request: CanonicalIpcRequest): string {
  validateCanonicalIpcRequest(request);
  return stableJson(request);
}

export function validateIpcGuardAuditRecord(record: IpcGuardAuditRecord): void {
  assert(record.schema === 1, "audit_schema_invalid");
  assert(record.decision === "allow" || record.decision === "deny", "audit_decision_invalid");
  assert(typeof record.reason === "string" && record.reason.length > 0, "audit_reason_invalid");

  const core: Omit<IpcGuardAuditRecord, "hash"> = {
    schema: record.schema,
    ts_ms: record.ts_ms,
    decision: record.decision,
    ...(record.channel ? { channel: record.channel } : {}),
    ...(record.contract_kind ? { contract_kind: record.contract_kind } : {}),
    ...(record.actor ? { actor: record.actor } : {}),
    reason: record.reason,
    ...(record.request_hash ? { request_hash: record.request_hash } : {}),
    detail: record.detail,
  };

  assert(buildAuditHash(core) === record.hash, "audit_hash_drift");
}
