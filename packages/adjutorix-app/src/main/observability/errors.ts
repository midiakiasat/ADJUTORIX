import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / OBSERVABILITY / errors.ts
 *
 * Canonical error taxonomy, normalization, and serialization for the Electron
 * main process.
 *
 * Responsibilities:
 * - define stable runtime error classes across domains
 * - normalize unknown exceptions into deterministic error envelopes
 * - classify severity, retryability, user-safety, and origin
 * - preserve causal chains without leaking unsafe internals by default
 * - support IPC-safe, log-safe, and dialog-safe projections
 * - provide content-addressed fingerprints for deduplication and analytics
 *
 * Hard invariants:
 * - every surfaced error has an explicit code
 * - every error envelope is serializable and deterministic
 * - unknown thrown values are converted, never passed through raw
 * - secrets/tokens/authorization strings are redacted in public projections
 * - causal chain depth is bounded
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type ErrorDomain =
  | "runtime"
  | "config"
  | "window"
  | "ipc"
  | "agent"
  | "filesystem"
  | "security"
  | "menu"
  | "workspace"
  | "patch"
  | "verify"
  | "ledger"
  | "diagnostics";

export type ErrorSeverity = "info" | "warn" | "error" | "fatal";
export type ErrorDisposition = "user" | "system" | "developer";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type ErrorContext = Record<string, JsonValue>;

export type SerializedCause = {
  code: string;
  name: string;
  message: string;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  retryable: boolean;
  user_safe: boolean;
  fingerprint: string;
  context?: ErrorContext;
  cause?: SerializedCause;
};

export type ErrorEnvelope = {
  schema: 1;
  code: string;
  name: string;
  message: string;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  disposition: ErrorDisposition;
  retryable: boolean;
  user_safe: boolean;
  fingerprint: string;
  stack?: string;
  context?: ErrorContext;
  cause?: SerializedCause;
};

export type PublicError = {
  code: string;
  message: string;
  domain: ErrorDomain;
  severity: ErrorSeverity;
  retryable: boolean;
  fingerprint: string;
};

export type ErrorProjectionMode = "internal" | "ipc" | "dialog" | "log";

