/**
 * ADJUTORIX APP — RENDERER / STATE / ledger_state.ts
 *
 * Canonical renderer-side ledger state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for ledger/history state
 * - unify current heads, timeline windows, entry selection, replay lineage, patch/verify
 *   references, filters, and diagnostics linkage under one deterministic reducer
 * - prevent divergence between timeline views, current-state badges, selected entry details,
 *   and apply/replay reasoning that each guess which ledger slice is authoritative
 * - provide pure transitions suitable for replay, testing, diagnostics, and invariants
 *
 * Scope:
 * - current ledger heads and stats
 * - timeline slices and selected entry state
 * - patch / verify / apply references carried by entries
 * - pagination windows, filters, and sort direction
 * - replay/recovery anchors and lineage navigation state
 * - renderer-only visibility and expansion state
 *
 * Non-scope:
 * - server/main-process ledger persistence
 * - replay execution implementation
 * - patch application semantics themselves
 *
 * Hard invariants:
 * - identical prior state + identical action => identical next state hash
 * - ledger entries are unique by entry id and sequence consistency is explicit
 * - selected entry, if present, must exist in the loaded entity map
 * - heads and stats remain plain JSON-safe evidence snapshots
 * - timeline ordering is deterministic and controlled by explicit direction
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

export type LedgerPhase = "idle" | "loading" | "ready" | "degraded" | "failed";
export type LedgerDirection = "forward" | "reverse";
export type LedgerEntryKind =
  | "workspace-open"
  | "workspace-close"
  | "patch-preview"
  | "patch-approve"
  | "verify-run"
  | "verify-bind"
  | "patch-apply"
  | "diagnostic"
  | "agent"
  | "replay"
  | "unknown";
export type LedgerAttention = "none" | "low" | "medium" | "high" | "critical";

export type LedgerEntryReference = {
  patchId: string | null;
  previewHash: string | null;
  verifyId: string | null;
  requestHash: string | null;
};

export type LedgerEntry = {
  entryId: string;
  seq: number;
  kind: LedgerEntryKind;
  tsMs: number;
  title: string;
  summary: string;
  references: LedgerEntryReference;
  attention: LedgerAttention;
  detail: JsonObject | null;
  hash: string;
};

export type LedgerHeads = {
  currentSeq: number | null;
  appliedSeq: number | null;
  verifiedSeq: number | null;
  previewSeq: number | null;
  replaySeq: number | null;
};

export type LedgerStats = {
  totalEntries: number;
  firstSeq: number | null;
  lastSeq: number | null;
  kinds: Record<string, number>;
};

export type LedgerFilters = {
  query: string;
  kinds: string[];
  minSeq: number | null;
  maxSeq: number | null;
  attentionOnly: boolean;
};

export type LedgerWindow = {
  startSeq: number | null;
  endSeq: number | null;
  limit: number;
  direction: LedgerDirection;
};

export type LedgerReplayAnchor = {
  selectedReplayFromSeq: number | null;
  selectedReplayToSeq: number | null;
  lastReplayTargetSeq: number | null;
  lastReplayAtMs: number | null;
};

export type LedgerEvidence = {
  current: JsonObject | null;
  heads: JsonObject | null;
  stats: JsonObject | null;
  diagnostics: JsonObject | null;
};

export type LedgerUiState = {
  selectedEntryId: string | null;
  expandedEntryIds: string[];
  pinnedEntryIds: string[];
  focusedSeq: number | null;
};

export type LedgerState = {
  schema: 1;
  phase: LedgerPhase;
  heads: LedgerHeads;
  stats: LedgerStats;
  entriesById: Record<string, LedgerEntry>;
  seqIndex: Record<string, string>;
  timelineEntryIds: string[];
  filters: LedgerFilters;
  window: LedgerWindow;
  replay: LedgerReplayAnchor;
  ui: LedgerUiState;
  attention: LedgerAttention;
  evidence: LedgerEvidence;
  lastHydratedAtMs: number | null;
  lastError: string | null;
  hash: string;
};

export type LedgerEntryInput = {
  entryId: string;
  seq: number;
  kind?: LedgerEntryKind;
  tsMs?: number;
  title?: string;
  summary?: string;
  references?: Partial<LedgerEntryReference>;
  attention?: LedgerAttention;
  detail?: JsonObject | null;
};

export type LedgerWindowInput = {
  startSeq?: number | null;
  endSeq?: number | null;
  limit?: number;
  direction?: LedgerDirection;
};

export type LedgerStateAction =
  | { type: "LEDGER_LOAD_REQUESTED" }
  | { type: "LEDGER_CURRENT_BOUND"; current: JsonObject | null; atMs?: number }
  | { type: "LEDGER_HEADS_BOUND"; heads: JsonObject | null; atMs?: number }
  | { type: "LEDGER_STATS_BOUND"; stats: JsonObject | null; atMs?: number }
  | { type: "LEDGER_TIMELINE_REPLACED"; entries: LedgerEntryInput[]; window?: LedgerWindowInput; atMs?: number }
  | { type: "LEDGER_ENTRY_UPSERTED"; entry: LedgerEntryInput; atMs?: number }
  | { type: "LEDGER_ENTRY_SELECTED"; entryId: string | null }
  | { type: "LEDGER_ENTRY_EXPANDED_TOGGLED"; entryId: string }
  | { type: "LEDGER_ENTRY_PINNED_TOGGLED"; entryId: string }
  | { type: "LEDGER_FILTER_QUERY_SET"; query: string }
  | { type: "LEDGER_FILTER_KINDS_SET"; kinds: string[] }
  | { type: "LEDGER_FILTER_SEQ_RANGE_SET"; minSeq: number | null; maxSeq: number | null }
  | { type: "LEDGER_FILTER_ATTENTION_ONLY_SET"; enabled: boolean }
  | { type: "LEDGER_WINDOW_SET"; window: LedgerWindowInput }
  | { type: "LEDGER_REPLAY_ANCHOR_SET"; fromSeq?: number | null; toSeq?: number | null }
  | { type: "LEDGER_REPLAY_RECORDED"; targetSeq: number; atMs?: number }
  | { type: "LEDGER_DIAGNOSTICS_EVIDENCE_SET"; diagnostics: JsonObject | null }
  | { type: "LEDGER_ERROR_SET"; error: string | null }
  | { type: "LEDGER_RESET" };

export type LedgerSelector<T> = (state: LedgerState) => T;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

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

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(stableJson(value)) as JsonObject;
}

function attentionRank(attention: LedgerAttention): number {
  return { none: 0, low: 1, medium: 2, high: 3, critical: 4 }[attention];
}

function entryKind(kind: unknown): LedgerEntryKind {
  const value = typeof kind === "string" ? kind : "unknown";
  const allowed: LedgerEntryKind[] = [
    "workspace-open",
    "workspace-close",
    "patch-preview",
    "patch-approve",
    "verify-run",
    "verify-bind",
    "patch-apply",
    "diagnostic",
    "agent",
    "replay",
    "unknown",
  ];
  return allowed.includes(value as LedgerEntryKind) ? (value as LedgerEntryKind) : "unknown";
}

function makeEntry(input: LedgerEntryInput): LedgerEntry {
  const core: Omit<LedgerEntry, "hash"> = {
    entryId: input.entryId,
    seq: input.seq,
    kind: entryKind(input.kind),
    tsMs: input.tsMs ?? nowMs(),
    title: input.title ?? input.entryId,
    summary: input.summary ?? "",
    references: {
      patchId: input.references?.patchId ?? null,
      previewHash: input.references?.previewHash ?? null,
      verifyId: input.references?.verifyId ?? null,
      requestHash: input.references?.requestHash ?? null,
    },
    attention: input.attention ?? "none",
    detail: input.detail ?? null,
  };
  return { ...core, hash: hashString(stableJson(core)) };
}

function withEntry(existing: LedgerEntry, patch: Partial<Omit<LedgerEntry, "hash">>): LedgerEntry {
  const core: Omit<LedgerEntry, "hash"> = {
    entryId: patch.entryId ?? existing.entryId,
    seq: patch.seq ?? existing.seq,
    kind: patch.kind ?? existing.kind,
    tsMs: patch.tsMs ?? existing.tsMs,
    title: patch.title ?? existing.title,
    summary: patch.summary ?? existing.summary,
    references: patch.references ?? existing.references,
    attention: patch.attention ?? existing.attention,
    detail: patch.detail ?? existing.detail,
  };
  return { ...core, hash: hashString(stableJson(core)) };
}

function deriveHeads(heads: JsonObject | null, timeline: LedgerEntry[]): LedgerHeads {
  const maxSeq = timeline.length > 0 ? Math.max(...timeline.map((e) => e.seq)) : null;
  return {
    currentSeq: typeof heads?.currentSeq === "number" ? heads.currentSeq : maxSeq,
    appliedSeq: typeof heads?.appliedSeq === "number" ? heads.appliedSeq : null,
    verifiedSeq: typeof heads?.verifiedSeq === "number" ? heads.verifiedSeq : null,
    previewSeq: typeof heads?.previewSeq === "number" ? heads.previewSeq : null,
    replaySeq: typeof heads?.replaySeq === "number" ? heads.replaySeq : null,
  };
}

function deriveStats(stats: JsonObject | null, entries: LedgerEntry[]): LedgerStats {
  const sorted = [...entries].sort((a, b) => a.seq - b.seq);
  const kinds: Record<string, number> = {};
  for (const entry of entries) kinds[entry.kind] = (kinds[entry.kind] ?? 0) + 1;
  return {
    totalEntries: typeof stats?.totalEntries === "number" ? stats.totalEntries : entries.length,
    firstSeq: typeof stats?.firstSeq === "number" ? stats.firstSeq : sorted[0]?.seq ?? null,
    lastSeq: typeof stats?.lastSeq === "number" ? stats.lastSeq : sorted[sorted.length - 1]?.seq ?? null,
    kinds,
  };
}

function deriveAttention(entries: Record<string, LedgerEntry>): LedgerAttention {
  let max: LedgerAttention = "none";
  for (const entry of Object.values(entries)) {
    if (attentionRank(entry.attention) > attentionRank(max)) max = entry.attention;
  }
  return max;
}

function normalizeTimeline(entryIds: string[], entriesById: Record<string, LedgerEntry>, direction: LedgerDirection): string[] {
  return [...new Set(entryIds.filter((id) => !!entriesById[id]))].sort((a, b) => {
    const ea = entriesById[a];
    const eb = entriesById[b];
    return direction === "forward" ? ea.seq - eb.seq : eb.seq - ea.seq;
  });
}

function computeStateHash(core: Omit<LedgerState, "hash">): string {
  return hashString(stableJson(core));
}

function recompute(state: Omit<LedgerState, "hash">): LedgerState {
  const entries = Object.values(state.entriesById);
  const next: Omit<LedgerState, "hash"> = {
    ...state,
    timelineEntryIds: normalizeTimeline(state.timelineEntryIds, state.entriesById, state.window.direction),
    heads: deriveHeads(state.evidence.heads, entries),
    stats: deriveStats(state.evidence.stats, entries),
    attention: deriveAttention(state.entriesById),
  };
  if (next.ui.selectedEntryId && !next.entriesById[next.ui.selectedEntryId]) {
    next.ui.selectedEntryId = next.timelineEntryIds[0] ?? null;
  }
  return { ...next, hash: computeStateHash(next) };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialLedgerState(): LedgerState {
  const core: Omit<LedgerState, "hash"> = {
    schema: 1,
    phase: "idle",
    heads: {
      currentSeq: null,
      appliedSeq: null,
      verifiedSeq: null,
      previewSeq: null,
      replaySeq: null,
    },
    stats: {
      totalEntries: 0,
      firstSeq: null,
      lastSeq: null,
      kinds: {},
    },
    entriesById: {},
    seqIndex: {},
    timelineEntryIds: [],
    filters: {
      query: "",
      kinds: [],
      minSeq: null,
      maxSeq: null,
      attentionOnly: false,
    },
    window: {
      startSeq: null,
      endSeq: null,
      limit: 200,
      direction: "reverse",
    },
    replay: {
      selectedReplayFromSeq: null,
      selectedReplayToSeq: null,
      lastReplayTargetSeq: null,
      lastReplayAtMs: null,
    },
    ui: {
      selectedEntryId: null,
      expandedEntryIds: [],
      pinnedEntryIds: [],
      focusedSeq: null,
    },
    attention: "none",
    evidence: {
      current: null,
      heads: null,
      stats: null,
      diagnostics: null,
    },
    lastHydratedAtMs: null,
    lastError: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function ledgerStateReducer(state: LedgerState, action: LedgerStateAction): LedgerState {
  const core: Omit<LedgerState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    heads: { ...state.heads },
    stats: { ...state.stats, kinds: { ...state.stats.kinds } },
    entriesById: { ...state.entriesById },
    seqIndex: { ...state.seqIndex },
    timelineEntryIds: [...state.timelineEntryIds],
    filters: { ...state.filters, kinds: [...state.filters.kinds] },
    window: { ...state.window },
    replay: { ...state.replay },
    ui: { ...state.ui, expandedEntryIds: [...state.ui.expandedEntryIds], pinnedEntryIds: [...state.ui.pinnedEntryIds] },
    attention: state.attention,
    evidence: { ...state.evidence },
    lastHydratedAtMs: state.lastHydratedAtMs,
    lastError: state.lastError,
  };

  switch (action.type) {
    case "LEDGER_LOAD_REQUESTED": {
      core.phase = "loading";
      core.lastError = null;
      return recompute(core);
    }

    case "LEDGER_CURRENT_BOUND": {
      core.evidence.current = action.current;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "LEDGER_HEADS_BOUND": {
      core.evidence.heads = action.heads;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "LEDGER_STATS_BOUND": {
      core.evidence.stats = action.stats;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "LEDGER_TIMELINE_REPLACED": {
      const entries = action.entries.map(makeEntry);
      core.entriesById = {};
      core.seqIndex = {};
      for (const entry of entries) {
        core.entriesById[entry.entryId] = entry;
        core.seqIndex[String(entry.seq)] = entry.entryId;
      }
      core.timelineEntryIds = entries.map((e) => e.entryId);
      core.window = {
        startSeq: action.window?.startSeq ?? core.window.startSeq,
        endSeq: action.window?.endSeq ?? core.window.endSeq,
        limit: action.window?.limit ?? core.window.limit,
        direction: action.window?.direction ?? core.window.direction,
      };
      core.ui.selectedEntryId = core.timelineEntryIds[0] ?? null;
      core.ui.focusedSeq = core.ui.selectedEntryId ? core.entriesById[core.ui.selectedEntryId]?.seq ?? null : null;
      core.phase = "ready";
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.lastError = null;
      return recompute(core);
    }

    case "LEDGER_ENTRY_UPSERTED": {
      const entry = makeEntry(action.entry);
      core.entriesById[entry.entryId] = entry;
      core.seqIndex[String(entry.seq)] = entry.entryId;
      core.timelineEntryIds = [...new Set([...core.timelineEntryIds, entry.entryId])];
      if (!core.ui.selectedEntryId) core.ui.selectedEntryId = entry.entryId;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "LEDGER_ENTRY_SELECTED": {
      core.ui.selectedEntryId = action.entryId && core.entriesById[action.entryId] ? action.entryId : null;
      core.ui.focusedSeq = core.ui.selectedEntryId ? core.entriesById[core.ui.selectedEntryId]?.seq ?? null : null;
      return recompute(core);
    }

    case "LEDGER_ENTRY_EXPANDED_TOGGLED": {
      const set = new Set(core.ui.expandedEntryIds);
      if (set.has(action.entryId)) set.delete(action.entryId);
      else if (core.entriesById[action.entryId]) set.add(action.entryId);
      core.ui.expandedEntryIds = [...set].sort((a, b) => a.localeCompare(b));
      return recompute(core);
    }

    case "LEDGER_ENTRY_PINNED_TOGGLED": {
      const set = new Set(core.ui.pinnedEntryIds);
      if (set.has(action.entryId)) set.delete(action.entryId);
      else if (core.entriesById[action.entryId]) set.add(action.entryId);
      core.ui.pinnedEntryIds = [...set].sort((a, b) => a.localeCompare(b));
      return recompute(core);
    }

    case "LEDGER_FILTER_QUERY_SET": {
      core.filters.query = action.query;
      return recompute(core);
    }

    case "LEDGER_FILTER_KINDS_SET": {
      core.filters.kinds = uniqueSortedStrings(action.kinds);
      return recompute(core);
    }

    case "LEDGER_FILTER_SEQ_RANGE_SET": {
      core.filters.minSeq = action.minSeq;
      core.filters.maxSeq = action.maxSeq;
      return recompute(core);
    }

    case "LEDGER_FILTER_ATTENTION_ONLY_SET": {
      core.filters.attentionOnly = action.enabled;
      return recompute(core);
    }

    case "LEDGER_WINDOW_SET": {
      core.window = {
        startSeq: action.window.startSeq ?? core.window.startSeq,
        endSeq: action.window.endSeq ?? core.window.endSeq,
        limit: action.window.limit ?? core.window.limit,
        direction: action.window.direction ?? core.window.direction,
      };
      return recompute(core);
    }

    case "LEDGER_REPLAY_ANCHOR_SET": {
      if (action.fromSeq !== undefined) core.replay.selectedReplayFromSeq = action.fromSeq;
      if (action.toSeq !== undefined) core.replay.selectedReplayToSeq = action.toSeq;
      return recompute(core);
    }

    case "LEDGER_REPLAY_RECORDED": {
      core.replay.lastReplayTargetSeq = action.targetSeq;
      core.replay.lastReplayAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "LEDGER_DIAGNOSTICS_EVIDENCE_SET": {
      core.evidence.diagnostics = action.diagnostics;
      return recompute(core);
    }

    case "LEDGER_ERROR_SET": {
      core.lastError = action.error;
      core.phase = action.error ? "failed" : core.phase === "failed" ? "degraded" : core.phase;
      return recompute(core);
    }

    case "LEDGER_RESET": {
      return createInitialLedgerState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectLedgerPhase: LedgerSelector<LedgerPhase> = (state) => state.phase;
export const selectLedgerHeads: LedgerSelector<LedgerHeads> = (state) => state.heads;
export const selectLedgerStats: LedgerSelector<LedgerStats> = (state) => state.stats;
export const selectSelectedLedgerEntry: LedgerSelector<LedgerEntry | null> = (state) =>
  state.ui.selectedEntryId ? state.entriesById[state.ui.selectedEntryId] ?? null : null;
export const selectTimelineEntries: LedgerSelector<LedgerEntry[]> = (state) =>
  state.timelineEntryIds.map((id) => state.entriesById[id]).filter(Boolean);
export const selectFilteredTimelineEntries: LedgerSelector<LedgerEntry[]> = (state) => {
  const query = state.filters.query.trim().toLowerCase();
  return selectTimelineEntries(state).filter((entry) => {
    if (state.filters.kinds.length > 0 && !state.filters.kinds.includes(entry.kind)) return false;
    if (state.filters.minSeq !== null && entry.seq < state.filters.minSeq) return false;
    if (state.filters.maxSeq !== null && entry.seq > state.filters.maxSeq) return false;
    if (state.filters.attentionOnly && entry.attention === "none") return false;
    if (!query) return true;
    return (
      entry.entryId.toLowerCase().includes(query) ||
      entry.title.toLowerCase().includes(query) ||
      entry.summary.toLowerCase().includes(query) ||
      entry.kind.toLowerCase().includes(query)
    );
  });
};

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateLedgerEntry(entry: LedgerEntry): void {
  const core: Omit<LedgerEntry, "hash"> = {
    entryId: entry.entryId,
    seq: entry.seq,
    kind: entry.kind,
    tsMs: entry.tsMs,
    title: entry.title,
    summary: entry.summary,
    references: entry.references,
    attention: entry.attention,
    detail: entry.detail,
  };
  if (entry.hash !== hashString(stableJson(core))) {
    throw new Error(`ledger_entry_hash_drift:${entry.entryId}`);
  }
}

export function validateLedgerState(state: LedgerState): void {
  if (state.schema !== 1) throw new Error("ledger_state_schema_invalid");

  const core: Omit<LedgerState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    heads: state.heads,
    stats: state.stats,
    entriesById: state.entriesById,
    seqIndex: state.seqIndex,
    timelineEntryIds: state.timelineEntryIds,
    filters: state.filters,
    window: state.window,
    replay: state.replay,
    ui: state.ui,
    attention: state.attention,
    evidence: state.evidence,
    lastHydratedAtMs: state.lastHydratedAtMs,
    lastError: state.lastError,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("ledger_state_hash_drift");
  }

  for (const id of state.timelineEntryIds) {
    if (!state.entriesById[id]) throw new Error(`ledger_state_missing_timeline_entry:${id}`);
  }

  for (const [id, entry] of Object.entries(state.entriesById)) {
    validateLedgerEntry(entry);
    if (state.seqIndex[String(entry.seq)] !== id) {
      throw new Error(`ledger_state_seq_index_mismatch:${id}`);
    }
  }

  if (state.ui.selectedEntryId && !state.entriesById[state.ui.selectedEntryId]) {
    throw new Error("ledger_state_selected_entry_missing");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyLedgerStateActions(initial: LedgerState, actions: LedgerStateAction[]): LedgerState {
  return actions.reduce(ledgerStateReducer, initial);
}

export function serializeLedgerState(state: LedgerState): string {
  validateLedgerState(state);
  return stableJson(state);
}
