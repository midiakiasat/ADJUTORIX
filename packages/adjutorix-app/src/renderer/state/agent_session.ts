/**
 * ADJUTORIX APP — RENDERER / STATE / agent_session.ts
 *
 * Canonical renderer-side agent session state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for the Adjutorix agent session
 * - unify process status, auth posture, transport health, RPC readiness, reconnect churn,
 *   control intent, and user-visible session diagnostics under one deterministic reducer
 * - prevent drift between panels that each guess whether the agent is running, healthy,
 *   authenticated, reconnecting, degraded, or safe to use
 * - provide pure transitions suitable for replay, testing, diagnostics, and UI invariants
 *
 * Scope:
 * - agent lifecycle posture (stopped / starting / ready / degraded / reconnecting / failed)
 * - health, status, auth, and transport snapshots
 * - reconnect attempt history and policy-facing counters
 * - user-issued control intents and last command outcomes
 * - session timestamps and freshness markers
 * - capability readiness for query / verify / patch / diagnostics workflows
 *
 * Non-scope:
 * - direct process management
 * - direct HTTP/RPC invocation
 * - reconnect timer implementation
 *
 * Hard invariants:
 * - all transitions are pure and deterministic
 * - identical prior state + identical action => identical next state hash
 * - fatal session states dominate weaker optimistic flags
 * - reconnecting state cannot coexist with a fully ready state silently
 * - capability readiness is derived from explicit state, never ad hoc booleans
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

export type AgentSessionPhase =
  | "idle"
  | "starting"
  | "ready"
  | "degraded"
  | "reconnecting"
  | "stopped"
  | "failed";

export type AgentHealthLevel = "healthy" | "degraded" | "unhealthy" | "offline" | "unknown";
export type AgentAuthState = "uninitialized" | "ready" | "missing" | "empty" | "invalid" | "unreadable" | "error" | "unknown";
export type AgentTransportState = "idle" | "ready" | "degraded" | "error" | "unknown";
export type AgentControlIntent = "start" | "stop" | "restart" | "refresh" | "none";
export type AgentCommandOutcome = "success" | "failure" | "pending" | "none";
export type AgentFailureKind =
  | "transport"
  | "timeout"
  | "http"
  | "auth"
  | "protocol"
  | "rpc"
  | "invalid-response"
  | "process-exit"
  | "probe"
  | "manual"
  | "unknown";

export type AgentReconnectRecord = {
  attempt: number;
  triggerKind: AgentFailureKind;
  startedAtMs: number;
  endedAtMs: number | null;
  success: boolean;
  authRefreshTried: boolean;
  processRestartTried: boolean;
  message: string;
};

export type AgentCapabilityReadiness = {
  query: boolean;
  status: boolean;
  verify: boolean;
  patchPreview: boolean;
  patchApply: boolean;
  diagnostics: boolean;
};

export type AgentSnapshots = {
  health: JsonObject | null;
  status: JsonObject | null;
  auth: JsonObject | null;
  reconnect: JsonObject | null;
  transport: JsonObject | null;
  diagnostics: JsonObject | null;
};

export type AgentControlState = {
  intent: AgentControlIntent;
  lastCommand: AgentControlIntent;
  lastOutcome: AgentCommandOutcome;
  lastCommandAtMs: number | null;
  lastOutcomeAtMs: number | null;
  lastMessage: string | null;
};

export type AgentSessionState = {
  schema: 1;
  phase: AgentSessionPhase;
  healthLevel: AgentHealthLevel;
  authState: AgentAuthState;
  transportState: AgentTransportState;
  processPid: number | null;
  online: boolean;
  usable: boolean;
  reconnecting: boolean;
  restartCount: number;
  consecutiveFailures: number;
  consecutiveAuthFailures: number;
  lastSuccessAtMs: number | null;
  lastFailureAtMs: number | null;
  lastProbeAtMs: number | null;
  capabilityReadiness: AgentCapabilityReadiness;
  snapshots: AgentSnapshots;
  control: AgentControlState;
  reconnectHistory: AgentReconnectRecord[];
  lastError: string | null;
  lastEventAtMs: number | null;
  hash: string;
};

export type AgentSessionAction =
  | { type: "AGENT_START_REQUESTED"; atMs?: number; message?: string }
  | { type: "AGENT_START_SUCCEEDED"; status?: JsonObject | null; atMs?: number; message?: string }
  | { type: "AGENT_START_FAILED"; error: string; atMs?: number }
  | { type: "AGENT_STOP_REQUESTED"; atMs?: number; message?: string }
  | { type: "AGENT_STOP_SUCCEEDED"; status?: JsonObject | null; atMs?: number; message?: string }
  | { type: "AGENT_STOP_FAILED"; error: string; atMs?: number }
  | { type: "AGENT_RESTART_REQUESTED"; atMs?: number; message?: string }
  | { type: "AGENT_HEALTH_UPDATED"; health: JsonObject | null; atMs?: number }
  | { type: "AGENT_STATUS_UPDATED"; status: JsonObject | null; atMs?: number }
  | { type: "AGENT_AUTH_UPDATED"; auth: JsonObject | null; atMs?: number }
  | { type: "AGENT_TRANSPORT_UPDATED"; transport: JsonObject | null; atMs?: number }
  | { type: "AGENT_DIAGNOSTICS_UPDATED"; diagnostics: JsonObject | null; atMs?: number }
  | { type: "AGENT_RECONNECT_SCHEDULED"; reconnect: JsonObject | null; atMs?: number }
  | { type: "AGENT_RECONNECT_ATTEMPT_RECORDED"; record: AgentReconnectRecord; atMs?: number }
  | { type: "AGENT_RECONNECT_RESET" }
  | { type: "AGENT_FAILURE_RECORDED"; kind: AgentFailureKind; error: string; atMs?: number }
  | { type: "AGENT_RECOVERY_RECORDED"; atMs?: number }
  | { type: "AGENT_PROBE_RECORDED"; ok: boolean; atMs?: number }
  | { type: "AGENT_CONTROL_INTENT_SET"; intent: AgentControlIntent; atMs?: number; message?: string }
  | { type: "AGENT_CONTROL_OUTCOME_SET"; outcome: AgentCommandOutcome; atMs?: number; message?: string }
  | { type: "AGENT_ERROR_CLEARED" }
  | { type: "AGENT_SESSION_RESET" };

export type AgentSessionSelector<T> = (state: AgentSessionState) => T;

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

function computeStateHash(core: Omit<AgentSessionState, "hash">): string {
  return hashString(stableJson(core));
}

function asObject(value: unknown): JsonObject | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return JSON.parse(stableJson(value)) as JsonObject;
}

function boolFromSnapshot(snapshot: JsonObject | null, key: string, fallback = false): boolean {
  return typeof snapshot?.[key] === "boolean" ? (snapshot[key] as boolean) : fallback;
}

function stringFromSnapshot<T extends string>(snapshot: JsonObject | null, key: string, allowed: readonly T[], fallback: T): T {
  const value = snapshot?.[key];
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

function numberFromSnapshot(snapshot: JsonObject | null, key: string, fallback: number | null = null): number | null {
  const value = snapshot?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function deriveHealthLevel(health: JsonObject | null): AgentHealthLevel {
  return stringFromSnapshot(health, "level", ["healthy", "degraded", "unhealthy", "offline", "unknown"] as const, "unknown");
}

function deriveAuthState(auth: JsonObject | null): AgentAuthState {
  return stringFromSnapshot(
    auth,
    "state",
    ["uninitialized", "ready", "missing", "empty", "invalid", "unreadable", "error", "unknown"] as const,
    "unknown",
  );
}

function deriveTransportState(transport: JsonObject | null): AgentTransportState {
  return stringFromSnapshot(transport, "health", ["idle", "ready", "degraded", "error", "unknown"] as const, "unknown");
}

function derivePhase(
  healthLevel: AgentHealthLevel,
  transportState: AgentTransportState,
  authState: AgentAuthState,
  online: boolean,
  reconnecting: boolean,
  lastError: string | null,
  controlIntent: AgentControlIntent,
): AgentSessionPhase {
  if (controlIntent === "start" && !online) return "starting";
  if (controlIntent === "stop" && !online) return "stopped";
  if (reconnecting) return "reconnecting";
  if (!online && !lastError) return "idle";
  if (!online && lastError) return "failed";
  if (healthLevel === "healthy" && transportState === "ready" && authState === "ready") return "ready";
  if (healthLevel === "degraded" || transportState === "degraded") return "degraded";
  if (healthLevel === "unhealthy" || transportState === "error" || authState === "error") return "failed";
  return online ? "degraded" : "idle";
}

function deriveCapabilityReadiness(
  phase: AgentSessionPhase,
  healthLevel: AgentHealthLevel,
  authState: AgentAuthState,
  transportState: AgentTransportState,
): AgentCapabilityReadiness {
  const processReady = phase === "ready" || phase === "degraded";
  const authReady = authState === "ready";
  const transportReady = transportState === "ready" || transportState === "degraded";
  const healthyEnough = healthLevel === "healthy" || healthLevel === "degraded";

  return {
    query: processReady && authReady && transportReady,
    status: processReady && transportReady,
    verify: processReady && authReady && transportReady && healthyEnough,
    patchPreview: processReady && authReady && transportReady && healthyEnough,
    patchApply: phase === "ready" && authReady && transportState === "ready" && healthLevel === "healthy",
    diagnostics: processReady && transportReady,
  };
}

function recompute(state: Omit<AgentSessionState, "hash">): AgentSessionState {
  return {
    ...state,
    hash: computeStateHash(state),
  };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialAgentSessionState(): AgentSessionState {
  const core: Omit<AgentSessionState, "hash"> = {
    schema: 1,
    phase: "idle",
    healthLevel: "unknown",
    authState: "unknown",
    transportState: "unknown",
    processPid: null,
    online: false,
    usable: false,
    reconnecting: false,
    restartCount: 0,
    consecutiveFailures: 0,
    consecutiveAuthFailures: 0,
    lastSuccessAtMs: null,
    lastFailureAtMs: null,
    lastProbeAtMs: null,
    capabilityReadiness: {
      query: false,
      status: false,
      verify: false,
      patchPreview: false,
      patchApply: false,
      diagnostics: false,
    },
    snapshots: {
      health: null,
      status: null,
      auth: null,
      reconnect: null,
      transport: null,
      diagnostics: null,
    },
    control: {
      intent: "none",
      lastCommand: "none",
      lastOutcome: "none",
      lastCommandAtMs: null,
      lastOutcomeAtMs: null,
      lastMessage: null,
    },
    reconnectHistory: [],
    lastError: null,
    lastEventAtMs: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function agentSessionReducer(state: AgentSessionState, action: AgentSessionAction): AgentSessionState {
  const core: Omit<AgentSessionState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    healthLevel: state.healthLevel,
    authState: state.authState,
    transportState: state.transportState,
    processPid: state.processPid,
    online: state.online,
    usable: state.usable,
    reconnecting: state.reconnecting,
    restartCount: state.restartCount,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveAuthFailures: state.consecutiveAuthFailures,
    lastSuccessAtMs: state.lastSuccessAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastProbeAtMs: state.lastProbeAtMs,
    capabilityReadiness: state.capabilityReadiness,
    snapshots: { ...state.snapshots },
    control: { ...state.control },
    reconnectHistory: [...state.reconnectHistory],
    lastError: state.lastError,
    lastEventAtMs: state.lastEventAtMs,
  };

  switch (action.type) {
    case "AGENT_START_REQUESTED": {
      core.control.intent = "start";
      core.control.lastCommand = "start";
      core.control.lastOutcome = "pending";
      core.control.lastCommandAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? "Start requested.";
      core.phase = "starting";
      core.lastEventAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "AGENT_START_SUCCEEDED": {
      const status = asObject(action.status);
      core.snapshots.status = status ?? core.snapshots.status;
      core.online = true;
      core.processPid = numberFromSnapshot(status, "pid", core.processPid);
      core.control.intent = "none";
      core.control.lastCommand = "start";
      core.control.lastOutcome = "success";
      core.control.lastOutcomeAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? "Start succeeded.";
      core.lastSuccessAtMs = nowMs(action.atMs);
      core.lastError = null;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_START_FAILED": {
      core.online = false;
      core.control.intent = "none";
      core.control.lastCommand = "start";
      core.control.lastOutcome = "failure";
      core.control.lastOutcomeAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.error;
      core.lastError = action.error;
      core.lastFailureAtMs = nowMs(action.atMs);
      core.consecutiveFailures += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_STOP_REQUESTED": {
      core.control.intent = "stop";
      core.control.lastCommand = "stop";
      core.control.lastOutcome = "pending";
      core.control.lastCommandAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? "Stop requested.";
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_STOP_SUCCEEDED": {
      core.snapshots.status = asObject(action.status) ?? core.snapshots.status;
      core.online = false;
      core.processPid = null;
      core.reconnecting = false;
      core.control.intent = "none";
      core.control.lastCommand = "stop";
      core.control.lastOutcome = "success";
      core.control.lastOutcomeAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? "Stop succeeded.";
      core.lastError = null;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_STOP_FAILED": {
      core.control.intent = "none";
      core.control.lastCommand = "stop";
      core.control.lastOutcome = "failure";
      core.control.lastOutcomeAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.error;
      core.lastError = action.error;
      core.lastFailureAtMs = nowMs(action.atMs);
      core.consecutiveFailures += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_RESTART_REQUESTED": {
      core.control.intent = "restart";
      core.control.lastCommand = "restart";
      core.control.lastOutcome = "pending";
      core.control.lastCommandAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? "Restart requested.";
      core.restartCount += 1;
      core.reconnecting = true;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_HEALTH_UPDATED": {
      core.snapshots.health = asObject(action.health);
      core.healthLevel = deriveHealthLevel(core.snapshots.health);
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_STATUS_UPDATED": {
      core.snapshots.status = asObject(action.status);
      core.processPid = numberFromSnapshot(core.snapshots.status, "pid", core.processPid);
      core.online = boolFromSnapshot(core.snapshots.status, "online", core.processPid !== null || core.online);
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_AUTH_UPDATED": {
      core.snapshots.auth = asObject(action.auth);
      core.authState = deriveAuthState(core.snapshots.auth);
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_TRANSPORT_UPDATED": {
      core.snapshots.transport = asObject(action.transport);
      core.transportState = deriveTransportState(core.snapshots.transport);
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_DIAGNOSTICS_UPDATED": {
      core.snapshots.diagnostics = asObject(action.diagnostics);
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_RECONNECT_SCHEDULED": {
      core.snapshots.reconnect = asObject(action.reconnect);
      core.reconnecting = true;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_RECONNECT_ATTEMPT_RECORDED": {
      core.reconnectHistory = [action.record, ...core.reconnectHistory].slice(0, 128);
      core.reconnecting = !action.record.success;
      if (action.record.success) {
        core.consecutiveFailures = 0;
        core.consecutiveAuthFailures = 0;
        core.lastSuccessAtMs = action.record.endedAtMs ?? nowMs(action.atMs);
        core.lastError = null;
      } else {
        core.consecutiveFailures += 1;
        if (action.record.authRefreshTried) core.consecutiveAuthFailures += 1;
        core.lastFailureAtMs = action.record.endedAtMs ?? nowMs(action.atMs);
        core.lastError = action.record.message;
      }
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_RECONNECT_RESET": {
      core.reconnecting = false;
      core.consecutiveFailures = 0;
      core.consecutiveAuthFailures = 0;
      core.snapshots.reconnect = null;
      core.lastEventAtMs = nowMs();
      break;
    }

    case "AGENT_FAILURE_RECORDED": {
      core.lastError = action.error;
      core.lastFailureAtMs = nowMs(action.atMs);
      core.consecutiveFailures += 1;
      if (action.kind === "auth") core.consecutiveAuthFailures += 1;
      if (action.kind === "process-exit" || action.kind === "probe" || action.kind === "transport" || action.kind === "timeout") {
        core.reconnecting = true;
      }
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_RECOVERY_RECORDED": {
      core.lastSuccessAtMs = nowMs(action.atMs);
      core.consecutiveFailures = 0;
      core.consecutiveAuthFailures = 0;
      core.reconnecting = false;
      core.lastError = null;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_PROBE_RECORDED": {
      core.lastProbeAtMs = nowMs(action.atMs);
      if (action.ok) {
        core.lastSuccessAtMs = nowMs(action.atMs);
      } else {
        core.lastFailureAtMs = nowMs(action.atMs);
      }
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_CONTROL_INTENT_SET": {
      core.control.intent = action.intent;
      core.control.lastCommand = action.intent;
      core.control.lastOutcome = action.intent === "none" ? core.control.lastOutcome : "pending";
      core.control.lastCommandAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? null;
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_CONTROL_OUTCOME_SET": {
      core.control.lastOutcome = action.outcome;
      core.control.lastOutcomeAtMs = nowMs(action.atMs);
      core.control.lastMessage = action.message ?? core.control.lastMessage;
      if (action.outcome !== "pending") core.control.intent = "none";
      core.lastEventAtMs = nowMs(action.atMs);
      break;
    }

    case "AGENT_ERROR_CLEARED": {
      core.lastError = null;
      core.lastEventAtMs = nowMs();
      break;
    }

    case "AGENT_SESSION_RESET": {
      return createInitialAgentSessionState();
    }

    default:
      return state;
  }

  core.phase = derivePhase(
    core.healthLevel,
    core.transportState,
    core.authState,
    core.online,
    core.reconnecting,
    core.lastError,
    core.control.intent,
  );
  core.capabilityReadiness = deriveCapabilityReadiness(core.phase, core.healthLevel, core.authState, core.transportState);
  core.usable = Object.values(core.capabilityReadiness).some(Boolean);

  return recompute(core);
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectAgentPhase: AgentSessionSelector<AgentSessionPhase> = (state) => state.phase;
export const selectAgentHealthLevel: AgentSessionSelector<AgentHealthLevel> = (state) => state.healthLevel;
export const selectAgentIsOnline: AgentSessionSelector<boolean> = (state) => state.online;
export const selectAgentIsUsable: AgentSessionSelector<boolean> = (state) => state.usable;
export const selectAgentCanPatchApply: AgentSessionSelector<boolean> = (state) => state.capabilityReadiness.patchApply;
export const selectAgentReconnectHistory: AgentSessionSelector<AgentReconnectRecord[]> = (state) => state.reconnectHistory;
export const selectAgentLastError: AgentSessionSelector<string | null> = (state) => state.lastError;

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateAgentSessionState(state: AgentSessionState): void {
  if (state.schema !== 1) throw new Error("agent_session_state_schema_invalid");

  const core: Omit<AgentSessionState, "hash"> = {
    schema: state.schema,
    phase: state.phase,
    healthLevel: state.healthLevel,
    authState: state.authState,
    transportState: state.transportState,
    processPid: state.processPid,
    online: state.online,
    usable: state.usable,
    reconnecting: state.reconnecting,
    restartCount: state.restartCount,
    consecutiveFailures: state.consecutiveFailures,
    consecutiveAuthFailures: state.consecutiveAuthFailures,
    lastSuccessAtMs: state.lastSuccessAtMs,
    lastFailureAtMs: state.lastFailureAtMs,
    lastProbeAtMs: state.lastProbeAtMs,
    capabilityReadiness: state.capabilityReadiness,
    snapshots: state.snapshots,
    control: state.control,
    reconnectHistory: state.reconnectHistory,
    lastError: state.lastError,
    lastEventAtMs: state.lastEventAtMs,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("agent_session_state_hash_drift");
  }

  if (state.phase === "ready" && state.reconnecting) {
    throw new Error("agent_session_ready_and_reconnecting_conflict");
  }

  if (!state.online && state.capabilityReadiness.patchApply) {
    throw new Error("agent_session_patch_apply_ready_while_offline");
  }

  if (state.authState !== "ready" && state.capabilityReadiness.patchApply) {
    throw new Error("agent_session_patch_apply_ready_without_auth");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyAgentSessionActions(initial: AgentSessionState, actions: AgentSessionAction[]): AgentSessionState {
  return actions.reduce(agentSessionReducer, initial);
}

export function serializeAgentSessionState(state: AgentSessionState): string {
  validateAgentSessionState(state);
  return stableJson(state);
}