export type NormalizeErrorOptions = {
  defaultCode?: string;
  defaultDomain?: ErrorDomain;
  defaultSeverity?: ErrorSeverity;
  defaultDisposition?: ErrorDisposition;
  defaultRetryable?: boolean;
  defaultUserSafe?: boolean;
  context?: ErrorContext;
  includeStack?: boolean;
  maxCauseDepth?: number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULTS = {
  code: "runtime.unknown",
  domain: "runtime" as ErrorDomain,
  severity: "error" as ErrorSeverity,
  disposition: "developer" as ErrorDisposition,
  retryable: false,
  userSafe: false,
  includeStack: true,
  maxCauseDepth: 4,
};

const REDACT_PATTERNS = [
  /token/gi,
  /secret/gi,
  /password/gi,
  /authorization/gi,
  /api[_-]?key/gi,
  /bearer\s+[a-z0-9._-]+/gi,
];

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:observability:errors:${message}`);
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

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function redactString(input: string): string {
  let output = input;
  for (const pattern of REDACT_PATTERNS) {
    output = output.replace(pattern, "<redacted>");
  }
  return output;
}

function normalizeJson(value: unknown): JsonValue {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value === "number") {
    assert(Number.isFinite(value), "non_finite_number");
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (typeof value === "object") {
    const out: Record<string, JsonValue> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const next = (value as Record<string, unknown>)[key];
      out[key] = /token|secret|password|authorization|key/i.test(key) ? "<redacted>" : normalizeJson(next);
    }
    return out;
  }
  return redactString(String(value));
}

function toContext(value: unknown): ErrorContext | undefined {
  if (value === undefined) return undefined;
  const normalized = normalizeJson(value);
  assert(normalized !== null && typeof normalized === "object" && !Array.isArray(normalized), "context_not_object");
  return normalized as ErrorContext;
}

function fingerprint(parts: Record<string, unknown>): string {
  return sha256(stableJson(parts)).slice(0, 24);
}

function cleanMessage(message: string): string {
  return redactString(message).trim() || "Unknown error";
}

// -----------------------------------------------------------------------------
// BASE ERROR CLASS
// -----------------------------------------------------------------------------

export class AdjutorixError extends Error {
  public readonly code: string;
  public readonly domain: ErrorDomain;
  public readonly severity: ErrorSeverity;
  public readonly disposition: ErrorDisposition;
  public readonly retryable: boolean;
  public readonly userSafe: boolean;
  public readonly context?: ErrorContext;
  public override readonly cause?: unknown;

  constructor(params: {
    code: string;
    message: string;
    domain: ErrorDomain;
    severity?: ErrorSeverity;
    disposition?: ErrorDisposition;
    retryable?: boolean;
    userSafe?: boolean;
    context?: ErrorContext;
    cause?: unknown;
    name?: string;
  }) {
    super(cleanMessage(params.message));
    this.name = params.name || "AdjutorixError";
    this.code = params.code;
    this.domain = params.domain;
    this.severity = params.severity ?? DEFAULTS.severity;
    this.disposition = params.disposition ?? DEFAULTS.disposition;
    this.retryable = params.retryable ?? DEFAULTS.retryable;
    this.userSafe = params.userSafe ?? DEFAULTS.userSafe;
    this.context = params.context ? toContext(params.context) : undefined;
    this.cause = params.cause;
  }
}

// -----------------------------------------------------------------------------
// DOMAIN-SPECIFIC ERRORS
// -----------------------------------------------------------------------------

export class ConfigError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super({
      name: "ConfigError",
      code,
      message,
      domain: "config",
      severity: "fatal",
      disposition: "developer",
      retryable: false,
      userSafe: true,
      context,
      cause,
    });
  }
}

export class IpcContractError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super({
      name: "IpcContractError",
      code,
      message,
      domain: "ipc",
      severity: "error",
      disposition: "developer",
      retryable: false,
      userSafe: true,
      context,
      cause,
    });
  }
}

export class AgentError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown, retryable = true) {
    super({
      name: "AgentError",
      code,
      message,
      domain: "agent",
      severity: retryable ? "warn" : "error",
      disposition: "system",
      retryable,
      userSafe: true,
      context,
      cause,
    });
  }
}

export class SecurityViolationError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super({
      name: "SecurityViolationError",
      code,
      message,
      domain: "security",
      severity: "error",
      disposition: "system",
      retryable: false,
      userSafe: true,
      context,
      cause,
    });
  }
}

export class FilesystemError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super({
      name: "FilesystemError",
      code,
      message,
      domain: "filesystem",
      severity: "error",
      disposition: "system",
      retryable: false,
      userSafe: true,
      context,
      cause,
    });
  }
}

export class WindowStateError extends AdjutorixError {
  constructor(code: string, message: string, context?: ErrorContext, cause?: unknown) {
    super({
      name: "WindowStateError",
      code,
      message,
      domain: "window",
      severity: "warn",
      disposition: "system",
      retryable: true,
      userSafe: true,
      context,
      cause,
    });
  }
}

// -----------------------------------------------------------------------------
// SERIALIZATION
// -----------------------------------------------------------------------------

function serializeCause(cause: unknown, depth: number, maxDepth: number): SerializedCause | undefined {
  if (cause === undefined || cause === null || depth >= maxDepth) return undefined;

  const normalized = normalizeError(cause, {
    includeStack: false,
    maxCauseDepth: maxDepth - depth,
  });

  return {
    code: normalized.code,
    name: normalized.name,
    message: normalized.message,
    domain: normalized.domain,
    severity: normalized.severity,
    retryable: normalized.retryable,
    user_safe: normalized.user_safe,
    fingerprint: normalized.fingerprint,
    ...(normalized.context ? { context: normalized.context } : {}),
    ...(normalized.cause ? { cause: normalized.cause } : {}),
  };
}

export function normalizeError(error: unknown, options: NormalizeErrorOptions = {}): ErrorEnvelope {
  const defaultCode = options.defaultCode ?? DEFAULTS.code;
  const defaultDomain = options.defaultDomain ?? DEFAULTS.domain;
  const defaultSeverity = options.defaultSeverity ?? DEFAULTS.severity;
  const defaultDisposition = options.defaultDisposition ?? DEFAULTS.disposition;
  const defaultRetryable = options.defaultRetryable ?? DEFAULTS.retryable;
  const defaultUserSafe = options.defaultUserSafe ?? DEFAULTS.userSafe;
  const includeStack = options.includeStack ?? DEFAULTS.includeStack;
  const maxCauseDepth = options.maxCauseDepth ?? DEFAULTS.maxCauseDepth;

  let base: {
    code: string;
    name: string;
    message: string;
    domain: ErrorDomain;
    severity: ErrorSeverity;
    disposition: ErrorDisposition;
    retryable: boolean;
    userSafe: boolean;
    stack?: string;
    context?: ErrorContext;
    cause?: unknown;
  };

  if (error instanceof AdjutorixError) {
    base = {
      code: error.code,
      name: error.name,
      message: cleanMessage(error.message),
      domain: error.domain,
      severity: error.severity,
      disposition: error.disposition,
      retryable: error.retryable,
      userSafe: error.userSafe,
      ...(includeStack && error.stack ? { stack: redactString(error.stack) } : {}),
      ...(error.context ? { context: toContext(error.context) } : {}),
      ...(error.cause !== undefined ? { cause: error.cause } : {}),
    };
  } else if (error instanceof Error) {
    const anyErr = error as Error & { code?: unknown; cause?: unknown };
    base = {
      code: typeof anyErr.code === "string" ? anyErr.code : defaultCode,
      name: error.name || "Error",
      message: cleanMessage(error.message || "Unknown error"),
      domain: defaultDomain,
      severity: defaultSeverity,
      disposition: defaultDisposition,
      retryable: defaultRetryable,
      userSafe: defaultUserSafe,
      ...(includeStack && error.stack ? { stack: redactString(error.stack) } : {}),
      ...(options.context ? { context: toContext(options.context) } : {}),
      ...(anyErr.cause !== undefined ? { cause: anyErr.cause } : {}),
    };
  } else {
    base = {
      code: defaultCode,
      name: "NonError",
      message: cleanMessage(typeof error === "string" ? error : String(error)),
      domain: defaultDomain,
      severity: defaultSeverity,
      disposition: defaultDisposition,
      retryable: defaultRetryable,
      userSafe: defaultUserSafe,
      ...(options.context ? { context: toContext(options.context) } : {}),
    };
  }

  const normalizedContext = base.context ? toContext(base.context) : undefined;
  const fp = fingerprint({
    code: base.code,
    name: base.name,
    message: base.message,
    domain: base.domain,
    severity: base.severity,
    disposition: base.disposition,
    retryable: base.retryable,
    userSafe: base.userSafe,
    context: normalizedContext,
  });

  return {
    schema: 1,
    code: base.code,
    name: base.name,
    message: base.message,
    domain: base.domain,
    severity: base.severity,
    disposition: base.disposition,
    retryable: base.retryable,
    user_safe: base.userSafe,
    fingerprint: fp,
    ...(base.stack ? { stack: base.stack } : {}),
    ...(normalizedContext ? { context: normalizedContext } : {}),
    ...(base.cause !== undefined ? { cause: serializeCause(base.cause, 1, maxCauseDepth) } : {}),
  };
}

export function validateErrorEnvelope(envelope: ErrorEnvelope): void {
  assert(envelope.schema === 1, "schema_invalid");
  assert(typeof envelope.code === "string" && envelope.code.length > 0, "code_invalid");
  assert(typeof envelope.name === "string" && envelope.name.length > 0, "name_invalid");
  assert(typeof envelope.message === "string" && envelope.message.length > 0, "message_invalid");
  assert(typeof envelope.domain === "string" && envelope.domain.length > 0, "domain_invalid");
  assert(typeof envelope.severity === "string" && envelope.severity.length > 0, "severity_invalid");
  assert(typeof envelope.disposition === "string" && envelope.disposition.length > 0, "disposition_invalid");
  assert(typeof envelope.retryable === "boolean", "retryable_invalid");
  assert(typeof envelope.user_safe === "boolean", "user_safe_invalid");
  assert(typeof envelope.fingerprint === "string" && envelope.fingerprint.length > 0, "fingerprint_invalid");
}

export function serializeErrorEnvelope(envelope: ErrorEnvelope): string {
  validateErrorEnvelope(envelope);
  return stableJson(envelope);
}

export function deserializeErrorEnvelope(raw: string): ErrorEnvelope {
  const parsed = JSON.parse(raw) as ErrorEnvelope;
  validateErrorEnvelope(parsed);
  return parsed;
}

// -----------------------------------------------------------------------------
// PROJECTIONS
// -----------------------------------------------------------------------------

export function toPublicError(envelope: ErrorEnvelope): PublicError {
  validateErrorEnvelope(envelope);
  return {
    code: envelope.code,
    message: envelope.user_safe ? envelope.message : "An internal error occurred.",
    domain: envelope.domain,
    severity: envelope.severity,
    retryable: envelope.retryable,
    fingerprint: envelope.fingerprint,
  };
}

export function projectError(error: unknown, mode: ErrorProjectionMode, options: NormalizeErrorOptions = {}): ErrorEnvelope | PublicError | string {
  const normalized = normalizeError(error, options);

  switch (mode) {
    case "internal":
    case "log":
      return normalized;
    case "ipc":
      return toPublicError(normalized);
    case "dialog":
      return normalized.user_safe ? normalized.message : `Unexpected error. Reference: ${normalized.fingerprint}`;
    default:
      return normalized;
  }
}

// -----------------------------------------------------------------------------
// FACTORY HELPERS
// -----------------------------------------------------------------------------

export function configError(code: string, message: string, context?: ErrorContext, cause?: unknown): ConfigError {
  return new ConfigError(code, message, context, cause);
}

export function ipcError(code: string, message: string, context?: ErrorContext, cause?: unknown): IpcContractError {
  return new IpcContractError(code, message, context, cause);
}

export function agentError(code: string, message: string, context?: ErrorContext, cause?: unknown, retryable = true): AgentError {
  return new AgentError(code, message, context, cause, retryable);
}

export function securityError(code: string, message: string, context?: ErrorContext, cause?: unknown): SecurityViolationError {
  return new SecurityViolationError(code, message, context, cause);
}

export function filesystemError(code: string, message: string, context?: ErrorContext, cause?: unknown): FilesystemError {
  return new FilesystemError(code, message, context, cause);
}

export function windowStateError(code: string, message: string, context?: ErrorContext, cause?: unknown): WindowStateError {
  return new WindowStateError(code, message, context, cause);
}
