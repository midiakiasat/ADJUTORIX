import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * ADJUTORIX APP — SRC / HOOKS / useLedger.ts
 *
 * Canonical governed ledger hook.
 *
 * Purpose:
 * - provide one renderer-side, typed, memoized, event-driven surface for ledger truth
 * - unify transaction history, edges, approvals, apply/verify lineage, replay posture,
 *   rollback visibility, filters, selection state, and refresh/update lifecycles behind one hook
 * - prevent jobs, patch review, verify, diagnostics, transaction graph, and status panels from each
 *   inventing their own interpretation of ledger state or event ordering
 *
 * Architectural role:
 * - pure React hook over caller-supplied provider functions
 * - no Electron/window/global assumptions
 * - no hidden singleton store, no implicit polling, no background mutation
 * - all async transitions are explicit, cancellable, and sequence-guarded
 *
 * Hard invariants:
 * - identical provider results produce identical derived state
 * - stale async completions never overwrite newer state
 * - transaction ordering is stable and explicit
 * - lineage and edge maps are derived only from explicit ledger entries
 * - provider subscription cleanup is deterministic
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type LedgerLoadState = "idle" | "loading" | "ready" | "refreshing" | "error";
export type LedgerHealthLevel = "healthy" | "degraded" | "unhealthy" | "unknown";
export type LedgerEntryType =
  | "job-created"
  | "job-updated"
  | "patch-proposed"
  | "patch-reviewed"
  | "verify-started"
  | "verify-finished"
  | "apply-requested"
  | "apply-completed"
  | "rollback-requested"
  | "rollback-completed"
  | "approval-recorded"
  | "diagnostic-recorded"
  | "custom";
export type LedgerEntryStatus = "pending" | "succeeded" | "failed" | "cancelled" | "unknown";
export type LedgerEdgeType =
  | "caused-by"
  | "verifies"
  | "approves"
  | "supersedes"
  | "rolls-back"
  | "references"
  | "custom";

export interface LedgerHealth {
  level: LedgerHealthLevel;
  reasons: string[];
}

export interface LedgerReferenceSet {
  jobId?: string | null;
  patchId?: string | null;
  verifyId?: string | null;
  approvalId?: string | null;
  requestId?: string | null;
}

export interface LedgerEntry {
  seq: number;
  id: string;
  type: LedgerEntryType;
  status: LedgerEntryStatus;
  title: string;
  summary?: string | null;
  createdAtMs: number;
  references?: LedgerReferenceSet;
  metadata?: Record<string, unknown>;
}

export interface LedgerEdge {
  id: string;
  fromSeq: number;
  toSeq: number;
  type: LedgerEdgeType;
  metadata?: Record<string, unknown>;
}

export interface LedgerSnapshot {
  ledgerId: string;
  headSeq: number;
  selectedSeq?: number | null;
  entries: LedgerEntry[];
  edges?: LedgerEdge[];
  health?: LedgerHealth;
  replayable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface LedgerDerivedState {
  totalEntries: number;
  totalEdges: number;
  pendingEntries: number;
  failedEntries: number;
  selectedEntry: LedgerEntry | null;
  selectedIncomingEdges: LedgerEdge[];
  selectedOutgoingEdges: LedgerEdge[];
  entriesBySeq: Map<number, LedgerEntry>;
  entriesById: Map<string, LedgerEntry>;
  edgesByFromSeq: Map<number, LedgerEdge[]>;
  edgesByToSeq: Map<number, LedgerEdge[]>;
  latestEntry: LedgerEntry | null;
}

export interface LedgerEvent {
  type:
    | "ledger-snapshot"
    | "ledger-entry"
    | "ledger-edge"
    | "ledger-selection"
    | "ledger-health"
    | "ledger-head-updated";
  snapshot?: LedgerSnapshot;
  entry?: LedgerEntry;
  edge?: LedgerEdge;
  selectedSeq?: number | null;
  headSeq?: number;
  health?: LedgerHealth;
}

export interface LedgerProvider {
  loadLedger: () => Promise<LedgerSnapshot>;
  refreshLedger?: () => Promise<LedgerSnapshot>;
  subscribe?: (listener: (event: LedgerEvent) => void) => () => void;
  selectSeq?: (seq: number | null) => Promise<void> | void;
}

export interface UseLedgerOptions {
  autoLoad?: boolean;
  provider: LedgerProvider;
}

export interface UseLedgerResult {
  state: LedgerLoadState;
  snapshot: LedgerSnapshot | null;
  derived: LedgerDerivedState;
  error: Error | null;
  isReady: boolean;
  isBusy: boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  selectSeq: (seq: number | null) => Promise<void>;
  setSnapshot: (snapshot: LedgerSnapshot | null) => void;
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function normalizeEntry(entry: LedgerEntry): LedgerEntry {
  return {
    ...entry,
    status: entry.status ?? "unknown",
    summary: entry.summary ?? null,
    createdAtMs: Number.isFinite(entry.createdAtMs) ? entry.createdAtMs : Date.now(),
    references: { ...(entry.references ?? {}) },
    metadata: { ...(entry.metadata ?? {}) },
  };
}

function normalizeEdge(edge: LedgerEdge): LedgerEdge {
  return {
    ...edge,
    metadata: { ...(edge.metadata ?? {}) },
  };
}

function normalizeSnapshot(snapshot: LedgerSnapshot): LedgerSnapshot {
  return {
    ...snapshot,
    selectedSeq: snapshot.selectedSeq ?? null,
    entries: (snapshot.entries ?? [])
      .map(normalizeEntry)
      .sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id)),
    edges: (snapshot.edges ?? [])
      .map(normalizeEdge)
      .sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq || a.id.localeCompare(b.id)),
    health: snapshot.health ?? { level: "unknown", reasons: [] },
    replayable: snapshot.replayable ?? false,
    metadata: { ...(snapshot.metadata ?? {}) },
  };
}

