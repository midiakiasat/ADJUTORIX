// @ts-nocheck
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / GOVERNANCE / confirmation_rules.ts
 *
 * Canonical confirmation policy and rule engine for governed operations.
 *
 * Purpose:
 * - determine when an operation requires explicit human confirmation before execution
 * - centralize confirmation semantics so they do not drift across IPC handlers, menus,
 *   patch flows, diagnostics export, service control, or workspace actions
 * - separate "operation is allowed" from "operation may proceed without human confirmation"
 * - provide deterministic, auditable decisions with explicit rule matches
 *
 * Scope:
 * - destructive mutations
 * - privileged service-control actions
 * - workspace trust transitions
 * - large / broad / high-blast-radius file changes
 * - diagnostics export with sensitive workspace content
 * - repeated / exempt / system-initiated operations
 *
 * This module does NOT render UI.
 * It only decides whether confirmation is required and why.
 *
 * Hard invariants:
 * - deny-by-default is separate from confirm-by-default; allowed actions may still require confirmation
 * - identical inputs produce identical confirmation decisions
 * - confirmation exemptions are explicit and narrow
 * - higher-risk rules dominate lower-risk exemptions when they conflict
 * - outputs are serialization-stable and auditable
 * - rule order is explicit and part of the policy surface
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

export type ConfirmationActor = "renderer" | "menu" | "main" | "system";
export type ConfirmationSurface =
  | "workspace.open"
  | "workspace.close"
  | "workspace.trust.set"
  | "patch.preview"
  | "patch.approve"
  | "patch.apply"
  | "patch.clear"
  | "verify.run"
  | "verify.bind"
  | "agent.start"
  | "agent.stop"
  | "diagnostics.export"
  | "rpc.invoke";

export type ConfirmationRiskLevel = "none" | "low" | "medium" | "high" | "critical";
export type ConfirmationDecision = "require" | "skip";
export type ConfirmationRuleKind =
  | "surface-default"
  | "destructive"
  | "trust-transition"
  | "blast-radius"
  | "sensitive-export"
  | "service-control"
  | "system-exemption"
  | "recent-repeat-exemption"
  | "healthy-preview-exemption"
  | "dry-run-exemption";

export type ConfirmationContextSnapshot = {
  workspaceOpen: boolean;
  workspaceTrust: "untrusted" | "restricted" | "trusted" | null;
  workspaceHealth: "healthy" | "degraded" | "unhealthy" | "offline" | null;
  mutationLockHeld: boolean;
  pendingChangeCount: number;
  targetedFileCount: number;
  targetedDirectoryCount: number;
  diagnosticsIncludesWorkspaceContent: boolean;
  diagnosticsIncludesLogs: boolean;
  diagnosticsIncludesSecrets: boolean;
  serviceRestartCount: number;
  recentEquivalentConfirmationAtMs: number | null;
  recentEquivalentConfirmationHash: string | null;
  previewOnly: boolean;
  dryRun: boolean;
};

export type ConfirmationRequest = {
  schema: 1;
  surface: ConfirmationSurface;
  actor: ConfirmationActor;
  risk: ConfirmationRiskLevel;
  requestHash: string;
  traceId?: string;
  summary: string;
  context: ConfirmationContextSnapshot;
};

export type ConfirmationRule = {
  schema: 1;
  id: string;
  kind: ConfirmationRuleKind;
  priority: number;
  decision: ConfirmationDecision;
  description: string;
  hash: string;
};

export type ConfirmationMatch = {
  ruleId: string;
  ruleKind: ConfirmationRuleKind;
  decision: ConfirmationDecision;
  reason: string;
  detail: Record<string, JsonValue>;
};

export type ConfirmationResult = {
  schema: 1;
  decision: ConfirmationDecision;
  surface: ConfirmationSurface;
  actor: ConfirmationActor;
  requestHash: string;
  effectiveRuleId: string;
  effectiveRuleKind: ConfirmationRuleKind;
  reason: string;
  matches: ConfirmationMatch[];
  hash: string;
};

