import crypto from "node:crypto";
import { ipcMain } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / patch_ipc.ts
 *
 * Governed patch IPC adapter for the Electron main process.
 *
 * Responsibilities:
 * - normalize and validate patch preview/apply IPC payloads
 * - maintain explicit preview lineage state
 * - separate preview, approval, verification binding, and apply
 * - integrate with boundary/audit hooks instead of bypassing them
 * - register patch IPC handlers idempotently
 * - provide deterministic hashes for intents, previews, approvals, and audits
 *
 * Hard invariants:
 * - apply never executes without an approved preview hash
 * - approved preview must be the currently active preview lineage
 * - verify binding is explicit and hash-based, never implicit
 * - identical semantic preview requests produce identical preview hashes
 * - registration and teardown are explicit and total
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

export type PatchIntent = Record<string, JsonValue>;

export type PatchPreviewPayload = {
  intent: PatchIntent;
  actor?: "renderer" | "menu" | "main" | "system";
  trace_id?: string;
};

export type PatchApplyPayload = {
  patchId?: string;
  patch_id?: string;
  previewHash?: string;
  actor?: "renderer" | "menu" | "main" | "system";
  trace_id?: string;
};

export type PatchVerifyBindingPayload = {
  previewHash: string;
  verifyId: string;
  passed: boolean;
};

export type PatchPreviewRecord = {
  schema: 1;
  previewHash: string;
  intentHash: string;
  patchId: string;
  actor: "renderer" | "menu" | "main" | "system";
  createdAtMs: number;
  intent: PatchIntent;
  normalizedPreview: JsonValue;
};

export type PatchApprovalState = {
  currentPreview: PatchPreviewRecord | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
};

export type PatchAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "preview" | "approve" | "bind_verify" | "apply" | "clear";
  decision: "allow" | "deny";
  reason: string;
  previewHash?: string;
  patchId?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type PatchAuditFn = (record: PatchAuditRecord) => void;

export type PatchBoundaryHooks = {
  beforePreview?: (intent: PatchIntent) => Promise<void> | void;
  afterPreview?: (record: PatchPreviewRecord) => Promise<void> | void;
  beforeApply?: (preview: PatchPreviewRecord) => Promise<void> | void;
  afterApply?: (result: JsonValue, preview: PatchPreviewRecord) => Promise<void> | void;
};

export type PatchExecutionHandlers = {
  preview: (intent: PatchIntent) => Promise<JsonValue>;
  apply: (patchId: string, preview: PatchPreviewRecord) => Promise<JsonValue>;
};

export type PatchPolicy = {
  allowPreview: boolean;
  allowApply: boolean;
  requireVerifyBindingForApply: boolean;
  maxPreviewBytes: number;
};

export type PatchIpcOptions = {
  state: PatchApprovalState;
  policy: PatchPolicy;
  handlers: PatchExecutionHandlers;
  audit?: PatchAuditFn;
  boundary?: PatchBoundaryHooks;
  channels?: {
    preview?: string;
    apply?: string;
    bindVerify?: string;
    approve?: string;
    clear?: string;
  };
};

export type PatchPreviewResult = {
  ok: true;
  patchId: string;
  previewHash: string;
  intentHash: string;
  preview: JsonValue;
  approved: boolean;
};

export type PatchApplyResult = {
  ok: true;
  patchId: string;
  previewHash: string;
  result: JsonValue;
};

