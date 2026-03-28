import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / BOUNDARY / authority_router.ts
 *
 * Canonical authority routing layer for the Electron main process.
 *
 * Position in stack:
 *   ipc_guard -> capability_enforcer -> authority_router -> mutation_boundary / query handlers / local state handlers
 *
 * This module decides WHICH authority path a request is allowed to enter.
 * It does not itself implement business logic. Its job is to stop category
 * confusion, where a renderer request tries to reach the wrong execution class.
 *
 * Responsibilities:
 * - classify operations into authority lanes
 * - route normalized requests to the correct downstream executor
 * - prevent governed operations from bypassing preview/apply gates
 * - prevent query lanes from mutating state
 * - enforce deterministic route decisions and auditability
 * - expose a single routing contract to runtime wiring/bootstrap
 *
 * Hard invariants:
 * - deny by default
 * - every routable operation belongs to exactly one authority lane
 * - identical inputs produce identical route decisions
 * - no direct handler dispatch from raw IPC channels
 * - governed apply/preview routes remain distinct from local-state/service-control
 * - route results are serialization-stable and auditable
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

export type AuthorityActor = "renderer" | "menu" | "main" | "system";

export type AuthorityOperation =
  | "workspace.open"
  | "workspace.close"
  | "workspace.reveal"
  | "patch.preview"
  | "patch.apply"
  | "verify.run"
  | "verify.status"
  | "ledger.current"
  | "settings.update"
  | "window.state.update"
  | "diagnostics.export"
  | "agent.start"
  | "agent.stop"
  | "runtime.snapshot"
  | "rpc.invoke";

export type AuthorityLane =
  | "query"
  | "local-state"
  | "governed-preview"
  | "governed-apply"
  | "service-control"
  | "workspace-control"
  | "rpc-proxy";

export type AuthorityRequest = {
  schema: 1;
  actor: AuthorityActor;
  operation: AuthorityOperation;
  payload: Record<string, JsonValue>;
  trace_id?: string;
  request_hash: string;
};

export type RouteDecision = "allow" | "deny";

