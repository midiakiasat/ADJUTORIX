import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * ADJUTORIX APP — SRC / HOOKS / useWorkspace.ts
 *
 * Canonical governed workspace hook.
 *
 * Purpose:
 * - provide one renderer-side, typed, memoized, event-driven surface for workspace truth
 * - unify workspace identity, trust posture, file-tree summary, selection, health, indexing,
 *   watcher pressure, diagnostics pressure, and refresh/load lifecycles behind one hook
 * - prevent feature-local fetching and divergent reshaping of workspace state
 *
 * Architectural role:
 * - pure React hook over caller-supplied provider functions
 * - no direct Electron/global/window assumptions
 * - no hidden singleton store, no implicit polling, no background mutation
 * - all side effects are explicit and cancellable
 *
 * Hard invariants:
 * - identical provider results produce identical derived state
 * - refresh and load transitions are explicit
 * - stale async completions never overwrite newer state
 * - event subscription cleanup is deterministic
 * - derived summaries are computed from source state only
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type WorkspaceLoadState = "idle" | "loading" | "ready" | "refreshing" | "error";
export type WorkspaceTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type WorkspaceHealthLevel = "healthy" | "degraded" | "unhealthy" | "unknown";
export type WorkspaceIndexState = "unknown" | "idle" | "building" | "ready" | "stale" | "failed";
export type WorkspaceWatchState = "unknown" | "inactive" | "watching" | "degraded" | "failed";
export type WorkspaceEntryKind = "file" | "directory" | "symlink" | "unknown";

export interface WorkspaceEntry {
  path: string;
  name: string;
  kind: WorkspaceEntryKind;
  parentPath?: string | null;
  extension?: string | null;
  sizeBytes?: number | null;
  hidden?: boolean;
  ignored?: boolean;
  depth?: number;
  childCount?: number | null;
  modifiedAtMs?: number | null;
}

export interface WorkspaceDiagnosticsSnapshot {
  total: number;
  fatalCount: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
}

export interface WorkspaceHealth {
  level: WorkspaceHealthLevel;
  reasons: string[];
}

export interface WorkspaceIndexStatus {
  state: WorkspaceIndexState;
  progressPct?: number | null;
  updatedAtMs?: number | null;
  issueCount?: number | null;
}

export interface WorkspaceWatcherStatus {
  state: WorkspaceWatchState;
  watchedPaths?: number | null;
  eventLagMs?: number | null;
  lastEventAtMs?: number | null;
}

export interface WorkspaceSnapshot {
  workspaceId: string;
  rootPath: string;
  name: string;
  trustLevel: WorkspaceTrustLevel;
  entries: WorkspaceEntry[];
  selectedPath?: string | null;
  openedPaths?: string[];
  recentPaths?: string[];
  diagnostics?: WorkspaceDiagnosticsSnapshot;
  health?: WorkspaceHealth;
  indexStatus?: WorkspaceIndexStatus;
  watcherStatus?: WorkspaceWatcherStatus;
  metadata?: Record<string, unknown>;
}

export interface WorkspaceDerivedState {
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
  visibleEntries: number;
  hiddenEntries: number;
  ignoredEntries: number;
  selectedEntry: WorkspaceEntry | null;
  openedEntrySet: Set<string>;
  recentEntrySet: Set<string>;
  byPath: Map<string, WorkspaceEntry>;
  treeRoots: WorkspaceEntry[];
}

export interface WorkspaceEvent {
  type:
    | "workspace-updated"
    | "workspace-selected-path"
    | "workspace-trust-changed"
    | "workspace-index-updated"
    | "workspace-watcher-updated"
    | "workspace-diagnostics-updated";
  snapshot?: WorkspaceSnapshot;
  selectedPath?: string | null;
}

export interface WorkspaceProvider {
  loadWorkspace: () => Promise<WorkspaceSnapshot>;
  refreshWorkspace?: () => Promise<WorkspaceSnapshot>;
  subscribe?: (listener: (event: WorkspaceEvent) => void) => () => void;
  selectPath?: (path: string | null) => Promise<void> | void;
}

export interface UseWorkspaceOptions {
  autoLoad?: boolean;
  provider: WorkspaceProvider;
}

