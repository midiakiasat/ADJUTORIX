import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / invariant_enforcer.ts
 *
 * Cross-cutting invariant enforcement layer for the Electron main process.
 *
 * Position in stack:
 *   ipc_guard -> capability_enforcer -> authority_router -> mutation_boundary
 *                                                \-> invariant_enforcer
 *
 * Unlike the narrower boundary modules, this module validates SYSTEM-WIDE
 * consistency conditions that span multiple subsystems at once.
 *
 * It exists to answer questions like:
 * - Is a route decision compatible with the capability result?
 * - Is a patch apply request bound to the currently approved preview lineage?
 * - Is runtime/menu/window state mutually consistent?
 * - Are observability artifacts internally coherent with execution decisions?
 * - Did a request enter a lane that contradicts its declared operation class?
 *
 * Responsibilities:
 * - define invariant vocabulary and failure taxonomy
 * - validate composed state before execution and optionally after execution
 * - aggregate violations deterministically
 * - emit auditable invariant reports
 * - support hard-fail and soft-report modes
 *
 * Hard invariants:
 * - deny on invariant breach in hard mode
 * - invariant evaluation is pure and deterministic
 * - identical inputs produce identical report hashes
 * - no subsystem may claim success while violating a stronger global invariant
 * - preview/apply/verify lineage must remain globally coherent
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

export type InvariantSeverity = "warn" | "error" | "fatal";
export type InvariantDecision = "pass" | "fail";
export type InvariantMode = "hard" | "soft";

export type CapabilityDecision = "allow" | "deny";
export type AuthorityDecision = "allow" | "deny";
export type AuthorityLane =
  | "query"
  | "local-state"
  | "governed-preview"
  | "governed-apply"
  | "service-control"
  | "workspace-control"
  | "rpc-proxy";

export type Operation =
  | "workspace.open"
  | "workspace.close"
  | "workspace.reveal"
  | "patch.preview"
  | "patch.apply"
  | "verify.run"
  | "verify.status"
  | "ledger.current"
  | "settings.update"
  | "window.state.update"
  | "diagnostics.export"
  | "agent.start"
  | "agent.stop"
  | "runtime.snapshot"
  | "rpc.invoke";

export type CanonicalRequest = {
  schema: 1;
  actor: "renderer" | "menu" | "main" | "system";
  operation: Operation;
  payload: Record<string, JsonValue>;
  request_hash: string;
  trace_id?: string;
};

