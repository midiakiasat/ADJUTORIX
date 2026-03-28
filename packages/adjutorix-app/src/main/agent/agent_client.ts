import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / AGENT / agent_client.ts
 *
 * Canonical Adjutorix agent HTTP/JSON-RPC client for the Electron main process.
 *
 * Purpose:
 * - provide one authoritative transport/client surface to the local or configured agent
 * - centralize token loading, request normalization, timeout policy, and error handling
 * - expose deterministic health, status, and RPC invocation semantics
 * - separate transport concerns from process supervision and IPC adapters
 * - produce stable audit artifacts and snapshots for diagnostics/tests
 *
 * Responsibilities:
 * - load and cache auth token from local token file deterministically
 * - normalize JSON-RPC requests and transport envelopes
 * - enforce bounded timeout/retry rules
 * - classify transport, protocol, auth, and application failures explicitly
 * - capture response hashes and load-bearing telemetry without leaking secrets
 * - support health ping, generic RPC invocation, and batch-safe future extension
 *
 * Hard invariants:
 * - no caller constructs ad hoc JSON-RPC payloads outside this client surface
 * - identical semantic request inputs produce identical request hashes
 * - tokens are never emitted in snapshots/audit details
 * - network/transport failure is distinct from JSON-RPC application failure
 * - timeouts are explicit, bounded, and deterministic
 * - client state is serialization-stable and side-effect free except for token refresh cache
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AgentClientHealth = "idle" | "ready" | "degraded" | "error";
export type AgentRpcFailureKind = "transport" | "timeout" | "http" | "auth" | "protocol" | "rpc" | "invalid-response";
export type AgentClientAction = "token_load" | "health_ping" | "rpc_invoke" | "status_read" | "snapshot";

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params: JsonObject;
};

export type JsonRpcSuccess = {
  jsonrpc: "2.0";
  id: string | number | null;
  result: JsonValue;
};

export type JsonRpcErrorObject = {
  code: number;
  message: string;
  data?: JsonValue;
};

export type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: string | number | null;
  error: JsonRpcErrorObject;
};

export type AgentClientProbeResult = {
  ok: boolean;
  status: number | null;
  durationMs: number;
  checkedAtMs: number;
  bodyHash: string | null;
  requestHash: string;
  error: string | null;
};

export type AgentRpcSuccessResult = {
  ok: true;
  method: string;
  requestHash: string;
  responseHash: string;
  httpStatus: number;
  durationMs: number;
  receivedAtMs: number;
  result: JsonValue;
};

export type AgentRpcFailureResult = {
  ok: false;
  method: string;
  requestHash: string;
  responseHash: string | null;
  httpStatus: number | null;
  durationMs: number;
  receivedAtMs: number;
  kind: AgentRpcFailureKind;
  message: string;
  rpcError?: JsonRpcErrorObject;
};

export type AgentRpcResult = AgentRpcSuccessResult | AgentRpcFailureResult;

export type AgentClientState = {
  health: AgentClientHealth;
  tokenLoaded: boolean;
  tokenFingerprint: string | null;
  tokenLoadedAtMs: number | null;
  lastRequestHash: string | null;
  lastResponseHash: string | null;
  lastHttpStatus: number | null;
  lastError: string | null;
  lastMethod: string | null;
  lastDurationMs: number | null;
  lastSeenAtMs: number | null;
};

export type AgentClientSnapshot = {
  schema: 1;
  baseUrl: string;
  tokenFile: string;
  policy: {
    timeoutMs: number;
    healthTimeoutMs: number;
    maxResponseBytes: number;
    retryCount: number;
    retryBackoffMs: number;
    strictJsonRpc: boolean;
  };
  state: AgentClientState;
  hash: string;
};

export type AgentClientPolicy = {
  timeoutMs: number;
  healthTimeoutMs: number;
  maxResponseBytes: number;
  retryCount: number;
  retryBackoffMs: number;
  strictJsonRpc: boolean;
  acceptHttp401AsAuthFailure: boolean;
  healthMethod: string;
  statusMethod: string;
};

export type AgentClientAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: AgentClientAction;
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AgentClientAuditFn = (record: AgentClientAuditRecord) => void;

export type AgentClientHooks = {
  onHealthPing?: (result: AgentClientProbeResult) => Promise<void> | void;
  onRpc?: (result: AgentRpcResult) => Promise<void> | void;
};

