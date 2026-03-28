import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / mutation_boundary.ts
 *
 * Hard mutation authority boundary for the Electron main process.
 *
 * This module defines the only sanctioned route from renderer-originated intent
 * to state-changing operations. It is intentionally strict, deny-by-default,
 * and split into explicit phases:
 *
 *   renderer intent -> normalize -> authorize -> preview/verify gate -> execute
 *
 * Responsibilities:
 * - normalize and canonicalize inbound mutation intents
 * - reject implicit authority and undeclared mutation types
 * - separate previewable operations from directly executable no-op/system ops
 * - enforce capability and workspace guards before execution
 * - require preview/verify lineage for destructive/apply-class mutations
 * - emit deterministic audit records for every allow/deny decision
 * - provide a composable boundary API to runtime/bootstrap/wiring layers
 *
 * Hard invariants:
 * - deny by default
 * - no mutation executes from raw renderer payloads
 * - identical semantic intents produce identical intent hashes
 * - apply-class operations require explicit approved preview lineage
 * - every boundary decision is auditable
 * - capability evaluation is pure and side-effect free
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

export type MutationActor = "renderer" | "menu" | "system" | "main";
export type MutationDecision = "allow" | "deny";
export type MutationStage = "normalize" | "authorize" | "preview" | "verify" | "execute";

export type MutationKind =
  | "workspace.open"
  | "workspace.close"
  | "patch.preview"
  | "patch.apply"
  | "verify.run"
  | "settings.update"
  | "window.state.update"
  | "diagnostics.export"
  | "agent.start"
  | "agent.stop";

export type MutationIntentPayload = Record<string, JsonValue>;

export type RawMutationIntent = {
  kind: string;
  payload?: Record<string, unknown>;
  actor?: string;
  trace_id?: string;
  idempotency_key?: string;
};

export type CanonicalMutationIntent = {
  schema: 1;
  kind: MutationKind;
  actor: MutationActor;
  payload: MutationIntentPayload;
  trace_id?: string;
  idempotency_key?: string;
  hash: string;
};

export type MutationCapabilities = {
  workspaceOpen: boolean;
  workspaceClose: boolean;
  patchPreview: boolean;
  patchApply: boolean;
  verifyRun: boolean;
  settingsUpdate: boolean;
  windowStateUpdate: boolean;
  diagnosticsExport: boolean;
  agentStart: boolean;
  agentStop: boolean;
};

export type MutationEnvironment = {
  workspacePath: string | null;
  hasPendingPreview: boolean;
  approvedPreviewHash: string | null;
  verifyPassedForPreviewHash: string | null;
  managedAgentRunning: boolean;
  settingsMutable: boolean;
  windowStateMutable: boolean;
};

