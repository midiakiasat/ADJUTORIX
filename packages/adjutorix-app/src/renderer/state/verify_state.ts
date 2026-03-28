/**
 * ADJUTORIX APP — RENDERER / STATE / verify_state.ts
 *
 * Canonical renderer-side verification workflow state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for verification lifecycle state
 * - unify verify job identity, target set, bound preview lineage, streamed evidence,
 *   status transitions, terminal outcomes, and UI navigation under one deterministic reducer
 * - prevent divergence between verify panel, patch review, diagnostics, activity feed,
 *   and apply readiness that each guess what the “current verification” actually is
 * - provide pure transitions suitable for replay, testing, diagnostics, and invariants
 *
 * Scope:
 * - verify job identity and lifecycle
 * - target paths and bound preview lineage
 * - evidence snapshots, streamed logs, checks, and summary counters
 * - pass/fail/partial semantics and terminal binding
 * - navigation/filter UI state for renderer consumption
 * - freshness and staleness detection inputs
 *
 * Non-scope:
 * - executing verification itself
 * - transport implementation for logs/status polling
 * - patch application gating logic itself
 *
 * Hard invariants:
 * - identical prior state + identical action => identical next state hash
 * - target paths are unique, normalized, and deterministically ordered
 * - bound verified preview lineage may not silently diverge from active preview lineage
 * - terminal outcomes dominate non-terminal status flags
 * - streamed evidence appends deterministically and remains bounded
 * - outputs are serialization-stable and audit-friendly
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
// DOMAIN TYPES
// -----------------------------------------------------------------------------

export type VerifyPhase =
  | "idle"
  | "requested"
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "partial"
  | "cancelled"
  | "stale"
  | "error";

export type VerifyOutcome = "unknown" | "passed" | "failed" | "partial" | "cancelled";
export type VerifyCheckSeverity = "info" | "warn" | "error" | "fatal";
export type VerifyCheckStatus = "pending" | "running" | "passed" | "failed" | "skipped";
export type VerifyAttention = "none" | "low" | "medium" | "high" | "critical";

export type VerifyLineage = {
  verifyId: string | null;
  previewHash: string | null;
  verifiedPreviewHash: string | null;
  requestHash: string | null;
  patchId: string | null;
};

export type VerifySummary = {
  totalChecks: number;
  passedChecks: number;
  failedChecks: number;
  skippedChecks: number;
  warnings: number;
  errors: number;
};

export type VerifyCheckRecord = {
  checkId: string;
  name: string;
  status: VerifyCheckStatus;
  severity: VerifyCheckSeverity;
  message: string;
  startedAtMs: number | null;
  endedAtMs: number | null;
  detail: JsonObject | null;
  hash: string;
};

export type VerifyLogEntry = {
  seq: number;
  level: "info" | "warn" | "error";
  message: string;
  atMs: number;
  hash: string;
};

export type VerifyEvidence = {
  status: JsonObject | null;
  result: JsonObject | null;
  diagnostics: JsonObject | null;
  ledger: JsonObject | null;
};

export type VerifyNavigationState = {
  filterQuery: string;
  selectedCheckId: string | null;
  showOnlyFailures: boolean;
  showOnlyAttention: boolean;
  expandedCheckIds: string[];
};

export type VerifyState = {
  schema: 1;
  phase: VerifyPhase;
  outcome: VerifyOutcome;
  lineage: VerifyLineage;
  targets: string[];
  summary: VerifySummary;
  checks: Record<string, VerifyCheckRecord>;
  checkOrder: string[];
  logs: VerifyLogEntry[];
  navigation: VerifyNavigationState;
  attention: VerifyAttention;
  queuedAtMs: number | null;
  startedAtMs: number | null;
  endedAtMs: number | null;
  lastStatusAtMs: number | null;
  staleAtMs: number | null;
  boundToPatchReview: boolean;
  terminal: boolean;
  evidence: VerifyEvidence;
  lastError: string | null;
  hash: string;
};

export type VerifyRequestPayload = {
  verifyId?: string | null;
  previewHash?: string | null;
  requestHash?: string | null;
  patchId?: string | null;
  targets?: string[];
  queuedAtMs?: number;
};

export type VerifyCheckInput = {
  checkId: string;
  name: string;
  status?: VerifyCheckStatus;
  severity?: VerifyCheckSeverity;
  message?: string;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  detail?: JsonObject | null;
};

export type VerifyLogInput = {
  seq: number;
  level?: "info" | "warn" | "error";
  message: string;
  atMs?: number;
};

export type VerifyStateAction =
  | { type: "VERIFY_REQUESTED"; payload: VerifyRequestPayload }
  | { type: "VERIFY_QUEUED"; verifyId: string; status?: JsonObject | null; atMs?: number }
  | { type: "VERIFY_RUNNING"; verifyId: string; status?: JsonObject | null; atMs?: number }
  | { type: "VERIFY_STATUS_UPDATED"; status: JsonObject | null; atMs?: number }
  | { type: "VERIFY_RESULT_BOUND"; outcome: VerifyOutcome; verifiedPreviewHash?: string | null; result?: JsonObject | null; atMs?: number }
  | { type: "VERIFY_FAILED"; error: string; result?: JsonObject | null; atMs?: number }
  | { type: "VERIFY_CANCELLED"; atMs?: number }
  | { type: "VERIFY_STALE_MARKED"; atMs?: number }
  | { type: "VERIFY_TARGETS_REPLACED"; targets: string[] }
  | { type: "VERIFY_LINEAGE_BOUND"; verifyId?: string | null; previewHash?: string | null; verifiedPreviewHash?: string | null; requestHash?: string | null; patchId?: string | null }
  | { type: "VERIFY_CHECKS_REPLACED"; checks: VerifyCheckInput[] }
  | { type: "VERIFY_CHECK_UPDATED"; check: VerifyCheckInput }
  | { type: "VERIFY_LOG_APPENDED"; log: VerifyLogInput }
  | { type: "VERIFY_LOGS_REPLACED"; logs: VerifyLogInput[] }
  | { type: "VERIFY_FILTER_SET"; query: string }
  | { type: "VERIFY_SELECTED_CHECK_SET"; checkId: string | null }
  | { type: "VERIFY_SHOW_ONLY_FAILURES_SET"; enabled: boolean }
  | { type: "VERIFY_SHOW_ONLY_ATTENTION_SET"; enabled: boolean }
  | { type: "VERIFY_CHECK_EXPANDED_TOGGLED"; checkId: string }
  | { type: "VERIFY_DIAGNOSTICS_EVIDENCE_SET"; diagnostics: JsonObject | null }
  | { type: "VERIFY_LEDGER_EVIDENCE_SET"; ledger: JsonObject | null }
  | { type: "VERIFY_BOUND_TO_PATCH_REVIEW"; bound: boolean }
  | { type: "VERIFY_ERROR_CLEARED" }
  | { type: "VERIFY_RESET" };

export type VerifySelector<T> = (state: VerifyState) => T;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

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

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function nowMs(input?: number): number {
  return input ?? Date.now();
}

function normalizePath(path: string): string {
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(stableJson(value)) as JsonObject;
}

function severityRank(severity: VerifyCheckSeverity): number {
  return { info: 0, warn: 1, error: 2, fatal: 3 }[severity];
}

function attentionFromChecks(checks: Record<string, VerifyCheckRecord>, outcome: VerifyOutcome, lastError: string | null): VerifyAttention {
  if (lastError) return "critical";
  if (outcome === "failed") return "high";
  if (outcome === "partial") return "medium";
  const maxSeverity = Object.values(checks).reduce((m, c) => Math.max(m, severityRank(c.severity)), 0);
  if (maxSeverity >= 3) return "critical";
  if (maxSeverity >= 2) return "high";
  if (maxSeverity >= 1) return "medium";
  return "none";
}

function computeCheckHash(core: Omit<VerifyCheckRecord, "hash">): string {
  return hashString(stableJson(core));
}

function computeLogHash(core: Omit<VerifyLogEntry, "hash">): string {
  return hashString(stableJson(core));
}

function computeStateHash(core: Omit<VerifyState, "hash">): string {
  return hashString(stableJson(core));
}

function makeCheck(input: VerifyCheckInput): VerifyCheckRecord {
  const core: Omit<VerifyCheckRecord, "hash"> = {
    checkId: input.checkId,
    name: input.name,
    status: input.status ?? "pending",
    severity: input.severity ?? "info",
    message: input.message ?? "",
    startedAtMs: input.startedAtMs ?? null,
    endedAtMs: input.endedAtMs ?? null,
    detail: input.detail ?? null,
  };
  return { ...core, hash: computeCheckHash(core) };
}

function withCheck(existing: VerifyCheckRecord, patch: Partial<Omit<VerifyCheckRecord, "hash">>): VerifyCheckRecord {
  const core: Omit<VerifyCheckRecord, "hash"> = {
    checkId: patch.checkId ?? existing.checkId,
    name: patch.name ?? existing.name,
    status: patch.status ?? existing.status,
    severity: patch.severity ?? existing.severity,
    message: patch.message ?? existing.message,
    startedAtMs: patch.startedAtMs ?? existing.startedAtMs,
    endedAtMs: patch.endedAtMs ?? existing.endedAtMs,
    detail: patch.detail ?? existing.detail,
  };
  return { ...core, hash: computeCheckHash(core) };
}

function makeLog(input: VerifyLogInput): VerifyLogEntry {
  const core: Omit<VerifyLogEntry, "hash"> = {
    seq: input.seq,
    level: input.level ?? "info",
    message: input.message,
    atMs: nowMs(input.atMs),
  };
  return { ...core, hash: computeLogHash(core) };
}

function deriveSummary(checks: Record<string, VerifyCheckRecord>): VerifySummary {
  const values = Object.values(checks);
  return {
    totalChecks: values.length,
    passedChecks: values.filter((c) => c.status === "passed").length,
    failedChecks: values.filter((c) => c.status === "failed").length,
    skippedChecks: values.filter((c) => c.status === "skipped").length,
    warnings: values.filter((c) => c.severity === "warn").length,
    errors: values.filter((c) => c.severity === "error" || c.severity === "fatal").length,
  };
}

function deriveTerminal(phase: VerifyPhase): boolean {
  return ["passed", "failed", "partial", "cancelled", "stale", "error"].includes(phase);
}

function derivePhase(core: Omit<VerifyState, "hash">): VerifyPhase {
  if (core.lastError) return "error";
  if (core.phase === "cancelled") return "cancelled";
  if (core.phase === "stale") return "stale";
  if (core.outcome === "passed") return core.lineage.verifiedPreviewHash ? "passed" : "partial";
  if (core.outcome === "failed") return "failed";
  if (core.outcome === "partial") return "partial";
  if (core.startedAtMs) return "running";
  if (core.queuedAtMs) return "queued";
  if (core.lineage.verifyId || core.lineage.previewHash) return "requested";
  return "idle";
}

function recompute(state: Omit<VerifyState, "hash">): VerifyState {
  const next: Omit<VerifyState, "hash"> = {
    ...state,
    summary: deriveSummary(state.checks),
    attention: attentionFromChecks(state.checks, state.outcome, state.lastError),
  };
  next.phase = derivePhase(next);
  next.terminal = deriveTerminal(next.phase);
  return { ...next, hash: computeStateHash(next) };
}

function buildChecks(inputs: VerifyCheckInput[]): { checks: Record<string, VerifyCheckRecord>; order: string[] } {
  const checks: Record<string, VerifyCheckRecord> = {};
  const order = [...new Set(inputs.map((c) => c.checkId))].sort((a, b) => a.localeCompare(b));
  for (const input of inputs) {
    const check = makeCheck(input);
    checks[check.checkId] = check;
  }
  return { checks, order };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialVerifyState(): VerifyState {
  const core: Omit<VerifyState, "hash"> = {
    schema: 1,
    phase: "idle",
    outcome: "unknown",
    lineage: {
      verifyId: null,
      previewHash: null,
      verifiedPreviewHash: null,
      requestHash: null,
      patchId: null,
    },
    targets: [],
    summary: {
      totalChecks: 0,
      passedChecks: 0,
      failedChecks: 0,
      skippedChecks: 0,
      warnings: 0,
      errors: 0,
    },
    checks: {},
    checkOrder: [],
    logs: [],
    navigation: {
      filterQuery: "",
      selectedCheckId: null,
      showOnlyFailures: false,
      showOnlyAttention: false,
      expandedCheckIds: [],
    },
    attention: "none",
    queuedAtMs: null,
    startedAtMs: null,
    endedAtMs: null,
    lastStatusAtMs: null,
    staleAtMs: null,
    boundToPatchReview: false,
    terminal: false,
    evidence: {
      status: null,
      result: null,
      diagnostics: null,
      ledger: null,
    },
    lastError: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function verifyStateReducer(state: VerifyState, action: VerifyStateAction): VerifyState {
  const core: Omit<VerifyState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    outcome: state.outcome,
    lineage: { ...state.lineage },
    targets: [...state.targets],
    summary: { ...state.summary },
    checks: { ...state.checks },
    checkOrder: [...state.checkOrder],
    logs: [...state.logs],
    navigation: { ...state.navigation, expandedCheckIds: [...state.navigation.expandedCheckIds] },
    attention: state.attention,
    queuedAtMs: state.queuedAtMs,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    lastStatusAtMs: state.lastStatusAtMs,
    staleAtMs: state.staleAtMs,
    boundToPatchReview: state.boundToPatchReview,
    terminal: state.terminal,
    evidence: { ...state.evidence },
    lastError: state.lastError,
  };

  switch (action.type) {
    case "VERIFY_REQUESTED": {
      core.lineage.verifyId = action.payload.verifyId ?? null;
      core.lineage.previewHash = action.payload.previewHash ?? null;
      core.lineage.requestHash = action.payload.requestHash ?? null;
      core.lineage.patchId = action.payload.patchId ?? null;
      core.targets = uniqueSortedPaths(action.payload.targets ?? []);
      core.queuedAtMs = nowMs(action.payload.queuedAtMs);
      core.startedAtMs = null;
      core.endedAtMs = null;
      core.outcome = "unknown";
      core.lastError = null;
      core.evidence.status = null;
      core.evidence.result = null;
      return recompute(core);
    }

    case "VERIFY_QUEUED": {
      core.lineage.verifyId = action.verifyId;
      core.queuedAtMs = nowMs(action.atMs);
      core.lastStatusAtMs = nowMs(action.atMs);
      core.evidence.status = action.status ?? core.evidence.status;
      return recompute(core);
    }

    case "VERIFY_RUNNING": {
      core.lineage.verifyId = action.verifyId;
      core.startedAtMs = nowMs(action.atMs);
      core.lastStatusAtMs = nowMs(action.atMs);
      core.evidence.status = action.status ?? core.evidence.status;
      core.lastError = null;
      return recompute(core);
    }

    case "VERIFY_STATUS_UPDATED": {
      core.evidence.status = action.status;
      core.lastStatusAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "VERIFY_RESULT_BOUND": {
      core.outcome = action.outcome;
      core.lineage.verifiedPreviewHash = action.verifiedPreviewHash ?? null;
      core.evidence.result = action.result ?? core.evidence.result;
      core.endedAtMs = nowMs(action.atMs);
      core.lastStatusAtMs = nowMs(action.atMs);
      core.lastError = null;
      return recompute(core);
    }

    case "VERIFY_FAILED": {
      core.outcome = "failed";
      core.endedAtMs = nowMs(action.atMs);
      core.lastStatusAtMs = nowMs(action.atMs);
      core.evidence.result = action.result ?? core.evidence.result;
      core.lineage.verifiedPreviewHash = null;
      core.lastError = action.error;
      return recompute(core);
    }

    case "VERIFY_CANCELLED": {
      core.outcome = "cancelled";
      core.phase = "cancelled";
      core.endedAtMs = nowMs(action.atMs);
      core.lastStatusAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "VERIFY_STALE_MARKED": {
      core.phase = "stale";
      core.staleAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "VERIFY_TARGETS_REPLACED": {
      core.targets = uniqueSortedPaths(action.targets);
      return recompute(core);
    }

    case "VERIFY_LINEAGE_BOUND": {
      if (action.verifyId !== undefined) core.lineage.verifyId = action.verifyId;
      if (action.previewHash !== undefined) core.lineage.previewHash = action.previewHash;
      if (action.verifiedPreviewHash !== undefined) core.lineage.verifiedPreviewHash = action.verifiedPreviewHash;
      if (action.requestHash !== undefined) core.lineage.requestHash = action.requestHash;
      if (action.patchId !== undefined) core.lineage.patchId = action.patchId;
      return recompute(core);
    }

    case "VERIFY_CHECKS_REPLACED": {
      const built = buildChecks(action.checks);
      core.checks = built.checks;
      core.checkOrder = built.order;
      if (!core.navigation.selectedCheckId || !core.checks[core.navigation.selectedCheckId]) {
        core.navigation.selectedCheckId = built.order[0] ?? null;
      }
      core.navigation.expandedCheckIds = built.order;
      return recompute(core);
    }

    case "VERIFY_CHECK_UPDATED": {
      const existing = core.checks[action.check.checkId];
      const next = existing ? withCheck(existing, {
        name: action.check.name,
        status: action.check.status,
        severity: action.check.severity,
        message: action.check.message,
        startedAtMs: action.check.startedAtMs,
        endedAtMs: action.check.endedAtMs,
        detail: action.check.detail,
      }) : makeCheck(action.check);
      core.checks[next.checkId] = next;
      core.checkOrder = [...new Set([...core.checkOrder, next.checkId])].sort((a, b) => a.localeCompare(b));
      return recompute(core);
    }

    case "VERIFY_LOG_APPENDED": {
      const next = makeLog(action.log);
      core.logs = [...core.logs.filter((l) => l.seq !== next.seq), next]
        .sort((a, b) => a.seq - b.seq)
        .slice(-500);
      return recompute(core);
    }

    case "VERIFY_LOGS_REPLACED": {
      core.logs = action.logs.map(makeLog).sort((a, b) => a.seq - b.seq).slice(-500);
      return recompute(core);
    }

    case "VERIFY_FILTER_SET": {
      core.navigation.filterQuery = action.query;
      return recompute(core);
    }

    case "VERIFY_SELECTED_CHECK_SET": {
      core.navigation.selectedCheckId = action.checkId && core.checks[action.checkId] ? action.checkId : null;
      return recompute(core);
    }

    case "VERIFY_SHOW_ONLY_FAILURES_SET": {
      core.navigation.showOnlyFailures = action.enabled;
      return recompute(core);
    }

    case "VERIFY_SHOW_ONLY_ATTENTION_SET": {
      core.navigation.showOnlyAttention = action.enabled;
      return recompute(core);
    }

    case "VERIFY_CHECK_EXPANDED_TOGGLED": {
      const set = new Set(core.navigation.expandedCheckIds);
      if (set.has(action.checkId)) set.delete(action.checkId);
      else if (core.checks[action.checkId]) set.add(action.checkId);
      core.navigation.expandedCheckIds = [...set].sort((a, b) => a.localeCompare(b));
      return recompute(core);
    }

    case "VERIFY_DIAGNOSTICS_EVIDENCE_SET": {
      core.evidence.diagnostics = action.diagnostics;
      return recompute(core);
    }

    case "VERIFY_LEDGER_EVIDENCE_SET": {
      core.evidence.ledger = action.ledger;
      return recompute(core);
    }

    case "VERIFY_BOUND_TO_PATCH_REVIEW": {
      core.boundToPatchReview = action.bound;
      return recompute(core);
    }

    case "VERIFY_ERROR_CLEARED": {
      core.lastError = null;
      return recompute(core);
    }

    case "VERIFY_RESET": {
      return createInitialVerifyState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// INTERNAL UPDATE HELPERS
// -----------------------------------------------------------------------------

function withCheck(existing: VerifyCheckRecord, patch: Partial<Omit<VerifyCheckRecord, "hash">>): VerifyCheckRecord {
  const core: Omit<VerifyCheckRecord, "hash"> = {
    checkId: patch.checkId ?? existing.checkId,
    name: patch.name ?? existing.name,
    status: patch.status ?? existing.status,
    severity: patch.severity ?? existing.severity,
    message: patch.message ?? existing.message,
    startedAtMs: patch.startedAtMs ?? existing.startedAtMs,
    endedAtMs: patch.endedAtMs ?? existing.endedAtMs,
    detail: patch.detail ?? existing.detail,
  };
  return { ...core, hash: computeCheckHash(core) };
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectVerifyPhase: VerifySelector<VerifyPhase> = (state) => state.phase;
export const selectVerifyOutcome: VerifySelector<VerifyOutcome> = (state) => state.outcome;
export const selectVerifyTargets: VerifySelector<string[]> = (state) => state.targets;
export const selectVerifyChecks = (state: VerifyState): VerifyCheckRecord[] => state.checkOrder.map((id) => state.checks[id]).filter(Boolean);
export const selectSelectedVerifyCheck: VerifySelector<VerifyCheckRecord | null> = (state) =>
  state.navigation.selectedCheckId ? state.checks[state.navigation.selectedCheckId] ?? null : null;
export const selectVerifyCanBindToPatch: VerifySelector<boolean> = (state) =>
  state.outcome === "passed" && !!state.lineage.previewHash && state.lineage.verifiedPreviewHash === state.lineage.previewHash;
export const selectVerifyFailedChecks: VerifySelector<VerifyCheckRecord[]> = (state) =>
  selectVerifyChecks(state).filter((check) => check.status === "failed");

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateVerifyCheckRecord(check: VerifyCheckRecord): void {
  const core: Omit<VerifyCheckRecord, "hash"> = {
    checkId: check.checkId,
    name: check.name,
    status: check.status,
    severity: check.severity,
    message: check.message,
    startedAtMs: check.startedAtMs,
    endedAtMs: check.endedAtMs,
    detail: check.detail,
  };
  if (check.hash !== computeCheckHash(core)) {
    throw new Error(`verify_check_hash_drift:${check.checkId}`);
  }
}

export function validateVerifyLogEntry(log: VerifyLogEntry): void {
  const core: Omit<VerifyLogEntry, "hash"> = {
    seq: log.seq,
    level: log.level,
    message: log.message,
    atMs: log.atMs,
  };
  if (log.hash !== computeLogHash(core)) {
    throw new Error(`verify_log_hash_drift:${log.seq}`);
  }
}

export function validateVerifyState(state: VerifyState): void {
  if (state.schema !== 1) throw new Error("verify_state_schema_invalid");

  const core: Omit<VerifyState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    outcome: state.outcome,
    lineage: state.lineage,
    targets: state.targets,
    summary: state.summary,
    checks: state.checks,
    checkOrder: state.checkOrder,
    logs: state.logs,
    navigation: state.navigation,
    attention: state.attention,
    queuedAtMs: state.queuedAtMs,
    startedAtMs: state.startedAtMs,
    endedAtMs: state.endedAtMs,
    lastStatusAtMs: state.lastStatusAtMs,
    staleAtMs: state.staleAtMs,
    boundToPatchReview: state.boundToPatchReview,
    terminal: state.terminal,
    evidence: state.evidence,
    lastError: state.lastError,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("verify_state_hash_drift");
  }

  const normalizedTargets = uniqueSortedPaths(state.targets);
  if (stableJson(normalizedTargets) !== stableJson(state.targets)) {
    throw new Error("verify_state_targets_not_normalized");
  }

  for (const checkId of state.checkOrder) {
    if (!state.checks[checkId]) throw new Error(`verify_state_check_order_missing:${checkId}`);
  }

  for (const [checkId, check] of Object.entries(state.checks)) {
    if (!state.checkOrder.includes(checkId)) throw new Error(`verify_state_orphan_check:${checkId}`);
    validateVerifyCheckRecord(check);
  }

  for (let i = 1; i < state.logs.length; i += 1) {
    if (state.logs[i - 1].seq > state.logs[i].seq) {
      throw new Error("verify_state_logs_not_sorted");
    }
  }
  state.logs.forEach(validateVerifyLogEntry);

  if (state.outcome === "passed" && state.lineage.verifiedPreviewHash !== state.lineage.previewHash) {
    throw new Error("verify_state_passed_lineage_mismatch");
  }

  if (state.terminal !== deriveTerminal(state.phase)) {
    throw new Error("verify_state_terminal_flag_mismatch");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyVerifyStateActions(initial: VerifyState, actions: VerifyStateAction[]): VerifyState {
  return actions.reduce(verifyStateReducer, initial);
}

export function serializeVerifyState(state: VerifyState): string {
  validateVerifyState(state);
  return stableJson(state);
}