function buildDerived(snapshot: LedgerSnapshot | null): LedgerDerivedState {
  if (!snapshot) {
    return {
      totalEntries: 0,
      totalEdges: 0,
      pendingEntries: 0,
      failedEntries: 0,
      selectedEntry: null,
      selectedIncomingEdges: [],
      selectedOutgoingEdges: [],
      entriesBySeq: new Map<number, LedgerEntry>(),
      entriesById: new Map<string, LedgerEntry>(),
      edgesByFromSeq: new Map<number, LedgerEdge[]>(),
      edgesByToSeq: new Map<number, LedgerEdge[]>(),
      latestEntry: null,
    };
  }

  const entriesBySeq = new Map<number, LedgerEntry>();
  const entriesById = new Map<string, LedgerEntry>();
  for (const entry of snapshot.entries) {
    entriesBySeq.set(entry.seq, entry);
    entriesById.set(entry.id, entry);
  }

  const edgesByFromSeq = new Map<number, LedgerEdge[]>();
  const edgesByToSeq = new Map<number, LedgerEdge[]>();
  for (const edge of snapshot.edges ?? []) {
    const out = edgesByFromSeq.get(edge.fromSeq) ?? [];
    out.push(edge);
    edgesByFromSeq.set(edge.fromSeq, out);

    const incoming = edgesByToSeq.get(edge.toSeq) ?? [];
    incoming.push(edge);
    edgesByToSeq.set(edge.toSeq, incoming);
  }

  for (const list of edgesByFromSeq.values()) {
    list.sort((a, b) => a.toSeq - b.toSeq || a.id.localeCompare(b.id));
  }
  for (const list of edgesByToSeq.values()) {
    list.sort((a, b) => a.fromSeq - b.fromSeq || a.id.localeCompare(b.id));
  }

  const selectedEntry = snapshot.selectedSeq != null ? entriesBySeq.get(snapshot.selectedSeq) ?? null : null;

  return {
    totalEntries: snapshot.entries.length,
    totalEdges: (snapshot.edges ?? []).length,
    pendingEntries: snapshot.entries.filter((entry) => entry.status === "pending").length,
    failedEntries: snapshot.entries.filter((entry) => entry.status === "failed").length,
    selectedEntry,
    selectedIncomingEdges: selectedEntry ? edgesByToSeq.get(selectedEntry.seq) ?? [] : [],
    selectedOutgoingEdges: selectedEntry ? edgesByFromSeq.get(selectedEntry.seq) ?? [] : [],
    entriesBySeq,
    entriesById,
    edgesByFromSeq,
    edgesByToSeq,
    latestEntry: snapshot.entries[snapshot.entries.length - 1] ?? null,
  };
}

