/**
 * ADJUTORIX APP — RENDERER / STATE / diagnostics_state.ts
 *
 * Canonical renderer-side diagnostics state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for diagnostics and observability state
 * - unify runtime diagnostics, startup reports, log tails, crash context, export workflow,
 *   observability bundles, and user navigation under one deterministic reducer
 * - prevent divergence between diagnostics panels that each guess which snapshot/log/export
 *   is current, complete, or safe to present
 * - provide pure transitions suitable for replay, testing, audit, and invariants
 *
 * Scope:
 * - runtime diagnostics snapshot
 * - startup report and crash context
 * - log-tail buffers and log selection state
 * - observability bundle metadata and readiness
 * - diagnostics export workflow and artifact tracking
 * - renderer-only filters and panel navigation state
 *
 * Non-scope:
 * - log collection implementation
 * - file export implementation
 * - main-process diagnostics generation
 *
 * Hard invariants:
 * - identical prior state + identical action => identical next state hash
 * - log entries are deterministic, bounded, and sequence-ordered per log stream
 * - export readiness is derived from explicit evidence, never guessed
 * - selected panel/log targets must refer to loaded state or reset cleanly
 * - crash/startup/runtime evidence remain plain JSON-safe data
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

export type DiagnosticsPhase = "idle" | "loading" | "ready" | "degraded" | "exporting" | "failed";
export type DiagnosticsHealth = "healthy" | "degraded" | "unhealthy" | "unknown";
export type DiagnosticsPanel = "overview" | "runtime" | "startup" | "observability" | "logs" | "crash" | "export";
export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type LogTarget = "main" | "observability" | "custom";
export type ExportPhase = "idle" | "requested" | "running" | "succeeded" | "failed";
export type DiagnosticsAttention = "none" | "low" | "medium" | "high" | "critical";

export type DiagnosticsRuntimeSnapshot = JsonObject | null;
export type DiagnosticsStartupReport = JsonObject | null;
export type DiagnosticsObservabilityBundle = JsonObject | null;
export type DiagnosticsCrashContext = JsonObject | null;

export type DiagnosticsLogEntry = {
  seq: number;
  target: LogTarget;
  level: LogLevel;
  message: string;
  atMs: number;
  hash: string;
};

export type DiagnosticsLogStream = {
  target: LogTarget;
  entries: DiagnosticsLogEntry[];
  truncated: boolean;
  requestedLines: number | null;
  requestedBytes: number | null;
  lastLoadedAtMs: number | null;
  hash: string;
};

export type DiagnosticsExportState = {
  phase: ExportPhase;
  includeRuntimeSnapshot: boolean;
  includeStartupReport: boolean;
  includeObservability: boolean;
  includeLogTail: boolean;
  includeCrashContext: boolean;
  logTailLines: number;
  promptForPath: boolean;
  artifactPath: string | null;
  artifactMeta: JsonObject | null;
  requestedAtMs: number | null;
  finishedAtMs: number | null;
  lastError: string | null;
};

export type DiagnosticsNavigationState = {
  panel: DiagnosticsPanel;
  selectedLogTarget: LogTarget;
  selectedLogSeq: number | null;
  filterQuery: string;
  levelFilter: LogLevel[];
  showOnlyErrors: boolean;
};

export type DiagnosticsEvidence = {
  runtime: DiagnosticsRuntimeSnapshot;
  startup: DiagnosticsStartupReport;
  observability: DiagnosticsObservabilityBundle;
  crash: DiagnosticsCrashContext;
  diagnosticsBundleMeta: JsonObject | null;
};

export type DiagnosticsState = {
  schema: 1;
  phase: DiagnosticsPhase;
  health: DiagnosticsHealth;
  attention: DiagnosticsAttention;
  evidence: DiagnosticsEvidence;
  logsByTarget: Record<LogTarget, DiagnosticsLogStream>;
  navigation: DiagnosticsNavigationState;
  exportState: DiagnosticsExportState;
  lastHydratedAtMs: number | null;
  lastError: string | null;
  hash: string;
};

export type DiagnosticsLogInput = {
  seq: number;
  target: LogTarget;
  level?: LogLevel;
  message: string;
  atMs?: number;
};

export type DiagnosticsExportRequest = {
  includeRuntimeSnapshot?: boolean;
  includeStartupReport?: boolean;
  includeObservability?: boolean;
  includeLogTail?: boolean;
  includeCrashContext?: boolean;
  logTailLines?: number;
  promptForPath?: boolean;
  requestedAtMs?: number;
};

export type DiagnosticsStateAction =
  | { type: "DIAGNOSTICS_LOAD_REQUESTED" }
  | { type: "DIAGNOSTICS_RUNTIME_BOUND"; runtime: JsonObject | null; atMs?: number }
  | { type: "DIAGNOSTICS_STARTUP_BOUND"; startup: JsonObject | null; atMs?: number }
  | { type: "DIAGNOSTICS_OBSERVABILITY_BOUND"; observability: JsonObject | null; atMs?: number }
  | { type: "DIAGNOSTICS_CRASH_BOUND"; crash: JsonObject | null; atMs?: number }
  | { type: "DIAGNOSTICS_LOG_TAIL_REPLACED"; target: LogTarget; entries: DiagnosticsLogInput[]; requestedLines?: number | null; requestedBytes?: number | null; truncated?: boolean; atMs?: number }
  | { type: "DIAGNOSTICS_LOG_APPENDED"; entry: DiagnosticsLogInput }
  | { type: "DIAGNOSTICS_PANEL_SET"; panel: DiagnosticsPanel }
  | { type: "DIAGNOSTICS_LOG_TARGET_SET"; target: LogTarget }
  | { type: "DIAGNOSTICS_LOG_SELECTED"; seq: number | null }
  | { type: "DIAGNOSTICS_FILTER_QUERY_SET"; query: string }
  | { type: "DIAGNOSTICS_LEVEL_FILTER_SET"; levels: LogLevel[] }
  | { type: "DIAGNOSTICS_SHOW_ONLY_ERRORS_SET"; enabled: boolean }
  | { type: "DIAGNOSTICS_EXPORT_REQUESTED"; request: DiagnosticsExportRequest }
  | { type: "DIAGNOSTICS_EXPORT_RUNNING"; atMs?: number }
  | { type: "DIAGNOSTICS_EXPORT_SUCCEEDED"; artifactPath?: string | null; artifactMeta?: JsonObject | null; diagnosticsBundleMeta?: JsonObject | null; atMs?: number }
  | { type: "DIAGNOSTICS_EXPORT_FAILED"; error: string; atMs?: number }
  | { type: "DIAGNOSTICS_ERROR_SET"; error: string | null }
  | { type: "DIAGNOSTICS_RESET" };

export type DiagnosticsSelector<T> = (state: DiagnosticsState) => T;

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

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(stableJson(value)) as JsonObject;
}

function uniqueSortedLevels(levels: LogLevel[]): LogLevel[] {
  return [...new Set(levels)].sort((a, b) => a.localeCompare(b));
}

function levelRank(level: LogLevel): number {
  return { trace: 0, debug: 1, info: 2, warn: 3, error: 4, fatal: 5 }[level];
}

function deriveHealth(runtime: JsonObject | null, startup: JsonObject | null, crash: JsonObject | null, lastError: string | null): DiagnosticsHealth {
  if (lastError) return "unhealthy";
  const runtimeLevel = typeof runtime?.level === "string" ? runtime.level : null;
  const startupLevel = typeof startup?.level === "string" ? startup.level : null;
  const crashPresent = !!crash;
  if (runtimeLevel === "unhealthy" || startupLevel === "unhealthy" || crashPresent) return "unhealthy";
  if (runtimeLevel === "degraded" || startupLevel === "degraded") return "degraded";
  if (runtimeLevel === "healthy" || startupLevel === "healthy") return "healthy";
  return "unknown";
}

function deriveAttention(state: Omit<DiagnosticsState, "hash">): DiagnosticsAttention {
  if (state.lastError || state.exportState.phase === "failed") return "critical";
  if (state.evidence.crash) return "high";
  const allLogs = Object.values(state.logsByTarget).flatMap((s) => s.entries);
  const maxLevel = allLogs.reduce((m, entry) => Math.max(m, levelRank(entry.level)), 0);
  if (maxLevel >= levelRank("fatal")) return "critical";
  if (maxLevel >= levelRank("error")) return "high";
  if (maxLevel >= levelRank("warn")) return "medium";
  if (state.evidence.observability) return "low";
  return "none";
}

function makeLogEntry(input: DiagnosticsLogInput): DiagnosticsLogEntry {
  const core: Omit<DiagnosticsLogEntry, "hash"> = {
    seq: input.seq,
    target: input.target,
    level: input.level ?? "info",
    message: input.message,
    atMs: nowMs(input.atMs),
  };
  return { ...core, hash: hashString(stableJson(core)) };
}

function computeStreamHash(core: Omit<DiagnosticsLogStream, "hash">): string {
  return hashString(stableJson(core));
}

function withLogStream(stream: DiagnosticsLogStream, patch: Partial<Omit<DiagnosticsLogStream, "hash">>): DiagnosticsLogStream {
  const core: Omit<DiagnosticsLogStream, "hash"> = {
    target: patch.target ?? stream.target,
    entries: patch.entries ?? stream.entries,
    truncated: patch.truncated ?? stream.truncated,
    requestedLines: patch.requestedLines ?? stream.requestedLines,
    requestedBytes: patch.requestedBytes ?? stream.requestedBytes,
    lastLoadedAtMs: patch.lastLoadedAtMs ?? stream.lastLoadedAtMs,
  };
  return { ...core, hash: computeStreamHash(core) };
}

function makeEmptyStream(target: LogTarget): DiagnosticsLogStream {
  const core: Omit<DiagnosticsLogStream, "hash"> = {
    target,
    entries: [],
    truncated: false,
    requestedLines: null,
    requestedBytes: null,
    lastLoadedAtMs: null,
  };
  return { ...core, hash: computeStreamHash(core) };
}

function computeStateHash(core: Omit<DiagnosticsState, "hash">): string {
  return hashString(stableJson(core));
}

function recompute(state: Omit<DiagnosticsState, "hash">): DiagnosticsState {
  const next: Omit<DiagnosticsState, "hash"> = {
    ...state,
    health: deriveHealth(state.evidence.runtime, state.evidence.startup, state.evidence.crash, state.lastError),
    attention: deriveAttention(state),
  };
  return { ...next, hash: computeStateHash(next) };
}

function exportReady(state: Omit<DiagnosticsState, "hash">): boolean {
  return (
    (!!state.evidence.runtime || !!state.evidence.startup || !!state.evidence.observability || !!state.evidence.crash || Object.values(state.logsByTarget).some((s) => s.entries.length > 0)) &&
    state.exportState.phase !== "running"
  );
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialDiagnosticsState(): DiagnosticsState {
  const core: Omit<DiagnosticsState, "hash"> = {
    schema: 1,
    phase: "idle",
    health: "unknown",
    attention: "none",
    evidence: {
      runtime: null,
      startup: null,
      observability: null,
      crash: null,
      diagnosticsBundleMeta: null,
    },
    logsByTarget: {
      main: makeEmptyStream("main"),
      observability: makeEmptyStream("observability"),
      custom: makeEmptyStream("custom"),
    },
    navigation: {
      panel: "overview",
      selectedLogTarget: "main",
      selectedLogSeq: null,
      filterQuery: "",
      levelFilter: [],
      showOnlyErrors: false,
    },
    exportState: {
      phase: "idle",
      includeRuntimeSnapshot: true,
      includeStartupReport: true,
      includeObservability: true,
      includeLogTail: true,
      includeCrashContext: true,
      logTailLines: 200,
      promptForPath: true,
      artifactPath: null,
      artifactMeta: null,
      requestedAtMs: null,
      finishedAtMs: null,
      lastError: null,
    },
    lastHydratedAtMs: null,
    lastError: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function diagnosticsStateReducer(state: DiagnosticsState, action: DiagnosticsStateAction): DiagnosticsState {
  const core: Omit<DiagnosticsState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    health: state.health,
    attention: state.attention,
    evidence: { ...state.evidence },
    logsByTarget: {
      main: state.logsByTarget.main,
      observability: state.logsByTarget.observability,
      custom: state.logsByTarget.custom,
    },
    navigation: {
      ...state.navigation,
      levelFilter: [...state.navigation.levelFilter],
    },
    exportState: { ...state.exportState },
    lastHydratedAtMs: state.lastHydratedAtMs,
    lastError: state.lastError,
  };

  switch (action.type) {
    case "DIAGNOSTICS_LOAD_REQUESTED": {
      core.phase = "loading";
      core.lastError = null;
      return recompute(core);
    }

    case "DIAGNOSTICS_RUNTIME_BOUND": {
      core.evidence.runtime = action.runtime;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "DIAGNOSTICS_STARTUP_BOUND": {
      core.evidence.startup = action.startup;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "DIAGNOSTICS_OBSERVABILITY_BOUND": {
      core.evidence.observability = action.observability;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "DIAGNOSTICS_CRASH_BOUND": {
      core.evidence.crash = action.crash;
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "DIAGNOSTICS_LOG_TAIL_REPLACED": {
      const entries = action.entries.map(makeLogEntry).sort((a, b) => a.seq - b.seq).slice(-1000);
      core.logsByTarget[action.target] = withLogStream(core.logsByTarget[action.target], {
        entries,
        requestedLines: action.requestedLines ?? null,
        requestedBytes: action.requestedBytes ?? null,
        truncated: action.truncated ?? false,
        lastLoadedAtMs: nowMs(action.atMs),
      });
      if (core.navigation.selectedLogTarget === action.target && !entries.find((e) => e.seq === core.navigation.selectedLogSeq)) {
        core.navigation.selectedLogSeq = entries[entries.length - 1]?.seq ?? null;
      }
      core.lastHydratedAtMs = nowMs(action.atMs);
      core.phase = "ready";
      return recompute(core);
    }

    case "DIAGNOSTICS_LOG_APPENDED": {
      const next = makeLogEntry(action.entry);
      const stream = core.logsByTarget[next.target];
      const entries = [...stream.entries.filter((e) => e.seq !== next.seq), next].sort((a, b) => a.seq - b.seq).slice(-1000);
      core.logsByTarget[next.target] = withLogStream(stream, {
        entries,
        lastLoadedAtMs: next.atMs,
      });
      if (core.navigation.selectedLogTarget === next.target) {
        core.navigation.selectedLogSeq = next.seq;
      }
      return recompute(core);
    }

    case "DIAGNOSTICS_PANEL_SET": {
      core.navigation.panel = action.panel;
      return recompute(core);
    }

    case "DIAGNOSTICS_LOG_TARGET_SET": {
      core.navigation.selectedLogTarget = action.target;
      core.navigation.selectedLogSeq = core.logsByTarget[action.target].entries.at(-1)?.seq ?? null;
      return recompute(core);
    }

    case "DIAGNOSTICS_LOG_SELECTED": {
      const stream = core.logsByTarget[core.navigation.selectedLogTarget];
      core.navigation.selectedLogSeq = action.seq && stream.entries.some((e) => e.seq === action.seq) ? action.seq : null;
      return recompute(core);
    }

    case "DIAGNOSTICS_FILTER_QUERY_SET": {
      core.navigation.filterQuery = action.query;
      return recompute(core);
    }

    case "DIAGNOSTICS_LEVEL_FILTER_SET": {
      core.navigation.levelFilter = uniqueSortedLevels(action.levels);
      return recompute(core);
    }

    case "DIAGNOSTICS_SHOW_ONLY_ERRORS_SET": {
      core.navigation.showOnlyErrors = action.enabled;
      return recompute(core);
    }

    case "DIAGNOSTICS_EXPORT_REQUESTED": {
      core.exportState = {
        ...core.exportState,
        phase: exportReady(core) ? "requested" : "failed",
        includeRuntimeSnapshot: action.request.includeRuntimeSnapshot ?? core.exportState.includeRuntimeSnapshot,
        includeStartupReport: action.request.includeStartupReport ?? core.exportState.includeStartupReport,
        includeObservability: action.request.includeObservability ?? core.exportState.includeObservability,
        includeLogTail: action.request.includeLogTail ?? core.exportState.includeLogTail,
        includeCrashContext: action.request.includeCrashContext ?? core.exportState.includeCrashContext,
        logTailLines: action.request.logTailLines ?? core.exportState.logTailLines,
        promptForPath: action.request.promptForPath ?? core.exportState.promptForPath,
        requestedAtMs: nowMs(action.request.requestedAtMs),
        finishedAtMs: null,
        lastError: exportReady(core) ? null : "diagnostics_export_not_ready",
      };
      core.phase = core.exportState.phase === "failed" ? "failed" : "exporting";
      core.lastError = core.exportState.lastError;
      return recompute(core);
    }

    case "DIAGNOSTICS_EXPORT_RUNNING": {
      core.exportState.phase = "running";
      core.exportState.requestedAtMs = core.exportState.requestedAtMs ?? nowMs(action.atMs);
      core.phase = "exporting";
      core.lastError = null;
      return recompute(core);
    }

    case "DIAGNOSTICS_EXPORT_SUCCEEDED": {
      core.exportState.phase = "succeeded";
      core.exportState.artifactPath = action.artifactPath ?? null;
      core.exportState.artifactMeta = action.artifactMeta ?? null;
      core.exportState.finishedAtMs = nowMs(action.atMs);
      core.exportState.lastError = null;
      core.evidence.diagnosticsBundleMeta = action.diagnosticsBundleMeta ?? core.evidence.diagnosticsBundleMeta;
      core.phase = "ready";
      core.lastError = null;
      core.lastHydratedAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "DIAGNOSTICS_EXPORT_FAILED": {
      core.exportState.phase = "failed";
      core.exportState.finishedAtMs = nowMs(action.atMs);
      core.exportState.lastError = action.error;
      core.phase = "failed";
      core.lastError = action.error;
      return recompute(core);
    }

    case "DIAGNOSTICS_ERROR_SET": {
      core.lastError = action.error;
      core.phase = action.error ? "failed" : core.phase === "failed" ? "degraded" : core.phase;
      return recompute(core);
    }

    case "DIAGNOSTICS_RESET": {
      return createInitialDiagnosticsState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectDiagnosticsPhase: DiagnosticsSelector<DiagnosticsPhase> = (state) => state.phase;
export const selectDiagnosticsHealth: DiagnosticsSelector<DiagnosticsHealth> = (state) => state.health;
export const selectCurrentLogStream: DiagnosticsSelector<DiagnosticsLogStream> = (state) => state.logsByTarget[state.navigation.selectedLogTarget];
export const selectSelectedLogEntry: DiagnosticsSelector<DiagnosticsLogEntry | null> = (state) => {
  const stream = state.logsByTarget[state.navigation.selectedLogTarget];
  return state.navigation.selectedLogSeq !== null ? stream.entries.find((e) => e.seq === state.navigation.selectedLogSeq) ?? null : null;
};
export const selectExportReady: DiagnosticsSelector<boolean> = (state) => exportReady({
  schema: state.schema,
  phase: state.phase,
  health: state.health,
  attention: state.attention,
  evidence: state.evidence,
  logsByTarget: state.logsByTarget,
  navigation: state.navigation,
  exportState: state.exportState,
  lastHydratedAtMs: state.lastHydratedAtMs,
  lastError: state.lastError,
});
export const selectFilteredLogEntries: DiagnosticsSelector<DiagnosticsLogEntry[]> = (state) => {
  const stream = selectCurrentLogStream(state);
  const q = state.navigation.filterQuery.trim().toLowerCase();
  return stream.entries.filter((entry) => {
    if (state.navigation.showOnlyErrors && levelRank(entry.level) < levelRank("error")) return false;
    if (state.navigation.levelFilter.length > 0 && !state.navigation.levelFilter.includes(entry.level)) return false;
    if (!q) return true;
    return entry.message.toLowerCase().includes(q);
  });
};

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateDiagnosticsLogEntry(entry: DiagnosticsLogEntry): void {
  const core: Omit<DiagnosticsLogEntry, "hash"> = {
    seq: entry.seq,
    target: entry.target,
    level: entry.level,
    message: entry.message,
    atMs: entry.atMs,
  };
  if (entry.hash !== hashString(stableJson(core))) {
    throw new Error(`diagnostics_log_entry_hash_drift:${entry.target}:${entry.seq}`);
  }
}

export function validateDiagnosticsLogStream(stream: DiagnosticsLogStream): void {
  const core: Omit<DiagnosticsLogStream, "hash"> = {
    target: stream.target,
    entries: stream.entries,
    truncated: stream.truncated,
    requestedLines: stream.requestedLines,
    requestedBytes: stream.requestedBytes,
    lastLoadedAtMs: stream.lastLoadedAtMs,
  };
  if (stream.hash !== computeStreamHash(core)) {
    throw new Error(`diagnostics_log_stream_hash_drift:${stream.target}`);
  }
  for (let i = 1; i < stream.entries.length; i += 1) {
    if (stream.entries[i - 1].seq > stream.entries[i].seq) throw new Error(`diagnostics_log_stream_unsorted:${stream.target}`);
  }
  stream.entries.forEach(validateDiagnosticsLogEntry);
}

export function validateDiagnosticsState(state: DiagnosticsState): void {
  if (state.schema !== 1) throw new Error("diagnostics_state_schema_invalid");

  const core: Omit<DiagnosticsState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    health: state.health,
    attention: state.attention,
    evidence: state.evidence,
    logsByTarget: state.logsByTarget,
    navigation: state.navigation,
    exportState: state.exportState,
    lastHydratedAtMs: state.lastHydratedAtMs,
    lastError: state.lastError,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("diagnostics_state_hash_drift");
  }

  validateDiagnosticsLogStream(state.logsByTarget.main);
  validateDiagnosticsLogStream(state.logsByTarget.observability);
  validateDiagnosticsLogStream(state.logsByTarget.custom);

  if (state.navigation.selectedLogSeq !== null) {
    const stream = state.logsByTarget[state.navigation.selectedLogTarget];
    if (!stream.entries.some((entry) => entry.seq === state.navigation.selectedLogSeq)) {
      throw new Error("diagnostics_state_selected_log_missing");
    }
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyDiagnosticsStateActions(initial: DiagnosticsState, actions: DiagnosticsStateAction[]): DiagnosticsState {
  return actions.reduce(diagnosticsStateReducer, initial);
}

export function serializeDiagnosticsState(state: DiagnosticsState): string {
  validateDiagnosticsState(state);
  return stableJson(state);
}