export type PatchHandlerBundle = {
  previewPatch: (payload: PatchPreviewPayload) => Promise<PatchPreviewResult>;
  approvePreview: (previewHash: string) => void;
  bindVerifyResult: (payload: PatchVerifyBindingPayload) => void;
  clearApprovalState: () => void;
  applyPatch: (payload: PatchApplyPayload) => Promise<PatchApplyResult>;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_CHANNELS = {
  preview: "adjutorix:patch:preview",
  apply: "adjutorix:patch:apply",
  bindVerify: "adjutorix:patch:bindVerify",
  approve: "adjutorix:patch:approvePreview",
  clear: "adjutorix:patch:clearPreviewState",
} as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:ipc:patch_ipc:${message}`);
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

function nowMs(): number {
  return Date.now();
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
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    return out;
  }
  return String(value);
}

function normalizeIntent(intent: unknown): PatchIntent {
  assert(intent && typeof intent === "object" && !Array.isArray(intent), "intent_invalid");
  return normalizeJson(intent) as PatchIntent;
}

function intentHash(intent: PatchIntent): string {
  return sha256(stableJson({ schema: 1, intent }));
}

function previewHash(intentHashValue: string, actor: string, preview: JsonValue): string {
  return sha256(stableJson({ schema: 1, intentHash: intentHashValue, actor, preview }));
}

function patchIdFromPreview(intentHashValue: string): string {
  return `patch_${intentHashValue.slice(0, 16)}`;
}

function auditRecord(
  action: PatchAuditRecord["action"],
  decision: PatchAuditRecord["decision"],
  reason: string,
  detail: Record<string, JsonValue>,
  previewHashValue?: string,
  patchId?: string,
): PatchAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    action,
    decision,
    reason,
    ...(previewHashValue ? { previewHash: previewHashValue } : {}),
    ...(patchId ? { patchId } : {}),
    detail,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function emitAudit(audit: PatchAuditFn | undefined, record: PatchAuditRecord): void {
  audit?.(record);
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createPatchIpc(options: PatchIpcOptions): PatchHandlerBundle {
  const state = options.state;
  const policy = options.policy;
  const handlers = options.handlers;
  const audit = options.audit;
  const boundary = options.boundary;

  const channels = {
    preview: options.channels?.preview ?? DEFAULT_CHANNELS.preview,
    apply: options.channels?.apply ?? DEFAULT_CHANNELS.apply,
    bindVerify: options.channels?.bindVerify ?? DEFAULT_CHANNELS.bindVerify,
    approve: options.channels?.approve ?? DEFAULT_CHANNELS.approve,
    clear: options.channels?.clear ?? DEFAULT_CHANNELS.clear,
  };

  let registered = false;

  const previewPatch = async (payload: PatchPreviewPayload): Promise<PatchPreviewResult> => {
    if (!policy.allowPreview) {
      const record = auditRecord("preview", "deny", "patch_preview_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`patch_preview_denied:${record.reason}`);
    }

    const actor = payload.actor ?? "renderer";
    const intent = normalizeIntent(payload.intent);
    const serialized = stableJson(intent);
    assert(Buffer.byteLength(serialized, "utf8") <= policy.maxPreviewBytes, "preview_intent_too_large");

    await maybeCallWith(boundary?.beforePreview, intent);

    const normalizedPreview = normalizeJson(await handlers.preview(intent));
    const intentHashValue = intentHash(intent);
    const patchId = patchIdFromPreview(intentHashValue);
    const previewHashValue = previewHash(intentHashValue, actor, normalizedPreview);

    const record: PatchPreviewRecord = {
      schema: 1,
      previewHash: previewHashValue,
      intentHash: intentHashValue,
      patchId,
      actor,
      createdAtMs: nowMs(),
      intent,
      normalizedPreview,
    };

    state.currentPreview = record;
    state.approvedPreviewHash = null;
    state.verifiedPreviewHash = null;
    state.verifyId = null;

    await maybeCallWith(boundary?.afterPreview, record);

    emitAudit(audit, auditRecord("preview", "allow", "patch_preview_created", {
      actor,
      intentHash: intentHashValue,
    }, previewHashValue, patchId));

    return {
      ok: true,
      patchId,
      previewHash: previewHashValue,
      intentHash: intentHashValue,
      preview: normalizedPreview,
      approved: false,
    };
  };

  const approvePreview = (previewHashValue: string): void => {
    const current = state.currentPreview;
    if (!current) {
      const record = auditRecord("approve", "deny", "no_current_preview", {}, previewHashValue);
      emitAudit(audit, record);
      throw new Error(`patch_approve_denied:${record.reason}`);
    }
    if (current.previewHash !== previewHashValue) {
      const record = auditRecord("approve", "deny", "preview_hash_mismatch", {
        currentPreviewHash: current.previewHash,
      }, previewHashValue, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_approve_denied:${record.reason}`);
    }

    state.approvedPreviewHash = current.previewHash;
    state.verifiedPreviewHash = null;
    state.verifyId = null;

    emitAudit(audit, auditRecord("approve", "allow", "preview_approved", {}, current.previewHash, current.patchId));
  };

  const bindVerifyResult = (payload: PatchVerifyBindingPayload): void => {
    const current = state.currentPreview;
    if (!current) {
      const record = auditRecord("bind_verify", "deny", "no_current_preview", {}, payload.previewHash);
      emitAudit(audit, record);
      throw new Error(`patch_bind_verify_denied:${record.reason}`);
    }
    if (current.previewHash !== payload.previewHash) {
      const record = auditRecord("bind_verify", "deny", "preview_hash_mismatch", {
        currentPreviewHash: current.previewHash,
        verifyId: payload.verifyId,
      }, payload.previewHash, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_bind_verify_denied:${record.reason}`);
    }

    state.verifyId = payload.verifyId;
    state.verifiedPreviewHash = payload.passed ? payload.previewHash : null;

    emitAudit(audit, auditRecord("bind_verify", "allow", payload.passed ? "verify_bound_passed" : "verify_bound_failed", {
      verifyId: payload.verifyId,
      passed: payload.passed,
    }, payload.previewHash, current.patchId));
  };

  const clearApprovalState = (): void => {
    const previous = state.currentPreview;
    state.currentPreview = null;
    state.approvedPreviewHash = null;
    state.verifiedPreviewHash = null;
    state.verifyId = null;

    emitAudit(audit, auditRecord("clear", "allow", "patch_state_cleared", {
      hadPreview: previous !== null,
    }, previous?.previewHash, previous?.patchId));
  };

  const applyPatch = async (payload: PatchApplyPayload): Promise<PatchApplyResult> => {
    if (!policy.allowApply) {
      const record = auditRecord("apply", "deny", "patch_apply_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    const current = state.currentPreview;
    if (!current) {
      const record = auditRecord("apply", "deny", "no_current_preview", {});
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    const suppliedPatchId = payload.patchId ?? payload.patch_id ?? current.patchId;
    const suppliedPreviewHash = payload.previewHash ?? null;

    if (suppliedPatchId !== current.patchId) {
      const record = auditRecord("apply", "deny", "patch_id_mismatch", {
        suppliedPatchId,
        currentPatchId: current.patchId,
      }, suppliedPreviewHash ?? undefined, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    if (state.approvedPreviewHash !== current.previewHash) {
      const record = auditRecord("apply", "deny", "preview_not_approved", {
        approvedPreviewHash: state.approvedPreviewHash,
        currentPreviewHash: current.previewHash,
      }, current.previewHash, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    if (!(typeof suppliedPreviewHash === "string" && suppliedPreviewHash === current.previewHash)) {
      const record = auditRecord("apply", "deny", "supplied_preview_hash_invalid", {
        suppliedPreviewHash: suppliedPreviewHash as JsonValue,
        currentPreviewHash: current.previewHash,
      }, suppliedPreviewHash ?? undefined, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    if (policy.requireVerifyBindingForApply && state.verifiedPreviewHash !== current.previewHash) {
      const record = auditRecord("apply", "deny", "verify_binding_required", {
        verifiedPreviewHash: state.verifiedPreviewHash,
        currentPreviewHash: current.previewHash,
        verifyId: state.verifyId,
      }, current.previewHash, current.patchId);
      emitAudit(audit, record);
      throw new Error(`patch_apply_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.beforeApply, current);
    const result = normalizeJson(await handlers.apply(current.patchId, current));
    await maybeCallWith(boundary?.afterApply, result, undefined as never);

    emitAudit(audit, auditRecord("apply", "allow", "patch_applied", {
      verifyId: state.verifyId,
    }, current.previewHash, current.patchId));

    return {
      ok: true,
      patchId: current.patchId,
      previewHash: current.previewHash,
      result,
    };
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(channels.preview, async (_event, payload: PatchPreviewPayload) => previewPatch(payload));
    ipcMain.handle(channels.apply, async (_event, payload: PatchApplyPayload) => applyPatch(payload));
    ipcMain.handle(channels.bindVerify, async (_event, payload: PatchVerifyBindingPayload) => {
      bindVerifyResult(payload);
      return { ok: true };
    });
    ipcMain.handle(channels.approve, async (_event, previewHashValue: string) => {
      approvePreview(previewHashValue);
      return { ok: true };
    });
    ipcMain.handle(channels.clear, async () => {
      clearApprovalState();
      return { ok: true };
    });

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(channels.preview);
    ipcMain.removeHandler(channels.apply);
    ipcMain.removeHandler(channels.bindVerify);
    ipcMain.removeHandler(channels.approve);
    ipcMain.removeHandler(channels.clear);
    registered = false;
  };

  return {
    previewPatch,
    approvePreview,
    bindVerifyResult,
    clearApprovalState,
    applyPatch,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION
// -----------------------------------------------------------------------------

export function createDefaultPatchApprovalState(): PatchApprovalState {
  return {
    currentPreview: null,
    approvedPreviewHash: null,
    verifiedPreviewHash: null,
    verifyId: null,
  };
}

export function createDefaultPatchPolicy(): PatchPolicy {
  return {
    allowPreview: true,
    allowApply: true,
    requireVerifyBindingForApply: true,
    maxPreviewBytes: 256 * 1024,
  };
}

export function validatePatchApprovalState(state: PatchApprovalState): void {
  if (state.currentPreview !== null) {
    assert(typeof state.currentPreview.previewHash === "string" && state.currentPreview.previewHash.length > 0, "preview_hash_invalid");
    assert(typeof state.currentPreview.patchId === "string" && state.currentPreview.patchId.length > 0, "patch_id_invalid");
  }
}
