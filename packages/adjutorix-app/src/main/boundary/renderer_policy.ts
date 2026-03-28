import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / renderer_policy.ts
 *
 * Canonical renderer policy contract enforced from the Electron main process.
 *
 * Purpose:
 * - define the renderer's allowed authority surface in one place
 * - project policy into preload/API exposure, IPC allowlists, and request guards
 * - make renderer constraints explicit, deterministic, and auditable
 * - separate pure UI/view concerns from state mutation and service-control concerns
 *
 * Scope:
 * - what the renderer may query
 * - what the renderer may request indirectly through governed boundaries
 * - what the renderer may never do directly
 * - what preload may expose on behalf of main
 *
 * Hard invariants:
 * - renderer never receives implicit filesystem/process/network authority
 * - renderer policy is deny-by-default
 * - identical policy inputs produce identical policy hashes
 * - preload exposure must be a subset of policy-allowed capabilities
 * - policy decisions are serialization-stable and auditable
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

export type RendererCapability =
  | "runtime.read"
  | "workspace.open.request"
  | "workspace.reveal.request"
  | "patch.preview.request"
  | "patch.apply.request"
  | "verify.run.request"
  | "verify.status.read"
  | "ledger.current.read"
  | "settings.update.request"
  | "window.state.update.request"
  | "diagnostics.export.request"
  | "rpc.proxy.request"
  | "devtools.request";

export type RendererForbiddenAuthority =
  | "filesystem.direct"
  | "process.spawn"
  | "token.read"
  | "network.raw"
  | "agent.control.direct"
  | "ipc.channel.arbitrary"
  | "native.module.load"
  | "window.create.arbitrary";

export type RendererSurfaceNamespace =
  | "adjutorix.rpc"
  | "adjutorix.workspace"
  | "adjutorix.patch"
  | "adjutorix.verify"
  | "adjutorix.ledger"
  | "adjutorix.runtime"
  | "adjutorix.settings"
  | "adjutorix.window"
  | "adjutorix.diagnostics"
  | "adjutorix.devtools";

export type RendererPolicyMode = "strict" | "development" | "smoke";
export type RendererPolicyDecision = "allow" | "deny";

export type RendererRuntimeState = {
  devtools_enabled: boolean;
  smoke_mode: boolean;
  strict_mode: boolean;
  workspace_open: boolean;
  diagnostics_enabled: boolean;
  rpc_proxy_enabled: boolean;
  settings_mutable: boolean;
  window_state_mutable: boolean;
};

export type RendererPolicy = {
  schema: 1;
  mode: RendererPolicyMode;
  allowed_capabilities: RendererCapability[];
  forbidden_authorities: RendererForbiddenAuthority[];
  exposed_namespaces: RendererSurfaceNamespace[];
  hash: string;
};

export type RendererCapabilityDecision = {
  schema: 1;
  capability: RendererCapability;
  decision: RendererPolicyDecision;
  reason: string;
  detail: Record<string, JsonValue>;
  policy_hash: string;
  hash: string;
};

export type RendererNamespaceDecision = {
  schema: 1;
  namespace: RendererSurfaceNamespace;
  decision: RendererPolicyDecision;
  reason: string;
  detail: Record<string, JsonValue>;
  policy_hash: string;
  hash: string;
};

export type RendererPolicyAuditRecord = {
  schema: 1;
  ts_ms: number;
  kind: "capability" | "namespace" | "policy";
  decision: RendererPolicyDecision;
  subject: string;
  reason: string;
  detail: Record<string, JsonValue>;
  policy_hash: string;
  hash: string;
};