function upsertEntry(entries: LedgerEntry[], next: LedgerEntry): LedgerEntry[] {
  const idx = entries.findIndex((entry) => entry.seq === next.seq || entry.id === next.id);
  const merged = idx >= 0
    ? [...entries.slice(0, idx), next, ...entries.slice(idx + 1)]
    : [...entries, next];
  return merged.sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
}

function upsertEdge(edges: LedgerEdge[], next: LedgerEdge): LedgerEdge[] {
  const idx = edges.findIndex((edge) => edge.id === next.id);
  const merged = idx >= 0
    ? [...edges.slice(0, idx), next, ...edges.slice(idx + 1)]
    : [...edges, next];
  return merged.sort((a, b) => a.fromSeq - b.fromSeq || a.toSeq - b.toSeq || a.id.localeCompare(b.id));
}

function applyLedgerEvent(previous: LedgerSnapshot | null, event: LedgerEvent): LedgerSnapshot | null {
  if (event.snapshot) {
    return normalizeSnapshot(event.snapshot);
  }

  if (!previous) return previous;

  switch (event.type) {
    case "ledger-entry":
      if (!event.entry) return previous;
      return {
        ...previous,
        entries: upsertEntry(previous.entries, normalizeEntry(event.entry)),
      };
    case "ledger-edge":
      if (!event.edge) return previous;
      return {
        ...previous,
        edges: upsertEdge(previous.edges ?? [], normalizeEdge(event.edge)),
      };
    case "ledger-selection":
      return {
        ...previous,
        selectedSeq: event.selectedSeq ?? null,
      };
    case "ledger-health":
      return {
        ...previous,
        health: event.health ?? previous.health,
      };
    case "ledger-head-updated":
      return {
        ...previous,
        headSeq: event.headSeq ?? previous.headSeq,
      };
    default:
      return previous;
  }
}

// -----------------------------------------------------------------------------
// HOOK
// -----------------------------------------------------------------------------

export function useLedger(options: UseLedgerOptions): UseLedgerResult {
  const { provider, autoLoad = true } = options;

  const [state, setState] = useState<LedgerLoadState>(autoLoad ? "loading" : "idle");
  const [snapshot, setSnapshotState] = useState<LedgerSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSnapshot = useCallback((next: LedgerSnapshot | null) => {
    if (!mountedRef.current) return;
    setSnapshotState(next ? normalizeSnapshot(next) : null);
  }, []);

  const runLoad = useCallback(
    async (mode: "load" | "refresh") => {
      const requestId = ++requestSeqRef.current;
      setError(null);
      setState((current) => {
        if (mode === "refresh" && (current === "ready" || current === "refreshing")) return "refreshing";
        return "loading";
      });

      try {
        const next = mode === "refresh" && provider.refreshLedger
          ? await provider.refreshLedger()
          : await provider.loadLedger();

        if (!mountedRef.current || requestId !== requestSeqRef.current) return;
        setSnapshotState(normalizeSnapshot(next));
        setState("ready");
      } catch (cause) {
        if (!mountedRef.current || requestId !== requestSeqRef.current) return;
        setError(cause instanceof Error ? cause : new Error(String(cause)));
        setState("error");
      }
    },
    [provider],
  );

  const reload = useCallback(async () => {
    await runLoad("load");
  }, [runLoad]);

  const refresh = useCallback(async () => {
    await runLoad("refresh");
  }, [runLoad]);

  const selectSeq = useCallback(
    async (seq: number | null) => {
      if (provider.selectSeq) {
        await provider.selectSeq(seq);
      }
      setSnapshotState((current) => current ? { ...current, selectedSeq: seq } : current);
    },
    [provider],
  );

  useEffect(() => {
    if (!autoLoad) return;
    void reload();
  }, [autoLoad, reload]);

  useEffect(() => {
    if (!provider.subscribe) return;

    const unsubscribe = provider.subscribe((event) => {
      if (!mountedRef.current) return;
      setSnapshotState((current) => applyLedgerEvent(current, event));
    });

    return () => {
      unsubscribe?.();
    };
  }, [provider]);

  const derived = useMemo(() => buildDerived(snapshot), [snapshot]);

  return {
    state,
    snapshot,
    derived,
    error,
    isReady: state === "ready",
    isBusy: state === "loading" || state === "refreshing",
    reload,
    refresh,
    selectSeq,
    setSnapshot,
  };
}

export default useLedger;
