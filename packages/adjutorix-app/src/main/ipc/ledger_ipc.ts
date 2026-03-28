import crypto from "node:crypto";
import { ipcMain } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / ledger_ipc.ts
 *
 * Dedicated ledger read-model IPC adapter for the Electron main process.
 *
 * Responsibilities:
 * - expose explicit read-only ledger IPC surfaces
 * - normalize and validate ledger query payloads
 * - provide current snapshot, timeline slices, entry lookup, and head metadata
 * - enforce deterministic serialization and stable result hashing
 * - keep ledger access read-only and auditable
 * - register/unregister handlers idempotently
 *
 * Hard invariants:
 * - ledger IPC never mutates state
 * - all reads are explicit and parameterized
 * - identical semantic queries produce identical query hashes
 * - timeline ordering is deterministic
 * - missing entries are surfaced as explicit denials/errors, not silent null drifts
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

export type LedgerIntent = "current" | "timeline" | "entry" | "heads" | "stats";

export type LedgerEntry = {
  schema: 1;
  entryId: string;
  seq: number;
  ts_ms: number;
  kind: string;
  jobId?: string | null;
  patchId?: string | null;
  verifyId?: string | null;
  parentEntryIds: string[];
  payload: Record<string, JsonValue>;
  hash: string;
};

export type LedgerSnapshot = {
  schema: 1;
  headEntryId: string | null;
  headSeq: number | null;
  totalEntries: number;
  latestTsMs: number | null;
  stateHash: string;
  summary: Record<string, JsonValue>;
};

export type LedgerHeads = {
  schema: 1;
  current: string | null;
  verified: string | null;
  appliedPatch: string | null;
  workspace: string | null;
  stateHash: string;
};

export type LedgerStats = {
  schema: 1;
  totalEntries: number;
  byKind: Record<string, number>;
  firstSeq: number | null;
  lastSeq: number | null;
  stateHash: string;
};

export type LedgerRuntimeState = {
  snapshot: LedgerSnapshot;
  heads: LedgerHeads;
  entries: LedgerEntry[];
};

export type LedgerCurrentPayload = Record<string, never>;

export type LedgerTimelinePayload = {
  startSeq?: number;
  endSeq?: number;
  limit?: number;
  kinds?: string[];
  reverse?: boolean;
};

export type LedgerEntryPayload = {
  entryId?: string;
  seq?: number;
};

export type LedgerHeadsPayload = Record<string, never>;
export type LedgerStatsPayload = Record<string, never>;

