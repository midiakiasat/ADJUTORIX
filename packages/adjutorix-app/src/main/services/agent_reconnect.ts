export type AgentReconnectLifecycle = "idle" | "reconnecting" | "failed" | "disposed";

export type AgentReconnectFailure = {
  code: string;
  message: string;
};

export type AgentReconnectState = {
  lifecycle: AgentReconnectLifecycle;
  generation: number;
  activeAttemptId: string | null;
  retryCount: number;
  connected: boolean;
  reconnecting: boolean;
  lastDisconnectAtMs: number | null;
  lastReconnectAtMs: number | null;
  lastFailure: AgentReconnectFailure | null;
  sessionId: string;
  endpoint: string;
  protocolVersion: string;
  authState: string;
};

export type AgentReconnectEvent = {
  type: string;
  state: AgentReconnectState;
  reason?: unknown;
  attemptId?: string | null;
  attempt?: number;
  error?: AgentReconnectFailure;
  identity?: unknown;
};

export type AgentReconnectEnvironment = {
  client: {
    connect: () => Promise<unknown> | unknown;
  };
  process?: {
    getState?: () => Partial<AgentReconnectState> | Record<string, unknown>;
    restart?: () => Promise<unknown> | unknown;
  };
  auth?: {
    refresh?: () => Promise<unknown> | unknown;
    invalidate?: () => Promise<unknown> | unknown;
  };
  policy?: Record<string, unknown>;
  sleep?: (ms: number) => Promise<unknown> | unknown;
  now?: () => number;
};

function cloneState(state: AgentReconnectState): AgentReconnectState {
  return {
    ...state,
    lastFailure: state.lastFailure ? { ...state.lastFailure } : null,
  };
}

function normalizeError(error: unknown): AgentReconnectFailure {
  if (error instanceof Error) {
    return {
      code: String((error as { code?: unknown }).code ?? error.name ?? "ERROR"),
      message: error.message,
    };
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;
    return {
      code: String(record.code ?? record.kind ?? record.name ?? "ERROR"),
      message: String(record.message ?? record.reason ?? error),
    };
  }

  return {
    code: "ERROR",
    message: String(error),
  };
}

function textOf(value: unknown): string {
  const parts: string[] = [];

  const collect = (item: unknown): void => {
    if (item == null) return;

    if (typeof item === "string") {
      parts.push(item);
      return;
    }

    if (item instanceof Error) {
      parts.push(item.message, String((item as { code?: unknown }).code ?? ""));
      return;
    }

    if (typeof item === "object") {
      const record = item as Record<string, unknown>;
      for (const key of ["reason", "message", "code", "kind", "name", "error", "cause"]) {
        collect(record[key]);
      }
      return;
    }

    parts.push(String(item));
  };

  collect(value);
  return parts.join(" ").toLowerCase();
}

function isUnauthorized(error: unknown): boolean {
  const raw = textOf(error);
  return raw.includes("401") || raw.includes("unauthorized") || raw.includes("auth");
}

function isProtocolMismatch(error: unknown): boolean {
  const raw = textOf(error);
  return raw.includes("protocol") || raw.includes("mismatch") || raw.includes("semantic");
}

function isRetryableTransport(error: unknown): boolean {
  const record = error as { retryable?: unknown };
  if (record?.retryable === false) return false;
  if (record?.retryable === true) return true;
  if (isUnauthorized(error) || isProtocolMismatch(error)) return false;

  const raw = textOf(error);
  return (
    raw.includes("transport") ||
    raw.includes("unavailable") ||
    raw.includes("timeout") ||
    raw.includes("timedout") ||
    raw.includes("network") ||
    raw.includes("socket") ||
    raw.includes("econn") ||
    raw.includes("refused") ||
    raw.includes("reset") ||
    raw.includes("probe") ||
    raw.includes("temporary")
  );
}

function numberFrom(...values: unknown[]): number | null {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
}

function booleanFrom(...values: unknown[]): boolean | null {
  for (const value of values) {
    if (typeof value === "boolean") return value;
  }
  return null;
}

function nestedBool(obj: Record<string, unknown>, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split(".")) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function normalizeConnectResult(raw: unknown): Record<string, unknown> {
  const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const identity =
    record.identity && typeof record.identity === "object"
      ? (record.identity as Record<string, unknown>)
      : record;

  return {
    ...identity,
    authState: record.authState ?? identity.authState,
    connectionState: record.connectionState,
    trustLevel: record.trustLevel,
  };
}

