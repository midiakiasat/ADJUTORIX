import { useCallback, useEffect, useMemo, useRef, useState } from "react";

/**
 * ADJUTORIX APP — SRC / HOOKS / useAgent.ts
 *
 * Canonical governed agent-session hook.
 *
 * Purpose:
 * - provide one renderer-side, typed, memoized, event-driven surface for agent truth
 * - unify connectivity, auth posture, streaming state, messages, tool activity, job/session identity,
 *   reconnect lifecycle, send semantics, and provider health behind one hook
 * - prevent chat, jobs, provider status, terminal, and diagnostics surfaces from each inventing their
 *   own agent state store or websocket/request lifecycle
 *
 * Architectural role:
 * - pure React hook over caller-supplied provider functions
 * - no direct Electron/window/global assumptions
 * - no hidden singleton store, no implicit polling, no background mutation beyond explicit provider events
 * - all async transitions are explicit, cancellable, and sequence-guarded
 *
 * Hard invariants:
 * - identical provider results produce identical derived state
 * - stale async completions never overwrite newer state
 * - message/event ordering is stable and append-only unless explicitly replaced by snapshot
 * - reconnect and send transitions are explicit and independently visible
 * - provider subscription cleanup is deterministic
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AgentLoadState = "idle" | "connecting" | "ready" | "refreshing" | "error";
export type AgentConnectionState = "unknown" | "connecting" | "connected" | "degraded" | "disconnected" | "reconnecting" | "failed";
export type AgentAuthState = "unknown" | "available" | "missing" | "expired" | "invalid" | "not-required";
export type AgentTrustLevel = "unknown" | "untrusted" | "restricted" | "trusted";
export type AgentStreamState = "idle" | "streaming" | "paused" | "completed" | "failed";
export type AgentMessageRole = "user" | "assistant" | "system" | "tool";
export type AgentToolRunState = "idle" | "running" | "succeeded" | "failed";
export type AgentJobPhase = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "unknown";

export interface AgentHealth {
  level: "healthy" | "degraded" | "unhealthy" | "unknown";
  reasons: string[];
}

export interface AgentSessionIdentity {
  sessionId: string;
  providerLabel: string;
  modelLabel?: string | null;
  endpointLabel?: string | null;
}

export interface AgentMessage {
  id: string;
  role: AgentMessageRole;
  content: string;
  createdAtMs: number;
  streamState?: AgentStreamState;
  requestId?: string | null;
  toolName?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentToolActivity {
  id: string;
  toolName: string;
  state: AgentToolRunState;
  startedAtMs?: number | null;
  endedAtMs?: number | null;
  message?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentJobSummary {
  id: string;
  title: string;
  phase: AgentJobPhase;
  createdAtMs?: number | null;
  updatedAtMs?: number | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentSnapshot {
  identity: AgentSessionIdentity;
  connectionState: AgentConnectionState;
  authState: AgentAuthState;
  trustLevel: AgentTrustLevel;
  health?: AgentHealth;
  streamState?: AgentStreamState;
  messages: AgentMessage[];
  activeTools?: AgentToolActivity[];
  jobs?: AgentJobSummary[];
  pendingRequestCount?: number;
  metadata?: Record<string, unknown>;
}

export interface AgentDerivedState {
  totalMessages: number;
  totalAssistantMessages: number;
  totalUserMessages: number;
  totalToolMessages: number;
  activeToolCount: number;
  runningJobCount: number;
  lastMessage: AgentMessage | null;
  messagesById: Map<string, AgentMessage>;
  activeToolMap: Map<string, AgentToolActivity>;
  jobsById: Map<string, AgentJobSummary>;
}

export interface AgentEvent {
  type:
    | "agent-snapshot"
    | "agent-connected"
    | "agent-disconnected"
    | "agent-health"
    | "agent-message"
    | "agent-message-updated"
    | "agent-stream-state"
    | "agent-tool"
    | "agent-job"
    | "agent-auth";
  snapshot?: AgentSnapshot;
  message?: AgentMessage;
  tool?: AgentToolActivity;
  job?: AgentJobSummary;
  streamState?: AgentStreamState;
  connectionState?: AgentConnectionState;
  authState?: AgentAuthState;
  trustLevel?: AgentTrustLevel;
  health?: AgentHealth;
}

export interface AgentSendInput {
  content: string;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface AgentProvider {
  connect: () => Promise<AgentSnapshot>;
  refresh?: () => Promise<AgentSnapshot>;
  reconnect?: () => Promise<AgentSnapshot>;
  disconnect?: () => Promise<void>;
  sendMessage?: (input: AgentSendInput) => Promise<void>;
  subscribe?: (listener: (event: AgentEvent) => void) => () => void;
}

export interface UseAgentOptions {
  autoConnect?: boolean;
  provider: AgentProvider;
}

export interface UseAgentResult {
  state: AgentLoadState;
  snapshot: AgentSnapshot | null;
  derived: AgentDerivedState;
  error: Error | null;
  sendError: Error | null;
  isReady: boolean;
  isBusy: boolean;
  isSending: boolean;
  connect: () => Promise<void>;
  refresh: () => Promise<void>;
  reconnect: () => Promise<void>;
  disconnect: () => Promise<void>;
  sendMessage: (input: AgentSendInput) => Promise<void>;
  setSnapshot: (snapshot: AgentSnapshot | null) => void;
}

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function normalizeMessage(message: AgentMessage): AgentMessage {
  return {
    ...message,
    content: message.content ?? "",
    createdAtMs: Number.isFinite(message.createdAtMs) ? message.createdAtMs : Date.now(),
    streamState: message.streamState ?? "idle",
    metadata: { ...(message.metadata ?? {}) },
  };
}

function normalizeTool(tool: AgentToolActivity): AgentToolActivity {
  return {
    ...tool,
    state: tool.state ?? "idle",
    metadata: { ...(tool.metadata ?? {}) },
  };
}

function normalizeJob(job: AgentJobSummary): AgentJobSummary {
  return {
    ...job,
    phase: job.phase ?? "unknown",
    metadata: { ...(job.metadata ?? {}) },
  };
}

function normalizeSnapshot(snapshot: AgentSnapshot): AgentSnapshot {
  return {
    ...snapshot,
    connectionState: snapshot.connectionState ?? "unknown",
    authState: snapshot.authState ?? "unknown",
    trustLevel: snapshot.trustLevel ?? "unknown",
    health: snapshot.health ?? { level: "unknown", reasons: [] },
    streamState: snapshot.streamState ?? "idle",
    messages: (snapshot.messages ?? []).map(normalizeMessage).sort((a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
    activeTools: (snapshot.activeTools ?? []).map(normalizeTool).sort((a, b) => a.id.localeCompare(b.id)),
    jobs: (snapshot.jobs ?? []).map(normalizeJob).sort((a, b) => a.id.localeCompare(b.id)),
    pendingRequestCount: snapshot.pendingRequestCount ?? 0,
    metadata: { ...(snapshot.metadata ?? {}) },
  };
}

function buildDerived(snapshot: AgentSnapshot | null): AgentDerivedState {
  if (!snapshot) {
    return {
      totalMessages: 0,
      totalAssistantMessages: 0,
      totalUserMessages: 0,
      totalToolMessages: 0,
      activeToolCount: 0,
      runningJobCount: 0,
      lastMessage: null,
      messagesById: new Map<string, AgentMessage>(),
      activeToolMap: new Map<string, AgentToolActivity>(),
      jobsById: new Map<string, AgentJobSummary>(),
    };
  }

  const messagesById = new Map<string, AgentMessage>();
  for (const message of snapshot.messages) messagesById.set(message.id, message);

  const activeToolMap = new Map<string, AgentToolActivity>();
  for (const tool of snapshot.activeTools ?? []) activeToolMap.set(tool.id, tool);

  const jobsById = new Map<string, AgentJobSummary>();
  for (const job of snapshot.jobs ?? []) jobsById.set(job.id, job);

  return {
    totalMessages: snapshot.messages.length,
    totalAssistantMessages: snapshot.messages.filter((item) => item.role === "assistant").length,
    totalUserMessages: snapshot.messages.filter((item) => item.role === "user").length,
    totalToolMessages: snapshot.messages.filter((item) => item.role === "tool").length,
    activeToolCount: (snapshot.activeTools ?? []).filter((item) => item.state === "running").length,
    runningJobCount: (snapshot.jobs ?? []).filter((item) => item.phase === "running").length,
    lastMessage: snapshot.messages[snapshot.messages.length - 1] ?? null,
    messagesById,
    activeToolMap,
    jobsById,
  };
}

function upsertById<T extends { id: string }>(items: T[], next: T, sortFn?: (a: T, b: T) => number): T[] {
  const idx = items.findIndex((item) => item.id === next.id);
  const merged = idx >= 0
    ? [...items.slice(0, idx), next, ...items.slice(idx + 1)]
    : [...items, next];
  return sortFn ? [...merged].sort(sortFn) : merged;
}

function applyAgentEvent(previous: AgentSnapshot | null, event: AgentEvent): AgentSnapshot | null {
  if (event.snapshot) {
    return normalizeSnapshot(event.snapshot);
  }

  if (!previous) return previous;

  switch (event.type) {
    case "agent-connected":
    case "agent-disconnected":
      return {
        ...previous,
        connectionState: event.connectionState ?? previous.connectionState,
      };
    case "agent-health":
      return {
        ...previous,
        health: event.health ?? previous.health,
        connectionState: event.connectionState ?? previous.connectionState,
      };
    case "agent-auth":
      return {
        ...previous,
        authState: event.authState ?? previous.authState,
        trustLevel: event.trustLevel ?? previous.trustLevel,
      };
    case "agent-stream-state":
      return {
        ...previous,
        streamState: event.streamState ?? previous.streamState,
      };
    case "agent-message": {
      if (!event.message) return previous;
      const nextMessage = normalizeMessage(event.message);
      return {
        ...previous,
        messages: upsertById(previous.messages, nextMessage, (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
      };
    }
    case "agent-message-updated": {
      if (!event.message) return previous;
      const nextMessage = normalizeMessage(event.message);
      return {
        ...previous,
        messages: upsertById(previous.messages, nextMessage, (a, b) => a.createdAtMs - b.createdAtMs || a.id.localeCompare(b.id)),
      };
    }
    case "agent-tool": {
      if (!event.tool) return previous;
      const nextTool = normalizeTool(event.tool);
      return {
        ...previous,
        activeTools: upsertById(previous.activeTools ?? [], nextTool, (a, b) => a.id.localeCompare(b.id)),
      };
    }
    case "agent-job": {
      if (!event.job) return previous;
      const nextJob = normalizeJob(event.job);
      return {
        ...previous,
        jobs: upsertById(previous.jobs ?? [], nextJob, (a, b) => a.id.localeCompare(b.id)),
      };
    }
    default:
      return previous;
  }
}

// -----------------------------------------------------------------------------
// HOOK
// -----------------------------------------------------------------------------

export function useAgent(options: UseAgentOptions): UseAgentResult {
  const { provider, autoConnect = true } = options;

  const [state, setState] = useState<AgentLoadState>(autoConnect ? "connecting" : "idle");
  const [snapshot, setSnapshotState] = useState<AgentSnapshot | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [sendError, setSendError] = useState<Error | null>(null);
  const [isSending, setIsSending] = useState(false);

  const requestSeqRef = useRef(0);
  const sendSeqRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSnapshot = useCallback((next: AgentSnapshot | null) => {
    if (!mountedRef.current) return;
    setSnapshotState(next ? normalizeSnapshot(next) : null);
  }, []);

  const runConnectLike = useCallback(
    async (mode: "connect" | "refresh" | "reconnect") => {
      const requestId = ++requestSeqRef.current;
      setError(null);
      setState((current) => {
        if (mode === "refresh" && (current === "ready" || current === "refreshing")) return "refreshing";
        if (mode === "reconnect") return "connecting";
        return "connecting";
      });

      try {
        const next = mode === "refresh" && provider.refresh
          ? await provider.refresh()
          : mode === "reconnect" && provider.reconnect
            ? await provider.reconnect()
            : await provider.connect();

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

  const connect = useCallback(async () => {
    await runConnectLike("connect");
  }, [runConnectLike]);

  const refresh = useCallback(async () => {
    await runConnectLike("refresh");
  }, [runConnectLike]);

  const reconnect = useCallback(async () => {
    await runConnectLike("reconnect");
  }, [runConnectLike]);

  const disconnect = useCallback(async () => {
    try {
      await provider.disconnect?.();
    } finally {
      if (!mountedRef.current) return;
      setSnapshotState((current) => current ? { ...current, connectionState: "disconnected", streamState: "idle" } : current);
      setState((current) => (current === "idle" ? current : "ready"));
    }
  }, [provider]);

  const sendMessage = useCallback(
    async (input: AgentSendInput) => {
      if (!provider.sendMessage) {
        const nextError = new Error("Agent provider does not support sendMessage().");
        setSendError(nextError);
        throw nextError;
      }

      const sendId = ++sendSeqRef.current;
      setSendError(null);
      setIsSending(true);

      try {
        await provider.sendMessage(input);
        if (!mountedRef.current || sendId !== sendSeqRef.current) return;
      } catch (cause) {
        if (!mountedRef.current || sendId !== sendSeqRef.current) return;
        const nextError = cause instanceof Error ? cause : new Error(String(cause));
        setSendError(nextError);
        throw nextError;
      } finally {
        if (!mountedRef.current || sendId !== sendSeqRef.current) return;
        setIsSending(false);
      }
    },
    [provider],
  );

  useEffect(() => {
    if (!autoConnect) return;
    void connect();
  }, [autoConnect, connect]);

  useEffect(() => {
    if (!provider.subscribe) return;

    const unsubscribe = provider.subscribe((event) => {
      if (!mountedRef.current) return;
      setSnapshotState((current) => applyAgentEvent(current, event));
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
    sendError,
    isReady: state === "ready",
    isBusy: state === "connecting" || state === "refreshing",
    isSending,
    connect,
    refresh,
    reconnect,
    disconnect,
    sendMessage,
    setSnapshot,
  };
}

export default useAgent;