export type MutationAuditRecord = {
  schema: 1;
  ts_ms: number;
  decision: MutationDecision;
  stage: MutationStage;
  reason: string;
  intent_hash?: string;
  kind?: MutationKind;
  actor?: MutationActor;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type MutationBoundaryContext = {
  capabilities: MutationCapabilities;
  environment: MutationEnvironment;
  now?: () => number;
  audit?: (record: MutationAuditRecord) => void;
};

export type AuthorizedMutation = {
  intent: CanonicalMutationIntent;
  execution_class: "readlike-sideeffect" | "preview" | "apply" | "verify" | "local-state" | "service-control";
};

export type MutationExecutionHandlers = {
  workspaceOpen: (payload: MutationIntentPayload) => Promise<JsonValue>;
  workspaceClose: (payload: MutationIntentPayload) => Promise<JsonValue>;
  patchPreview: (payload: MutationIntentPayload) => Promise<JsonValue>;
  patchApply: (payload: MutationIntentPayload) => Promise<JsonValue>;
  verifyRun: (payload: MutationIntentPayload) => Promise<JsonValue>;
  settingsUpdate: (payload: MutationIntentPayload) => Promise<JsonValue>;
  windowStateUpdate: (payload: MutationIntentPayload) => Promise<JsonValue>;
  diagnosticsExport: (payload: MutationIntentPayload) => Promise<JsonValue>;
  agentStart: (payload: MutationIntentPayload) => Promise<JsonValue>;
  agentStop: (payload: MutationIntentPayload) => Promise<JsonValue>;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const ALLOWED_KINDS: readonly MutationKind[] = [
  "workspace.open",
  "workspace.close",
  "patch.preview",
  "patch.apply",
  "verify.run",
  "settings.update",
  "window.state.update",
  "diagnostics.export",
  "agent.start",
  "agent.stop",
] as const;

const ALLOWED_ACTORS: readonly MutationActor[] = ["renderer", "menu", "system", "main"] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:boundary:mutation_boundary:${message}`);
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function normalizePayload(payload: unknown): MutationIntentPayload {
  if (payload === undefined) return {};
  assert(isPlainObject(payload), "payload_not_object");
  return normalizeJson(payload) as MutationIntentPayload;
}

function isMutationKind(value: string): value is MutationKind {
  return (ALLOWED_KINDS as readonly string[]).includes(value);
}

function isMutationActor(value: string): value is MutationActor {
  return (ALLOWED_ACTORS as readonly string[]).includes(value);
}

function buildIntentHash(kind: MutationKind, actor: MutationActor, payload: MutationIntentPayload, trace_id?: string, idempotency_key?: string): string {
  return sha256(
    stableJson({
      schema: 1,
      kind,
      actor,
      payload,
      ...(trace_id ? { trace_id } : {}),
      ...(idempotency_key ? { idempotency_key } : {}),
    }),
  );
}

function buildAuditHash(record: Omit<MutationAuditRecord, "hash">): string {
  return sha256(stableJson(record));
}

function executionClassFor(kind: MutationKind): AuthorizedMutation["execution_class"] {
  switch (kind) {
    case "workspace.open":
    case "workspace.close":
      return "readlike-sideeffect";
    case "patch.preview":
      return "preview";
    case "patch.apply":
      return "apply";
    case "verify.run":
      return "verify";
    case "settings.update":
    case "window.state.update":
      return "local-state";
    case "diagnostics.export":
    case "agent.start":
    case "agent.stop":
      return "service-control";
    default: {
      const exhaustive: never = kind;
      throw new Error(`unhandled_execution_class:${exhaustive}`);
    }
  }
}

function emitAudit(
  ctx: MutationBoundaryContext,
  decision: MutationDecision,
  stage: MutationStage,
  reason: string,
  detail: Record<string, JsonValue>,
  intent?: CanonicalMutationIntent,
): void {
  const now = ctx.now ?? Date.now;
  const recordCore: Omit<MutationAuditRecord, "hash"> = {
    schema: 1,
    ts_ms: now(),
    decision,
    stage,
    reason,
    ...(intent ? {
      intent_hash: intent.hash,
      kind: intent.kind,
      actor: intent.actor,
    } : {}),
    detail,
  };

  ctx.audit?.({
    ...recordCore,
    hash: buildAuditHash(recordCore),
  });
}

// -----------------------------------------------------------------------------
// NORMALIZATION
// -----------------------------------------------------------------------------

export function normalizeMutationIntent(raw: RawMutationIntent, ctx?: MutationBoundaryContext): CanonicalMutationIntent {
  assert(typeof raw.kind === "string" && raw.kind.length > 0, "intent_kind_missing");
  assert(isMutationKind(raw.kind), `intent_kind_denied:${raw.kind}`);

  const actor = raw.actor ?? "renderer";
  assert(typeof actor === "string" && isMutationActor(actor), `intent_actor_denied:${String(actor)}`);

  const payload = normalizePayload(raw.payload);
  const trace_id = raw.trace_id && String(raw.trace_id).length > 0 ? String(raw.trace_id) : undefined;
  const idempotency_key = raw.idempotency_key && String(raw.idempotency_key).length > 0 ? String(raw.idempotency_key) : undefined;

  const intent: CanonicalMutationIntent = {
    schema: 1,
    kind: raw.kind,
    actor,
    payload,
    ...(trace_id ? { trace_id } : {}),
    ...(idempotency_key ? { idempotency_key } : {}),
    hash: buildIntentHash(raw.kind, actor, payload, trace_id, idempotency_key),
  };

  if (ctx) {
    emitAudit(ctx, "allow", "normalize", "intent_normalized", { payload_keys: Object.keys(payload).sort() }, intent);
  }

  return intent;
}

// -----------------------------------------------------------------------------
// AUTHORIZATION
// -----------------------------------------------------------------------------

export function authorizeMutation(intent: CanonicalMutationIntent, ctx: MutationBoundaryContext): AuthorizedMutation {
  const caps = ctx.capabilities;
  const env = ctx.environment;

  const deny = (reason: string, detail: Record<string, JsonValue> = {}): never => {
    emitAudit(ctx, "deny", "authorize", reason, detail, intent);
    throw new Error(`mutation_denied:${reason}`);
  };

  switch (intent.kind) {
    case "workspace.open": {
      if (!caps.workspaceOpen) deny("capability_workspace_open_missing");
      const workspacePath = intent.payload.workspacePath;
      if (!(typeof workspacePath === "string" && workspacePath.length > 0)) {
        deny("workspace_path_invalid", { workspacePath: workspacePath as JsonValue });
      }
      break;
    }

    case "workspace.close": {
      if (!caps.workspaceClose) deny("capability_workspace_close_missing");
      if (!env.workspacePath) deny("workspace_not_open");
      break;
    }

    case "patch.preview": {
      if (!caps.patchPreview) deny("capability_patch_preview_missing");
      if (!env.workspacePath) deny("workspace_required_for_preview");
      const intentPayload = intent.payload.intent;
      if (!(intentPayload && typeof intentPayload === "object" && !Array.isArray(intentPayload))) {
        deny("preview_intent_missing", { hasIntent: Boolean(intentPayload) });
      }
      break;
    }

    case "patch.apply": {
      if (!caps.patchApply) deny("capability_patch_apply_missing");
      if (!env.workspacePath) deny("workspace_required_for_apply");
      if (!env.hasPendingPreview) deny("preview_required_for_apply");
      if (!env.approvedPreviewHash) deny("approved_preview_hash_missing");
      if (env.verifyPassedForPreviewHash !== env.approvedPreviewHash) {
        deny("verify_not_bound_to_preview", {
          approvedPreviewHash: env.approvedPreviewHash,
          verifyPassedForPreviewHash: env.verifyPassedForPreviewHash,
        });
      }
      const previewHash = intent.payload.previewHash;
      if (!(typeof previewHash === "string" && previewHash === env.approvedPreviewHash)) {
        deny("preview_hash_mismatch", {
          suppliedPreviewHash: previewHash as JsonValue,
          approvedPreviewHash: env.approvedPreviewHash,
        });
      }
      break;
    }

    case "verify.run": {
      if (!caps.verifyRun) deny("capability_verify_run_missing");
      if (!env.workspacePath) deny("workspace_required_for_verify");
      const previewHash = intent.payload.previewHash;
      if (!(typeof previewHash === "string" && previewHash.length > 0)) {
        deny("verify_preview_hash_missing", { previewHash: previewHash as JsonValue });
      }
      break;
    }

    case "settings.update": {
      if (!caps.settingsUpdate) deny("capability_settings_update_missing");
      if (!env.settingsMutable) deny("settings_mutation_disabled");
      break;
    }

    case "window.state.update": {
      if (!caps.windowStateUpdate) deny("capability_window_state_update_missing");
      if (!env.windowStateMutable) deny("window_state_mutation_disabled");
      break;
    }

    case "diagnostics.export": {
      if (!caps.diagnosticsExport) deny("capability_diagnostics_export_missing");
      break;
    }

    case "agent.start": {
      if (!caps.agentStart) deny("capability_agent_start_missing");
      if (env.managedAgentRunning) deny("agent_already_running");
      break;
    }

    case "agent.stop": {
      if (!caps.agentStop) deny("capability_agent_stop_missing");
      if (!env.managedAgentRunning) deny("agent_not_running");
      break;
    }

    default: {
      const exhaustive: never = intent.kind;
      deny("unknown_intent_kind", { kind: exhaustive as never });
    }
  }

  const authorized: AuthorizedMutation = {
    intent,
    execution_class: executionClassFor(intent.kind),
  };

  emitAudit(ctx, "allow", "authorize", "intent_authorized", { execution_class: authorized.execution_class }, intent);
  return authorized;
}

// -----------------------------------------------------------------------------
// EXECUTION
// -----------------------------------------------------------------------------

export async function executeAuthorizedMutation(
  authorized: AuthorizedMutation,
  handlers: MutationExecutionHandlers,
  ctx?: MutationBoundaryContext,
): Promise<JsonValue> {
  const { intent } = authorized;

  const beginAudit = () => {
    if (!ctx) return;
    emitAudit(ctx, "allow", "execute", "execution_begin", { execution_class: authorized.execution_class }, intent);
  };

  const successAudit = (result: JsonValue) => {
    if (!ctx) return;
    emitAudit(ctx, "allow", "execute", "execution_success", {
      result_type: Array.isArray(result) ? "array" : result === null ? "null" : typeof result,
    }, intent);
  };

  const failureAudit = (error: unknown) => {
    if (!ctx) return;
    emitAudit(ctx, "deny", "execute", "execution_failure", {
      error: error instanceof Error ? error.message : String(error),
    }, intent);
  };

  beginAudit();

  try {
    let result: JsonValue;

    switch (intent.kind) {
      case "workspace.open":
        result = await handlers.workspaceOpen(intent.payload);
        break;
      case "workspace.close":
        result = await handlers.workspaceClose(intent.payload);
        break;
      case "patch.preview":
        result = await handlers.patchPreview(intent.payload);
        break;
      case "patch.apply":
        result = await handlers.patchApply(intent.payload);
        break;
      case "verify.run":
        result = await handlers.verifyRun(intent.payload);
        break;
      case "settings.update":
        result = await handlers.settingsUpdate(intent.payload);
        break;
      case "window.state.update":
        result = await handlers.windowStateUpdate(intent.payload);
        break;
      case "diagnostics.export":
        result = await handlers.diagnosticsExport(intent.payload);
        break;
      case "agent.start":
        result = await handlers.agentStart(intent.payload);
        break;
      case "agent.stop":
        result = await handlers.agentStop(intent.payload);
        break;
      default: {
        const exhaustive: never = intent.kind;
        throw new Error(`unhandled_execution_kind:${exhaustive}`);
      }
    }

    const normalized = normalizeJson(result);
    successAudit(normalized);
    return normalized;
  } catch (error) {
    failureAudit(error);
    throw error;
  }
}

// -----------------------------------------------------------------------------
// HIGH-LEVEL BOUNDARY
// -----------------------------------------------------------------------------

export async function passThroughMutationBoundary(
  raw: RawMutationIntent,
  ctx: MutationBoundaryContext,
  handlers: MutationExecutionHandlers,
): Promise<JsonValue> {
  const intent = normalizeMutationIntent(raw, ctx);
  const authorized = authorizeMutation(intent, ctx);
  return executeAuthorizedMutation(authorized, handlers, ctx);
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateCanonicalMutationIntent(intent: CanonicalMutationIntent): void {
  assert(intent.schema === 1, "intent_schema_invalid");
  assert(isMutationKind(intent.kind), `intent_kind_invalid:${intent.kind}`);
  assert(isMutationActor(intent.actor), `intent_actor_invalid:${intent.actor}`);
  assert(typeof intent.hash === "string" && intent.hash.length > 0, "intent_hash_invalid");

  const expectedHash = buildIntentHash(intent.kind, intent.actor, intent.payload, intent.trace_id, intent.idempotency_key);
  assert(expectedHash === intent.hash, "intent_hash_drift");
}

export function serializeCanonicalMutationIntent(intent: CanonicalMutationIntent): string {
  validateCanonicalMutationIntent(intent);
  return stableJson(intent);
}

export function validateMutationAuditRecord(record: MutationAuditRecord): void {
  assert(record.schema === 1, "audit_schema_invalid");
  assert(record.decision === "allow" || record.decision === "deny", "audit_decision_invalid");
  assert(["normalize", "authorize", "preview", "verify", "execute"].includes(record.stage), "audit_stage_invalid");
  assert(typeof record.reason === "string" && record.reason.length > 0, "audit_reason_invalid");

  const core: Omit<MutationAuditRecord, "hash"> = {
    schema: record.schema,
    ts_ms: record.ts_ms,
    decision: record.decision,
    stage: record.stage,
    reason: record.reason,
    ...(record.intent_hash ? { intent_hash: record.intent_hash } : {}),
    ...(record.kind ? { kind: record.kind } : {}),
    ...(record.actor ? { actor: record.actor } : {}),
    detail: record.detail,
  };
  assert(buildAuditHash(core) === record.hash, "audit_hash_drift");
}