export function createAgentReconnect(environment: AgentReconnectEnvironment) {
  const listeners = new Set<(event: AgentReconnectEvent) => void>();
  let disposed = false;
  let activeRun = 0;
  let inflight: Promise<AgentReconnectState> | null = null;

  const initial = environment.process?.getState?.() ?? {};
  const now = (): number => numberFrom(environment.now?.()) ?? 1;

  const state: AgentReconnectState = {
    lifecycle: "idle",
    generation: numberFrom(initial.generation) ?? 0,
    activeAttemptId: null,
    retryCount: numberFrom(initial.retryCount) ?? 0,
    connected: Boolean(initial.connected ?? true),
    reconnecting: false,
    lastDisconnectAtMs: null,
    lastReconnectAtMs: null,
    lastFailure: null,
    sessionId: String(initial.sessionId ?? "agent-session-1"),
    endpoint: String(initial.endpoint ?? "http://127.0.0.1:8000/rpc"),
    protocolVersion: String(initial.protocolVersion ?? "1"),
    authState: String(initial.authState ?? "available"),
  };

  const policy = (): Record<string, unknown> => environment.policy ?? {};

  const maxRetries = (): number =>
    numberFrom(
      policy().maxRetries,
      policy().maxAttempts,
      policy().retryBudget,
      policy().retryLimit,
      policy().reconnectRetries,
    ) ?? 2;

  const backoffMs = (): number =>
    numberFrom(policy().backoffMs, policy().retryBackoffMs, policy().reconnectBackoffMs) ?? 0;

  const authRefreshAllowed = (): boolean =>
    booleanFrom(
      policy().authRefreshOnAuthFailure,
      policy().refreshAuthOnUnauthorized,
      policy().refreshAuth,
    ) !== false;

  const restartAllowed = (): boolean => {
    const explicit = booleanFrom(
      policy().allowProcessRestartRecovery,
      policy().restartProcessOnTransportFailure,
      policy().restartOnTransportFailure,
      policy().restartTransportFailures,
      nestedBool(policy(), "recovery.restartProcess"),
      nestedBool(policy(), "transportRecovery.restartProcess"),
      nestedBool(policy(), "processRestart.enabled"),
      nestedBool(policy(), "processRestart.allow"),
    );

    return explicit !== false;
  };

  const snapshot = (): AgentReconnectState => cloneState(state);

  const emit = (type: string, extra: Omit<AgentReconnectEvent, "type" | "state"> = {}): void => {
    const event: AgentReconnectEvent = { type, state: snapshot(), ...extra };
    for (const listener of listeners) listener(event);
  };

  const sleep = async (ms: number): Promise<void> => {
    if (typeof environment.sleep === "function") {
      await environment.sleep(ms);
      return;
    }
    if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
  };

  const applyIdentity = (identity: Record<string, unknown>, attempt: number): void => {
    state.lifecycle = "idle";
    state.connected = true;
    state.reconnecting = false;
    state.generation += 1;
    state.activeAttemptId = null;
    state.retryCount = attempt;
    state.lastReconnectAtMs = now();
    state.lastFailure = null;
    state.sessionId = String(identity.sessionId ?? state.sessionId);
    state.endpoint = String(identity.endpointLabel ?? identity.endpoint ?? state.endpoint);
    state.protocolVersion = String(identity.protocolVersion ?? state.protocolVersion);
    state.authState = String(identity.authState ?? state.authState);
  };

  const applyFailure = (error: unknown): void => {
    state.lifecycle = "failed";
    state.connected = false;
    state.reconnecting = false;
    state.activeAttemptId = null;
    state.lastFailure = normalizeError(error);
  };

  const runReconnect = async (reason: unknown, force: boolean): Promise<AgentReconnectState> => {
    if (disposed) throw new Error("agent_reconnect_disposed");
    if (inflight && !force) return inflight;

    const runId = ++activeRun;
    const attemptId = `agent-reconnect-${runId}`;

    state.lifecycle = "reconnecting";
    state.connected = false;
    state.reconnecting = true;
    state.retryCount = 0;
    state.activeAttemptId = attemptId;
    state.lastDisconnectAtMs = now();

    emit("agent-reconnect-started", { reason, attemptId });

    inflight = (async (): Promise<AgentReconnectState> => {
      let refreshedAuth = false;
      let restartedProcess = false;
      let lastError: unknown = null;

      for (let attempt = 0; attempt <= maxRetries(); attempt += 1) {
        if (disposed || runId !== activeRun) return snapshot();

        state.retryCount = attempt;
        emit("agent-reconnect-attempt", { reason, attemptId, attempt });

        try {
          const identity = normalizeConnectResult(await environment.client.connect());

          if (disposed || runId !== activeRun) return snapshot();

          applyIdentity(identity, attempt);
          emit("agent-reconnect-succeeded", { attemptId, attempt, identity });
          return snapshot();
        } catch (error) {
          if (disposed || runId !== activeRun) return snapshot();

          lastError = error;
          state.lastFailure = normalizeError(error);

          if (
            isUnauthorized(error) &&
            authRefreshAllowed() &&
            !refreshedAuth &&
            typeof environment.auth?.refresh === "function"
          ) {
            refreshedAuth = true;
            await environment.auth.refresh();
            continue;
          }

          if (
            isUnauthorized(error) &&
            refreshedAuth &&
            typeof environment.auth?.invalidate === "function"
          ) {
            await environment.auth.invalidate();
          }

          if (
            isRetryableTransport(error) &&
            !isProtocolMismatch(error) &&
            !restartedProcess &&
            restartAllowed() &&
            typeof environment.process?.restart === "function"
          ) {
            restartedProcess = true;
            await environment.process.restart();
            continue;
          }

          if (isRetryableTransport(error) && attempt < maxRetries()) {
            emit("agent-reconnect-retrying", {
              attemptId,
              attempt,
              error: normalizeError(error),
            });
            await sleep(backoffMs());
            continue;
          }

          applyFailure(error);
          emit("agent-reconnect-failed", {
            attemptId,
            attempt,
            error: normalizeError(error),
          });
          throw error instanceof Error ? error : new Error(String(error));
        }
      }

      applyFailure(lastError);
      emit("agent-reconnect-failed", {
        attemptId,
        error: normalizeError(lastError),
      });
      throw lastError instanceof Error ? lastError : new Error(String(lastError));
    })().finally(() => {
      if (runId === activeRun) inflight = null;
    });

    return inflight;
  };

  return {
    getState(): AgentReconnectState {
      return snapshot();
    },

    subscribe(listener: (event: AgentReconnectEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async onDisconnected(reason: unknown): Promise<AgentReconnectState> {
      return runReconnect(reason, false);
    },

    async forceReconnect(reason?: unknown): Promise<AgentReconnectState> {
      return runReconnect(reason ?? { kind: "manual" }, true);
    },

    dispose(): void {
      disposed = true;
      listeners.clear();
      state.lifecycle = "disposed";
      state.reconnecting = false;
      state.activeAttemptId = null;
    },
  };
}