export type AuthorityRoute = {
  schema: 1;
  actor: AuthorityActor;
  operation: AuthorityOperation;
  lane: AuthorityLane;
  decision: RouteDecision;
  reason: string;
  request_hash: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AuthorityAuditRecord = AuthorityRoute & {
  ts_ms: number;
};

export type AuthorityEnvironment = {
  workspace_open: boolean;
  approved_preview_hash: string | null;
  verified_preview_hash: string | null;
  diagnostics_enabled: boolean;
  settings_mutable: boolean;
  window_state_mutable: boolean;
  managed_agent_running: boolean;
  rpc_proxy_enabled: boolean;
};

export type AuthorityRouterContext = {
  environment: AuthorityEnvironment;
  now?: () => number;
  audit?: (record: AuthorityAuditRecord) => void;
};

export type AuthorityHandlers = {
  query: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  localState: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  governedPreview: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  governedApply: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  serviceControl: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  workspaceControl: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
  rpcProxy: (request: AuthorityRequest, route: AuthorityRoute) => Promise<JsonValue>;
};

// -----------------------------------------------------------------------------
// ROUTING TABLE
// -----------------------------------------------------------------------------

const OPERATION_LANE: Record<AuthorityOperation, AuthorityLane> = {
  "workspace.open": "workspace-control",
  "workspace.close": "workspace-control",
  "workspace.reveal": "workspace-control",
  "patch.preview": "governed-preview",
  "patch.apply": "governed-apply",
  "verify.run": "governed-preview",
  "verify.status": "query",
  "ledger.current": "query",
  "settings.update": "local-state",
  "window.state.update": "local-state",
  "diagnostics.export": "service-control",
  "agent.start": "service-control",
  "agent.stop": "service-control",
  "runtime.snapshot": "query",
  "rpc.invoke": "rpc-proxy",
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:boundary:authority_router:${message}`);
  }
}

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

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function isActor(value: string): value is AuthorityActor {
  return value === "renderer" || value === "menu" || value === "main" || value === "system";
}

function isOperation(value: string): value is AuthorityOperation {
  return value in OPERATION_LANE;
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
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return String(value);
}

function buildRequestHash(actor: AuthorityActor, operation: AuthorityOperation, payload: Record<string, JsonValue>, trace_id?: string): string {
  return sha256(
    stableJson({
      schema: 1,
      actor,
      operation,
      payload,
      ...(trace_id ? { trace_id } : {}),
    }),
  );
}

function buildRouteHash(core: Omit<AuthorityRoute, "hash">): string {
  return sha256(stableJson(core));
}

function emitAudit(ctx: AuthorityRouterContext | undefined, route: AuthorityRoute): void {
  if (!ctx?.audit) return;
  ctx.audit({
    ...route,
    ts_ms: (ctx.now ?? Date.now)(),
  });
}

function allow(
  request: AuthorityRequest,
  lane: AuthorityLane,
  reason: string,
  detail: Record<string, JsonValue> = {},
): AuthorityRoute {
  const core: Omit<AuthorityRoute, "hash"> = {
    schema: 1,
    actor: request.actor,
    operation: request.operation,
    lane,
    decision: "allow",
    reason,
    request_hash: request.request_hash,
    detail,
  };
  return {
    ...core,
    hash: buildRouteHash(core),
  };
}

function deny(
  request: AuthorityRequest,
  lane: AuthorityLane,
  reason: string,
  detail: Record<string, JsonValue> = {},
): AuthorityRoute {
  const core: Omit<AuthorityRoute, "hash"> = {
    schema: 1,
    actor: request.actor,
    operation: request.operation,
    lane,
    decision: "deny",
    reason,
    request_hash: request.request_hash,
    detail,
  };
  return {
    ...core,
    hash: buildRouteHash(core),
  };
}

// -----------------------------------------------------------------------------
// REQUEST NORMALIZATION
// -----------------------------------------------------------------------------

export function normalizeAuthorityRequest(input: {
  actor: string;
  operation: string;
  payload?: Record<string, unknown>;
  trace_id?: string;
}): AuthorityRequest {
  assert(isActor(input.actor), `actor_invalid:${input.actor}`);
  assert(isOperation(input.operation), `operation_invalid:${input.operation}`);
  const payload = normalizeJson(input.payload ?? {}) as Record<string, JsonValue>;
  const trace_id = input.trace_id && input.trace_id.length > 0 ? input.trace_id : undefined;

  return {
    schema: 1,
    actor: input.actor,
    operation: input.operation,
    payload,
    ...(trace_id ? { trace_id } : {}),
    request_hash: buildRequestHash(input.actor, input.operation, payload, trace_id),
  };
}

// -----------------------------------------------------------------------------
// ROUTING DECISION ENGINE
// -----------------------------------------------------------------------------

export function routeAuthorityRequest(request: AuthorityRequest, ctx: AuthorityRouterContext): AuthorityRoute {
  const env = ctx.environment;
  const lane = OPERATION_LANE[request.operation];
  let route: AuthorityRoute;

  switch (request.operation) {
    case "runtime.snapshot":
    case "verify.status":
    case "ledger.current": {
      route = allow(request, "query", "query_lane_allowed");
      break;
    }

    case "settings.update": {
      route = env.settings_mutable
        ? allow(request, "local-state", "settings_local_state_allowed")
        : deny(request, "local-state", "settings_mutation_disabled");
      break;
    }

    case "window.state.update": {
      route = env.window_state_mutable
        ? allow(request, "local-state", "window_state_local_mutation_allowed")
        : deny(request, "local-state", "window_state_mutation_disabled");
      break;
    }

    case "patch.preview": {
      route = env.workspace_open
        ? allow(request, "governed-preview", "governed_preview_allowed")
        : deny(request, "governed-preview", "workspace_required_for_preview");
      break;
    }

    case "verify.run": {
      const previewHash = request.payload.previewHash;
      route = env.workspace_open
        ? (typeof previewHash === "string" && previewHash.length > 0
            ? allow(request, "governed-preview", "verify_route_allowed", { previewHash })
            : deny(request, "governed-preview", "verify_preview_hash_missing", { previewHash: (previewHash ?? null) as JsonValue }))
        : deny(request, "governed-preview", "workspace_required_for_verify");
      break;
    }

    case "patch.apply": {
      const suppliedPreviewHash = request.payload.previewHash;
      if (!env.workspace_open) {
        route = deny(request, "governed-apply", "workspace_required_for_apply");
        break;
      }
      if (!env.approved_preview_hash) {
        route = deny(request, "governed-apply", "approved_preview_missing");
        break;
      }
      if (env.verified_preview_hash !== env.approved_preview_hash) {
        route = deny(request, "governed-apply", "verified_preview_mismatch", {
          approvedPreviewHash: env.approved_preview_hash,
          verifiedPreviewHash: env.verified_preview_hash,
        });
        break;
      }
      if (!(typeof suppliedPreviewHash === "string" && suppliedPreviewHash === env.approved_preview_hash)) {
        route = deny(request, "governed-apply", "supplied_preview_hash_invalid", {
          suppliedPreviewHash: (suppliedPreviewHash ?? null) as JsonValue,
          approvedPreviewHash: env.approved_preview_hash,
        });
        break;
      }
      route = allow(request, "governed-apply", "governed_apply_allowed", {
        previewHash: suppliedPreviewHash,
      });
      break;
    }

    case "workspace.open": {
      const workspacePath = request.payload.workspacePath;
      route = typeof workspacePath === "string" && workspacePath.length > 0
        ? allow(request, "workspace-control", "workspace_open_route_allowed", { workspacePath })
        : deny(request, "workspace-control", "workspace_path_invalid", { workspacePath: (workspacePath ?? null) as JsonValue });
      break;
    }

    case "workspace.close":
    case "workspace.reveal": {
      route = env.workspace_open
        ? allow(request, "workspace-control", "workspace_control_route_allowed")
        : deny(request, "workspace-control", "workspace_not_open");
      break;
    }

    case "diagnostics.export": {
      route = env.diagnostics_enabled
        ? allow(request, "service-control", "diagnostics_export_allowed")
        : deny(request, "service-control", "diagnostics_disabled");
      break;
    }

    case "agent.start": {
      route = env.managed_agent_running
        ? deny(request, "service-control", "agent_already_running")
        : allow(request, "service-control", "agent_start_allowed");
      break;
    }

    case "agent.stop": {
      route = env.managed_agent_running
        ? allow(request, "service-control", "agent_stop_allowed")
        : deny(request, "service-control", "agent_not_running");
      break;
    }

    case "rpc.invoke": {
      route = env.rpc_proxy_enabled
        ? allow(request, "rpc-proxy", "rpc_proxy_allowed")
        : deny(request, "rpc-proxy", "rpc_proxy_disabled");
      break;
    }

    default: {
      const exhaustive: never = request.operation;
      route = deny(request, lane, "operation_unhandled", { operation: exhaustive as never });
      break;
    }
  }

  emitAudit(ctx, route);
  return route;
}

// -----------------------------------------------------------------------------
// EXECUTION DISPATCH
// -----------------------------------------------------------------------------

export async function dispatchAuthorityRoute(
  request: AuthorityRequest,
  route: AuthorityRoute,
  handlers: AuthorityHandlers,
): Promise<JsonValue> {
  assert(route.request_hash === request.request_hash, "route_request_hash_mismatch");
  if (route.decision === "deny") {
    throw new Error(`authority_route_denied:${route.reason}`);
  }

  switch (route.lane) {
    case "query":
      return handlers.query(request, route);
    case "local-state":
      return handlers.localState(request, route);
    case "governed-preview":
      return handlers.governedPreview(request, route);
    case "governed-apply":
      return handlers.governedApply(request, route);
    case "service-control":
      return handlers.serviceControl(request, route);
    case "workspace-control":
      return handlers.workspaceControl(request, route);
    case "rpc-proxy":
      return handlers.rpcProxy(request, route);
    default: {
      const exhaustive: never = route.lane;
      throw new Error(`unhandled_authority_lane:${exhaustive}`);
    }
  }
}

export async function passThroughAuthorityRouter(
  request: AuthorityRequest,
  ctx: AuthorityRouterContext,
  handlers: AuthorityHandlers,
): Promise<JsonValue> {
  const route = routeAuthorityRequest(request, ctx);
  return dispatchAuthorityRoute(request, route, handlers);
}

// -----------------------------------------------------------------------------
// VALIDATION / SERIALIZATION
// -----------------------------------------------------------------------------

export function validateAuthorityRequest(request: AuthorityRequest): void {
  assert(request.schema === 1, "request_schema_invalid");
  assert(isActor(request.actor), `request_actor_invalid:${request.actor}`);
  assert(isOperation(request.operation), `request_operation_invalid:${request.operation}`);
  const expectedHash = buildRequestHash(request.actor, request.operation, request.payload, request.trace_id);
  assert(expectedHash === request.request_hash, "request_hash_drift");
}

export function validateAuthorityRoute(route: AuthorityRoute): void {
  assert(route.schema === 1, "route_schema_invalid");
  assert(isActor(route.actor), `route_actor_invalid:${route.actor}`);
  assert(isOperation(route.operation), `route_operation_invalid:${route.operation}`);
  assert(route.lane === OPERATION_LANE[route.operation], "route_lane_mismatch");
  assert(route.decision === "allow" || route.decision === "deny", "route_decision_invalid");
  assert(typeof route.reason === "string" && route.reason.length > 0, "route_reason_invalid");

  const core: Omit<AuthorityRoute, "hash"> = {
    schema: route.schema,
    actor: route.actor,
    operation: route.operation,
    lane: route.lane,
    decision: route.decision,
    reason: route.reason,
    request_hash: route.request_hash,
    detail: route.detail,
  };
  assert(buildRouteHash(core) === route.hash, "route_hash_drift");
}

export function serializeAuthorityRoute(route: AuthorityRoute): string {
  validateAuthorityRoute(route);
  return stableJson(route);
}

export function validateAuthorityAuditRecord(record: AuthorityAuditRecord): void {
  validateAuthorityRoute(record);
  assert(typeof record.ts_ms === "number" && Number.isFinite(record.ts_ms), "audit_ts_invalid");
}

// -----------------------------------------------------------------------------
// DEFAULT ENV HELPERS
// -----------------------------------------------------------------------------

export function defaultAuthorityEnvironment(): AuthorityEnvironment {
  return {
    workspace_open: false,
    approved_preview_hash: null,
    verified_preview_hash: null,
    diagnostics_enabled: true,
    settings_mutable: true,
    window_state_mutable: true,
    managed_agent_running: false,
    rpc_proxy_enabled: false,
  };
}
