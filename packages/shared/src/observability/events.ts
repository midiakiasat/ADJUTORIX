import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / OBSERVABILITY / events.ts
 *
 * Canonical typed event model for the Electron main process.
 *
 * Responsibilities:
 * - define event taxonomy across runtime, window, IPC, agent, menu, diagnostics
 * - provide stable event envelope construction
 * - ensure deterministic serialization and hashing
 * - support correlation (trace_id, span_id, causation_id, parent_event_id)
 * - classify severity, domain, and actor/source consistently
 * - expose validation and normalization helpers for all emitted events
 *
 * Hard invariants:
 * - every event has a stable schema and explicit version
 * - event_id is content-addressed from normalized envelope fields
 * - no event carries non-normalized ad hoc payloads
 * - timestamps are explicit and never inferred later
 * - unknown event kinds are rejected unless intentionally registered
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// PRIMITIVES
// -----------------------------------------------------------------------------

export type EventSeverity = "trace" | "debug" | "info" | "warn" | "error" | "fatal";
export type EventDomain =
  | "runtime"
  | "window"
  | "ipc"
  | "agent"
  | "menu"
  | "config"
  | "diagnostics"
  | "workspace"
  | "patch"
  | "verify"
  | "ledger"
  | "security";

export type EventActor = "system" | "user" | "renderer" | "main" | "agent" | "scheduler";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type EventPayload = Record<string, JsonValue>;

export type EventKind =
  | "runtime.bootstrap.begin"
  | "runtime.bootstrap.phase"
  | "runtime.bootstrap.ready"
  | "runtime.shutdown.begin"
  | "runtime.shutdown.complete"
  | "config.loaded"
  | "config.validated"
  | "window.created"
  | "window.ready_to_show"
  | "window.focus"
  | "window.blur"
  | "window.closed"
  | "window.navigation_blocked"
  | "ipc.handle.begin"
  | "ipc.handle.success"
  | "ipc.handle.failure"
  | "agent.health.check"
  | "agent.spawn.begin"
  | "agent.spawn.ready"
  | "agent.spawn.failure"
  | "agent.exit"
  | "menu.installed"
  | "menu.rebuilt"
  | "menu.action.invoked"
  | "workspace.opened"
  | "workspace.closed"
  | "patch.preview.requested"
  | "patch.apply.requested"
  | "verify.run.requested"
  | "ledger.current.requested"
  | "diagnostics.exported"
  | "security.violation"
  | "runtime.crash";

export type EventEnvelope = {
  schema: 1;
  event_id: string;
  kind: EventKind;
  domain: EventDomain;
  severity: EventSeverity;
  actor: EventActor;
  ts_ms: number;
  iso_ts: string;
  source: string;
  session_id: string;
  trace_id?: string;
  span_id?: string;
  causation_id?: string;
  parent_event_id?: string;
  payload: EventPayload;
  hash: string;
};

export type EventFactoryContext = {
  source: string;
  session_id: string;
  trace_id?: string;
  span_id?: string;
};

// -----------------------------------------------------------------------------
// REGISTRY
// -----------------------------------------------------------------------------