export type CapabilityResult = {
  schema: 1;
  actor: CanonicalRequest["actor"];
  operation: Operation;
  operation_class: string;
  decision: CapabilityDecision;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AuthorityRoute = {
  schema: 1;
  actor: CanonicalRequest["actor"];
  operation: Operation;
  lane: AuthorityLane;
  decision: AuthorityDecision;
  reason: string;
  request_hash: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type MutationBoundarySnapshot = {
  approved_preview_hash: string | null;
  verified_preview_hash: string | null;
  workspace_open: boolean;
  settings_mutable: boolean;
  window_state_mutable: boolean;
  diagnostics_enabled: boolean;
  managed_agent_running: boolean;
};

export type RuntimeCoherenceSnapshot = {
  workspace_path: string | null;
  menu_workspace_path: string | null;
  sidebar_visible: boolean;
  activity_visible: boolean;
  panel_visible: boolean;
  fullscreen: boolean;
  zoom_factor: number;
  theme: "system" | "light" | "dark";
  window_exists: boolean;
  renderer_loaded: boolean;
  agent_url: string | null;
};

export type ObservabilitySnapshot = {
  last_event_hash?: string;
  last_error_hash?: string;
  last_metric_snapshot_hash?: string;
  trace_id?: string;
};

export type InvariantInput = {
  request: CanonicalRequest;
  capability: CapabilityResult;
  route: AuthorityRoute;
  mutation: MutationBoundarySnapshot;
  runtime: RuntimeCoherenceSnapshot;
  observability?: ObservabilitySnapshot;
};

export type InvariantViolation = {
  code: string;
  severity: InvariantSeverity;
  message: string;
  detail: Record<string, JsonValue>;
};

export type InvariantReport = {
  schema: 1;
  mode: InvariantMode;
  decision: InvariantDecision;
  request_hash: string;
  violation_count: number;
  violations: InvariantViolation[];
  hash: string;
};

export type InvariantAuditRecord = InvariantReport & {
  ts_ms: number;
};

export type InvariantContext = {
  mode?: InvariantMode;
  now?: () => number;
  audit?: (record: InvariantAuditRecord) => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const OPERATION_EXPECTED_LANE: Record<Operation, AuthorityLane> = {
  "workspace.open": "workspace-control",
  "workspace.close": "workspace-control",
  "workspace.reveal": "workspace-control",
  "patch.preview": "governed-preview",
  "patch.apply": "governed-apply",
  "verify.run": "governed-preview",
  "verify.status": "query",
  "ledger.current": "query",
  "settings.update": "local-state",
  "window.state.update": "local-state",
  "diagnostics.export": "service-control",
  "agent.start": "service-control",
  "agent.stop": "service-control",
  "runtime.snapshot": "query",
  "rpc.invoke": "rpc-proxy",
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:boundary:invariant_enforcer:${message}`);
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

function reportHash(core: Omit<InvariantReport, "hash">): string {
  return sha256(stableJson(core));
}

function push(
  list: InvariantViolation[],
  code: string,
  severity: InvariantSeverity,
  message: string,
  detail: Record<string, JsonValue> = {},
): void {
  list.push({ code, severity, message, detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue> });
}

function emitAudit(ctx: InvariantContext | undefined, report: InvariantReport): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...report,
    ts_ms: (ctx.now ?? Date.now)(),
  });
}

// -----------------------------------------------------------------------------
// CORE INVARIANTS
// -----------------------------------------------------------------------------

function checkRouteMatchesOperation(input: InvariantInput, violations: InvariantViolation[]): void {
  const expected = OPERATION_EXPECTED_LANE[input.request.operation];
  if (input.route.lane !== expected) {
    push(violations, "route.lane_mismatch", "fatal", "Authority route lane does not match canonical operation lane", {
      operation: input.request.operation,
      expected_lane: expected,
      actual_lane: input.route.lane,
    });
  }
}

function checkCapabilityRouteAgreement(input: InvariantInput, violations: InvariantViolation[]): void {
  if (input.capability.decision === "deny" && input.route.decision === "allow") {
    push(violations, "capability.route_conflict", "fatal", "Authority route cannot allow an operation denied by capability enforcement", {
      capability_reason: input.capability.reason,
      route_reason: input.route.reason,
    });
  }
}

function checkRequestRouteHashAgreement(input: InvariantInput, violations: InvariantViolation[]): void {
  if (input.request.request_hash !== input.route.request_hash) {
    push(violations, "request.route_hash_mismatch", "fatal", "Authority route must refer to the same canonical request hash", {
      request_hash: input.request.request_hash,
      route_request_hash: input.route.request_hash,
    });
  }
}

function checkWorkspaceCoherence(input: InvariantInput, violations: InvariantViolation[]): void {
  const mutationWorkspace = input.mutation.workspace_open;
  const runtimeWorkspace = !!input.runtime.workspace_path;
  const menuWorkspace = !!input.runtime.menu_workspace_path;

  if (mutationWorkspace !== runtimeWorkspace) {
    push(violations, "workspace.runtime_mismatch", "error", "Mutation snapshot and runtime workspace state diverge", {
      mutation_workspace_open: mutationWorkspace,
      runtime_workspace_path: input.runtime.workspace_path,
    });
  }

  if (runtimeWorkspace !== menuWorkspace) {
    push(violations, "workspace.menu_mismatch", "warn", "Runtime workspace path and menu workspace path diverge", {
      runtime_workspace_path: input.runtime.workspace_path,
      menu_workspace_path: input.runtime.menu_workspace_path,
    });
  }

  if (input.request.operation !== "workspace.open" && !runtimeWorkspace) {
    const workspaceRequiredOps: Operation[] = [
      "workspace.close",
      "workspace.reveal",
      "patch.preview",
      "patch.apply",
      "verify.run",
    ];
    if (workspaceRequiredOps.includes(input.request.operation)) {
      push(violations, "workspace.required_missing", "fatal", "Operation requires an open workspace but runtime reports none", {
        operation: input.request.operation,
      });
    }
  }
}

function checkPreviewVerifyApplyLineage(input: InvariantInput, violations: InvariantViolation[]): void {
  const approved = input.mutation.approved_preview_hash;
  const verified = input.mutation.verified_preview_hash;
  const supplied = input.request.payload.previewHash;

  if (input.request.operation === "patch.apply") {
    if (!approved) {
      push(violations, "apply.approved_preview_missing", "fatal", "Apply operation requires approved preview lineage", {});
      return;
    }
    if (verified !== approved) {
      push(violations, "apply.verify_preview_mismatch", "fatal", "Apply operation requires verified preview hash to match approved preview hash", {
        approved_preview_hash: approved,
        verified_preview_hash: verified,
      });
    }
    if (!(typeof supplied === "string" && supplied === approved)) {
      push(violations, "apply.supplied_preview_mismatch", "fatal", "Apply request payload preview hash must match approved preview hash", {
        supplied_preview_hash: (supplied ?? null) as JsonValue,
        approved_preview_hash: approved,
      });
    }
  }

  if (input.request.operation === "verify.run") {
    if (!(typeof supplied === "string" && supplied.length > 0)) {
      push(violations, "verify.supplied_preview_missing", "error", "Verify operation must declare a preview hash in payload", {
        supplied_preview_hash: (supplied ?? null) as JsonValue,
      });
    }
  }
}

function checkLocalMutability(input: InvariantInput, violations: InvariantViolation[]): void {
  if (input.request.operation === "settings.update" && !input.mutation.settings_mutable) {
    push(violations, "settings.mutation_disabled", "fatal", "Settings update routed while settings mutability is disabled", {});
  }
  if (input.request.operation === "window.state.update" && !input.mutation.window_state_mutable) {
    push(violations, "window_state.mutation_disabled", "fatal", "Window state update routed while window state mutability is disabled", {});
  }
}

function checkDiagnosticsAndAgentControl(input: InvariantInput, violations: InvariantViolation[]): void {
  if (input.request.operation === "diagnostics.export" && !input.mutation.diagnostics_enabled) {
    push(violations, "diagnostics.disabled", "error", "Diagnostics export requested while diagnostics are disabled", {});
  }

  if (input.request.operation === "agent.start" && input.mutation.managed_agent_running) {
    push(violations, "agent.start_when_running", "error", "Agent start requested while managed agent is already running", {});
  }

  if (input.request.operation === "agent.stop" && !input.mutation.managed_agent_running) {
    push(violations, "agent.stop_when_stopped", "error", "Agent stop requested while no managed agent is running", {});
  }
}

function checkRuntimeWindowCoherence(input: InvariantInput, violations: InvariantViolation[]): void {
  if (!input.runtime.window_exists && input.runtime.renderer_loaded) {
    push(violations, "window.renderer_without_window", "fatal", "Renderer cannot be loaded if no window exists", {
      window_exists: input.runtime.window_exists,
      renderer_loaded: input.runtime.renderer_loaded,
    });
  }

  if (input.runtime.zoom_factor < 0.5 || input.runtime.zoom_factor > 3) {
    push(violations, "window.zoom_out_of_range", "warn", "Runtime zoom factor is outside allowed range", {
      zoom_factor: input.runtime.zoom_factor,
    });
  }
}

function checkObservabilityCoherence(input: InvariantInput, violations: InvariantViolation[]): void {
  if (!input.observability) return;

  if (input.request.trace_id && input.observability.trace_id && input.request.trace_id !== input.observability.trace_id) {
    push(violations, "observability.trace_id_mismatch", "warn", "Observability trace id diverges from request trace id", {
      request_trace_id: input.request.trace_id,
      observability_trace_id: input.observability.trace_id,
    });
  }

  if (input.route.decision === "deny" && !input.observability.last_error_hash && !input.observability.last_event_hash) {
    push(violations, "observability.missing_denial_artifact", "warn", "Denied route should usually emit an event or error artifact", {});
  }
}

// -----------------------------------------------------------------------------
// REPORT GENERATION
// -----------------------------------------------------------------------------

export function evaluateInvariants(input: InvariantInput, ctx?: InvariantContext): InvariantReport {
  const violations: InvariantViolation[] = [];

  checkRouteMatchesOperation(input, violations);
  checkCapabilityRouteAgreement(input, violations);
  checkRequestRouteHashAgreement(input, violations);
  checkWorkspaceCoherence(input, violations);
  checkPreviewVerifyApplyLineage(input, violations);
  checkLocalMutability(input, violations);
  checkDiagnosticsAndAgentControl(input, violations);
  checkRuntimeWindowCoherence(input, violations);
  checkObservabilityCoherence(input, violations);

  const mode: InvariantMode = ctx?.mode ?? "hard";
  const fatalish = violations.some((v) => v.severity === "fatal" || v.severity === "error");
  const decision: InvariantDecision = mode === "hard"
    ? (fatalish ? "fail" : "pass")
    : (violations.some((v) => v.severity === "fatal") ? "fail" : "pass");

  const core: Omit<InvariantReport, "hash"> = {
    schema: 1,
    mode,
    decision,
    request_hash: input.request.request_hash,
    violation_count: violations.length,
    violations,
  };

  const report: InvariantReport = {
    ...core,
    hash: reportHash(core),
  };

  emitAudit(ctx, report);
  return report;
}

export function enforceInvariants(input: InvariantInput, ctx?: InvariantContext): InvariantReport {
  const report = evaluateInvariants(input, ctx);
  if (report.decision === "fail") {
    const codes = report.violations.map((v) => v.code).join(",");
    throw new Error(`invariant_violation:${codes}`);
  }
  return report;
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateInvariantReport(report: InvariantReport): void {
  assert(report.schema === 1, "report_schema_invalid");
  assert(report.mode === "hard" || report.mode === "soft", "report_mode_invalid");
  assert(report.decision === "pass" || report.decision === "fail", "report_decision_invalid");
  assert(typeof report.request_hash === "string" && report.request_hash.length > 0, "report_request_hash_invalid");
  assert(Array.isArray(report.violations), "report_violations_invalid");
  assert(report.violation_count === report.violations.length, "report_violation_count_mismatch");

  const core: Omit<InvariantReport, "hash"> = {
    schema: report.schema,
    mode: report.mode,
    decision: report.decision,
    request_hash: report.request_hash,
    violation_count: report.violation_count,
    violations: report.violations,
  };
  assert(reportHash(core) === report.hash, "report_hash_drift");
}

export function serializeInvariantReport(report: InvariantReport): string {
  validateInvariantReport(report);
  return stableJson(report);
}

export function validateInvariantAuditRecord(record: InvariantAuditRecord): void {
  validateInvariantReport(record);
  assert(typeof record.ts_ms === "number" && Number.isFinite(record.ts_ms), "audit_ts_invalid");
}

// -----------------------------------------------------------------------------
// DEFAULT SNAPSHOTS
// -----------------------------------------------------------------------------

export function defaultMutationBoundarySnapshot(): MutationBoundarySnapshot {
  return {
    approved_preview_hash: null,
    verified_preview_hash: null,
    workspace_open: false,
    settings_mutable: true,
    window_state_mutable: true,
    diagnostics_enabled: true,
    managed_agent_running: false,
  };
}

export function defaultRuntimeCoherenceSnapshot(): RuntimeCoherenceSnapshot {
  return {
    workspace_path: null,
    menu_workspace_path: null,
    sidebar_visible: true,
    activity_visible: true,
    panel_visible: true,
    fullscreen: false,
    zoom_factor: 1,
    theme: "system",
    window_exists: false,
    renderer_loaded: false,
    agent_url: null,
  };
}
