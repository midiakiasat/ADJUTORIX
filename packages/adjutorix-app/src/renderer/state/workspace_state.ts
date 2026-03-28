/**
 * ADJUTORIX APP — RENDERER / STATE / workspace_state.ts
 *
 * Canonical renderer-side workspace state model and reducer.
 *
 * Purpose:
 * - define one authoritative client-side state machine for active workspace state
 * - unify workspace identity, trust, health, file selection, preview lineage, and UI-local
 *   interaction state under one deterministic contract
 * - prevent state drift between panels that each guess whether a workspace is open,
 *   trusted, healthy, dirty, selected, or aligned with active preview/verify lineage
 * - provide pure transitions suitable for replay, testing, diagnostics, and reducer-driven UI
 *
 * Scope:
 * - active workspace root identity
 * - trust / health / readiness snapshots
 * - selected paths and focused path
 * - patch preview / approval / verification lineage references
 * - refresh / event synchronization markers
 * - renderer-only workspace UI state such as expansion/focus/reveal intent
 *
 * Non-scope:
 * - direct IPC or transport execution
 * - filesystem watching implementation
 * - mutation execution itself
 *
 * Hard invariants:
 * - all transitions are pure and deterministic
 * - identical prior state + identical action => identical next state hash
 * - no workspace-dependent state remains populated after workspace close/reset
 * - selected paths are unique, normalized, and ordered deterministically
 * - preview/verify lineage may not reference a different workspace root silently
 * - outputs are serialization-stable and auditable
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type WorkspaceTrustLevel = "untrusted" | "restricted" | "trusted" | "unknown";
export type WorkspaceHealthLevel = "healthy" | "degraded" | "unhealthy" | "offline" | "unknown";
export type WorkspaceLifecycle = "empty" | "opening" | "open" | "closing" | "failed";

export type WorkspaceSelectionMode = "single" | "multi";

export type WorkspacePreviewLineage = {
  patchId: string | null;
  currentPreviewHash: string | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
  requestHash: string | null;
};

export type WorkspaceUiState = {
  focusedPath: string | null;
  revealedPath: string | null;
  expandedPaths: string[];
  searchQuery: string;
  lastUserIntent: string | null;
};

export type WorkspaceSyncState = {
  lastHydratedAtMs: number | null;
  lastEventAtMs: number | null;
  lastRefreshAtMs: number | null;
  pendingRefresh: boolean;
  sourceOfTruthHash: string | null;
};

export type WorkspaceStatusSnapshots = {
  health: JsonObject | null;
  trust: JsonObject | null;
  runtime: JsonObject | null;
  diagnostics: JsonObject | null;
};

export type WorkspaceState = {
  schema: 1;
  lifecycle: WorkspaceLifecycle;
  rootPath: string | null;
  workspaceId: string | null;
  title: string | null;
  trustLevel: WorkspaceTrustLevel;
  healthLevel: WorkspaceHealthLevel;
  dirty: boolean;
  selectionMode: WorkspaceSelectionMode;
  selectedPaths: string[];
  ui: WorkspaceUiState;
  lineage: WorkspacePreviewLineage;
  sync: WorkspaceSyncState;
  status: WorkspaceStatusSnapshots;
  lastError: string | null;
  hash: string;
};

export type WorkspaceAction =
  | { type: "WORKSPACE_OPEN_REQUESTED"; rootPath: string; title?: string | null; atMs?: number }
  | { type: "WORKSPACE_OPEN_SUCCEEDED"; rootPath: string; title?: string | null; runtime?: JsonObject | null; atMs?: number }
  | { type: "WORKSPACE_OPEN_FAILED"; rootPath?: string | null; error: string; atMs?: number }
  | { type: "WORKSPACE_CLOSE_REQUESTED"; atMs?: number }
  | { type: "WORKSPACE_CLOSED"; atMs?: number }
  | { type: "WORKSPACE_TRUST_UPDATED"; trust: JsonObject | null; level?: WorkspaceTrustLevel; atMs?: number }
  | { type: "WORKSPACE_HEALTH_UPDATED"; health: JsonObject | null; level?: WorkspaceHealthLevel; atMs?: number }
  | { type: "WORKSPACE_RUNTIME_UPDATED"; runtime: JsonObject | null; atMs?: number }
  | { type: "WORKSPACE_DIAGNOSTICS_UPDATED"; diagnostics: JsonObject | null; atMs?: number }
  | { type: "WORKSPACE_DIRTY_CHANGED"; dirty: boolean }
  | { type: "WORKSPACE_SELECTION_REPLACED"; paths: string[]; mode?: WorkspaceSelectionMode }
  | { type: "WORKSPACE_SELECTION_TOGGLED"; path: string }
  | { type: "WORKSPACE_SELECTION_CLEARED" }
  | { type: "WORKSPACE_FOCUS_SET"; path: string | null }
  | { type: "WORKSPACE_REVEAL_SET"; path: string | null }
  | { type: "WORKSPACE_EXPANDED_SET"; paths: string[] }
  | { type: "WORKSPACE_EXPANDED_TOGGLED"; path: string }
  | { type: "WORKSPACE_SEARCH_SET"; query: string }
  | { type: "WORKSPACE_INTENT_SET"; intent: string | null }
  | { type: "WORKSPACE_PREVIEW_BOUND"; patchId: string; previewHash: string; requestHash?: string | null }
  | { type: "WORKSPACE_PREVIEW_APPROVED"; previewHash: string }
  | { type: "WORKSPACE_VERIFY_BOUND"; verifyId: string; verifiedPreviewHash: string }
  | { type: "WORKSPACE_LINEAGE_RESET" }
  | { type: "WORKSPACE_REFRESH_REQUESTED"; atMs?: number }
  | { type: "WORKSPACE_REFRESH_COMPLETED"; sourceOfTruthHash?: string | null; atMs?: number }
  | { type: "WORKSPACE_EVENT_APPLIED"; sourceOfTruthHash?: string | null; atMs?: number }
  | { type: "WORKSPACE_ERROR_CLEARED" }
  | { type: "WORKSPACE_RESET" };

export type WorkspaceSelector<T> = (state: WorkspaceState) => T;

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

function stateHash(core: Omit<WorkspaceState, "hash">): string {
  return hashString(stableJson(core));
}

function nowMs(input?: number): number {
  return input ?? Date.now();
}

function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") || "/";
}

function normalizeNullablePath(p: string | null | undefined): string | null {
  if (!p) return null;
  const trimmed = p.trim();
  if (!trimmed) return null;
  return normalizePath(trimmed);
}

function uniqueSortedPaths(paths: string[]): string[] {
  return [...new Set(paths.map(normalizePath).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function deriveWorkspaceId(rootPath: string | null): string | null {
  return rootPath ? `ws_${hashString(rootPath)}` : null;
}

function deriveTitle(rootPath: string | null, explicit?: string | null): string | null {
  if (explicit && explicit.trim()) return explicit.trim();
  if (!rootPath) return null;
  const parts = normalizePath(rootPath).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? rootPath;
}

function deriveTrustLevel(snapshot: JsonObject | null, explicit?: WorkspaceTrustLevel): WorkspaceTrustLevel {
  if (explicit) return explicit;
  const level = snapshot?.level;
  return level === "untrusted" || level === "restricted" || level === "trusted" ? level : "unknown";
}

function deriveHealthLevel(snapshot: JsonObject | null, explicit?: WorkspaceHealthLevel): WorkspaceHealthLevel {
  if (explicit) return explicit;
  const level = snapshot?.level;
  return level === "healthy" || level === "degraded" || level === "unhealthy" || level === "offline" ? level : "unknown";
}

function ensureInsideWorkspace(rootPath: string | null, paths: string[]): string[] {
  if (!rootPath) return [];
  const root = normalizePath(rootPath);
  return uniqueSortedPaths(paths).filter((p) => p === root || p.startsWith(`${root}/`) || !p.startsWith("/"));
}

function coerceObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(stableJson(value)) as JsonObject;
}

function recompute(state: Omit<WorkspaceState, "hash">): WorkspaceState {
  return {
    ...state,
    hash: stateHash(state),
  };
}

function resetWorkspaceBoundState(base: Omit<WorkspaceState, "hash">): Omit<WorkspaceState, "hash"> {
  return {
    ...base,
    rootPath: null,
    workspaceId: null,
    title: null,
    trustLevel: "unknown",
    healthLevel: "unknown",
    dirty: false,
    selectedPaths: [],
    ui: {
      focusedPath: null,
      revealedPath: null,
      expandedPaths: [],
      searchQuery: "",
      lastUserIntent: null,
    },
    lineage: {
      patchId: null,
      currentPreviewHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
      requestHash: null,
    },
    status: {
      health: null,
      trust: null,
      runtime: null,
      diagnostics: null,
    },
  };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialWorkspaceState(): WorkspaceState {
  const core: Omit<WorkspaceState, "hash"> = {
    schema: 1,
    lifecycle: "empty",
    rootPath: null,
    workspaceId: null,
    title: null,
    trustLevel: "unknown",
    healthLevel: "unknown",
    dirty: false,
    selectionMode: "multi",
    selectedPaths: [],
    ui: {
      focusedPath: null,
      revealedPath: null,
      expandedPaths: [],
      searchQuery: "",
      lastUserIntent: null,
    },
    lineage: {
      patchId: null,
      currentPreviewHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
      requestHash: null,
    },
    sync: {
      lastHydratedAtMs: null,
      lastEventAtMs: null,
      lastRefreshAtMs: null,
      pendingRefresh: false,
      sourceOfTruthHash: null,
    },
    status: {
      health: null,
      trust: null,
      runtime: null,
      diagnostics: null,
    },
    lastError: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  const core: Omit<WorkspaceState, "hash"> = { ...state };
  delete (core as WorkspaceState).hash;

  switch (action.type) {
    case "WORKSPACE_OPEN_REQUESTED": {
      const rootPath = normalizePath(action.rootPath);
      return recompute({
        ...core,
        lifecycle: "opening",
        rootPath,
        workspaceId: deriveWorkspaceId(rootPath),
        title: deriveTitle(rootPath, action.title),
        lastError: null,
        sync: {
          ...core.sync,
          pendingRefresh: true,
          lastRefreshAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_OPEN_SUCCEEDED": {
      const rootPath = normalizePath(action.rootPath);
      return recompute({
        ...core,
        lifecycle: "open",
        rootPath,
        workspaceId: deriveWorkspaceId(rootPath),
        title: deriveTitle(rootPath, action.title),
        status: {
          ...core.status,
          runtime: coerceObject(action.runtime ?? null),
        },
        sync: {
          ...core.sync,
          pendingRefresh: false,
          lastHydratedAtMs: nowMs(action.atMs),
        },
        lastError: null,
      });
    }

    case "WORKSPACE_OPEN_FAILED": {
      return recompute({
        ...core,
        lifecycle: "failed",
        rootPath: normalizeNullablePath(action.rootPath) ?? core.rootPath,
        workspaceId: deriveWorkspaceId(normalizeNullablePath(action.rootPath) ?? core.rootPath),
        lastError: action.error,
        sync: {
          ...core.sync,
          pendingRefresh: false,
        },
      });
    }

    case "WORKSPACE_CLOSE_REQUESTED": {
      return recompute({
        ...core,
        lifecycle: core.rootPath ? "closing" : "empty",
        sync: {
          ...core.sync,
          pendingRefresh: false,
        },
      });
    }

    case "WORKSPACE_CLOSED": {
      return recompute({
        ...resetWorkspaceBoundState(core),
        lifecycle: "empty",
        lastError: null,
        sync: {
          ...core.sync,
          pendingRefresh: false,
          lastEventAtMs: nowMs(action.atMs),
          sourceOfTruthHash: null,
        },
      });
    }

    case "WORKSPACE_TRUST_UPDATED": {
      const trust = coerceObject(action.trust);
      return recompute({
        ...core,
        trustLevel: deriveTrustLevel(trust, action.level),
        status: {
          ...core.status,
          trust,
        },
        sync: {
          ...core.sync,
          lastEventAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_HEALTH_UPDATED": {
      const health = coerceObject(action.health);
      return recompute({
        ...core,
        healthLevel: deriveHealthLevel(health, action.level),
        status: {
          ...core.status,
          health,
        },
        sync: {
          ...core.sync,
          lastEventAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_RUNTIME_UPDATED": {
      return recompute({
        ...core,
        status: {
          ...core.status,
          runtime: coerceObject(action.runtime),
        },
        sync: {
          ...core.sync,
          lastEventAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_DIAGNOSTICS_UPDATED": {
      return recompute({
        ...core,
        status: {
          ...core.status,
          diagnostics: coerceObject(action.diagnostics),
        },
        sync: {
          ...core.sync,
          lastEventAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_DIRTY_CHANGED": {
      return recompute({
        ...core,
        dirty: action.dirty,
      });
    }

    case "WORKSPACE_SELECTION_REPLACED": {
      const normalized = ensureInsideWorkspace(core.rootPath, action.paths);
      return recompute({
        ...core,
        selectionMode: action.mode ?? core.selectionMode,
        selectedPaths: normalized,
        ui: {
          ...core.ui,
          focusedPath: normalized[0] ?? null,
        },
      });
    }

    case "WORKSPACE_SELECTION_TOGGLED": {
      const path = normalizePath(action.path);
      const has = core.selectedPaths.includes(path);
      const next = has ? core.selectedPaths.filter((p) => p !== path) : uniqueSortedPaths([...core.selectedPaths, path]);
      const selectedPaths = ensureInsideWorkspace(core.rootPath, next);
      return recompute({
        ...core,
        selectedPaths,
        ui: {
          ...core.ui,
          focusedPath: selectedPaths.includes(path) ? path : selectedPaths[0] ?? null,
        },
      });
    }

    case "WORKSPACE_SELECTION_CLEARED": {
      return recompute({
        ...core,
        selectedPaths: [],
        ui: {
          ...core.ui,
          focusedPath: null,
        },
      });
    }

    case "WORKSPACE_FOCUS_SET": {
      const focusedPath = normalizeNullablePath(action.path);
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          focusedPath,
        },
      });
    }

    case "WORKSPACE_REVEAL_SET": {
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          revealedPath: normalizeNullablePath(action.path),
        },
      });
    }

    case "WORKSPACE_EXPANDED_SET": {
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          expandedPaths: ensureInsideWorkspace(core.rootPath, action.paths),
        },
      });
    }

    case "WORKSPACE_EXPANDED_TOGGLED": {
      const path = normalizePath(action.path);
      const has = core.ui.expandedPaths.includes(path);
      const expandedPaths = ensureInsideWorkspace(
        core.rootPath,
        has ? core.ui.expandedPaths.filter((p) => p !== path) : [...core.ui.expandedPaths, path],
      );
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          expandedPaths,
        },
      });
    }

    case "WORKSPACE_SEARCH_SET": {
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          searchQuery: action.query,
        },
      });
    }

    case "WORKSPACE_INTENT_SET": {
      return recompute({
        ...core,
        ui: {
          ...core.ui,
          lastUserIntent: action.intent,
        },
      });
    }

    case "WORKSPACE_PREVIEW_BOUND": {
      return recompute({
        ...core,
        lineage: {
          ...core.lineage,
          patchId: action.patchId,
          currentPreviewHash: action.previewHash,
          requestHash: action.requestHash ?? core.lineage.requestHash,
          approvedPreviewHash:
            core.lineage.approvedPreviewHash === action.previewHash ? core.lineage.approvedPreviewHash : null,
          verifiedPreviewHash:
            core.lineage.verifiedPreviewHash === action.previewHash ? core.lineage.verifiedPreviewHash : null,
          verifyId:
            core.lineage.verifiedPreviewHash === action.previewHash ? core.lineage.verifyId : null,
        },
      });
    }

    case "WORKSPACE_PREVIEW_APPROVED": {
      return recompute({
        ...core,
        lineage: {
          ...core.lineage,
          approvedPreviewHash: action.previewHash,
        },
      });
    }

    case "WORKSPACE_VERIFY_BOUND": {
      return recompute({
        ...core,
        lineage: {
          ...core.lineage,
          verifyId: action.verifyId,
          verifiedPreviewHash: action.verifiedPreviewHash,
        },
      });
    }

    case "WORKSPACE_LINEAGE_RESET": {
      return recompute({
        ...core,
        lineage: {
          patchId: null,
          currentPreviewHash: null,
          approvedPreviewHash: null,
          verifiedPreviewHash: null,
          verifyId: null,
          requestHash: null,
        },
      });
    }

    case "WORKSPACE_REFRESH_REQUESTED": {
      return recompute({
        ...core,
        sync: {
          ...core.sync,
          pendingRefresh: true,
          lastRefreshAtMs: nowMs(action.atMs),
        },
      });
    }

    case "WORKSPACE_REFRESH_COMPLETED": {
      return recompute({
        ...core,
        sync: {
          ...core.sync,
          pendingRefresh: false,
          lastHydratedAtMs: nowMs(action.atMs),
          sourceOfTruthHash: action.sourceOfTruthHash ?? core.sync.sourceOfTruthHash,
        },
      });
    }

    case "WORKSPACE_EVENT_APPLIED": {
      return recompute({
        ...core,
        sync: {
          ...core.sync,
          lastEventAtMs: nowMs(action.atMs),
          sourceOfTruthHash: action.sourceOfTruthHash ?? core.sync.sourceOfTruthHash,
        },
      });
    }

    case "WORKSPACE_ERROR_CLEARED": {
      return recompute({
        ...core,
        lastError: null,
      });
    }

    case "WORKSPACE_RESET": {
      return createInitialWorkspaceState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectWorkspaceRoot: WorkspaceSelector<string | null> = (state) => state.rootPath;
export const selectWorkspaceIsOpen: WorkspaceSelector<boolean> = (state) => state.lifecycle === "open" && !!state.rootPath;
export const selectWorkspaceTrustLevel: WorkspaceSelector<WorkspaceTrustLevel> = (state) => state.trustLevel;
export const selectWorkspaceHealthLevel: WorkspaceSelector<WorkspaceHealthLevel> = (state) => state.healthLevel;
export const selectWorkspaceSelectedPaths: WorkspaceSelector<string[]> = (state) => state.selectedPaths;
export const selectWorkspaceFocusedPath: WorkspaceSelector<string | null> = (state) => state.ui.focusedPath;
export const selectWorkspaceLineage: WorkspaceSelector<WorkspacePreviewLineage> = (state) => state.lineage;
export const selectWorkspaceCanApply: WorkspaceSelector<boolean> = (state) => {
  return (
    state.lifecycle === "open" &&
    state.trustLevel === "trusted" &&
    state.healthLevel === "healthy" &&
    !!state.lineage.patchId &&
    !!state.lineage.currentPreviewHash &&
    !!state.lineage.approvedPreviewHash &&
    !!state.lineage.verifiedPreviewHash &&
    state.lineage.approvedPreviewHash === state.lineage.verifiedPreviewHash
  );
};

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateWorkspaceState(state: WorkspaceState): void {
  if (state.schema !== 1) {
    throw new Error("workspace_state_schema_invalid");
  }

  const core: Omit<WorkspaceState, "hash"> = {
    schema: state.schema,
    lifecycle: state.lifecycle,
    rootPath: state.rootPath,
    workspaceId: state.workspaceId,
    title: state.title,
    trustLevel: state.trustLevel,
    healthLevel: state.healthLevel,
    dirty: state.dirty,
    selectionMode: state.selectionMode,
    selectedPaths: state.selectedPaths,
    ui: state.ui,
    lineage: state.lineage,
    sync: state.sync,
    status: state.status,
    lastError: state.lastError,
  };

  if (state.hash !== stateHash(core)) {
    throw new Error("workspace_state_hash_drift");
  }

  const deduped = uniqueSortedPaths(state.selectedPaths);
  if (stableJson(deduped) !== stableJson(state.selectedPaths)) {
    throw new Error("workspace_state_selected_paths_not_normalized");
  }

  if (!state.rootPath && state.lifecycle === "open") {
    throw new Error("workspace_state_open_without_root");
  }

  if (!state.rootPath) {
    const workspaceBound = [
      state.selectedPaths.length > 0,
      !!state.ui.focusedPath,
      !!state.ui.revealedPath,
      state.ui.expandedPaths.length > 0,
      !!state.lineage.patchId,
      !!state.lineage.currentPreviewHash,
      !!state.lineage.approvedPreviewHash,
      !!state.lineage.verifiedPreviewHash,
      !!state.lineage.verifyId,
    ].some(Boolean);
    if (workspaceBound) {
      throw new Error("workspace_state_bound_fields_present_without_root");
    }
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyWorkspaceActions(initial: WorkspaceState, actions: WorkspaceAction[]): WorkspaceState {
  return actions.reduce(workspaceReducer, initial);
}

export function serializeWorkspaceState(state: WorkspaceState): string {
  validateWorkspaceState(state);
  return stableJson(state);
}