export type LedgerAuditRecord = {
  schema: 1;
  ts_ms: number;
  intent: LedgerIntent;
  decision: "allow" | "deny";
  reason: string;
  queryHash?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type LedgerAuditFn = (record: LedgerAuditRecord) => void;

export type LedgerPolicy = {
  allowCurrent: boolean;
  allowTimeline: boolean;
  allowEntryLookup: boolean;
  allowHeads: boolean;
  allowStats: boolean;
  maxTimelineLimit: number;
  allowReverseTimeline: boolean;
};

export type LedgerBoundaryHooks = {
  beforeCurrent?: () => Promise<void> | void;
  beforeTimeline?: (payload: LedgerTimelinePayload) => Promise<void> | void;
  beforeEntry?: (payload: LedgerEntryPayload) => Promise<void> | void;
  beforeHeads?: () => Promise<void> | void;
  beforeStats?: () => Promise<void> | void;
};

export type LedgerIpcOptions = {
  state: LedgerRuntimeState;
  policy: LedgerPolicy;
  audit?: LedgerAuditFn;
  boundary?: LedgerBoundaryHooks;
  channels?: {
    current?: string;
    timeline?: string;
    entry?: string;
    heads?: string;
    stats?: string;
  };
};

export type LedgerCurrentResult = {
  ok: true;
  snapshot: LedgerSnapshot;
  queryHash: string;
};

export type LedgerTimelineResult = {
  ok: true;
  entries: LedgerEntry[];
  queryHash: string;
  totalMatched: number;
};

export type LedgerEntryResult = {
  ok: true;
  entry: LedgerEntry;
  queryHash: string;
};

export type LedgerHeadsResult = {
  ok: true;
  heads: LedgerHeads;
  queryHash: string;
};

export type LedgerStatsResult = {
  ok: true;
  stats: LedgerStats;
  queryHash: string;
};

export type LedgerHandlerBundle = {
  getCurrent: (payload?: LedgerCurrentPayload) => Promise<LedgerCurrentResult>;
  getTimeline: (payload: LedgerTimelinePayload) => Promise<LedgerTimelineResult>;
  getEntry: (payload: LedgerEntryPayload) => Promise<LedgerEntryResult>;
  getHeads: (payload?: LedgerHeadsPayload) => Promise<LedgerHeadsResult>;
  getStats: (payload?: LedgerStatsPayload) => Promise<LedgerStatsResult>;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_CHANNELS = {
  current: "adjutorix:ledger:current",
  timeline: "adjutorix:ledger:timeline",
  entry: "adjutorix:ledger:entry",
  heads: "adjutorix:ledger:heads",
  stats: "adjutorix:ledger:stats",
} as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:ipc:ledger_ipc:${message}`);
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

function auditRecord(
  intent: LedgerIntent,
  decision: "allow" | "deny",
  reason: string,
  detail: Record<string, JsonValue>,
  queryHash?: string,
): LedgerAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    intent,
    decision,
    reason,
    ...(queryHash ? { queryHash } : {}),
    detail,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function emitAudit(audit: LedgerAuditFn | undefined, record: LedgerAuditRecord): void {
  audit?.(record);
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

function queryHash(intent: LedgerIntent, payload: Record<string, JsonValue>): string {
  return sha256(stableJson({ schema: 1, intent, payload }));
}

function normalizedEntry(entry: LedgerEntry): LedgerEntry {
  const core: Omit<LedgerEntry, "hash"> = {
    schema: 1,
    entryId: entry.entryId,
    seq: entry.seq,
    ts_ms: entry.ts_ms,
    kind: entry.kind,
    jobId: entry.jobId ?? null,
    patchId: entry.patchId ?? null,
    verifyId: entry.verifyId ?? null,
    parentEntryIds: [...entry.parentEntryIds].sort(),
    payload: normalizeJson(entry.payload) as Record<string, JsonValue>,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function normalizeTimelinePayload(payload: LedgerTimelinePayload, maxLimit: number, allowReverse: boolean): Required<LedgerTimelinePayload> {
  const startSeq = payload.startSeq ?? 0;
  const endSeq = payload.endSeq ?? Number.MAX_SAFE_INTEGER;
  const limit = payload.limit ?? maxLimit;
  const reverse = payload.reverse ?? false;
  const kinds = [...new Set((payload.kinds ?? []).map((kind) => {
    assert(typeof kind === "string" && kind.trim().length > 0, "timeline_kind_invalid");
    return kind.trim();
  }))].sort((a, b) => a.localeCompare(b));

  assert(Number.isInteger(startSeq) && startSeq >= 0, "timeline_startSeq_invalid");
  assert(Number.isInteger(endSeq) && endSeq >= startSeq, "timeline_endSeq_invalid");
  assert(Number.isInteger(limit) && limit > 0 && limit <= maxLimit, "timeline_limit_invalid");
  assert(!reverse || allowReverse, "timeline_reverse_not_allowed");

  return {
    startSeq,
    endSeq,
    limit,
    kinds,
    reverse,
  };
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createLedgerIpc(options: LedgerIpcOptions): LedgerHandlerBundle {
  const state = options.state;
  const policy = options.policy;
  const audit = options.audit;
  const boundary = options.boundary;

  const channels = {
    current: options.channels?.current ?? DEFAULT_CHANNELS.current,
    timeline: options.channels?.timeline ?? DEFAULT_CHANNELS.timeline,
    entry: options.channels?.entry ?? DEFAULT_CHANNELS.entry,
    heads: options.channels?.heads ?? DEFAULT_CHANNELS.heads,
    stats: options.channels?.stats ?? DEFAULT_CHANNELS.stats,
  };

  let registered = false;

  const getCurrent = async (_payload: LedgerCurrentPayload = {}): Promise<LedgerCurrentResult> => {
    if (!policy.allowCurrent) {
      const record = auditRecord("current", "deny", "ledger_current_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`ledger_current_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeCurrent);
    const qh = queryHash("current", {});
    emitAudit(audit, auditRecord("current", "allow", "ledger_current_returned", {
      headEntryId: state.snapshot.headEntryId,
      totalEntries: state.snapshot.totalEntries,
    }, qh));

    return {
      ok: true,
      snapshot: JSON.parse(stableJson(state.snapshot)) as LedgerSnapshot,
      queryHash: qh,
    };
  };

  const getTimeline = async (payload: LedgerTimelinePayload): Promise<LedgerTimelineResult> => {
    if (!policy.allowTimeline) {
      const record = auditRecord("timeline", "deny", "ledger_timeline_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`ledger_timeline_denied:${record.reason}`);
    }

    const normalized = normalizeTimelinePayload(payload, policy.maxTimelineLimit, policy.allowReverseTimeline);
    await maybeCallWith(boundary?.beforeTimeline, normalized);

    let entries = state.entries
      .map(normalizedEntry)
      .filter((entry) => entry.seq >= normalized.startSeq && entry.seq <= normalized.endSeq)
      .filter((entry) => normalized.kinds.length === 0 || normalized.kinds.includes(entry.kind))
      .sort((a, b) => a.seq - b.seq || a.entryId.localeCompare(b.entryId));

    const totalMatched = entries.length;
    if (normalized.reverse) entries = [...entries].reverse();
    entries = entries.slice(0, normalized.limit);

    const qh = queryHash("timeline", normalizeJson(normalized) as Record<string, JsonValue>);
    emitAudit(audit, auditRecord("timeline", "allow", "ledger_timeline_returned", {
      totalMatched,
      returned: entries.length,
      reverse: normalized.reverse,
    }, qh));

    return {
      ok: true,
      entries,
      queryHash: qh,
      totalMatched,
    };
  };

  const getEntry = async (payload: LedgerEntryPayload): Promise<LedgerEntryResult> => {
    if (!policy.allowEntryLookup) {
      const record = auditRecord("entry", "deny", "ledger_entry_lookup_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`ledger_entry_denied:${record.reason}`);
    }

    const normalizedPayload = normalizeJson(payload ?? {}) as Record<string, JsonValue>;
    await maybeCallWith(boundary?.beforeEntry, payload);

    const byId = typeof payload.entryId === "string" && payload.entryId.length > 0
      ? state.entries.find((entry) => entry.entryId === payload.entryId)
      : undefined;
    const bySeq = Number.isInteger(payload.seq)
      ? state.entries.find((entry) => entry.seq === payload.seq)
      : undefined;

    const entry = byId ?? bySeq;
    if (!entry) {
      const qh = queryHash("entry", normalizedPayload);
      const record = auditRecord("entry", "deny", "ledger_entry_not_found", normalizedPayload, qh);
      emitAudit(audit, record);
      throw new Error(`ledger_entry_denied:${record.reason}`);
    }

    const normalizedEntryValue = normalizedEntry(entry);
    const qh = queryHash("entry", normalizedPayload);
    emitAudit(audit, auditRecord("entry", "allow", "ledger_entry_returned", {
      entryId: normalizedEntryValue.entryId,
      seq: normalizedEntryValue.seq,
    }, qh));

    return {
      ok: true,
      entry: normalizedEntryValue,
      queryHash: qh,
    };
  };

  const getHeads = async (_payload: LedgerHeadsPayload = {}): Promise<LedgerHeadsResult> => {
    if (!policy.allowHeads) {
      const record = auditRecord("heads", "deny", "ledger_heads_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`ledger_heads_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeHeads);
    const qh = queryHash("heads", {});
    emitAudit(audit, auditRecord("heads", "allow", "ledger_heads_returned", {
      current: state.heads.current,
      verified: state.heads.verified,
    }, qh));

    return {
      ok: true,
      heads: JSON.parse(stableJson(state.heads)) as LedgerHeads,
      queryHash: qh,
    };
  };

  const getStats = async (_payload: LedgerStatsPayload = {}): Promise<LedgerStatsResult> => {
    if (!policy.allowStats) {
      const record = auditRecord("stats", "deny", "ledger_stats_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`ledger_stats_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeStats);

    const byKind: Record<string, number> = {};
    let firstSeq: number | null = null;
    let lastSeq: number | null = null;

    for (const entry of state.entries) {
      byKind[entry.kind] = (byKind[entry.kind] ?? 0) + 1;
      firstSeq = firstSeq === null ? entry.seq : Math.min(firstSeq, entry.seq);
      lastSeq = lastSeq === null ? entry.seq : Math.max(lastSeq, entry.seq);
    }

    const stats: LedgerStats = {
      schema: 1,
      totalEntries: state.entries.length,
      byKind: Object.fromEntries(Object.entries(byKind).sort(([a], [b]) => a.localeCompare(b))),
      firstSeq,
      lastSeq,
      stateHash: sha256(stableJson({ totalEntries: state.entries.length, byKind, firstSeq, lastSeq })),
    };

    const qh = queryHash("stats", {});
    emitAudit(audit, auditRecord("stats", "allow", "ledger_stats_returned", {
      totalEntries: stats.totalEntries,
      kinds: Object.keys(stats.byKind).length,
    }, qh));

    return {
      ok: true,
      stats,
      queryHash: qh,
    };
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(channels.current, async (_event, payload?: LedgerCurrentPayload) => getCurrent(payload));
    ipcMain.handle(channels.timeline, async (_event, payload: LedgerTimelinePayload) => getTimeline(payload));
    ipcMain.handle(channels.entry, async (_event, payload: LedgerEntryPayload) => getEntry(payload));
    ipcMain.handle(channels.heads, async (_event, payload?: LedgerHeadsPayload) => getHeads(payload));
    ipcMain.handle(channels.stats, async (_event, payload?: LedgerStatsPayload) => getStats(payload));

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(channels.current);
    ipcMain.removeHandler(channels.timeline);
    ipcMain.removeHandler(channels.entry);
    ipcMain.removeHandler(channels.heads);
    ipcMain.removeHandler(channels.stats);
    registered = false;
  };

  return {
    getCurrent,
    getTimeline,
    getEntry,
    getHeads,
    getStats,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION
// -----------------------------------------------------------------------------

export function createDefaultLedgerRuntimeState(): LedgerRuntimeState {
  const snapshot: LedgerSnapshot = {
    schema: 1,
    headEntryId: null,
    headSeq: null,
    totalEntries: 0,
    latestTsMs: null,
    stateHash: sha256(stableJson({ empty: true })),
    summary: {},
  };

  const heads: LedgerHeads = {
    schema: 1,
    current: null,
    verified: null,
    appliedPatch: null,
    workspace: null,
    stateHash: sha256(stableJson({ empty: true })),
  };

  return {
    snapshot,
    heads,
    entries: [],
  };
}

export function createDefaultLedgerPolicy(): LedgerPolicy {
  return {
    allowCurrent: true,
    allowTimeline: true,
    allowEntryLookup: true,
    allowHeads: true,
    allowStats: true,
    maxTimelineLimit: 1000,
    allowReverseTimeline: true,
  };
}

export function validateLedgerRuntimeState(state: LedgerRuntimeState): void {
  assert(Array.isArray(state.entries), "entries_invalid");
  assert(typeof state.snapshot.totalEntries === "number", "snapshot_totalEntries_invalid");
}
