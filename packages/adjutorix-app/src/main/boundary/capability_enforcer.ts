    import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / capability_enforcer.ts
 *
 * Canonical capability decision engine for the Electron main process.
 *
 * Role in the stack:
 * - ipc_guard filters ingress shape + channel legitimacy
 * - capability_enforcer computes whether an actor may perform an operation
 * - mutation_boundary uses the decision output to continue or deny execution
 *
 * This module exists to prevent capability logic from fragmenting across
 * bootstrap, menu, IPC handlers, and mutation handlers.
 *
 * Responsibilities:
 * - define capability vocabulary and operation mapping
 * - derive effective permissions from actor + runtime state + environment
 * - support explicit deny reasons and deterministic audit payloads
 * - model escalation-sensitive operations separately from benign controls
 * - provide a pure decision function with no hidden side effects
 *
 * Hard invariants:
 * - deny by default
 * - capability decisions are pure and serialization-stable
 * - identical inputs produce identical decision hashes
 * - no implicit admin/root mode
 * - local state mutation and governed mutation remain distinct classes
 * - external actor identity never bypasses runtime state constraints
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

export type CapabilityActor = "renderer" | "menu" | "main" | "system";

export type CapabilityOperation =
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

export type CapabilityClass =
  | "query"
  | "control"
  | "local-state"
  | "governed-preview"
  | "governed-apply"
  | "service-control";

export type CapabilityDecision = "allow" | "deny";

export type CapabilityPolicy = {
  allowWorkspaceOpen: boolean;
  allowWorkspaceClose: boolean;
  allowWorkspaceReveal: boolean;
  allowPatchPreview: boolean;
  allowPatchApply: boolean;
  allowVerifyRun: boolean;
  allowVerifyStatus: boolean;
  allowLedgerCurrent: boolean;
  allowSettingsUpdate: boolean;
  allowWindowStateUpdate: boolean;
  allowDiagnosticsExport: boolean;
  allowAgentStart: boolean;
  allowAgentStop: boolean;
  allowRuntimeSnapshot: boolean;
  allowRpcInvoke: boolean;
};

export type CapabilityRuntimeState = {
  workspacePath: string | null;
  workspaceDirty: boolean;
  approvedPreviewHash: string | null;
  verifyPassedPreviewHash: string | null;
  managedAgentRunning: boolean;
  settingsMutable: boolean;
  windowStateMutable: boolean;
  diagnosticsEnabled: boolean;
  agentConfigured: boolean;
  strictMode: boolean;
  smokeMode: boolean;
};

export type CapabilityInput = {
  actor: CapabilityActor;
  operation: CapabilityOperation;
  policy: CapabilityPolicy;
  state: CapabilityRuntimeState;
  payload?: Record<string, JsonValue>;
};