export type AgentClientOptions = {
  baseUrl: string;
  tokenFile: string;
  policy?: Partial<AgentClientPolicy>;
  audit?: AgentClientAuditFn;
  hooks?: AgentClientHooks;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: AgentClientPolicy = {
  timeoutMs: 8_000,
  healthTimeoutMs: 4_000,
  maxResponseBytes: 4 * 1024 * 1024,
  retryCount: 0,
  retryBackoffMs: 250,
  strictJsonRpc: true,
  acceptHttp401AsAuthFailure: true,
  healthMethod: "health.ping",
  statusMethod: "agent.status",
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:agent:agent_client:${message}`);
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

function sha256(value: string | Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function normalizeBaseUrl(input: string): string {
  const url = new URL(input);
  return url.toString();
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

function normalizeParams(params?: Record<string, unknown> | JsonObject): JsonObject {
  return normalizeJson(params ?? {}) as JsonObject;
}

function requestHash(req: JsonRpcRequest): string {
  return sha256(stableJson(req));
}

function snapshotHash(core: Omit<AgentClientSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<AgentClientAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function responseHash(text: string): string {
  return sha256(text);
}

function tokenFingerprint(token: string): string | null {
  if (!token) return null;
  return sha256(token).slice(0, 16);
}

async function maybeCall<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// CLIENT
// -----------------------------------------------------------------------------

export class AgentClient {
  private readonly baseUrl: string;
  private readonly tokenFile: string;
  private readonly policy: AgentClientPolicy;
  private readonly audit?: AgentClientAuditFn;
  private readonly hooks?: AgentClientHooks;
  private readonly now?: () => number;

  private tokenCache: string | null = null;
  private state: AgentClientState = {
    health: "idle",
    tokenLoaded: false,
    tokenFingerprint: null,
    tokenLoadedAtMs: null,
    lastRequestHash: null,
    lastResponseHash: null,
    lastHttpStatus: null,
    lastError: null,
    lastMethod: null,
    lastDurationMs: null,
    lastSeenAtMs: null,
  };

  constructor(options: AgentClientOptions) {
    this.baseUrl = normalizeBaseUrl(options.baseUrl);
    this.tokenFile = path.resolve(options.tokenFile);
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.hooks = options.hooks;
    this.now = options.now;
  }

  snapshot(): AgentClientSnapshot {
    const core: Omit<AgentClientSnapshot, "hash"> = {
      schema: 1,
      baseUrl: this.baseUrl,
      tokenFile: this.tokenFile,
      policy: {
        timeoutMs: this.policy.timeoutMs,
        healthTimeoutMs: this.policy.healthTimeoutMs,
        maxResponseBytes: this.policy.maxResponseBytes,
        retryCount: this.policy.retryCount,
        retryBackoffMs: this.policy.retryBackoffMs,
        strictJsonRpc: this.policy.strictJsonRpc,
      },
      state: JSON.parse(stableJson(this.state)) as AgentClientState,
    };

    const snapshot: AgentClientSnapshot = {
      ...core,
      hash: snapshotHash(core),
    };

    this.emitAudit("snapshot", "allow", "client_snapshot_created", {
      health: snapshot.state.health,
      lastMethod: snapshot.state.lastMethod,
    });

    return snapshot;
  }

  refreshToken(): string {
    const token = this.loadToken();
    this.tokenCache = token;
    this.state.tokenLoaded = token.length > 0;
    this.state.tokenFingerprint = tokenFingerprint(token);
    this.state.tokenLoadedAtMs = nowMs(this.now);
    this.emitAudit("token_load", token.length > 0 ? "allow" : "deny", token.length > 0 ? "token_loaded" : "token_missing_or_empty", {
      tokenFingerprint: this.state.tokenFingerprint,
      tokenFile: this.tokenFile,
    });
    return token;
  }

  async pingHealth(): Promise<AgentClientProbeResult> {
    const startedAt = nowMs(this.now);
    const request = this.buildRequest(this.policy.healthMethod, {});
    const requestHashValue = requestHash(request);

    const result = await this.performRawRequest(request, this.policy.healthTimeoutMs);
    const probe: AgentClientProbeResult = {
      ok: result.ok,
      status: result.httpStatus,
      durationMs: result.durationMs,
      checkedAtMs: result.receivedAtMs,
      bodyHash: result.responseHash,
      requestHash: requestHashValue,
      error: result.ok ? null : result.message,
    };

    this.state.health = probe.ok ? "ready" : "degraded";
    this.emitAudit("health_ping", probe.ok ? "allow" : "deny", probe.ok ? "health_ping_ok" : "health_ping_failed", {
      status: probe.status,
      durationMs: probe.durationMs,
      requestHash: probe.requestHash,
      error: probe.error,
    });
    await maybeCall(this.hooks?.onHealthPing, probe);

    return probe;
  }

  async readStatus(): Promise<AgentRpcResult> {
    return this.invoke(this.policy.statusMethod, {});
  }

  async invoke(method: string, params: JsonObject = {}): Promise<AgentRpcResult> {
    assert(typeof method === "string" && method.trim().length > 0, "method_invalid");
    const request = this.buildRequest(method, params);
    const result = await this.performRawRequest(request, this.policy.timeoutMs);

    this.emitAudit("rpc_invoke", result.ok ? "allow" : "deny", result.ok ? "rpc_invoke_ok" : "rpc_invoke_failed", {
      method,
      requestHash: result.requestHash,
      httpStatus: result.httpStatus,
      durationMs: result.durationMs,
      kind: result.ok ? null : result.kind,
    });

    await maybeCall(this.hooks?.onRpc, result);
    return result;
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private buildRequest(method: string, params: JsonObject): JsonRpcRequest {
    return {
      jsonrpc: "2.0",
      id: `${nowMs(this.now)}:${sha256(method).slice(0, 8)}`,
      method,
      params: normalizeParams(params),
    };
  }

  private loadToken(): string {
    try {
      return fs.readFileSync(this.tokenFile, "utf8").trim();
    } catch {
      return "";
    }
  }

  private currentToken(): string {
    if (this.tokenCache !== null) return this.tokenCache;
    return this.refreshToken();
  }

  private async performRawRequest(request: JsonRpcRequest, timeoutMs: number): Promise<AgentRpcResult> {
    const requestHashValue = requestHash(request);
    const startedAt = nowMs(this.now);
    let lastFailure: AgentRpcFailureResult | null = null;

    for (let attempt = 0; attempt <= this.policy.retryCount; attempt += 1) {
      const token = this.currentToken();
      try {
        const response = await fetch(this.baseUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(token ? { "x-adjutorix-token": token } : {}),
          },
          body: stableJson(request),
          signal: AbortSignal.timeout(timeoutMs),
        });

        const receivedAtMs = nowMs(this.now);
        const httpStatus = response.status;
        const responseText = await response.text();
        assert(Buffer.byteLength(responseText, "utf8") <= this.policy.maxResponseBytes, "response_too_large");
        const responseHashValue = responseHash(responseText);

        this.state.lastRequestHash = requestHashValue;
        this.state.lastResponseHash = responseHashValue;
        this.state.lastHttpStatus = httpStatus;
        this.state.lastMethod = request.method;
        this.state.lastDurationMs = receivedAtMs - startedAt;
        this.state.lastSeenAtMs = receivedAtMs;

        if (this.policy.acceptHttp401AsAuthFailure && httpStatus === 401) {
          const failure: AgentRpcFailureResult = {
            ok: false,
            method: request.method,
            requestHash: requestHashValue,
            responseHash: responseHashValue,
            httpStatus,
            durationMs: receivedAtMs - startedAt,
            receivedAtMs,
            kind: "auth",
            message: "Authentication failed while calling agent.",
          };
          this.state.lastError = failure.message;
          this.state.health = "error";
          return failure;
        }

        if (!response.ok) {
          const failure: AgentRpcFailureResult = {
            ok: false,
            method: request.method,
            requestHash: requestHashValue,
            responseHash: responseHashValue,
            httpStatus,
            durationMs: receivedAtMs - startedAt,
            receivedAtMs,
            kind: "http",
            message: `HTTP ${httpStatus} while calling agent.`,
          };
          this.state.lastError = failure.message;
          this.state.health = "degraded";
          return failure;
        }

        let parsed: unknown;
        try {
          parsed = JSON.parse(responseText);
        } catch {
          const failure: AgentRpcFailureResult = {
            ok: false,
            method: request.method,
            requestHash: requestHashValue,
            responseHash: responseHashValue,
            httpStatus,
            durationMs: receivedAtMs - startedAt,
            receivedAtMs,
            kind: "protocol",
            message: "Agent returned invalid JSON.",
          };
          this.state.lastError = failure.message;
          this.state.health = "error";
          return failure;
        }

        if (!this.isJsonRpcEnvelope(parsed)) {
          const failure: AgentRpcFailureResult = {
            ok: false,
            method: request.method,
            requestHash: requestHashValue,
            responseHash: responseHashValue,
            httpStatus,
            durationMs: receivedAtMs - startedAt,
            receivedAtMs,
            kind: "invalid-response",
            message: "Agent response did not match JSON-RPC envelope.",
          };
          this.state.lastError = failure.message;
          this.state.health = "error";
          return failure;
        }

        if ("error" in parsed && parsed.error) {
          const failure: AgentRpcFailureResult = {
            ok: false,
            method: request.method,
            requestHash: requestHashValue,
            responseHash: responseHashValue,
            httpStatus,
            durationMs: receivedAtMs - startedAt,
            receivedAtMs,
            kind: "rpc",
            message: parsed.error.message,
            rpcError: {
              code: parsed.error.code,
              message: parsed.error.message,
              ...(parsed.error.data !== undefined ? { data: normalizeJson(parsed.error.data) } : {}),
            },
          };
          this.state.lastError = failure.message;
          this.state.health = "degraded";
          return failure;
        }

        const success: AgentRpcSuccessResult = {
          ok: true,
          method: request.method,
          requestHash: requestHashValue,
          responseHash: responseHashValue,
          httpStatus,
          durationMs: receivedAtMs - startedAt,
          receivedAtMs,
          result: normalizeJson((parsed as JsonRpcSuccess).result),
        };
        this.state.lastError = null;
        this.state.health = "ready";
        return success;
      } catch (error) {
        const receivedAtMs = nowMs(this.now);
        const isTimeout = error instanceof Error && /aborted|timeout/i.test(error.message);
        const failure: AgentRpcFailureResult = {
          ok: false,
          method: request.method,
          requestHash: requestHashValue,
          responseHash: null,
          httpStatus: null,
          durationMs: receivedAtMs - startedAt,
          receivedAtMs,
          kind: isTimeout ? "timeout" : "transport",
          message: error instanceof Error ? error.message : String(error),
        };
        lastFailure = failure;
        this.state.lastRequestHash = requestHashValue;
        this.state.lastResponseHash = null;
        this.state.lastHttpStatus = null;
        this.state.lastMethod = request.method;
        this.state.lastDurationMs = failure.durationMs;
        this.state.lastSeenAtMs = receivedAtMs;
        this.state.lastError = failure.message;
        this.state.health = "degraded";

        if (attempt < this.policy.retryCount) {
          await delay(this.policy.retryBackoffMs);
          continue;
        }
      }
    }

    assert(lastFailure !== null, "missing_failure_result");
    return lastFailure;
  }

  private isJsonRpcEnvelope(value: unknown): value is JsonRpcSuccess | JsonRpcFailure {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if (obj.jsonrpc !== "2.0") return false;
    if (!("id" in obj)) return false;
    if (!("result" in obj) && !("error" in obj)) return false;
    if (this.policy.strictJsonRpc && ("result" in obj) === ("error" in obj)) return false;
    if ("error" in obj && obj.error !== undefined && obj.error !== null) {
      if (typeof obj.error !== "object") return false;
      const err = obj.error as Record<string, unknown>;
      if (typeof err.code !== "number" || typeof err.message !== "string") return false;
    }
    return true;
  }

  private emitAudit(
    action: AgentClientAction,
    decision: "allow" | "deny",
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<AgentClientAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
      reason,
      detail,
    };
    this.audit({
      ...core,
      hash: auditHash(core),
    });
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createAgentClient(options: AgentClientOptions): AgentClient {
  return new AgentClient(options);
}

export function defaultAgentClientPolicy(): AgentClientPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateAgentClientSnapshot(snapshot: AgentClientSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<AgentClientSnapshot, "hash"> = {
    schema: snapshot.schema,
    baseUrl: snapshot.baseUrl,
    tokenFile: snapshot.tokenFile,
    policy: snapshot.policy,
    state: snapshot.state,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
