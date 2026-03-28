import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / GOVERNANCE / apply_gate.ts
 *
 * Canonical governed-apply gate for the Electron main process.
 *
 * Purpose:
 * - act as the last deterministic authorization barrier before any workspace mutation
 * - ensure patch application cannot bypass preview lineage, verification, trust, authority,
 *   workspace health, or mutation-boundary invariants
 * - produce explicit, auditable allow/deny decisions with stable hashes
 * - separate "can apply" logic from IPC transport, patch preview generation, and executor code
 *
 * This module is intentionally narrow and severe.
 * It decides whether an apply request is admissible at all.
 * It does NOT perform the patch application itself.
 *
 * Responsibilities:
 * - validate request identity and actor/authority compatibility
 * - require exact preview lineage continuity
 * - require verification lineage continuity when policy demands it
 * - require trusted workspace and healthy runtime conditions
 * - enforce mutation preconditions such as clean governance state and non-conflicting locks
 * - expose deterministic denial taxonomy for UI, diagnostics, ledger, and replay
 *
 * Hard invariants:
 * - deny by default
 * - apply requires an explicitly approved preview hash
 * - apply never proceeds on mismatched preview/verify lineage
 * - identical inputs produce identical gate decisions
 * - gate decisions are pure and serialization-stable
 * - a weaker subsystem may not override a stronger deny condition here
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

export type ApplyActor = "renderer" | "menu" | "main" | "system";
export type ApplyDecision = "allow" | "deny";
export type ApplyFailureClass =
  | "authority"
  | "policy"
  | "workspace"
  | "health"
  | "preview-lineage"
  | "verify-lineage"
  | "trust"
  | "lock"
  | "request"
  | "consistency";

export type ApplyGateRequest = {
  schema: 1;
  actor: ApplyActor;
  patchId: string;
  previewHash: string;
  requestHash: string;
  traceId?: string;
};

export type ApplyGatePolicy = {
  requireVerifiedPreview: boolean;
  requireTrustedWorkspace: boolean;
  requireHealthyWorkspace: boolean;
  requireMutationLockFree: boolean;
  allowRendererApply: boolean;
  allowMenuApply: boolean;
  allowSystemApply: boolean;
  allowMainApply: boolean;
};

export type ApplyGateWorkspaceSnapshot = {
  rootPath: string | null;
  trustLevel: "untrusted" | "restricted" | "trusted" | null;
  healthLevel: "healthy" | "degraded" | "unhealthy" | "offline" | null;
  mutationLockHeld: boolean;
  mutationLockOwner: string | null;
  dirty: boolean;
};

export type ApplyGateLineageSnapshot = {
  currentPreviewHash: string | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
  latestPatchId: string | null;
};

export type ApplyGateAuthoritySnapshot = {
  capabilityDecision: "allow" | "deny";
  routeDecision: "allow" | "deny";
  routeLane: string | null;
  capabilityReason: string | null;
  routeReason: string | null;
};

export type ApplyGateConsistencySnapshot = {
  requestPatchIdMatchesCurrent: boolean;
  requestPreviewMatchesCurrent: boolean;
  approvedMatchesCurrent: boolean;
  verifiedMatchesApproved: boolean;
};

export type ApplyGateInputs = {
  request: ApplyGateRequest;
  policy: ApplyGatePolicy;
  workspace: ApplyGateWorkspaceSnapshot;
  lineage: ApplyGateLineageSnapshot;
  authority: ApplyGateAuthoritySnapshot;
  consistency: ApplyGateConsistencySnapshot;
};

export type ApplyGateViolation = {
  code: string;
  class: ApplyFailureClass;
  message: string;
  detail: Record<string, JsonValue>;
};

export type ApplyGateResult = {
  schema: 1;
  decision: ApplyDecision;
  actor: ApplyActor;
  patchId: string;
  previewHash: string;
  requestHash: string;
  reason: string;
  violations: ApplyGateViolation[];
  hash: string;
};

export type ApplyGateAuditRecord = ApplyGateResult & {
  ts_ms: number;
};

