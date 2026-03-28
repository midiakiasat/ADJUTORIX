import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / GOVERNANCE / governed_surface.ts
 *
 * Canonical governed surface registry for the Electron main process.
 *
 * Purpose:
 * - define the full set of sanctioned governed operations in one place
 * - bind each operation to its authority lane, trust requirements, health requirements,
 *   lineage requirements, and execution class
 * - prevent surface sprawl where new actions appear in IPC/router/runtime layers without
 *   being formally incorporated into governance
 * - provide deterministic summaries for UI, diagnostics, tests, and invariant enforcement
 *
 * This module answers questions like:
 * - which operations are actually governed?
 * - which are read-only queries versus controlled mutations?
 * - what preconditions exist for each operation?
 * - which actor classes may access each operation?
 * - what gates must succeed before execution?
 *
 * Hard invariants:
 * - every governed operation has exactly one canonical spec
 * - deny-by-default for unspecified operations
 * - identical registry contents produce identical registry hashes
 * - mutation surfaces must declare stronger requirements than equivalent queries
 * - registry decisions are serialization-stable and auditable
 * - policy derivation is declarative, not scattered across handlers
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

export type GovernedActor = "renderer" | "menu" | "main" | "system";
export type GovernedSurfaceKind = "query" | "preview" | "verify" | "mutation" | "service-control" | "diagnostics";
export type GovernedAuthorityLane =
  | "query"
  | "local-state"
  | "governed-preview"
  | "governed-apply"
  | "service-control"
  | "workspace-control"
  | "rpc-proxy";

export type GovernedOperation =
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
  | "agent.health"
  | "agent.status"
  | "agent.start"
  | "agent.stop"
  | "diagnostics.runtime"
  | "diagnostics.bundle"
  | "diagnostics.export"
  | "rpc.invoke";

export type GovernedRequirementLevel = "none" | "optional" | "required";

export type GovernedPreconditions = {
  workspaceOpen: GovernedRequirementLevel;
  trustedWorkspace: GovernedRequirementLevel;
  healthyWorkspace: GovernedRequirementLevel;
  approvedPreview: GovernedRequirementLevel;
  verifiedPreview: GovernedRequirementLevel;
  mutationLockFree: GovernedRequirementLevel;
  agentHealthy: GovernedRequirementLevel;
  authReady: GovernedRequirementLevel;
};

export type GovernedActorPolicy = {
  renderer: boolean;
  menu: boolean;
  main: boolean;
  system: boolean;
};

export type GovernedSurfaceSpec = {
  schema: 1;
  operation: GovernedOperation;
  kind: GovernedSurfaceKind;
  authorityLane: GovernedAuthorityLane;
  mutation: boolean;
  query: boolean;
  affectsWorkspace: boolean;
  affectsAgent: boolean;
  affectsLedger: boolean;
  affectsDiagnostics: boolean;
  actorPolicy: GovernedActorPolicy;
  preconditions: GovernedPreconditions;
  description: string;
  hash: string;
};

export type GovernedSurfaceDecision = {
  schema: 1;
  operation: GovernedOperation;
  actor: GovernedActor;
  allowed: boolean;
  reason: string;
  detail: Record<string, JsonValue>;
  specHash: string;
  hash: string;
};

export type GovernedSurfaceRegistrySnapshot = {
  schema: 1;
  operationCount: number;
  mutationCount: number;
  queryCount: number;
  registryHash: string;
  operations: GovernedSurfaceSpec[];
};

export type GovernedSurfaceAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "lookup" | "decision" | "snapshot";
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type GovernedSurfaceAuditFn = (record: GovernedSurfaceAuditRecord) => void;