export type ConfirmationPolicy = {
  recentRepeatWindowMs: number;
  repeatExemptionEnabled: boolean;
  systemExemptionEnabled: boolean;
  previewExemptionEnabled: boolean;
  dryRunExemptionEnabled: boolean;
  highBlastRadiusFileThreshold: number;
  criticalBlastRadiusFileThreshold: number;
  serviceRestartConfirmationThreshold: number;
  surfaceDefaults: Record<ConfirmationSurface, ConfirmationDecision>;
};

export type ConfirmationAuditRecord = ConfirmationResult & {
  ts_ms: number;
};

export type ConfirmationContext = {
  now?: () => number;
  audit?: (record: ConfirmationAuditRecord) => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_SURFACE_DEFAULTS: Record<ConfirmationSurface, ConfirmationDecision> = {
  "workspace.open": "skip",
  "workspace.close": "skip",
  "workspace.trust.set": "require",
  "patch.preview": "skip",
  "patch.approve": "skip",
  "patch.apply": "require",
  "patch.clear": "skip",
  "verify.run": "skip",
  "verify.bind": "skip",
  "agent.start": "skip",
  "agent.stop": "require",
  "diagnostics.export": "require",
  "rpc.invoke": "require",
};

const DEFAULT_POLICY: ConfirmationPolicy = {
  recentRepeatWindowMs: 60_000,
  repeatExemptionEnabled: true,
  systemExemptionEnabled: true,
  previewExemptionEnabled: true,
  dryRunExemptionEnabled: true,
  highBlastRadiusFileThreshold: 25,
  criticalBlastRadiusFileThreshold: 250,
  serviceRestartConfirmationThreshold: 2,
  surfaceDefaults: DEFAULT_SURFACE_DEFAULTS,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:governance:confirmation_rules:${message}`);
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

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function ruleHash(core: Omit<ConfirmationRule, "hash">): string {
  return sha256(stableJson(core));
}

function resultHash(core: Omit<ConfirmationResult, "hash">): string {
  return sha256(stableJson(core));
}

function requestHash(
  surface: ConfirmationSurface,
  actor: ConfirmationActor,
  risk: ConfirmationRiskLevel,
  summary: string,
  context: ConfirmationContextSnapshot,
  traceId?: string,
): string {
  return sha256(
    stableJson({
      schema: 1,
      surface,
      actor,
      risk,
      summary,
      context,
      ...(traceId ? { traceId } : {}),
    }),
  );
}

function makeRule(core: Omit<ConfirmationRule, "hash">): ConfirmationRule {
  return {
    ...core,
    hash: ruleHash(core),
  };
}

function emitAudit(ctx: ConfirmationContext | undefined, result: ConfirmationResult): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...result,
    ts_ms: nowMs(ctx.now),
  });
}

// -----------------------------------------------------------------------------
// RULES
// -----------------------------------------------------------------------------

export const CONFIRMATION_RULES: ConfirmationRule[] = [
  makeRule({
    schema: 1,
    id: "critical_blast_radius",
    kind: "blast-radius",
    priority: 1000,
    decision: "require",
    description: "Require confirmation for critical-blast-radius changes.",
  }),
  makeRule({
    schema: 1,
    id: "sensitive_diagnostics_export",
    kind: "sensitive-export",
    priority: 950,
    decision: "require",
    description: "Require confirmation when diagnostics export includes sensitive workspace data.",
  }),
  makeRule({
    schema: 1,
    id: "trust_transition",
    kind: "trust-transition",
    priority: 900,
    decision: "require",
    description: "Require confirmation for trust-level mutation operations.",
  }),
  makeRule({
    schema: 1,
    id: "destructive_patch_apply",
    kind: "destructive",
    priority: 850,
    decision: "require",
    description: "Require confirmation for destructive governed apply operations.",
  }),
  makeRule({
    schema: 1,
    id: "service_control_repeated_restart",
    kind: "service-control",
    priority: 800,
    decision: "require",
    description: "Require confirmation for potentially unstable service control after repeated restarts.",
  }),
  makeRule({
    schema: 1,
    id: "high_blast_radius",
    kind: "blast-radius",
    priority: 750,
    decision: "require",
    description: "Require confirmation for high-blast-radius operations.",
  }),
  makeRule({
    schema: 1,
    id: "system_exemption",
    kind: "system-exemption",
    priority: 200,
    decision: "skip",
    description: "Allow narrow exemption for system-triggered low-risk operations.",
  }),
  makeRule({
    schema: 1,
    id: "recent_repeat_exemption",
    kind: "recent-repeat-exemption",
    priority: 150,
    decision: "skip",
    description: "Skip confirmation for a very recent equivalent confirmed action.",
  }),
  makeRule({
    schema: 1,
    id: "healthy_preview_exemption",
    kind: "healthy-preview-exemption",
    priority: 125,
    decision: "skip",
    description: "Skip confirmation for low-risk preview-only actions in healthy trusted workspaces.",
  }),
  makeRule({
    schema: 1,
    id: "dry_run_exemption",
    kind: "dry-run-exemption",
    priority: 100,
    decision: "skip",
    description: "Skip confirmation for dry-run actions that do not mutate state.",
  }),
  makeRule({
    schema: 1,
    id: "surface_default",
    kind: "surface-default",
    priority: 0,
    decision: "skip",
    description: "Fallback to per-surface default confirmation policy.",
  }),
].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));

// -----------------------------------------------------------------------------
// MATCHERS
// -----------------------------------------------------------------------------

function matchCriticalBlastRadius(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (req.context.targetedFileCount >= policy.criticalBlastRadiusFileThreshold) {
    return {
      ruleId: "critical_blast_radius",
      ruleKind: "blast-radius",
      decision: "require",
      reason: "targeted_file_count_exceeds_critical_threshold",
      detail: {
        targetedFileCount: req.context.targetedFileCount,
        threshold: policy.criticalBlastRadiusFileThreshold,
      },
    };
  }
  return null;
}

function matchSensitiveExport(req: ConfirmationRequest): ConfirmationMatch | null {
  if (
    req.surface === "diagnostics.export" &&
    (req.context.diagnosticsIncludesSecrets || req.context.diagnosticsIncludesWorkspaceContent)
  ) {
    return {
      ruleId: "sensitive_diagnostics_export",
      ruleKind: "sensitive-export",
      decision: "require",
      reason: "diagnostics_export_contains_sensitive_workspace_material",
      detail: {
        diagnosticsIncludesSecrets: req.context.diagnosticsIncludesSecrets,
        diagnosticsIncludesWorkspaceContent: req.context.diagnosticsIncludesWorkspaceContent,
        diagnosticsIncludesLogs: req.context.diagnosticsIncludesLogs,
      },
    };
  }
  return null;
}

function matchTrustTransition(req: ConfirmationRequest): ConfirmationMatch | null {
  if (req.surface === "workspace.trust.set") {
    return {
      ruleId: "trust_transition",
      ruleKind: "trust-transition",
      decision: "require",
      reason: "workspace_trust_transition_requires_human_confirmation",
      detail: {
        workspaceTrust: req.context.workspaceTrust,
      },
    };
  }
  return null;
}

function matchDestructiveApply(req: ConfirmationRequest): ConfirmationMatch | null {
  if (req.surface === "patch.apply" && (req.risk === "high" || req.risk === "critical" || req.context.pendingChangeCount > 0)) {
    return {
      ruleId: "destructive_patch_apply",
      ruleKind: "destructive",
      decision: "require",
      reason: "governed_apply_has_destructive_or_existing_change_risk",
      detail: {
        risk: req.risk,
        pendingChangeCount: req.context.pendingChangeCount,
      },
    };
  }
  return null;
}

function matchServiceControl(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (
    (req.surface === "agent.stop" || req.surface === "agent.start") &&
    req.context.serviceRestartCount >= policy.serviceRestartConfirmationThreshold
  ) {
    return {
      ruleId: "service_control_repeated_restart",
      ruleKind: "service-control",
      decision: "require",
      reason: "service_restart_count_exceeds_confirmation_threshold",
      detail: {
        serviceRestartCount: req.context.serviceRestartCount,
        threshold: policy.serviceRestartConfirmationThreshold,
      },
    };
  }
  return null;
}

function matchHighBlastRadius(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (req.context.targetedFileCount >= policy.highBlastRadiusFileThreshold) {
    return {
      ruleId: "high_blast_radius",
      ruleKind: "blast-radius",
      decision: "require",
      reason: "targeted_file_count_exceeds_high_threshold",
      detail: {
        targetedFileCount: req.context.targetedFileCount,
        threshold: policy.highBlastRadiusFileThreshold,
      },
    };
  }
  return null;
}

function matchSystemExemption(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (
    policy.systemExemptionEnabled &&
    req.actor === "system" &&
    (req.risk === "none" || req.risk === "low") &&
    req.surface !== "patch.apply" &&
    req.surface !== "diagnostics.export" &&
    req.surface !== "workspace.trust.set"
  ) {
    return {
      ruleId: "system_exemption",
      ruleKind: "system-exemption",
      decision: "skip",
      reason: "low_risk_system_action_exempted",
      detail: {
        actor: req.actor,
        risk: req.risk,
      },
    };
  }
  return null;
}

function matchRecentRepeat(req: ConfirmationRequest, policy: ConfirmationPolicy, ctx?: ConfirmationContext): ConfirmationMatch | null {
  const currentTs = nowMs(ctx?.now);
  if (
    policy.repeatExemptionEnabled &&
    req.context.recentEquivalentConfirmationAtMs !== null &&
    req.context.recentEquivalentConfirmationHash === req.requestHash &&
    currentTs - req.context.recentEquivalentConfirmationAtMs <= policy.recentRepeatWindowMs
  ) {
    return {
      ruleId: "recent_repeat_exemption",
      ruleKind: "recent-repeat-exemption",
      decision: "skip",
      reason: "recent_equivalent_confirmation_still_fresh",
      detail: {
        recentEquivalentConfirmationAtMs: req.context.recentEquivalentConfirmationAtMs,
        recentRepeatWindowMs: policy.recentRepeatWindowMs,
      },
    };
  }
  return null;
}

function matchHealthyPreview(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (
    policy.previewExemptionEnabled &&
    req.surface === "patch.preview" &&
    req.context.previewOnly &&
    req.context.workspaceTrust === "trusted" &&
    req.context.workspaceHealth === "healthy" &&
    (req.risk === "none" || req.risk === "low")
  ) {
    return {
      ruleId: "healthy_preview_exemption",
      ruleKind: "healthy-preview-exemption",
      decision: "skip",
      reason: "trusted_healthy_preview_only_action",
      detail: {
        workspaceTrust: req.context.workspaceTrust,
        workspaceHealth: req.context.workspaceHealth,
      },
    };
  }
  return null;
}

function matchDryRun(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch | null {
  if (policy.dryRunExemptionEnabled && req.context.dryRun) {
    return {
      ruleId: "dry_run_exemption",
      ruleKind: "dry-run-exemption",
      decision: "skip",
      reason: "dry_run_action_does_not_require_confirmation",
      detail: {
        surface: req.surface,
      },
    };
  }
  return null;
}

function matchSurfaceDefault(req: ConfirmationRequest, policy: ConfirmationPolicy): ConfirmationMatch {
  return {
    ruleId: "surface_default",
    ruleKind: "surface-default",
    decision: policy.surfaceDefaults[req.surface],
    reason: "surface_default_policy_applied",
    detail: {
      surface: req.surface,
      defaultDecision: policy.surfaceDefaults[req.surface],
    },
  };
}

// -----------------------------------------------------------------------------
// EVALUATION
// -----------------------------------------------------------------------------

export function defaultConfirmationPolicy(): ConfirmationPolicy {
  return {
    ...DEFAULT_POLICY,
    surfaceDefaults: { ...DEFAULT_POLICY.surfaceDefaults },
  };
}

export function buildConfirmationRequest(
  surface: ConfirmationSurface,
  actor: ConfirmationActor,
  risk: ConfirmationRiskLevel,
  summary: string,
  context: ConfirmationContextSnapshot,
  traceId?: string,
): ConfirmationRequest {
  const canonicalHash = requestHash(surface, actor, risk, summary, context, traceId);
  return {
    schema: 1,
    surface,
    actor,
    risk,
    requestHash: canonicalHash,
    ...(traceId ? { traceId } : {}),
    summary,
    context: JSON.parse(stableJson(context)) as ConfirmationContextSnapshot,
  };
}

export function evaluateConfirmationRules(
  request: ConfirmationRequest,
  policy: ConfirmationPolicy = defaultConfirmationPolicy(),
  ctx?: ConfirmationContext,
): ConfirmationResult {
  assert(request.schema === 1, "request_schema_invalid");

  const expectedHash = requestHash(
    request.surface,
    request.actor,
    request.risk,
    request.summary,
    request.context,
    request.traceId,
  );
  assert(request.requestHash === expectedHash, "request_hash_drift");

  const matches: ConfirmationMatch[] = [];

  const maybePush = (m: ConfirmationMatch | null): void => {
    if (m) matches.push(m);
  };

  maybePush(matchCriticalBlastRadius(request, policy));
  maybePush(matchSensitiveExport(request));
  maybePush(matchTrustTransition(request));
  maybePush(matchDestructiveApply(request));
  maybePush(matchServiceControl(request, policy));
  maybePush(matchHighBlastRadius(request, policy));
  maybePush(matchSystemExemption(request, policy));
  maybePush(matchRecentRepeat(request, policy, ctx));
  maybePush(matchHealthyPreview(request, policy));
  maybePush(matchDryRun(request, policy));
  matches.push(matchSurfaceDefault(request, policy));

  const effective = matches
    .map((match) => {
      const rule = CONFIRMATION_RULES.find((r) => r.id === match.ruleId);
      assert(rule, `unknown_rule:${match.ruleId}`);
      return { match, rule };
    })
    .sort((a, b) => b.rule.priority - a.rule.priority || a.rule.id.localeCompare(b.rule.id))[0];

  const core: Omit<ConfirmationResult, "hash"> = {
    schema: 1,
    decision: effective.match.decision,
    surface: request.surface,
    actor: request.actor,
    requestHash: request.requestHash,
    effectiveRuleId: effective.rule.id,
    effectiveRuleKind: effective.rule.kind,
    reason: effective.match.reason,
    matches,
  };

  const result: ConfirmationResult = {
    ...core,
    hash: resultHash(core),
  };

  emitAudit(ctx, result);
  return result;
}

export function requiresConfirmation(
  request: ConfirmationRequest,
  policy: ConfirmationPolicy = defaultConfirmationPolicy(),
  ctx?: ConfirmationContext,
): boolean {
  return evaluateConfirmationRules(request, policy, ctx).decision === "require";
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateConfirmationRule(rule: ConfirmationRule): void {
  assert(rule.schema === 1, "rule_schema_invalid");
  const core: Omit<ConfirmationRule, "hash"> = {
    schema: rule.schema,
    id: rule.id,
    kind: rule.kind,
    priority: rule.priority,
    decision: rule.decision,
    description: rule.description,
  };
  assert(rule.hash === ruleHash(core), "rule_hash_drift");
}

export function validateConfirmationResult(result: ConfirmationResult): void {
  assert(result.schema === 1, "result_schema_invalid");
  const core: Omit<ConfirmationResult, "hash"> = {
    schema: result.schema,
    decision: result.decision,
    surface: result.surface,
    actor: result.actor,
    requestHash: result.requestHash,
    effectiveRuleId: result.effectiveRuleId,
    effectiveRuleKind: result.effectiveRuleKind,
    reason: result.reason,
    matches: result.matches,
  };
  assert(result.hash === resultHash(core), "result_hash_drift");
}

export function serializeConfirmationResult(result: ConfirmationResult): string {
  validateConfirmationResult(result);
  return stableJson(result);
}