export interface UseWorkspaceResult {
  state: WorkspaceLoadState;
  snapshot: WorkspaceSnapshot | null;
  derived: WorkspaceDerivedState;
  error: Error | null;
  isReady: boolean;
  isBusy: boolean;
  reload: () => Promise<void>;
  refresh: () => Promise<void>;
  selectPath: (path: string | null) => Promise<void>;
  setSnapshot: (snapshot: WorkspaceSnapshot | null) => void;
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function normalizeEntry(entry: WorkspaceEntry): WorkspaceEntry {
  const path = normalizePath(entry.path);
  const parentPath = entry.parentPath ? normalizePath(entry.parentPath) : null;
  return {
    ...entry,
    path,
    parentPath,
    name: entry.name || path.split("/").pop() || path,
    extension: entry.extension ?? (entry.kind === "file" ? (path.match(/(\.[^.]+)$/)?.[1] ?? null) : null),
    depth: entry.depth ?? path.split("/").filter(Boolean).length,
  };
}

function normalizeSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
  const rootPath = normalizePath(snapshot.rootPath);
  const entries = snapshot.entries.map(normalizeEntry).sort((a, b) => a.path.localeCompare(b.path));
  return {
    ...snapshot,
    rootPath,
    selectedPath: snapshot.selectedPath ? normalizePath(snapshot.selectedPath) : null,
    openedPaths: (snapshot.openedPaths ?? []).map(normalizePath),
    recentPaths: (snapshot.recentPaths ?? []).map(normalizePath),
    entries,
    health: snapshot.health ?? { level: "unknown", reasons: [] },
    indexStatus: snapshot.indexStatus ?? { state: "unknown" },
    watcherStatus: snapshot.watcherStatus ?? { state: "unknown" },
    diagnostics: snapshot.diagnostics ?? {
      total: 0,
      fatalCount: 0,
      errorCount: 0,
      warningCount: 0,
      infoCount: 0,
    },
  };
}

function buildDerived(snapshot: WorkspaceSnapshot | null): WorkspaceDerivedState {
  if (!snapshot) {
    return {
      totalEntries: 0,
      totalFiles: 0,
      totalDirectories: 0,
      visibleEntries: 0,
      hiddenEntries: 0,
      ignoredEntries: 0,
      selectedEntry: null,
      openedEntrySet: new Set<string>(),
      recentEntrySet: new Set<string>(),
      byPath: new Map<string, WorkspaceEntry>(),
      treeRoots: [],
    };
  }

  const byPath = new Map<string, WorkspaceEntry>();
  for (const entry of snapshot.entries) {
    byPath.set(entry.path, entry);
  }

  const totalFiles = snapshot.entries.filter((entry) => entry.kind === "file").length;
  const totalDirectories = snapshot.entries.filter((entry) => entry.kind === "directory").length;
  const hiddenEntries = snapshot.entries.filter((entry) => Boolean(entry.hidden)).length;
  const ignoredEntries = snapshot.entries.filter((entry) => Boolean(entry.ignored)).length;
  const visibleEntries = snapshot.entries.filter((entry) => !entry.hidden && !entry.ignored).length;
  const selectedEntry = snapshot.selectedPath ? byPath.get(snapshot.selectedPath) ?? null : null;
  const openedEntrySet = new Set<string>(snapshot.openedPaths ?? []);
  const recentEntrySet = new Set<string>(snapshot.recentPaths ?? []);
  const treeRoots = snapshot.entries.filter((entry) => !entry.parentPath || entry.parentPath === snapshot.rootPath || entry.path === snapshot.rootPath);

  return {
    totalEntries: snapshot.entries.length,
    totalFiles,
    totalDirectories,
    visibleEntries,
    hiddenEntries,
    ignoredEntries,
    selectedEntry,
    openedEntrySet,
    recentEntrySet,
    byPath,
    treeRoots,
  };
}

function applyWorkspaceEvent(previous: WorkspaceSnapshot | null, event: WorkspaceEvent): WorkspaceSnapshot | null {
  if (event.snapshot) {
    return normalizeSnapshot(event.snapshot);
  }

  if (!previous) return previous;

  switch (event.type) {
    case "workspace-selected-path":
      return {
        ...previous,
        selectedPath: event.selectedPath ? normalizePath(event.selectedPath) : null,
      };
    default:
      return previous;
  }
}

// -----------------------------------------------------------------------------
// HOOK
// -----------------------------------------------------------------------------

export function useWorkspace(options: UseWorkspaceOptions): UseWorkspaceResult {
  const { provider, autoLoad = true } = options;

  const [state, setState] = useState<WorkspaceLoadState>(autoLoad ? "loading" : "idle");
  const [snapshot, setSnapshotState] = useState<WorkspaceSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);

  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSnapshot = useCallback((next: WorkspaceSnapshot | null) => {
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
        const next = mode === "refresh" && provider.refreshWorkspace ? await provider.refreshWorkspace() : await provider.loadWorkspace();
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

  const selectPath = useCallback(
    async (path: string | null) => {
      const normalized = path ? normalizePath(path) : null;
      if (provider.selectPath) {
        await provider.selectPath(normalized);
      }
      setSnapshotState((current) => {
        if (!current) return current;
        return {
          ...current,
          selectedPath: normalized,
        };
      });
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
      setSnapshotState((current) => applyWorkspaceEvent(current, event));
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
    selectPath,
    setSnapshot,
  };
}

export default useWorkspace;
