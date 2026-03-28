/**
 * ADJUTORIX APP — RENDERER / STATE / app_state.ts
 *
 * Canonical top-level renderer application state graph and reducer.
 *
 * Purpose:
 * - define one authoritative global state model for the renderer application shell
 * - unify navigation, layout, notifications, activity timeline, command intent,
 *   subsystem snapshots, and bootstrap/failure posture in a deterministic reducer
 * - prevent drift between feature-local stores that each attempt to represent
 *   the same global facts differently
 * - provide pure transitions suitable for replay, diagnostics, invariants, and tests
 *
 * Scope:
 * - renderer bootstrap phase and compatibility posture
 * - current application view / layout structure
 * - global notifications and activity log
 * - command composer state and governed workflow bindings
 * - subsystem snapshots (workspace / patch / verify / ledger / diagnostics / agent)
 * - refresh/error/loading state
 *
 * Non-scope:
 * - direct IPC transport execution
 * - DOM/UI rendering behavior
 * - persistence layer implementation
 *
 * Hard invariants:
 * - all transitions are pure and deterministic
 * - identical prior state + identical action => identical next state hash
 * - subsystem snapshots remain plain JSON-safe data
 * - selected view is always a declared app view
 * - command lineage fields remain explicit and never inferred from unrelated slices
 * - outputs are serialization-stable and auditable
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

export type AppBootPhase = "booting" | "ready" | "degraded" | "failed";
export type AppHealth = "healthy" | "degraded" | "unhealthy" | "unknown";

export type AppView =
  | "overview"
  | "workspace"
  | "patch"
  | "verify"
  | "ledger"
  | "agent"
  | "diagnostics"
  | "activity";

export type ActivitySource = "workspace" | "patch" | "verify" | "ledger" | "agent" | "diagnostics" | "app";
export type ToastLevel = "info" | "warn" | "error" | "success";
export type CommandIntent =
  | "patch-preview"
  | "patch-approve"
  | "patch-apply"
  | "verify-run"
  | "agent-start"
  | "agent-stop"
  | "diagnostics-export";

export type AppManifest = {
  version: 1;
  name: string;
  bridgeVersion: number;
  bridgeName: string;
  capabilities: string[];
};

export type StatusSlices = {
  runtime: JsonObject | null;
  workspaceHealth: JsonObject | null;
  workspaceTrust: JsonObject | null;
  patchState: JsonObject | null;
  verifyState: JsonObject | null;
  ledgerState: JsonObject | null;
  diagnosticsRuntime: JsonObject | null;
  diagnosticsObservability: JsonObject | null;
  agentHealth: JsonObject | null;
  agentStatus: JsonObject | null;
};

export type CommandComposerState = {
  prompt: string;
  targetPaths: string[];
  previewHash: string;
  patchId: string;
  requestHash: string;
  verifyTargets: string[];
  diagnosticsExportRequested: boolean;
  lastIntent: CommandIntent | null;
};

export type LayoutState = {
  leftRailCollapsed: boolean;
  rightRailCollapsed: boolean;
  commandPaletteOpen: boolean;
  currentView: AppView;
  selectedActivityId: string | null;
};

export type ActivityItem = {
  id: string;
  source: ActivitySource;
  title: string;
  detail: string;
  atMs: number;
  level: ToastLevel;
  payload?: JsonValue;
};

export type ToastItem = {
  id: string;
  level: ToastLevel;
  title: string;
  message: string;
  atMs: number;
};

export type BootstrapState = {
  phase: AppBootPhase;
  startedAtMs: number;
  readyAtMs: number | null;
  failedAtMs: number | null;
  degradedReason: string | null;
  fatalError: string | null;
  manifest: AppManifest | null;
};

export type RefreshState = {
  loading: boolean;
  lastRefreshAtMs: number | null;
  lastSuccessfulRefreshAtMs: number | null;
  pendingReason: string | null;
};

export type ErrorState = {
  lastError: string | null;
  errorCount: number;
};

export type AppState = {
  schema: 1;
  bootstrap: BootstrapState;
  health: AppHealth;
  status: StatusSlices;
  command: CommandComposerState;
  layout: LayoutState;
  refresh: RefreshState;
  errors: ErrorState;
  activities: ActivityItem[];
  toasts: ToastItem[];
  appHash: string;
};

// -----------------------------------------------------------------------------
// ACTIONS
// -----------------------------------------------------------------------------

export type AppAction =
  | { type: "BOOTSTRAP_STARTED"; startedAtMs?: number }
  | { type: "BOOTSTRAP_SUCCEEDED"; readyAtMs?: number; manifest: AppManifest }
  | { type: "BOOTSTRAP_DEGRADED"; reason: string }
  | { type: "BOOTSTRAP_FAILED"; error: string; failedAtMs?: number }
  | { type: "SET_HEALTH"; health: AppHealth }
  | { type: "SET_STATUS_PARTIAL"; patch: Partial<StatusSlices> }
  | { type: "SET_VIEW"; view: AppView }
  | { type: "TOGGLE_LEFT_RAIL" }
  | { type: "TOGGLE_RIGHT_RAIL" }
  | { type: "TOGGLE_COMMAND_PALETTE"; open?: boolean }
  | { type: "SET_COMMAND_PROMPT"; prompt: string }
  | { type: "SET_COMMAND_TARGETS"; targetPaths: string[] }
  | { type: "SET_VERIFY_TARGETS"; targetPaths: string[] }
  | { type: "SET_PATCH_BINDING"; patchId: string; previewHash: string; requestHash: string }
  | { type: "SET_COMMAND_INTENT"; intent: CommandIntent | null }
  | { type: "SET_DIAGNOSTICS_EXPORT_REQUESTED"; requested: boolean }
  | { type: "SET_LOADING"; loading: boolean; reason?: string | null }
  | { type: "SET_LAST_REFRESH"; atMs?: number; success?: boolean }
  | { type: "SET_LAST_ERROR"; error: string | null }
  | { type: "ADD_ACTIVITY"; item: ActivityItem }
  | { type: "ADD_TOAST"; toast: ToastItem }
  | { type: "DISMISS_TOAST"; id: string }
  | { type: "SELECT_ACTIVITY"; id: string | null }
  | { type: "RESET_COMMAND_COMPOSER" }
  | { type: "RESET_STATUS" }
  | { type: "RESET_APP" };

export type AppSelector<T> = (state: AppState) => T;

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

function appStateHash(core: Omit<AppState, "appHash">): string {
  return hashString(stableJson(core));
}

function nowMs(input?: number): number {
  return input ?? Date.now();
}

function uniqueSortedStrings(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function deriveHealth(status: StatusSlices): AppHealth {
  const levels = [
    status.workspaceHealth?.level,
    status.agentHealth?.level,
    status.diagnosticsRuntime?.level,
  ];
  if (levels.includes("unhealthy")) return "unhealthy";
  if (levels.includes("degraded")) return "degraded";
  if (levels.includes("healthy")) return "healthy";
  return "unknown";
}

function recompute(state: Omit<AppState, "appHash">): AppState {
  return {
    ...state,
    appHash: appStateHash(state),
  };
}

function makeBootstrapState(startedAtMs: number): BootstrapState {
  return {
    phase: "booting",
    startedAtMs,
    readyAtMs: null,
    failedAtMs: null,
    degradedReason: null,
    fatalError: null,
    manifest: null,
  };
}

function makeEmptyStatus(): StatusSlices {
  return {
    runtime: null,
    workspaceHealth: null,
    workspaceTrust: null,
    patchState: null,
    verifyState: null,
    ledgerState: null,
    diagnosticsRuntime: null,
    diagnosticsObservability: null,
    agentHealth: null,
    agentStatus: null,
  };
}

function makeEmptyCommandState(): CommandComposerState {
  return {
    prompt: "",
    targetPaths: [],
    previewHash: "",
    patchId: "",
    requestHash: "",
    verifyTargets: [],
    diagnosticsExportRequested: false,
    lastIntent: null,
  };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialAppState(): AppState {
  const startedAtMs = nowMs();
  const core: Omit<AppState, "appHash"> = {
    schema: 1,
    bootstrap: makeBootstrapState(startedAtMs),
    health: "unknown",
    status: makeEmptyStatus(),
    command: makeEmptyCommandState(),
    layout: {
      leftRailCollapsed: false,
      rightRailCollapsed: false,
      commandPaletteOpen: false,
      currentView: "overview",
      selectedActivityId: null,
    },
    refresh: {
      loading: false,
      lastRefreshAtMs: null,
      lastSuccessfulRefreshAtMs: null,
      pendingReason: null,
    },
    errors: {
      lastError: null,
      errorCount: 0,
    },
    activities: [],
    toasts: [],
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function appReducer(state: AppState, action: AppAction): AppState {
  const core: Omit<AppState, "appHash"> = { ...state };
  delete (core as AppState).appHash;

  switch (action.type) {
    case "BOOTSTRAP_STARTED": {
      return recompute({
        ...core,
        bootstrap: makeBootstrapState(nowMs(action.startedAtMs)),
      });
    }

    case "BOOTSTRAP_SUCCEEDED": {
      return recompute({
        ...core,
        bootstrap: {
          ...core.bootstrap,
          phase: "ready",
          readyAtMs: nowMs(action.readyAtMs),
          failedAtMs: null,
          degradedReason: null,
          fatalError: null,
          manifest: action.manifest,
        },
      });
    }

    case "BOOTSTRAP_DEGRADED": {
      return recompute({
        ...core,
        bootstrap: {
          ...core.bootstrap,
          phase: "degraded",
          degradedReason: action.reason,
        },
      });
    }

    case "BOOTSTRAP_FAILED": {
      return recompute({
        ...core,
        bootstrap: {
          ...core.bootstrap,
          phase: "failed",
          failedAtMs: nowMs(action.failedAtMs),
          fatalError: action.error,
        },
        errors: {
          lastError: action.error,
          errorCount: core.errors.errorCount + 1,
        },
      });
    }

    case "SET_HEALTH": {
      return recompute({
        ...core,
        health: action.health,
      });
    }

    case "SET_STATUS_PARTIAL": {
      const status = { ...core.status, ...action.patch };
      return recompute({
        ...core,
        status,
        health: deriveHealth(status),
      });
    }

    case "SET_VIEW": {
      return recompute({
        ...core,
        layout: {
          ...core.layout,
          currentView: action.view,
        },
      });
    }

    case "TOGGLE_LEFT_RAIL": {
      return recompute({
        ...core,
        layout: {
          ...core.layout,
          leftRailCollapsed: !core.layout.leftRailCollapsed,
        },
      });
    }

    case "TOGGLE_RIGHT_RAIL": {
      return recompute({
        ...core,
        layout: {
          ...core.layout,
          rightRailCollapsed: !core.layout.rightRailCollapsed,
        },
      });
    }

    case "TOGGLE_COMMAND_PALETTE": {
      return recompute({
        ...core,
        layout: {
          ...core.layout,
          commandPaletteOpen: action.open ?? !core.layout.commandPaletteOpen,
        },
      });
    }

    case "SET_COMMAND_PROMPT": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          prompt: action.prompt,
        },
      });
    }

    case "SET_COMMAND_TARGETS": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          targetPaths: uniqueSortedStrings(action.targetPaths),
        },
      });
    }

    case "SET_VERIFY_TARGETS": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          verifyTargets: uniqueSortedStrings(action.targetPaths),
        },
      });
    }

    case "SET_PATCH_BINDING": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          patchId: action.patchId,
          previewHash: action.previewHash,
          requestHash: action.requestHash,
        },
      });
    }

    case "SET_COMMAND_INTENT": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          lastIntent: action.intent,
        },
      });
    }

    case "SET_DIAGNOSTICS_EXPORT_REQUESTED": {
      return recompute({
        ...core,
        command: {
          ...core.command,
          diagnosticsExportRequested: action.requested,
        },
      });
    }

    case "SET_LOADING": {
      return recompute({
        ...core,
        refresh: {
          ...core.refresh,
          loading: action.loading,
          pendingReason: action.loading ? action.reason ?? core.refresh.pendingReason : null,
        },
      });
    }

    case "SET_LAST_REFRESH": {
      const atMs = nowMs(action.atMs);
      return recompute({
        ...core,
        refresh: {
          ...core.refresh,
          lastRefreshAtMs: atMs,
          lastSuccessfulRefreshAtMs: action.success === false ? core.refresh.lastSuccessfulRefreshAtMs : atMs,
          pendingReason: null,
        },
      });
    }

    case "SET_LAST_ERROR": {
      return recompute({
        ...core,
        errors: {
          lastError: action.error,
          errorCount: action.error ? core.errors.errorCount + 1 : core.errors.errorCount,
        },
      });
    }

    case "ADD_ACTIVITY": {
      return recompute({
        ...core,
        activities: [action.item, ...core.activities].slice(0, 300),
      });
    }

    case "ADD_TOAST": {
      return recompute({
        ...core,
        toasts: [action.toast, ...core.toasts].slice(0, 12),
      });
    }

    case "DISMISS_TOAST": {
      return recompute({
        ...core,
        toasts: core.toasts.filter((t) => t.id !== action.id),
      });
    }

    case "SELECT_ACTIVITY": {
      return recompute({
        ...core,
        layout: {
          ...core.layout,
          selectedActivityId: action.id,
        },
      });
    }

    case "RESET_COMMAND_COMPOSER": {
      return recompute({
        ...core,
        command: makeEmptyCommandState(),
      });
    }

    case "RESET_STATUS": {
      return recompute({
        ...core,
        status: makeEmptyStatus(),
        health: "unknown",
      });
    }

    case "RESET_APP": {
      return createInitialAppState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectBootstrapPhase: AppSelector<AppBootPhase> = (state) => state.bootstrap.phase;
export const selectAppHealth: AppSelector<AppHealth> = (state) => state.health;
export const selectCurrentView: AppSelector<AppView> = (state) => state.layout.currentView;
export const selectIsLoading: AppSelector<boolean> = (state) => state.refresh.loading;
export const selectCurrentPrompt: AppSelector<string> = (state) => state.command.prompt;
export const selectCurrentPatchBinding: AppSelector<Pick<CommandComposerState, "patchId" | "previewHash" | "requestHash">> = (state) => ({
  patchId: state.command.patchId,
  previewHash: state.command.previewHash,
  requestHash: state.command.requestHash,
});
export const selectCanAttemptApply: AppSelector<boolean> = (state) => {
  return (
    !!state.command.patchId &&
    !!state.command.previewHash &&
    !!state.command.requestHash &&
    state.health !== "unhealthy" &&
    state.bootstrap.phase !== "failed"
  );
};
export const selectToastCount: AppSelector<number> = (state) => state.toasts.length;
export const selectActivityCount: AppSelector<number> = (state) => state.activities.length;

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateAppState(state: AppState): void {
  if (state.schema !== 1) throw new Error("app_state_schema_invalid");

  const core: Omit<AppState, "appHash"> = {
    schema: state.schema,
    bootstrap: state.bootstrap,
    health: state.health,
    status: state.status,
    command: state.command,
    layout: state.layout,
    refresh: state.refresh,
    errors: state.errors,
    activities: state.activities,
    toasts: state.toasts,
  };

  if (state.appHash !== appStateHash(core)) {
    throw new Error("app_state_hash_drift");
  }

  if (![
    "overview",
    "workspace",
    "patch",
    "verify",
    "ledger",
    "agent",
    "diagnostics",
    "activity",
  ].includes(state.layout.currentView)) {
    throw new Error("app_state_invalid_view");
  }

  if (stableJson(uniqueSortedStrings(state.command.targetPaths)) !== stableJson(state.command.targetPaths)) {
    throw new Error("app_state_target_paths_not_normalized");
  }

  if (stableJson(uniqueSortedStrings(state.command.verifyTargets)) !== stableJson(state.command.verifyTargets)) {
    throw new Error("app_state_verify_targets_not_normalized");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyAppActions(initial: AppState, actions: AppAction[]): AppState {
  return actions.reduce(appReducer, initial);
}

export function serializeAppState(state: AppState): string {
  validateAppState(state);
  return stableJson(state);
}