export type GovernedSurfaceContext = {
  now?: () => number;
  audit?: GovernedSurfaceAuditFn;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:governance:governed_surface:${message}`);
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

function specHash(core: Omit<GovernedSurfaceSpec, "hash">): string {
  return sha256(stableJson(core));
}

function decisionHash(core: Omit<GovernedSurfaceDecision, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<GovernedSurfaceAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function emitAudit(
  ctx: GovernedSurfaceContext | undefined,
  action: GovernedSurfaceAuditRecord["action"],
  decision: GovernedSurfaceAuditRecord["decision"],
  reason: string,
  detail: Record<string, JsonValue>,
): void {
  if (!ctx?.audit) return;
  const core: Omit<GovernedSurfaceAuditRecord, "hash"> = {
    schema: 1,
    ts_ms: nowMs(ctx.now),
    action,
    decision,
    reason,
    detail,
  };
  ctx.audit({
    ...core,
    hash: auditHash(core),
  });
}

function makeSpec(core: Omit<GovernedSurfaceSpec, "hash">): GovernedSurfaceSpec {
  return {
    ...core,
    hash: specHash(core),
  };
}

function actorAllowed(policy: GovernedActorPolicy, actor: GovernedActor): boolean {
  return policy[actor];
}

// -----------------------------------------------------------------------------
// REGISTRY
// -----------------------------------------------------------------------------

export const GOVERNED_SURFACE_REGISTRY: Record<GovernedOperation, GovernedSurfaceSpec> = {
  "runtime.snapshot": makeSpec({
    schema: 1,
    operation: "runtime.snapshot",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read normalized runtime state snapshot.",
  }),
  "workspace.open": makeSpec({
    schema: 1,
    operation: "workspace.open",
    kind: "service-control",
    authorityLane: "workspace-control",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "optional",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Open a workspace root into active runtime state.",
  }),
  "workspace.close": makeSpec({
    schema: 1,
    operation: "workspace.close",
    kind: "service-control",
    authorityLane: "workspace-control",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "optional",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Close the active workspace and clear workspace-scoped runtime state.",
  }),
  "workspace.reveal": makeSpec({
    schema: 1,
    operation: "workspace.reveal",
    kind: "query",
    authorityLane: "workspace-control",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Reveal a workspace path in the native shell.",
  }),
  "workspace.health": makeSpec({
    schema: 1,
    operation: "workspace.health",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read current workspace health and readiness report.",
  }),
  "workspace.trust.read": makeSpec({
    schema: 1,
    operation: "workspace.trust.read",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read workspace trust classification.",
  }),
  "workspace.trust.set": makeSpec({
    schema: 1,
    operation: "workspace.trust.set",
    kind: "service-control",
    authorityLane: "local-state",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: false,
    affectsDiagnostics: false,
    actorPolicy: { renderer: false, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "optional",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Persist workspace trust decision.",
  }),
  "patch.preview": makeSpec({
    schema: 1,
    operation: "patch.preview",
    kind: "preview",
    authorityLane: "governed-preview",
    mutation: false,
    query: false,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "optional",
      healthyWorkspace: "required",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "required",
      agentHealthy: "required",
      authReady: "required",
    },
    description: "Generate governed patch preview against active workspace.",
  }),
  "patch.approve": makeSpec({
    schema: 1,
    operation: "patch.approve",
    kind: "preview",
    authorityLane: "governed-preview",
    mutation: false,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "optional",
      healthyWorkspace: "required",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "required",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Approve current preview lineage for downstream verification/apply.",
  }),
  "patch.apply": makeSpec({
    schema: 1,
    operation: "patch.apply",
    kind: "mutation",
    authorityLane: "governed-apply",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "required",
      healthyWorkspace: "required",
      approvedPreview: "required",
      verifiedPreview: "required",
      mutationLockFree: "required",
      agentHealthy: "required",
      authReady: "required",
    },
    description: "Execute governed patch apply after successful approval and verification lineage.",
  }),
  "patch.clear": makeSpec({
    schema: 1,
    operation: "patch.clear",
    kind: "service-control",
    authorityLane: "governed-preview",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: false,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "optional",
      verifiedPreview: "optional",
      mutationLockFree: "optional",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Clear active patch preview/approval lineage state.",
  }),
  "verify.run": makeSpec({
    schema: 1,
    operation: "verify.run",
    kind: "verify",
    authorityLane: "governed-preview",
    mutation: false,
    query: false,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "optional",
      healthyWorkspace: "required",
      approvedPreview: "optional",
      verifiedPreview: "none",
      mutationLockFree: "required",
      agentHealthy: "required",
      authReady: "required",
    },
    description: "Run verification against current workspace and optional preview lineage.",
  }),
  "verify.status": makeSpec({
    schema: 1,
    operation: "verify.status",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Read current verification job status.",
  }),
  "verify.bind": makeSpec({
    schema: 1,
    operation: "verify.bind",
    kind: "verify",
    authorityLane: "governed-preview",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: false, menu: false, main: true, system: true },
    preconditions: {
      workspaceOpen: "required",
      trustedWorkspace: "optional",
      healthyWorkspace: "required",
      approvedPreview: "optional",
      verifiedPreview: "none",
      mutationLockFree: "required",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Bind verification result into preview lineage state.",
  }),
  "ledger.current": makeSpec({
    schema: 1,
    operation: "ledger.current",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read current ledger view.",
  }),
  "ledger.timeline": makeSpec({
    schema: 1,
    operation: "ledger.timeline",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read ledger timeline slice.",
  }),
  "ledger.entry": makeSpec({
    schema: 1,
    operation: "ledger.entry",
    kind: "query",
    authorityLane: "query",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: false,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "none",
    },
    description: "Read single ledger entry.",
  }),
  "agent.health": makeSpec({
    schema: 1,
    operation: "agent.health",
    kind: "query",
    authorityLane: "service-control",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: true,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Read normalized agent health report.",
  }),
  "agent.status": makeSpec({
    schema: 1,
    operation: "agent.status",
    kind: "query",
    authorityLane: "service-control",
    mutation: false,
    query: true,
    affectsWorkspace: false,
    affectsAgent: true,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Read current agent runtime/process status.",
  }),
  "agent.start": makeSpec({
    schema: 1,
    operation: "agent.start",
    kind: "service-control",
    authorityLane: "service-control",
    mutation: true,
    query: false,
    affectsWorkspace: false,
    affectsAgent: true,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: false, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "none",
      authReady: "optional",
    },
    description: "Start managed local agent process.",
  }),
  "agent.stop": makeSpec({
    schema: 1,
    operation: "agent.stop",
    kind: "service-control",
    authorityLane: "service-control",
    mutation: true,
    query: false,
    affectsWorkspace: false,
    affectsAgent: true,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: false, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "none",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Stop managed local agent process.",
  }),
  "diagnostics.runtime": makeSpec({
    schema: 1,
    operation: "diagnostics.runtime",
    kind: "diagnostics",
    authorityLane: "service-control",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Read runtime diagnostics snapshot.",
  }),
  "diagnostics.bundle": makeSpec({
    schema: 1,
    operation: "diagnostics.bundle",
    kind: "diagnostics",
    authorityLane: "service-control",
    mutation: false,
    query: true,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: true, menu: true, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "none",
      healthyWorkspace: "none",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Read diagnostics observability bundle.",
  }),
  "diagnostics.export": makeSpec({
    schema: 1,
    operation: "diagnostics.export",
    kind: "diagnostics",
    authorityLane: "service-control",
    mutation: true,
    query: false,
    affectsWorkspace: true,
    affectsAgent: true,
    affectsLedger: true,
    affectsDiagnostics: true,
    actorPolicy: { renderer: false, menu: true, main: true, system: false },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "optional",
      healthyWorkspace: "optional",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "optional",
      authReady: "optional",
    },
    description: "Export diagnostics bundle to persisted artifact.",
  }),
  "rpc.invoke": makeSpec({
    schema: 1,
    operation: "rpc.invoke",
    kind: "service-control",
    authorityLane: "rpc-proxy",
    mutation: false,
    query: false,
    affectsWorkspace: false,
    affectsAgent: true,
    affectsLedger: false,
    affectsDiagnostics: true,
    actorPolicy: { renderer: false, menu: false, main: true, system: true },
    preconditions: {
      workspaceOpen: "optional",
      trustedWorkspace: "optional",
      healthyWorkspace: "optional",
      approvedPreview: "none",
      verifiedPreview: "none",
      mutationLockFree: "none",
      agentHealthy: "required",
      authReady: "required",
    },
    description: "Invoke sanctioned RPC methods through guarded proxy.",
  }),
};

// -----------------------------------------------------------------------------
// LOOKUP / DECISION
// -----------------------------------------------------------------------------

export function getGovernedSurfaceSpec(operation: GovernedOperation, ctx?: GovernedSurfaceContext): GovernedSurfaceSpec {
  const spec = GOVERNED_SURFACE_REGISTRY[operation];
  assert(spec, `unknown_operation:${operation}`);
  emitAudit(ctx, "lookup", "allow", "governed_surface_spec_found", {
    operation,
    kind: spec.kind,
    authorityLane: spec.authorityLane,
  });
  return spec;
}

export function decideGovernedSurface(
  operation: GovernedOperation,
  actor: GovernedActor,
  ctx?: GovernedSurfaceContext,
): GovernedSurfaceDecision {
  const spec = getGovernedSurfaceSpec(operation, ctx);
  const allowed = actorAllowed(spec.actorPolicy, actor);
  const reason = allowed ? "actor_allowed_for_governed_operation" : "actor_denied_for_governed_operation";

  const core: Omit<GovernedSurfaceDecision, "hash"> = {
    schema: 1,
    operation,
    actor,
    allowed,
    reason,
    detail: {
      kind: spec.kind,
      authorityLane: spec.authorityLane,
      mutation: spec.mutation,
      query: spec.query,
      preconditions: spec.preconditions as unknown as JsonValue,
    },
    specHash: spec.hash,
  };

  const result: GovernedSurfaceDecision = {
    ...core,
    hash: decisionHash(core),
  };

  emitAudit(ctx, "decision", allowed ? "allow" : "deny", reason, {
    operation,
    actor,
    specHash: spec.hash,
  });
  return result;
}

// -----------------------------------------------------------------------------
// SNAPSHOT / SUMMARY
// -----------------------------------------------------------------------------

export function governedSurfaceSnapshot(ctx?: GovernedSurfaceContext): GovernedSurfaceRegistrySnapshot {
  const operations = Object.values(GOVERNED_SURFACE_REGISTRY).sort((a, b) => a.operation.localeCompare(b.operation));
  const mutationCount = operations.filter((op) => op.mutation).length;
  const queryCount = operations.filter((op) => op.query).length;
  const registryHash = sha256(stableJson(operations));

  const snapshot: GovernedSurfaceRegistrySnapshot = {
    schema: 1,
    operationCount: operations.length,
    mutationCount,
    queryCount,
    registryHash,
    operations,
  };

  emitAudit(ctx, "snapshot", "allow", "governed_surface_snapshot_created", {
    operationCount: snapshot.operationCount,
    mutationCount,
    queryCount,
    registryHash,
  });
  return snapshot;
}

export function governedOperationsByLane(lane: GovernedAuthorityLane): GovernedSurfaceSpec[] {
  return Object.values(GOVERNED_SURFACE_REGISTRY)
    .filter((spec) => spec.authorityLane === lane)
    .sort((a, b) => a.operation.localeCompare(b.operation));
}

export function governedMutationOperations(): GovernedSurfaceSpec[] {
  return Object.values(GOVERNED_SURFACE_REGISTRY)
    .filter((spec) => spec.mutation)
    .sort((a, b) => a.operation.localeCompare(b.operation));
}

export function governedQueryOperations(): GovernedSurfaceSpec[] {
  return Object.values(GOVERNED_SURFACE_REGISTRY)
    .filter((spec) => spec.query)
    .sort((a, b) => a.operation.localeCompare(b.operation));
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateGovernedSurfaceSpec(spec: GovernedSurfaceSpec): void {
  assert(spec.schema === 1, "spec_schema_invalid");
  const core: Omit<GovernedSurfaceSpec, "hash"> = {
    schema: spec.schema,
    operation: spec.operation,
    kind: spec.kind,
    authorityLane: spec.authorityLane,
    mutation: spec.mutation,
    query: spec.query,
    affectsWorkspace: spec.affectsWorkspace,
    affectsAgent: spec.affectsAgent,
    affectsLedger: spec.affectsLedger,
    affectsDiagnostics: spec.affectsDiagnostics,
    actorPolicy: spec.actorPolicy,
    preconditions: spec.preconditions,
    description: spec.description,
  };
  assert(spec.hash === specHash(core), `spec_hash_drift:${spec.operation}`);
}

export function validateGovernedSurfaceDecision(decision: GovernedSurfaceDecision): void {
  assert(decision.schema === 1, "decision_schema_invalid");
  const core: Omit<GovernedSurfaceDecision, "hash"> = {
    schema: decision.schema,
    operation: decision.operation,
    actor: decision.actor,
    allowed: decision.allowed,
    reason: decision.reason,
    detail: decision.detail,
    specHash: decision.specHash,
  };
  assert(decision.hash === decisionHash(core), "decision_hash_drift");
}

export function validateGovernedSurfaceRegistry(): void {
  const seen = new Set<string>();
  for (const spec of Object.values(GOVERNED_SURFACE_REGISTRY)) {
    assert(!seen.has(spec.operation), `duplicate_operation:${spec.operation}`);
    seen.add(spec.operation);
    validateGovernedSurfaceSpec(spec);
  }
}

export function serializeGovernedSurfaceRegistry(): string {
  validateGovernedSurfaceRegistry();
  return stableJson(governedSurfaceSnapshot());
}