export type ApplyGateContext = {
  now?: () => number;
  audit?: (record: ApplyGateAuditRecord) => void;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:governance:apply_gate:${message}`);
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

function requestHash(actor: ApplyActor, patchId: string, previewHash: string, traceId?: string): string {
  return sha256(
    stableJson({
      schema: 1,
      actor,
      patchId,
      previewHash,
      ...(traceId ? { traceId } : {}),
    }),
  );
}

function resultHash(core: Omit<ApplyGateResult, "hash">): string {
  return sha256(stableJson(core));
}

function violation(
  code: string,
  klass: ApplyFailureClass,
  message: string,
  detail: Record<string, JsonValue> = {},
): ApplyGateViolation {
  return {
    code,
    class: klass,
    message,
    detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue>,
  };
}

function emitAudit(ctx: ApplyGateContext | undefined, result: ApplyGateResult): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...result,
    ts_ms: (ctx.now ?? Date.now)(),
  });
}

// -----------------------------------------------------------------------------
// CORE CHECKS
// -----------------------------------------------------------------------------

function checkActorPolicy(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const { actor } = inputs.request;
  const p = inputs.policy;

  const allowed =
    (actor === "renderer" && p.allowRendererApply) ||
    (actor === "menu" && p.allowMenuApply) ||
    (actor === "system" && p.allowSystemApply) ||
    (actor === "main" && p.allowMainApply);

  if (!allowed) {
    out.push(
      violation("actor_disallowed_by_policy", "policy", "Actor is not allowed to perform governed apply.", {
        actor,
      }),
    );
  }
}

function checkAuthority(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const a = inputs.authority;
  if (a.capabilityDecision !== "allow") {
    out.push(
      violation("capability_denied", "authority", "Capability layer denied apply authority.", {
        capabilityDecision: a.capabilityDecision,
        capabilityReason: a.capabilityReason,
      }),
    );
  }
  if (a.routeDecision !== "allow") {
    out.push(
      violation("route_denied", "authority", "Authority routing denied governed apply route.", {
        routeDecision: a.routeDecision,
        routeReason: a.routeReason,
        routeLane: a.routeLane,
      }),
    );
  }
  if (a.routeLane !== "governed-apply") {
    out.push(
      violation("route_lane_mismatch", "authority", "Apply request was not routed through governed-apply lane.", {
        routeLane: a.routeLane,
      }),
    );
  }
}

function checkWorkspace(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const w = inputs.workspace;
  if (!w.rootPath) {
    out.push(violation("workspace_missing", "workspace", "No active workspace is available for apply."));
  }
  if (inputs.policy.requireTrustedWorkspace && w.trustLevel !== "trusted") {
    out.push(
      violation("workspace_not_trusted", "trust", "Workspace must be trusted for apply.", {
        trustLevel: w.trustLevel,
      }),
    );
  }
  if (inputs.policy.requireHealthyWorkspace && w.healthLevel !== "healthy") {
    out.push(
      violation("workspace_not_healthy", "health", "Workspace must be healthy for governed apply.", {
        healthLevel: w.healthLevel,
      }),
    );
  }
}

function checkMutationLock(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const w = inputs.workspace;
  if (inputs.policy.requireMutationLockFree && w.mutationLockHeld) {
    out.push(
      violation("mutation_lock_held", "lock", "Mutation lock is currently held; apply cannot proceed.", {
        mutationLockHeld: w.mutationLockHeld,
        mutationLockOwner: w.mutationLockOwner,
      }),
    );
  }
}

function checkLineage(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const r = inputs.request;
  const l = inputs.lineage;

  if (!l.currentPreviewHash) {
    out.push(violation("current_preview_missing", "preview-lineage", "No current preview lineage exists."));
  }
  if (!l.approvedPreviewHash) {
    out.push(violation("approved_preview_missing", "preview-lineage", "No approved preview lineage exists."));
  }
  if (l.currentPreviewHash && r.previewHash !== l.currentPreviewHash) {
    out.push(
      violation("request_preview_mismatch_current", "preview-lineage", "Request preview hash does not match current preview lineage.", {
        requestPreviewHash: r.previewHash,
        currentPreviewHash: l.currentPreviewHash,
      }),
    );
  }
  if (l.approvedPreviewHash && r.previewHash !== l.approvedPreviewHash) {
    out.push(
      violation("request_preview_mismatch_approved", "preview-lineage", "Request preview hash does not match approved preview lineage.", {
        requestPreviewHash: r.previewHash,
        approvedPreviewHash: l.approvedPreviewHash,
      }),
    );
  }
  if (l.latestPatchId && r.patchId !== l.latestPatchId) {
    out.push(
      violation("request_patch_mismatch_latest", "preview-lineage", "Request patch id does not match latest patch lineage.", {
        requestPatchId: r.patchId,
        latestPatchId: l.latestPatchId,
      }),
    );
  }

  if (inputs.policy.requireVerifiedPreview) {
    if (!l.verifiedPreviewHash) {
      out.push(
        violation("verified_preview_missing", "verify-lineage", "Verified preview lineage is required before apply.", {
          verifyId: l.verifyId,
        }),
      );
    }
    if (l.approvedPreviewHash && l.verifiedPreviewHash && l.approvedPreviewHash !== l.verifiedPreviewHash) {
      out.push(
        violation("verified_preview_mismatch_approved", "verify-lineage", "Verified preview lineage does not match approved preview lineage.", {
          approvedPreviewHash: l.approvedPreviewHash,
          verifiedPreviewHash: l.verifiedPreviewHash,
          verifyId: l.verifyId,
        }),
      );
    }
  }
}

function checkConsistency(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const c = inputs.consistency;
  if (!c.requestPatchIdMatchesCurrent) {
    out.push(violation("consistency_patch_id_mismatch", "consistency", "Request patch id is inconsistent with active mutation state."));
  }
  if (!c.requestPreviewMatchesCurrent) {
    out.push(violation("consistency_preview_mismatch", "consistency", "Request preview hash is inconsistent with active preview state."));
  }
  if (!c.approvedMatchesCurrent) {
    out.push(violation("consistency_approved_mismatch", "consistency", "Approved preview state diverges from current preview state."));
  }
  if (inputs.policy.requireVerifiedPreview && !c.verifiedMatchesApproved) {
    out.push(violation("consistency_verified_mismatch", "consistency", "Verified preview state diverges from approved preview state."));
  }
}

function validateRequest(inputs: ApplyGateInputs, out: ApplyGateViolation[]): void {
  const r = inputs.request;
  if (r.schema !== 1) {
    out.push(violation("request_schema_invalid", "request", "Apply gate request schema is invalid.", { schema: r.schema as JsonValue }));
  }
  if (!(typeof r.patchId === "string" && r.patchId.length > 0)) {
    out.push(violation("request_patch_id_invalid", "request", "Patch id is required."));
  }
  if (!(typeof r.previewHash === "string" && r.previewHash.length > 0)) {
    out.push(violation("request_preview_hash_invalid", "request", "Preview hash is required."));
  }
  const expectedHash = requestHash(r.actor, r.patchId, r.previewHash, r.traceId);
  if (r.requestHash !== expectedHash) {
    out.push(
      violation("request_hash_drift", "request", "Request hash does not match canonical request identity.", {
        requestHash: r.requestHash,
        expectedHash,
      }),
    );
  }
}

// -----------------------------------------------------------------------------
// EVALUATION
// -----------------------------------------------------------------------------

export function evaluateApplyGate(inputs: ApplyGateInputs, ctx?: ApplyGateContext): ApplyGateResult {
  const violations: ApplyGateViolation[] = [];

  validateRequest(inputs, violations);
  checkActorPolicy(inputs, violations);
  checkAuthority(inputs, violations);
  checkWorkspace(inputs, violations);
  checkMutationLock(inputs, violations);
  checkLineage(inputs, violations);
  checkConsistency(inputs, violations);

  const decision: ApplyDecision = violations.length === 0 ? "allow" : "deny";
  const reason =
    decision === "allow"
      ? "apply_gate_passed"
      : violations[0]?.code ?? "apply_gate_denied";

  const core: Omit<ApplyGateResult, "hash"> = {
    schema: 1,
    decision,
    actor: inputs.request.actor,
    patchId: inputs.request.patchId,
    previewHash: inputs.request.previewHash,
    requestHash: inputs.request.requestHash,
    reason,
    violations,
  };

  const result: ApplyGateResult = {
    ...core,
    hash: resultHash(core),
  };

  emitAudit(ctx, result);
  return result;
}

export function enforceApplyGate(inputs: ApplyGateInputs, ctx?: ApplyGateContext): ApplyGateResult {
  const result = evaluateApplyGate(inputs, ctx);
  if (result.decision === "deny") {
    const codes = result.violations.map((v) => v.code).join(",");
    throw new Error(`apply_gate_denied:${codes}`);
  }
  return result;
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function defaultApplyGatePolicy(): ApplyGatePolicy {
  return {
    requireVerifiedPreview: true,
    requireTrustedWorkspace: true,
    requireHealthyWorkspace: true,
    requireMutationLockFree: true,
    allowRendererApply: true,
    allowMenuApply: true,
    allowSystemApply: false,
    allowMainApply: true,
  };
}

export function validateApplyGateResult(result: ApplyGateResult): void {
  assert(result.schema === 1, "result_schema_invalid");
  const core: Omit<ApplyGateResult, "hash"> = {
    schema: result.schema,
    decision: result.decision,
    actor: result.actor,
    patchId: result.patchId,
    previewHash: result.previewHash,
    requestHash: result.requestHash,
    reason: result.reason,
    violations: result.violations,
  };
  assert(result.hash === resultHash(core), "result_hash_drift");
}

export function serializeApplyGateResult(result: ApplyGateResult): string {
  validateApplyGateResult(result);
  return stableJson(result);
}