const EVENT_META: Record<EventKind, { domain: EventDomain; severity: EventSeverity; actor: EventActor }> = {
  "runtime.bootstrap.begin": { domain: "runtime", severity: "info", actor: "main" },
  "runtime.bootstrap.phase": { domain: "runtime", severity: "debug", actor: "main" },
  "runtime.bootstrap.ready": { domain: "runtime", severity: "info", actor: "main" },
  "runtime.shutdown.begin": { domain: "runtime", severity: "info", actor: "main" },
  "runtime.shutdown.complete": { domain: "runtime", severity: "info", actor: "main" },
  "config.loaded": { domain: "config", severity: "info", actor: "system" },
  "config.validated": { domain: "config", severity: "info", actor: "system" },
  "window.created": { domain: "window", severity: "info", actor: "main" },
  "window.ready_to_show": { domain: "window", severity: "info", actor: "main" },
  "window.focus": { domain: "window", severity: "debug", actor: "user" },
  "window.blur": { domain: "window", severity: "debug", actor: "user" },
  "window.closed": { domain: "window", severity: "info", actor: "main" },
  "window.navigation_blocked": { domain: "security", severity: "warn", actor: "main" },
  "ipc.handle.begin": { domain: "ipc", severity: "debug", actor: "renderer" },
  "ipc.handle.success": { domain: "ipc", severity: "debug", actor: "main" },
  "ipc.handle.failure": { domain: "ipc", severity: "error", actor: "main" },
  "agent.health.check": { domain: "agent", severity: "debug", actor: "main" },
  "agent.spawn.begin": { domain: "agent", severity: "info", actor: "main" },
  "agent.spawn.ready": { domain: "agent", severity: "info", actor: "agent" },
  "agent.spawn.failure": { domain: "agent", severity: "error", actor: "main" },
  "agent.exit": { domain: "agent", severity: "warn", actor: "agent" },
  "menu.installed": { domain: "menu", severity: "info", actor: "main" },
  "menu.rebuilt": { domain: "menu", severity: "debug", actor: "main" },
  "menu.action.invoked": { domain: "menu", severity: "info", actor: "user" },
  "workspace.opened": { domain: "workspace", severity: "info", actor: "user" },
  "workspace.closed": { domain: "workspace", severity: "info", actor: "user" },
  "patch.preview.requested": { domain: "patch", severity: "info", actor: "user" },
  "patch.apply.requested": { domain: "patch", severity: "warn", actor: "user" },
  "verify.run.requested": { domain: "verify", severity: "info", actor: "user" },
  "ledger.current.requested": { domain: "ledger", severity: "debug", actor: "renderer" },
  "diagnostics.exported": { domain: "diagnostics", severity: "info", actor: "user" },
  "security.violation": { domain: "security", severity: "error", actor: "system" },
  "runtime.crash": { domain: "runtime", severity: "fatal", actor: "system" },
};