export type RendererPolicyContext = {
  now?: () => number;
  audit?: (record: RendererPolicyAuditRecord) => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const ALL_CAPABILITIES: readonly RendererCapability[] = [
  "runtime.read",
  "workspace.open.request",
  "workspace.reveal.request",
  "patch.preview.request",
  "patch.apply.request",
  "verify.run.request",
  "verify.status.read",
  "ledger.current.read",
  "settings.update.request",
  "window.state.update.request",
  "diagnostics.export.request",
  "rpc.proxy.request",
  "devtools.request",
] as const;

const ALL_FORBIDDEN_AUTHORITIES: readonly RendererForbiddenAuthority[] = [
  "filesystem.direct",
  "process.spawn",
  "token.read",
  "network.raw",
  "agent.control.direct",
  "ipc.channel.arbitrary",
  "native.module.load",
  "window.create.arbitrary",
] as const;

const CAPABILITY_NAMESPACE_MAP: Record<RendererCapability, RendererSurfaceNamespace> = {
  "runtime.read": "adjutorix.runtime",
  "workspace.open.request": "adjutorix.workspace",
  "workspace.reveal.request": "adjutorix.workspace",
  "patch.preview.request": "adjutorix.patch",
  "patch.apply.request": "adjutorix.patch",
  "verify.run.request": "adjutorix.verify",
  "verify.status.read": "adjutorix.verify",
  "ledger.current.read": "adjutorix.ledger",
  "settings.update.request": "adjutorix.settings",
  "window.state.update.request": "adjutorix.window",
  "diagnostics.export.request": "adjutorix.diagnostics",
  "rpc.proxy.request": "adjutorix.rpc",
  "devtools.request": "adjutorix.devtools",
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:boundary:renderer_policy:${message}`);
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

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort() as T[];
}

function isCapability(value: string): value is RendererCapability {
  return (ALL_CAPABILITIES as readonly string[]).includes(value);
}

function isNamespace(value: string): value is RendererSurfaceNamespace {
  return Object.values(CAPABILITY_NAMESPACE_MAP).includes(value as RendererSurfaceNamespace);
}

function buildPolicyHash(core: Omit<RendererPolicy, "hash">): string {
  return sha256(stableJson(core));
}

function buildDecisionHash(core: Omit<RendererCapabilityDecision, "hash"> | Omit<RendererNamespaceDecision, "hash">): string {
  return sha256(stableJson(core));
}

function buildAuditHash(core: Omit<RendererPolicyAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function emitAudit(
  ctx: RendererPolicyContext | undefined,
  kind: RendererPolicyAuditRecord["kind"],
  decision: RendererPolicyDecision,
  subject: string,
  reason: string,
  detail: Record<string, JsonValue>,
  policy_hash: string,
): void {
  if (!ctx?.audit) return;
  const core: Omit<RendererPolicyAuditRecord, "hash"> = {
    schema: 1,
    ts_ms: (ctx.now ?? Date.now)(),
    kind,
    decision,
    subject,
    reason,
    detail,
    policy_hash,
  };
  ctx.audit({
    ...core,
    hash: buildAuditHash(core),
  });
}

// -----------------------------------------------------------------------------
// POLICY CONSTRUCTION
// -----------------------------------------------------------------------------

export function buildRendererPolicy(state: RendererRuntimeState): RendererPolicy {
  const mode: RendererPolicyMode = state.smoke_mode
    ? "smoke"
    : state.strict_mode
      ? "strict"
      : "development";

  const allowed: RendererCapability[] = [
    "runtime.read",
    "workspace.open.request",
    "workspace.reveal.request",
    "patch.preview.request",
    "patch.apply.request",
    "verify.run.request",
    "verify.status.read",
    "ledger.current.read",
  ];

  if (state.settings_mutable) allowed.push("settings.update.request");
  if (state.window_state_mutable) allowed.push("window.state.update.request");
  if (state.diagnostics_enabled) allowed.push("diagnostics.export.request");
  if (state.rpc_proxy_enabled && !state.strict_mode) allowed.push("rpc.proxy.request");
  if (state.devtools_enabled && !state.smoke_mode) allowed.push("devtools.request");

  const allowed_capabilities = uniqueSorted(allowed);
  const exposed_namespaces = uniqueSorted(
    allowed_capabilities.map((cap) => CAPABILITY_NAMESPACE_MAP[cap]),
  );

  const core: Omit<RendererPolicy, "hash"> = {
    schema: 1,
    mode,
    allowed_capabilities,
    forbidden_authorities: uniqueSorted(ALL_FORBIDDEN_AUTHORITIES),
    exposed_namespaces,
  };

  return {
    ...core,
    hash: buildPolicyHash(core),
  };
}

// -----------------------------------------------------------------------------
// POLICY DECISIONS
// -----------------------------------------------------------------------------

export function decideRendererCapability(
  policy: RendererPolicy,
  capability: RendererCapability,
  ctx?: RendererPolicyContext,
): RendererCapabilityDecision {
  assert(isCapability(capability), `capability_invalid:${capability}`);

  const decision: RendererPolicyDecision = policy.allowed_capabilities.includes(capability) ? "allow" : "deny";
  const reason = decision === "allow" ? "capability_allowed_by_policy" : "capability_not_exposed_by_policy";

  const core: Omit<RendererCapabilityDecision, "hash"> = {
    schema: 1,
    capability,
    decision,
    reason,
    detail: {
      namespace: CAPABILITY_NAMESPACE_MAP[capability],
      mode: policy.mode,
    },
    policy_hash: policy.hash,
  };

  const result: RendererCapabilityDecision = {
    ...core,
    hash: buildDecisionHash(core),
  };

  emitAudit(ctx, "capability", decision, capability, reason, core.detail, policy.hash);
  return result;
}

export function decideRendererNamespace(
  policy: RendererPolicy,
  namespace: RendererSurfaceNamespace,
  ctx?: RendererPolicyContext,
): RendererNamespaceDecision {
  assert(isNamespace(namespace), `namespace_invalid:${namespace}`);

  const decision: RendererPolicyDecision = policy.exposed_namespaces.includes(namespace) ? "allow" : "deny";
  const reason = decision === "allow" ? "namespace_exposed_by_policy" : "namespace_not_exposed_by_policy";

  const supportedCapabilities = uniqueSorted(
    (Object.keys(CAPABILITY_NAMESPACE_MAP) as RendererCapability[]).filter(
      (cap) => CAPABILITY_NAMESPACE_MAP[cap] === namespace,
    ),
  );

  const core: Omit<RendererNamespaceDecision, "hash"> = {
    schema: 1,
    namespace,
    decision,
    reason,
    detail: {
      supported_capabilities: supportedCapabilities,
      mode: policy.mode,
    },
    policy_hash: policy.hash,
  };

  const result: RendererNamespaceDecision = {
    ...core,
    hash: buildDecisionHash(core),
  };

  emitAudit(ctx, "namespace", decision, namespace, reason, core.detail, policy.hash);
  return result;
}

// -----------------------------------------------------------------------------
// PROJECTIONS
// -----------------------------------------------------------------------------

export function preloadExposureContract(policy: RendererPolicy): Record<string, JsonValue> {
  const exposed = new Set(policy.exposed_namespaces);

  return {
    adjutorix: {
      ...(exposed.has("adjutorix.rpc") ? { rpc: { invoke: true } } : {}),
      ...(exposed.has("adjutorix.workspace") ? { workspace: { open: true, revealInShell: true } } : {}),
      ...(exposed.has("adjutorix.patch") ? { patch: { preview: true, apply: true } } : {}),
      ...(exposed.has("adjutorix.verify") ? { verify: { run: true, status: true } } : {}),
      ...(exposed.has("adjutorix.ledger") ? { ledger: { current: true } } : {}),
      ...(exposed.has("adjutorix.runtime") ? { runtime: { getSnapshot: true, getRuntimeInfo: true } } : {}),
      ...(exposed.has("adjutorix.settings") ? { settings: { update: true } } : {}),
      ...(exposed.has("adjutorix.window") ? { window: { updateState: true } } : {}),
      ...(exposed.has("adjutorix.diagnostics") ? { diagnostics: { export: true } } : {}),
      ...(exposed.has("adjutorix.devtools") ? { devtools: { toggle: true } } : {}),
    },
    forbidden_authorities: policy.forbidden_authorities,
    policy_hash: policy.hash,
  };
}

export function rendererPolicySummary(policy: RendererPolicy): Record<string, JsonValue> {
  return {
    mode: policy.mode,
    allowed_capabilities: policy.allowed_capabilities,
    exposed_namespaces: policy.exposed_namespaces,
    forbidden_authorities: policy.forbidden_authorities,
    policy_hash: policy.hash,
  };
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateRendererPolicy(policy: RendererPolicy): void {
  assert(policy.schema === 1, "policy_schema_invalid");
  assert(policy.mode === "strict" || policy.mode === "development" || policy.mode === "smoke", "policy_mode_invalid");
  for (const capability of policy.allowed_capabilities) {
    assert(isCapability(capability), `policy_capability_invalid:${capability}`);
  }
  for (const namespace of policy.exposed_namespaces) {
    assert(isNamespace(namespace), `policy_namespace_invalid:${namespace}`);
  }

  const expectedNamespaces = uniqueSorted(policy.allowed_capabilities.map((cap) => CAPABILITY_NAMESPACE_MAP[cap]));
  assert(stableJson(expectedNamespaces) === stableJson(uniqueSorted(policy.exposed_namespaces)), "policy_namespace_projection_mismatch");

  const core: Omit<RendererPolicy, "hash"> = {
    schema: policy.schema,
    mode: policy.mode,
    allowed_capabilities: uniqueSorted(policy.allowed_capabilities),
    forbidden_authorities: uniqueSorted(policy.forbidden_authorities),
    exposed_namespaces: uniqueSorted(policy.exposed_namespaces),
  };
  assert(buildPolicyHash(core) === policy.hash, "policy_hash_drift");
}

export function serializeRendererPolicy(policy: RendererPolicy): string {
  validateRendererPolicy(policy);
  return stableJson(policy);
}

export function validateRendererCapabilityDecision(decision: RendererCapabilityDecision): void {
  assert(decision.schema === 1, "capability_decision_schema_invalid");
  assert(isCapability(decision.capability), `capability_decision_invalid:${decision.capability}`);
  assert(decision.decision === "allow" || decision.decision === "deny", "capability_decision_state_invalid");
  const core: Omit<RendererCapabilityDecision, "hash"> = {
    schema: decision.schema,
    capability: decision.capability,
    decision: decision.decision,
    reason: decision.reason,
    detail: decision.detail,
    policy_hash: decision.policy_hash,
  };
  assert(buildDecisionHash(core) === decision.hash, "capability_decision_hash_drift");
}

export function validateRendererNamespaceDecision(decision: RendererNamespaceDecision): void {
  assert(decision.schema === 1, "namespace_decision_schema_invalid");
  assert(isNamespace(decision.namespace), `namespace_decision_invalid:${decision.namespace}`);
  assert(decision.decision === "allow" || decision.decision === "deny", "namespace_decision_state_invalid");
  const core: Omit<RendererNamespaceDecision, "hash"> = {
    schema: decision.schema,
    namespace: decision.namespace,
    decision: decision.decision,
    reason: decision.reason,
    detail: decision.detail,
    policy_hash: decision.policy_hash,
  };
  assert(buildDecisionHash(core) === decision.hash, "namespace_decision_hash_drift");
}

export function validateRendererPolicyAuditRecord(record: RendererPolicyAuditRecord): void {
  assert(record.schema === 1, "audit_schema_invalid");
  assert(record.kind === "capability" || record.kind === "namespace" || record.kind === "policy", "audit_kind_invalid");
  assert(record.decision === "allow" || record.decision === "deny", "audit_decision_invalid");
  const core: Omit<RendererPolicyAuditRecord, "hash"> = {
    schema: record.schema,
    ts_ms: record.ts_ms,
    kind: record.kind,
    decision: record.decision,
    subject: record.subject,
    reason: record.reason,
    detail: record.detail,
    policy_hash: record.policy_hash,
  };
  assert(buildAuditHash(core) === record.hash, "audit_hash_drift");
}