export type CapabilityResult = {
  schema: 1;
  actor: CapabilityActor;
  operation: CapabilityOperation;
  operation_class: CapabilityClass;
  decision: CapabilityDecision;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type CapabilityAuditRecord = CapabilityResult & {
  ts_ms: number;
};

export type CapabilityEnforcerContext = {
  now?: () => number;
  audit?: (record: CapabilityAuditRecord) => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const OPERATION_CLASS: Record<CapabilityOperation, CapabilityClass> = {
  "workspace.open": "control",
  "workspace.close": "control",
  "workspace.reveal": "control",
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
  "rpc.invoke": "control",
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:boundary:capability_enforcer:${message}`);
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

function buildResultHash(core: Omit<CapabilityResult, "hash">): string {
  return sha256(stableJson(core));
}

function isActor(value: string): value is CapabilityActor {
  return value === "renderer" || value === "menu" || value === "main" || value === "system";
}

function isOperation(value: string): value is CapabilityOperation {
  return value in OPERATION_CLASS;
}

function emitAudit(ctx: CapabilityEnforcerContext | undefined, result: CapabilityResult): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...result,
    ts_ms: (ctx.now ?? Date.now)(),
  });
}

function allow(
  input: CapabilityInput,
  reason: string,
  detail: Record<string, JsonValue> = {},
): CapabilityResult {
  const core: Omit<CapabilityResult, "hash"> = {
    schema: 1,
    actor: input.actor,
    operation: input.operation,
    operation_class: OPERATION_CLASS[input.operation],
    decision: "allow",
    reason,
    detail,
  };
  return {
    ...core,
    hash: buildResultHash(core),
  };
}

function deny(
  input: CapabilityInput,
  reason: string,
  detail: Record<string, JsonValue> = {},
): CapabilityResult {
  const core: Omit<CapabilityResult, "hash"> = {
    schema: 1,
    actor: input.actor,
    operation: input.operation,
    operation_class: OPERATION_CLASS[input.operation],
    decision: "deny",
    reason,
    detail,
  };
  return {
    ...core,
    hash: buildResultHash(core),
  };
}

function workspaceRequired(input: CapabilityInput): CapabilityResult | null {
  if (!input.state.workspacePath) {
    return deny(input, "workspace_required", { workspacePath: null });
  }
  return null;
}

function previewLineageRequired(input: CapabilityInput): CapabilityResult | null {
  const approved = input.state.approvedPreviewHash;
  const verified = input.state.verifyPassedPreviewHash;
  if (!approved) {
    return deny(input, "approved_preview_missing", {});
  }
  if (verified !== approved) {
    return deny(input, "verify_preview_mismatch", {
      approvedPreviewHash: approved,
      verifyPassedPreviewHash: verified,
    });
  }
  return null;
}

// -----------------------------------------------------------------------------
// DECISION ENGINE
// -----------------------------------------------------------------------------

export function evaluateCapability(input: CapabilityInput, ctx?: CapabilityEnforcerContext): CapabilityResult {
  assert(isActor(input.actor), `actor_invalid:${input.actor}`);
  assert(isOperation(input.operation), `operation_invalid:${input.operation}`);

  const p = input.policy;
  const s = input.state;

  // Global deny rails first.
  if (s.strictMode && input.actor === "renderer" && input.operation === "rpc.invoke") {
    const result = deny(input, "strict_mode_blocks_renderer_rpc", {
      strictMode: true,
    });
    emitAudit(ctx, result);
    return result;
  }

  let result: CapabilityResult;

  switch (input.operation) {
    case "workspace.open": {
      result = p.allowWorkspaceOpen
        ? allow(input, "workspace_open_allowed")
        : deny(input, "policy_workspace_open_denied");
      break;
    }

    case "workspace.close": {
      if (!p.allowWorkspaceClose) {
        result = deny(input, "policy_workspace_close_denied");
        break;
      }
      result = s.workspacePath
        ? allow(input, "workspace_close_allowed", { workspacePath: s.workspacePath })
        : deny(input, "workspace_not_open");
      break;
    }

    case "workspace.reveal": {
      if (!p.allowWorkspaceReveal) {
        result = deny(input, "policy_workspace_reveal_denied");
        break;
      }
      const needsWorkspace = workspaceRequired(input);
      result = needsWorkspace ?? allow(input, "workspace_reveal_allowed", { workspacePath: s.workspacePath! });
      break;
    }

    case "patch.preview": {
      if (!p.allowPatchPreview) {
        result = deny(input, "policy_patch_preview_denied");
        break;
      }
      const needsWorkspace = workspaceRequired(input);
      if (needsWorkspace) {
        result = needsWorkspace;
        break;
      }
      result = allow(input, "patch_preview_allowed", {
        workspacePath: s.workspacePath!,
      });
      break;
    }

    case "patch.apply": {
      if (!p.allowPatchApply) {
        result = deny(input, "policy_patch_apply_denied");
        break;
      }
      const needsWorkspace = workspaceRequired(input);
      if (needsWorkspace) {
        result = needsWorkspace;
        break;
      }
      const lineage = previewLineageRequired(input);
      if (lineage) {
        result = lineage;
        break;
      }
      const suppliedPreviewHash = input.payload?.previewHash;
      if (!(typeof suppliedPreviewHash === "string" && suppliedPreviewHash === s.approvedPreviewHash)) {
        result = deny(input, "supplied_preview_hash_invalid", {
          suppliedPreviewHash: (suppliedPreviewHash ?? null) as JsonValue,
          approvedPreviewHash: s.approvedPreviewHash,
        });
        break;
      }
      result = allow(input, "patch_apply_allowed", {
        previewHash: suppliedPreviewHash,
      });
      break;
    }

    case "verify.run": {
      if (!p.allowVerifyRun) {
        result = deny(input, "policy_verify_run_denied");
        break;
      }
      const needsWorkspace = workspaceRequired(input);
      if (needsWorkspace) {
        result = needsWorkspace;
        break;
      }
      const suppliedPreviewHash = input.payload?.previewHash;
      if (!(typeof suppliedPreviewHash === "string" && suppliedPreviewHash.length > 0)) {
        result = deny(input, "verify_preview_hash_missing", {
          previewHash: (suppliedPreviewHash ?? null) as JsonValue,
        });
        break;
      }
      result = allow(input, "verify_run_allowed", {
        previewHash: suppliedPreviewHash,
      });
      break;
    }

    case "verify.status": {
      result = p.allowVerifyStatus
        ? allow(input, "verify_status_allowed")
        : deny(input, "policy_verify_status_denied");
      break;
    }

    case "ledger.current": {
      result = p.allowLedgerCurrent
        ? allow(input, "ledger_current_allowed")
        : deny(input, "policy_ledger_current_denied");
      break;
    }

    case "settings.update": {
      if (!p.allowSettingsUpdate) {
        result = deny(input, "policy_settings_update_denied");
        break;
      }
      result = s.settingsMutable
        ? allow(input, "settings_update_allowed")
        : deny(input, "settings_mutation_disabled");
      break;
    }

    case "window.state.update": {
      if (!p.allowWindowStateUpdate) {
        result = deny(input, "policy_window_state_update_denied");
        break;
      }
      result = s.windowStateMutable
        ? allow(input, "window_state_update_allowed")
        : deny(input, "window_state_mutation_disabled");
      break;
    }

    case "diagnostics.export": {
      if (!p.allowDiagnosticsExport) {
        result = deny(input, "policy_diagnostics_export_denied");
        break;
      }
      result = s.diagnosticsEnabled
        ? allow(input, "diagnostics_export_allowed")
        : deny(input, "diagnostics_disabled");
      break;
    }

    case "agent.start": {
      if (!p.allowAgentStart) {
        result = deny(input, "policy_agent_start_denied");
        break;
      }
      if (!s.agentConfigured) {
        result = deny(input, "agent_not_configured");
        break;
      }
      result = s.managedAgentRunning
        ? deny(input, "agent_already_running")
        : allow(input, "agent_start_allowed");
      break;
    }

    case "agent.stop": {
      if (!p.allowAgentStop) {
        result = deny(input, "policy_agent_stop_denied");
        break;
      }
      result = s.managedAgentRunning
        ? allow(input, "agent_stop_allowed")
        : deny(input, "agent_not_running");
      break;
    }

    case "runtime.snapshot": {
      result = p.allowRuntimeSnapshot
        ? allow(input, "runtime_snapshot_allowed")
        : deny(input, "policy_runtime_snapshot_denied");
      break;
    }

    case "rpc.invoke": {
      if (!p.allowRpcInvoke) {
        result = deny(input, "policy_rpc_invoke_denied");
        break;
      }
      const method = input.payload?.method;
      if (!(typeof method === "string" && method.length > 0)) {
        result = deny(input, "rpc_method_missing", {
          method: (method ?? null) as JsonValue,
        });
        break;
      }
      result = allow(input, "rpc_invoke_allowed", {
        method,
      });
      break;
    }

    default: {
      const exhaustive: never = input.operation;
      result = deny(input, "operation_unhandled", { operation: exhaustive as never });
      break;
    }
  }

  emitAudit(ctx, result);
  return result;
}

// -----------------------------------------------------------------------------
// ENFORCEMENT
// -----------------------------------------------------------------------------

export function enforceCapability(input: CapabilityInput, ctx?: CapabilityEnforcerContext): CapabilityResult {
  const result = evaluateCapability(input, ctx);
  if (result.decision === "deny") {
    throw new Error(`capability_denied:${result.reason}`);
  }
  return result;
}

// -----------------------------------------------------------------------------
// POLICY HELPERS
// -----------------------------------------------------------------------------

export function permissivePolicy(): CapabilityPolicy {
  return {
    allowWorkspaceOpen: true,
    allowWorkspaceClose: true,
    allowWorkspaceReveal: true,
    allowPatchPreview: true,
    allowPatchApply: true,
    allowVerifyRun: true,
    allowVerifyStatus: true,
    allowLedgerCurrent: true,
    allowSettingsUpdate: true,
    allowWindowStateUpdate: true,
    allowDiagnosticsExport: true,
    allowAgentStart: true,
    allowAgentStop: true,
    allowRuntimeSnapshot: true,
    allowRpcInvoke: true,
  };
}

export function rendererConstrainedPolicy(): CapabilityPolicy {
  return {
    allowWorkspaceOpen: true,
    allowWorkspaceClose: true,
    allowWorkspaceReveal: true,
    allowPatchPreview: true,
    allowPatchApply: true,
    allowVerifyRun: true,
    allowVerifyStatus: true,
    allowLedgerCurrent: true,
    allowSettingsUpdate: true,
    allowWindowStateUpdate: true,
    allowDiagnosticsExport: true,
    allowAgentStart: false,
    allowAgentStop: false,
    allowRuntimeSnapshot: true,
    allowRpcInvoke: false,
  };
}

export function defaultRuntimeState(): CapabilityRuntimeState {
  return {
    workspacePath: null,
    workspaceDirty: false,
    approvedPreviewHash: null,
    verifyPassedPreviewHash: null,
    managedAgentRunning: false,
    settingsMutable: true,
    windowStateMutable: true,
    diagnosticsEnabled: true,
    agentConfigured: false,
    strictMode: true,
    smokeMode: false,
  };
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateCapabilityResult(result: CapabilityResult): void {
  assert(result.schema === 1, "result_schema_invalid");
  assert(isActor(result.actor), `result_actor_invalid:${result.actor}`);
  assert(isOperation(result.operation), `result_operation_invalid:${result.operation}`);
  assert(result.operation_class === OPERATION_CLASS[result.operation], "result_operation_class_mismatch");
  assert(result.decision === "allow" || result.decision === "deny", "result_decision_invalid");
  assert(typeof result.reason === "string" && result.reason.length > 0, "result_reason_invalid");

  const core: Omit<CapabilityResult, "hash"> = {
    schema: result.schema,
    actor: result.actor,
    operation: result.operation,
    operation_class: result.operation_class,
    decision: result.decision,
    reason: result.reason,
    detail: result.detail,
  };
  assert(buildResultHash(core) === result.hash, "result_hash_drift");
}

export function serializeCapabilityResult(result: CapabilityResult): string {
  validateCapabilityResult(result);
  return stableJson(result);
}

export function validateCapabilityAuditRecord(record: CapabilityAuditRecord): void {
  validateCapabilityResult(record);
  assert(typeof record.ts_ms === "number" && Number.isFinite(record.ts_ms), "audit_ts_invalid");
}
