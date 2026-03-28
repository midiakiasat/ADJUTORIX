/**
 * ADJUTORIX APP — RENDERER / STATE / patch_review.ts
 *
 * Canonical renderer-side patch review state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for patch review workflow state
 * - unify patch identity, preview lineage, approval state, verification evidence,
 *   per-file review decisions, diff navigation, and apply readiness under one deterministic reducer
 * - prevent divergence between patch panel, editor overlays, diagnostics, verify output,
 *   and ledger/apply controls that each guess whether a patch is reviewable or approved
 * - provide pure transitions suitable for replay, testing, diagnostics, and invariants
 *
 * Scope:
 * - patch/preview/request identity
 * - review status and lifecycle
 * - file-level diff metadata and review decisions
 * - approval and verification lineage binding
 * - selected file / hunk navigation state
 * - apply eligibility and reviewer attention markers
 *
 * Non-scope:
 * - diff generation implementation
 * - patch application execution
 * - verify job execution itself
 *
 * Hard invariants:
 * - identical prior state + identical action => identical next state hash
 * - file entries are unique by normalized path and ordered deterministically
 * - approved/verified lineage must refer to the active preview lineage or be reset
 * - apply readiness is derived from explicit state, never ad hoc booleans
 * - no closed/cleared review keeps stale file selections or evidence silently
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

export type PatchReviewPhase =
  | "idle"
  | "previewing"
  | "reviewing"
  | "approved"
  | "verified"
  | "apply-ready"
  | "applied"
  | "failed";

export type PatchFileChangeKind = "create" | "modify" | "delete" | "rename" | "unknown";
export type PatchFileReviewDecision = "unreviewed" | "accepted" | "rejected" | "needs-attention";
export type PatchReviewAttention = "none" | "low" | "medium" | "high" | "critical";
export type PatchVerifyOutcome = "unknown" | "passed" | "failed" | "partial";

export type PatchSummary = {
  filesChanged: number;
  insertions: number;
  deletions: number;
  hunks: number;
};

export type PatchHunkRef = {
  hunkId: string;
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  summary: string;
};

export type PatchFileEntry = {
  path: string;
  previousPath: string | null;
  kind: PatchFileChangeKind;
  addedLines: number;
  removedLines: number;
  hunks: PatchHunkRef[];
  decision: PatchFileReviewDecision;
  comment: string | null;
  attention: PatchReviewAttention;
  viewedAtMs: number | null;
  hash: string;
};

export type PatchLineage = {
  patchId: string | null;
  previewHash: string | null;
  requestHash: string | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
};

export type PatchEvidence = {
  preview: JsonObject | null;
  verify: JsonObject | null;
  ledger: JsonObject | null;
  diagnostics: JsonObject | null;
};

export type PatchNavigationState = {
  selectedPath: string | null;
  selectedHunkId: string | null;
  expandedPaths: string[];
  filterQuery: string;
  showOnlyAttention: boolean;
};

export type PatchReviewState = {
  schema: 1;
  phase: PatchReviewPhase;
  lineage: PatchLineage;
  summary: PatchSummary;
  files: Record<string, PatchFileEntry>;
  fileOrder: string[];
  navigation: PatchNavigationState;
  verifyOutcome: PatchVerifyOutcome;
  approved: boolean;
  applied: boolean;
  applyReady: boolean;
  attention: PatchReviewAttention;
  lastGeneratedAtMs: number | null;
  lastApprovedAtMs: number | null;
  lastVerifiedAtMs: number | null;
  lastAppliedAtMs: number | null;
  lastError: string | null;
  evidence: PatchEvidence;
  hash: string;
};

export type PatchReviewOpenPayload = {
  patchId: string;
  previewHash: string;
  requestHash?: string | null;
  files?: PatchFileEntryInput[];
  summary?: Partial<PatchSummary>;
  preview?: JsonObject | null;
  atMs?: number;
};

export type PatchFileEntryInput = {
  path: string;
  previousPath?: string | null;
  kind?: PatchFileChangeKind;
  addedLines?: number;
  removedLines?: number;
  hunks?: PatchHunkRef[];
  decision?: PatchFileReviewDecision;
  comment?: string | null;
  attention?: PatchReviewAttention;
  viewedAtMs?: number | null;
};

export type PatchReviewAction =
  | { type: "PATCH_PREVIEW_REQUESTED"; atMs?: number }
  | { type: "PATCH_PREVIEW_BOUND"; payload: PatchReviewOpenPayload }
  | { type: "PATCH_PREVIEW_FAILED"; error: string; atMs?: number }
  | { type: "PATCH_FILE_DECISION_SET"; path: string; decision: PatchFileReviewDecision; comment?: string | null }
  | { type: "PATCH_FILE_VIEWED"; path: string; atMs?: number }
  | { type: "PATCH_FILE_ATTENTION_SET"; path: string; attention: PatchReviewAttention }
  | { type: "PATCH_FILE_COMMENT_SET"; path: string; comment: string | null }
  | { type: "PATCH_FILES_REPLACED"; files: PatchFileEntryInput[] }
  | { type: "PATCH_FILE_SELECTED"; path: string | null }
  | { type: "PATCH_HUNK_SELECTED"; hunkId: string | null }
  | { type: "PATCH_PATH_EXPANDED_TOGGLED"; path: string }
  | { type: "PATCH_FILTER_SET"; query: string }
  | { type: "PATCH_ATTENTION_FILTER_SET"; onlyAttention: boolean }
  | { type: "PATCH_APPROVED"; previewHash: string; atMs?: number }
  | { type: "PATCH_APPROVAL_RESET" }
  | { type: "PATCH_VERIFY_BOUND"; verifyId: string; verifiedPreviewHash: string; verify?: JsonObject | null; atMs?: number }
  | { type: "PATCH_VERIFY_OUTCOME_SET"; outcome: PatchVerifyOutcome; verify?: JsonObject | null; atMs?: number }
  | { type: "PATCH_LEDGER_EVIDENCE_SET"; ledger: JsonObject | null }
  | { type: "PATCH_DIAGNOSTICS_EVIDENCE_SET"; diagnostics: JsonObject | null }
  | { type: "PATCH_APPLY_MARKED_READY" }
  | { type: "PATCH_APPLIED"; ledger?: JsonObject | null; atMs?: number }
  | { type: "PATCH_ERROR_CLEARED" }
  | { type: "PATCH_REVIEW_RESET" };

export type PatchReviewSelector<T> = (state: PatchReviewState) => T;

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

function compareAttention(a: PatchReviewAttention, b: PatchReviewAttention): number {
  const rank: Record<PatchReviewAttention, number> = {
    none: 0,
    low: 1,
    medium: 2,
    high: 3,
    critical: 4,
  };
  return rank[a] - rank[b];
}

function summarizeAttention(files: Record<string, PatchFileEntry>): PatchReviewAttention {
  let max: PatchReviewAttention = "none";
  for (const file of Object.values(files)) {
    if (compareAttention(file.attention, max) > 0) max = file.attention;
  }
  return max;
}

function deriveSummary(files: Record<string, PatchFileEntry>, fallback?: Partial<PatchSummary>): PatchSummary {
  const values = Object.values(files);
  const calculated = {
    filesChanged: values.length,
    insertions: values.reduce((n, file) => n + file.addedLines, 0),
    deletions: values.reduce((n, file) => n + file.removedLines, 0),
    hunks: values.reduce((n, file) => n + file.hunks.length, 0),
  };
  return {
    filesChanged: fallback?.filesChanged ?? calculated.filesChanged,
    insertions: fallback?.insertions ?? calculated.insertions,
    deletions: fallback?.deletions ?? calculated.deletions,
    hunks: fallback?.hunks ?? calculated.hunks,
  };
}

function computeFileHash(core: Omit<PatchFileEntry, "hash">): string {
  return hashString(stableJson(core));
}

function computeStateHash(core: Omit<PatchReviewState, "hash">): string {
  return hashString(stableJson(core));
}

function makeFileEntry(input: PatchFileEntryInput): PatchFileEntry {
  const core: Omit<PatchFileEntry, "hash"> = {
    path: normalizePath(input.path),
    previousPath: input.previousPath ? normalizePath(input.previousPath) : null,
    kind: input.kind ?? "modify",
    addedLines: input.addedLines ?? 0,
    removedLines: input.removedLines ?? 0,
    hunks: [...(input.hunks ?? [])].sort((a, b) => a.hunkId.localeCompare(b.hunkId)),
    decision: input.decision ?? "unreviewed",
    comment: input.comment ?? null,
    attention: input.attention ?? "none",
    viewedAtMs: input.viewedAtMs ?? null,
  };
  return { ...core, hash: computeFileHash(core) };
}

function withFile(file: PatchFileEntry, patch: Partial<Omit<PatchFileEntry, "hash">>): PatchFileEntry {
  const core: Omit<PatchFileEntry, "hash"> = {
    path: patch.path ?? file.path,
    previousPath: patch.previousPath ?? file.previousPath,
    kind: patch.kind ?? file.kind,
    addedLines: patch.addedLines ?? file.addedLines,
    removedLines: patch.removedLines ?? file.removedLines,
    hunks: patch.hunks ?? file.hunks,
    decision: patch.decision ?? file.decision,
    comment: patch.comment ?? file.comment,
    attention: patch.attention ?? file.attention,
    viewedAtMs: patch.viewedAtMs ?? file.viewedAtMs,
  };
  return { ...core, hash: computeFileHash(core) };
}

function filesFromInputs(inputs: PatchFileEntryInput[]): { files: Record<string, PatchFileEntry>; order: string[] } {
  const files: Record<string, PatchFileEntry> = {};
  const order = uniqueSortedPaths(inputs.map((f) => f.path));
  for (const input of inputs) {
    const file = makeFileEntry(input);
    files[file.path] = file;
  }
  return { files, order };
}

function derivePhase(state: Omit<PatchReviewState, "hash">): PatchReviewPhase {
  if (state.lastError) return "failed";
  if (state.applied) return "applied";
  if (state.applyReady) return "apply-ready";
  if (state.verifyOutcome === "passed" && state.approved) return "verified";
  if (state.approved) return "approved";
  if (state.lineage.previewHash && Object.keys(state.files).length > 0) return "reviewing";
  if (state.lineage.patchId || state.lineage.previewHash) return "previewing";
  return "idle";
}

function deriveApplyReady(state: Omit<PatchReviewState, "hash">): boolean {
  const files = Object.values(state.files);
  const hasFiles = files.length > 0;
  const allAccepted = files.every((f) => f.decision === "accepted");
  const noCriticalAttention = files.every((f) => compareAttention(f.attention, "high") < 0);
  const lineageAligned =
    !!state.lineage.previewHash &&
    state.lineage.approvedPreviewHash === state.lineage.previewHash &&
    state.lineage.verifiedPreviewHash === state.lineage.previewHash;

  return hasFiles && allAccepted && noCriticalAttention && state.verifyOutcome === "passed" && state.approved && lineageAligned && !state.applied && !state.lastError;
}

function recompute(state: Omit<PatchReviewState, "hash">): PatchReviewState {
  const next: Omit<PatchReviewState, "hash"> = {
    ...state,
    summary: deriveSummary(state.files, state.summary),
    attention: summarizeAttention(state.files),
    applyReady: deriveApplyReady(state),
  };
  next.phase = derivePhase(next);
  return { ...next, hash: computeStateHash(next) };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialPatchReviewState(): PatchReviewState {
  const core: Omit<PatchReviewState, "hash"> = {
    schema: 1,
    phase: "idle",
    lineage: {
      patchId: null,
      previewHash: null,
      requestHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
    },
    summary: {
      filesChanged: 0,
      insertions: 0,
      deletions: 0,
      hunks: 0,
    },
    files: {},
    fileOrder: [],
    navigation: {
      selectedPath: null,
      selectedHunkId: null,
      expandedPaths: [],
      filterQuery: "",
      showOnlyAttention: false,
    },
    verifyOutcome: "unknown",
    approved: false,
    applied: false,
    applyReady: false,
    attention: "none",
    lastGeneratedAtMs: null,
    lastApprovedAtMs: null,
    lastVerifiedAtMs: null,
    lastAppliedAtMs: null,
    lastError: null,
    evidence: {
      preview: null,
      verify: null,
      ledger: null,
      diagnostics: null,
    },
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function patchReviewReducer(state: PatchReviewState, action: PatchReviewAction): PatchReviewState {
  const core: Omit<PatchReviewState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    lineage: { ...state.lineage },
    summary: { ...state.summary },
    files: { ...state.files },
    fileOrder: [...state.fileOrder],
    navigation: { ...state.navigation, expandedPaths: [...state.navigation.expandedPaths] },
    verifyOutcome: state.verifyOutcome,
    approved: state.approved,
    applied: state.applied,
    applyReady: state.applyReady,
    attention: state.attention,
    lastGeneratedAtMs: state.lastGeneratedAtMs,
    lastApprovedAtMs: state.lastApprovedAtMs,
    lastVerifiedAtMs: state.lastVerifiedAtMs,
    lastAppliedAtMs: state.lastAppliedAtMs,
    lastError: state.lastError,
    evidence: { ...state.evidence },
  };

  switch (action.type) {
    case "PATCH_PREVIEW_REQUESTED": {
      core.phase = "previewing";
      core.lastError = null;
      core.lastGeneratedAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "PATCH_PREVIEW_BOUND": {
      const built = filesFromInputs(action.payload.files ?? []);
      core.lineage.patchId = action.payload.patchId;
      core.lineage.previewHash = action.payload.previewHash;
      core.lineage.requestHash = action.payload.requestHash ?? null;
      core.lineage.approvedPreviewHash = null;
      core.lineage.verifiedPreviewHash = null;
      core.lineage.verifyId = null;
      core.files = built.files;
      core.fileOrder = built.order;
      core.navigation.selectedPath = built.order[0] ?? null;
      core.navigation.selectedHunkId = built.order[0] ? built.files[built.order[0]]?.hunks[0]?.hunkId ?? null : null;
      core.navigation.expandedPaths = built.order;
      core.verifyOutcome = "unknown";
      core.approved = false;
      core.applied = false;
      core.lastGeneratedAtMs = nowMs(action.payload.atMs);
      core.lastApprovedAtMs = null;
      core.lastVerifiedAtMs = null;
      core.lastAppliedAtMs = null;
      core.lastError = null;
      core.evidence.preview = action.payload.preview ?? null;
      core.evidence.verify = null;
      core.evidence.ledger = null;
      return recompute(core);
    }

    case "PATCH_PREVIEW_FAILED": {
      core.lastError = action.error;
      return recompute(core);
    }

    case "PATCH_FILE_DECISION_SET": {
      const path = normalizePath(action.path);
      const file = core.files[path];
      if (!file) return state;
      core.files[path] = withFile(file, {
        decision: action.decision,
        comment: action.comment ?? file.comment,
      });
      return recompute(core);
    }

    case "PATCH_FILE_VIEWED": {
      const path = normalizePath(action.path);
      const file = core.files[path];
      if (!file) return state;
      core.files[path] = withFile(file, { viewedAtMs: nowMs(action.atMs) });
      core.navigation.selectedPath = path;
      core.navigation.selectedHunkId = file.hunks[0]?.hunkId ?? null;
      return recompute(core);
    }

    case "PATCH_FILE_ATTENTION_SET": {
      const path = normalizePath(action.path);
      const file = core.files[path];
      if (!file) return state;
      core.files[path] = withFile(file, { attention: action.attention });
      return recompute(core);
    }

    case "PATCH_FILE_COMMENT_SET": {
      const path = normalizePath(action.path);
      const file = core.files[path];
      if (!file) return state;
      core.files[path] = withFile(file, { comment: action.comment });
      return recompute(core);
    }

    case "PATCH_FILES_REPLACED": {
      const built = filesFromInputs(action.files);
      core.files = built.files;
      core.fileOrder = built.order;
      if (!core.navigation.selectedPath || !core.files[core.navigation.selectedPath]) {
        core.navigation.selectedPath = built.order[0] ?? null;
      }
      core.navigation.expandedPaths = uniqueSortedPaths([...core.navigation.expandedPaths, ...built.order]);
      return recompute(core);
    }

    case "PATCH_FILE_SELECTED": {
      const selectedPath = action.path ? normalizePath(action.path) : null;
      core.navigation.selectedPath = selectedPath && core.files[selectedPath] ? selectedPath : null;
      core.navigation.selectedHunkId = core.navigation.selectedPath ? core.files[core.navigation.selectedPath]?.hunks[0]?.hunkId ?? null : null;
      return recompute(core);
    }

    case "PATCH_HUNK_SELECTED": {
      core.navigation.selectedHunkId = action.hunkId;
      return recompute(core);
    }

    case "PATCH_PATH_EXPANDED_TOGGLED": {
      const path = normalizePath(action.path);
      const set = new Set(core.navigation.expandedPaths);
      if (set.has(path)) set.delete(path);
      else if (core.files[path]) set.add(path);
      core.navigation.expandedPaths = [...set].sort((a, b) => a.localeCompare(b));
      return recompute(core);
    }

    case "PATCH_FILTER_SET": {
      core.navigation.filterQuery = action.query;
      return recompute(core);
    }

    case "PATCH_ATTENTION_FILTER_SET": {
      core.navigation.showOnlyAttention = action.onlyAttention;
      return recompute(core);
    }

    case "PATCH_APPROVED": {
      if (core.lineage.previewHash !== action.previewHash) {
        core.approved = false;
        core.lineage.approvedPreviewHash = null;
        core.lastError = "approval_preview_hash_mismatch";
        return recompute(core);
      }
      core.approved = true;
      core.lineage.approvedPreviewHash = action.previewHash;
      core.lastApprovedAtMs = nowMs(action.atMs);
      core.lastError = null;
      return recompute(core);
    }

    case "PATCH_APPROVAL_RESET": {
      core.approved = false;
      core.lineage.approvedPreviewHash = null;
      if (core.lineage.verifiedPreviewHash !== core.lineage.previewHash) {
        core.lineage.verifiedPreviewHash = null;
        core.lineage.verifyId = null;
        core.verifyOutcome = "unknown";
        core.evidence.verify = null;
      }
      return recompute(core);
    }

    case "PATCH_VERIFY_BOUND": {
      if (core.lineage.previewHash !== action.verifiedPreviewHash) {
        core.lineage.verifyId = null;
        core.lineage.verifiedPreviewHash = null;
        core.verifyOutcome = "failed";
        core.lastError = "verify_preview_hash_mismatch";
        return recompute(core);
      }
      core.lineage.verifyId = action.verifyId;
      core.lineage.verifiedPreviewHash = action.verifiedPreviewHash;
      core.verifyOutcome = "passed";
      core.lastVerifiedAtMs = nowMs(action.atMs);
      core.evidence.verify = action.verify ?? null;
      core.lastError = null;
      return recompute(core);
    }

    case "PATCH_VERIFY_OUTCOME_SET": {
      core.verifyOutcome = action.outcome;
      core.evidence.verify = action.verify ?? core.evidence.verify;
      if (action.outcome !== "passed") {
        core.lineage.verifiedPreviewHash = null;
        core.lineage.verifyId = null;
      }
      if (action.outcome === "failed") {
        core.lastError = "verify_failed";
      }
      core.lastVerifiedAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "PATCH_LEDGER_EVIDENCE_SET": {
      core.evidence.ledger = action.ledger;
      return recompute(core);
    }

    case "PATCH_DIAGNOSTICS_EVIDENCE_SET": {
      core.evidence.diagnostics = action.diagnostics;
      return recompute(core);
    }

    case "PATCH_APPLY_MARKED_READY": {
      core.applyReady = deriveApplyReady(core);
      return recompute(core);
    }

    case "PATCH_APPLIED": {
      core.applied = true;
      core.lastAppliedAtMs = nowMs(action.atMs);
      core.evidence.ledger = action.ledger ?? core.evidence.ledger;
      core.lastError = null;
      return recompute(core);
    }

    case "PATCH_ERROR_CLEARED": {
      core.lastError = null;
      return recompute(core);
    }

    case "PATCH_REVIEW_RESET": {
      return createInitialPatchReviewState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectPatchReviewPhase: PatchReviewSelector<PatchReviewPhase> = (state) => state.phase;
export const selectPatchFiles = (state: PatchReviewState): PatchFileEntry[] => state.fileOrder.map((path) => state.files[path]).filter(Boolean);
export const selectSelectedPatchFile: PatchReviewSelector<PatchFileEntry | null> = (state) =>
  state.navigation.selectedPath ? state.files[state.navigation.selectedPath] ?? null : null;
export const selectPatchCanApprove: PatchReviewSelector<boolean> = (state) => !!state.lineage.previewHash && state.fileOrder.length > 0 && !state.applied;
export const selectPatchCanApply: PatchReviewSelector<boolean> = (state) => state.applyReady;
export const selectAttentionFiles: PatchReviewSelector<PatchFileEntry[]> = (state) =>
  selectPatchFiles(state).filter((file) => file.attention !== "none" || file.decision === "needs-attention");

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validatePatchFileEntry(file: PatchFileEntry): void {
  const core: Omit<PatchFileEntry, "hash"> = {
    path: file.path,
    previousPath: file.previousPath,
    kind: file.kind,
    addedLines: file.addedLines,
    removedLines: file.removedLines,
    hunks: file.hunks,
    decision: file.decision,
    comment: file.comment,
    attention: file.attention,
    viewedAtMs: file.viewedAtMs,
  };
  if (file.hash !== computeFileHash(core)) {
    throw new Error(`patch_review_file_hash_drift:${file.path}`);
  }
}

export function validatePatchReviewState(state: PatchReviewState): void {
  if (state.schema !== 1) throw new Error("patch_review_state_schema_invalid");

  const core: Omit<PatchReviewState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    lineage: state.lineage,
    summary: state.summary,
    files: state.files,
    fileOrder: state.fileOrder,
    navigation: state.navigation,
    verifyOutcome: state.verifyOutcome,
    approved: state.approved,
    applied: state.applied,
    applyReady: state.applyReady,
    attention: state.attention,
    lastGeneratedAtMs: state.lastGeneratedAtMs,
    lastApprovedAtMs: state.lastApprovedAtMs,
    lastVerifiedAtMs: state.lastVerifiedAtMs,
    lastAppliedAtMs: state.lastAppliedAtMs,
    lastError: state.lastError,
    evidence: state.evidence,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("patch_review_state_hash_drift");
  }

  const normalizedOrder = uniqueSortedPaths(state.fileOrder);
  if (stableJson(normalizedOrder) !== stableJson(state.fileOrder)) {
    throw new Error("patch_review_file_order_not_normalized");
  }

  for (const path of state.fileOrder) {
    if (!state.files[path]) throw new Error(`patch_review_file_order_missing_entry:${path}`);
  }

  for (const [path, file] of Object.entries(state.files)) {
    if (!state.fileOrder.includes(path)) throw new Error(`patch_review_orphan_file:${path}`);
    validatePatchFileEntry(file);
  }

  if (state.approved && state.lineage.approvedPreviewHash !== state.lineage.previewHash) {
    throw new Error("patch_review_approved_lineage_mismatch");
  }

  if (state.verifyOutcome === "passed" && state.lineage.verifiedPreviewHash !== state.lineage.previewHash) {
    throw new Error("patch_review_verified_lineage_mismatch");
  }

  if (state.applied && !state.approved) {
    throw new Error("patch_review_applied_without_approval");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyPatchReviewActions(initial: PatchReviewState, actions: PatchReviewAction[]): PatchReviewState {
  return actions.reduce(patchReviewReducer, initial);
}

export function serializePatchReviewState(state: PatchReviewState): string {
  validatePatchReviewState(state);
  return stableJson(state);
}