// -----------------------------------------------------------------------------
// NORMALIZATION
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:observability:events:${message}`);
  }
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    assert(Number.isFinite(value), "non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeJson(entry));
  }
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  throw new Error(`main:observability:events:unsupported_payload_type:${typeof value}`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(normalizeJson(value));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function iso(ts: number): string {
  return new Date(ts).toISOString();
}

function isKnownKind(kind: string): kind is EventKind {
  return kind in EVENT_META;
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateEventPayload(payload: unknown): EventPayload {
  const normalized = normalizeJson(payload);
  assert(normalized !== null && typeof normalized === "object" && !Array.isArray(normalized), "payload_not_object");
  return normalized as EventPayload;
}

export function validateEventEnvelope(event: EventEnvelope): void {
  assert(event.schema === 1, "schema_invalid");
  assert(isKnownKind(event.kind), `unknown_kind:${event.kind}`);
  assert(event.domain === EVENT_META[event.kind].domain, "domain_mismatch");
  assert(event.severity === EVENT_META[event.kind].severity, "severity_mismatch");
  assert(event.actor === EVENT_META[event.kind].actor, "actor_mismatch");
  assert(typeof event.event_id === "string" && event.event_id.length > 0, "event_id_invalid");
  assert(typeof event.hash === "string" && event.hash.length > 0, "hash_invalid");
  assert(typeof event.ts_ms === "number" && Number.isFinite(event.ts_ms), "timestamp_invalid");
  assert(typeof event.iso_ts === "string" && event.iso_ts.length > 0, "iso_timestamp_invalid");
  assert(typeof event.source === "string" && event.source.length > 0, "source_invalid");
  assert(typeof event.session_id === "string" && event.session_id.length > 0, "session_id_invalid");
  validateEventPayload(event.payload);

  const rebuilt = createEvent(
    {
      source: event.source,
      session_id: event.session_id,
      ...(event.trace_id ? { trace_id: event.trace_id } : {}),
      ...(event.span_id ? { span_id: event.span_id } : {}),
    },
    event.kind,
    event.payload,
    {
      ts_ms: event.ts_ms,
      ...(event.causation_id ? { causation_id: event.causation_id } : {}),
      ...(event.parent_event_id ? { parent_event_id: event.parent_event_id } : {}),
    },
  );

  assert(rebuilt.event_id === event.event_id, "event_id_drift");
  assert(rebuilt.hash === event.hash, "event_hash_drift");
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export type CreateEventOptions = {
  ts_ms?: number;
  causation_id?: string;
  parent_event_id?: string;
  trace_id?: string;
  span_id?: string;
};

export function createEvent(
  context: EventFactoryContext,
  kind: EventKind,
  payload: EventPayload,
  options: CreateEventOptions = {},
): EventEnvelope {
  assert(isKnownKind(kind), `unknown_kind:${kind}`);
  const meta = EVENT_META[kind];
  const ts_ms = options.ts_ms ?? Date.now();
  const normalizedPayload = validateEventPayload(payload);

  const canonicalCore = {
    schema: 1 as const,
    kind,
    domain: meta.domain,
    severity: meta.severity,
    actor: meta.actor,
    ts_ms,
    iso_ts: iso(ts_ms),
    source: context.source,
    session_id: context.session_id,
    ...(options.trace_id || context.trace_id ? { trace_id: options.trace_id ?? context.trace_id } : {}),
    ...(options.span_id || context.span_id ? { span_id: options.span_id ?? context.span_id } : {}),
    ...(options.causation_id ? { causation_id: options.causation_id } : {}),
    ...(options.parent_event_id ? { parent_event_id: options.parent_event_id } : {}),
    payload: normalizedPayload,
  };

  const event_id = sha256(stableJson({ ...canonicalCore, kind: canonicalCore.kind, ts_ms: canonicalCore.ts_ms })).slice(0, 24);
  const hash = sha256(stableJson({ ...canonicalCore, event_id }));

  const envelope: EventEnvelope = {
    ...canonicalCore,
    event_id,
    hash,
  };

  return envelope;
}

export function childContext(
  parent: EventEnvelope,
  source: string,
  span_id?: string,
): EventFactoryContext {
  return {
    source,
    session_id: parent.session_id,
    trace_id: parent.trace_id ?? parent.event_id,
    ...(span_id ? { span_id } : {}),
  };
}

// -----------------------------------------------------------------------------
// SPECIALIZED BUILDERS
// -----------------------------------------------------------------------------

export function runtimePhaseEvent(
  context: EventFactoryContext,
  phase: string,
  detail: Record<string, JsonValue> = {},
): EventEnvelope {
  return createEvent(context, "runtime.bootstrap.phase", {
    phase,
    ...detail,
  });
}

export function ipcInvocationEvent(
  context: EventFactoryContext,
  channel: string,
  success: boolean,
  payload: Record<string, JsonValue>,
  options: CreateEventOptions = {},
): EventEnvelope {
  return createEvent(
    context,
    success ? "ipc.handle.success" : "ipc.handle.failure",
    {
      channel,
      ...payload,
    },
    options,
  );
}

export function securityViolationEvent(
  context: EventFactoryContext,
  violation: string,
  payload: Record<string, JsonValue> = {},
): EventEnvelope {
  return createEvent(context, "security.violation", {
    violation,
    ...payload,
  });
}

export function crashEvent(
  context: EventFactoryContext,
  error: { name?: string; message?: string; stack?: string },
  payload: Record<string, JsonValue> = {},
): EventEnvelope {
  return createEvent(context, "runtime.crash", {
    error_name: error.name ?? "Error",
    error_message: error.message ?? "unknown",
    ...(error.stack ? { error_stack: error.stack } : {}),
    ...payload,
  });
}

// -----------------------------------------------------------------------------
// SERIALIZATION / BATCH
// -----------------------------------------------------------------------------

export function serializeEvent(event: EventEnvelope): string {
  validateEventEnvelope(event);
  return stableJson(event);
}

export function deserializeEvent(raw: string): EventEnvelope {
  const parsed = JSON.parse(raw) as EventEnvelope;
  validateEventEnvelope(parsed);
  return parsed;
}

export function serializeEventBatch(events: EventEnvelope[]): string {
  const normalized = events.map((event) => {
    validateEventEnvelope(event);
    return JSON.parse(serializeEvent(event)) as JsonValue;
  });
  return stableJson(normalized);
}

export function sortEvents(events: EventEnvelope[]): EventEnvelope[] {
  return [...events].sort((a, b) => {
    if (a.ts_ms !== b.ts_ms) return a.ts_ms - b.ts_ms;
    return a.event_id.localeCompare(b.event_id);
  });
}

// -----------------------------------------------------------------------------
// QUERY HELPERS
// -----------------------------------------------------------------------------

export function eventFingerprint(event: EventEnvelope): string {
  validateEventEnvelope(event);
  return sha256(
    stableJson({
      kind: event.kind,
      domain: event.domain,
      severity: event.severity,
      actor: event.actor,
      payload: event.payload,
    }),
  );
}

export function matchesEventKind(event: EventEnvelope, kind: EventKind): boolean {
  return event.kind === kind;
}

export function hasSeverityAtLeast(event: EventEnvelope, minimum: EventSeverity): boolean {
  const order: Record<EventSeverity, number> = {
    trace: 10,
    debug: 20,
    info: 30,
    warn: 40,
    error: 50,
    fatal: 60,
  };
  return order[event.severity] >= order[minimum];
}
