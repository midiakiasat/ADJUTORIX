// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  createEvent,
  serializeEvent,
  type EventEnvelope,
  type EventFactoryContext,
  type EventKind,
  type EventPayload,
} from "@main/observability/events";
import {
  normalizeError,
  serializeErrorEnvelope,
  type ErrorEnvelope,
  type NormalizeErrorOptions,
} from "@main/observability/errors";
import {
  recordDiagnosticExport,
  recordIpcInvocation,
  recordMenuAction,
  recordWindowEvent,
  type MetricsRegistry,
} from "@main/observability/metrics";

/**
 * ADJUTORIX APP — MAIN / OBSERVABILITY / logging.ts
 *
 * High-level observability logging facade for the Electron main process.
 *
 * Responsibilities:
 * - unify structured log lines, typed events, and normalized errors
 * - maintain crash-safe append-only journal semantics
 * - mirror selected activity to console in debug/smoke modes
 * - bind logging to metrics without duplicating instrumentation code
 * - emit deterministic snapshots for diagnostics/export
 * - provide child scopes with trace/session inheritance
 *
 * Hard invariants:
 * - every written line is single-line JSON
 * - events and errors are serialized through canonical modules only
 * - log scope/context is immutable once constructed
 * - file writes are append-only during steady-state execution
 * - buffer flushing is explicit and bounded
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type LogContext = Record<string, JsonValue>;

export type LogLine = {
  schema: 1;
  kind: "log";
  ts_ms: number;
  iso_ts: string;
  level: LogLevel;
  logger: string;
  session_id: string;
  trace_id?: string;
  span_id?: string;
  message: string;
  context?: LogContext;
  hash: string;
};

export type LoggingOptions = {
  rootDir: string;
  fileName?: string;
  mirrorToConsole?: boolean;
  bufferSize?: number;
  sessionId: string;
  source: string;
  metrics?: MetricsRegistry | null;
};

export type ChildLoggerOptions = {
  logger: string;
  traceId?: string;
  spanId?: string;
  defaultContext?: LogContext;
};

export type LoggingSnapshot = {
  schema: 1;
  logger: string;
  session_id: string;
  buffered_lines: number;
  file_path: string;
  file_sha256: string | null;
  hash: string;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_FILE_NAME = "observability.jsonl";
const DEFAULT_BUFFER_SIZE = 1;
const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:observability:logging:${message}`);
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

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function nowIso(ts: number): string {
  return new Date(ts).toISOString();
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

function normalizeContext(input?: LogContext): LogContext | undefined {
  if (!input) return undefined;
  return normalizeJson(input) as LogContext;
}

function levelEnabled(minLevel: LogLevel, actual: LogLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[minLevel];
}

// -----------------------------------------------------------------------------
// FILE SINK
// -----------------------------------------------------------------------------

class JsonlSink {
  public readonly filePath: string;

  constructor(rootDir: string, fileName: string) {
    ensureDir(rootDir);
    this.filePath = path.join(rootDir, fileName);
  }

  appendLines(lines: string[]): void {
    if (lines.length === 0) return;
    fs.appendFileSync(this.filePath, `${lines.join("\n")}\n`, "utf8");
  }

  readAll(): string[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
  }

  sha256(): string | null {
    if (!fs.existsSync(this.filePath)) return null;
    return sha256(fs.readFileSync(this.filePath));
  }
}

// -----------------------------------------------------------------------------
// LOGGER
// -----------------------------------------------------------------------------

export class ObservabilityLogger {
  private readonly sink: JsonlSink;
  private readonly mirrorToConsole: boolean;
  private readonly bufferSize: number;
  private readonly sessionId: string;
  private readonly source: string;
  private readonly loggerName: string;
  private readonly defaultContext?: LogContext;
  private readonly traceId?: string;
  private readonly spanId?: string;
  private readonly metrics: MetricsRegistry | null;
  private readonly buffer: string[];
  private minLevel: LogLevel;

  constructor(options: LoggingOptions & {
    loggerName?: string;
    defaultContext?: LogContext;
    traceId?: string;
    spanId?: string;
    minLevel?: LogLevel;
  }) {
    this.sink = new JsonlSink(options.rootDir, options.fileName ?? DEFAULT_FILE_NAME);
    this.mirrorToConsole = options.mirrorToConsole ?? false;
    this.bufferSize = Math.max(1, options.bufferSize ?? DEFAULT_BUFFER_SIZE);
    this.sessionId = options.sessionId;
    this.source = options.source;
    this.loggerName = options.loggerName ?? options.source;
    this.defaultContext = normalizeContext(options.defaultContext);
    this.traceId = options.traceId;
    this.spanId = options.spanId;
    this.metrics = options.metrics ?? null;
    this.buffer = [];
    this.minLevel = options.minLevel ?? "info";
  }

  setMinLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  child(options: ChildLoggerOptions): ObservabilityLogger {
    return new ObservabilityLogger({
      rootDir: path.dirname(this.sink.filePath),
      fileName: path.basename(this.sink.filePath),
      mirrorToConsole: this.mirrorToConsole,
      bufferSize: this.bufferSize,
      sessionId: this.sessionId,
      source: this.source,
      metrics: this.metrics,
      loggerName: `${this.loggerName}.${options.logger}`,
      traceId: options.traceId ?? this.traceId,
      spanId: options.spanId ?? this.spanId,
      defaultContext: {
        ...(this.defaultContext ?? {}),
        ...(options.defaultContext ?? {}),
      },
      minLevel: this.minLevel,
    });
  }

  trace(message: string, context?: LogContext): void { this.writeLog("trace", message, context); }
  debug(message: string, context?: LogContext): void { this.writeLog("debug", message, context); }
  info(message: string, context?: LogContext): void { this.writeLog("info", message, context); }
  warn(message: string, context?: LogContext): void { this.writeLog("warn", message, context); }
  error(message: string, context?: LogContext): void { this.writeLog("error", message, context); }
  fatal(message: string, context?: LogContext): void { this.writeLog("fatal", message, context); }

  event(kind: EventKind, payload: EventPayload, context?: LogContext): EventEnvelope {
    const evt = createEvent(this.eventContext(), kind, {
      ...payload,
      ...(context ? { log_context: normalizeJson(context) } : {}),
    });
    this.enqueue(serializeEvent(evt));
    return evt;
  }

  exception(message: string, error: unknown, options: NormalizeErrorOptions = {}, context?: LogContext): ErrorEnvelope {
    const envelope = normalizeError(error, {
      ...options,
      context: {
        ...(options.context ?? {}),
        ...(context ?? {}),
      },
    });

    const line = stableJson({
      schema: 1,
      kind: "error",
      ts_ms: Date.now(),
      iso_ts: nowIso(Date.now()),
      logger: this.loggerName,
      session_id: this.sessionId,
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(this.spanId ? { span_id: this.spanId } : {}),
      message,
      envelope,
      hash: sha256(stableJson({ logger: this.loggerName, session_id: this.sessionId, message, envelope })),
    });

    this.enqueue(line);
    return envelope;
  }

  ipcInvocation(channel: string, success: boolean, durationMs: number, context?: LogContext): void {
    this.metrics && recordIpcInvocation(this.metrics, channel, success, durationMs);
    this.writeLog(success ? "debug" : "error", `IPC ${success ? "success" : "failure"}: ${channel}`, {
      channel,
      success,
      duration_ms: durationMs,
      ...(context ?? {}),
    });
  }

  menuAction(action: string, context?: LogContext): void {
    this.metrics && recordMenuAction(this.metrics, action);
    this.writeLog("info", `Menu action: ${action}`, { action, ...(context ?? {}) });
  }

  windowEvent(event: string, context?: LogContext): void {
    this.metrics && recordWindowEvent(this.metrics, event);
    this.writeLog("debug", `Window event: ${event}`, { event, ...(context ?? {}) });
  }

  diagnosticExport(kind: string, bytes: number, context?: LogContext): void {
    this.metrics && recordDiagnosticExport(this.metrics, bytes, kind);
    this.writeLog("info", `Diagnostics exported: ${kind}`, {
      kind,
      bytes,
      ...(context ?? {}),
    });
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    this.sink.appendLines(this.buffer);
    this.buffer.length = 0;
  }

  snapshot(): LoggingSnapshot {
    const snapCore = {
      schema: 1 as const,
      logger: this.loggerName,
      session_id: this.sessionId,
      buffered_lines: this.buffer.length,
      file_path: this.sink.filePath,
      file_sha256: this.sink.sha256(),
    };
    return {
      ...snapCore,
      hash: sha256(stableJson(snapCore)),
    };
  }

  readLines(): string[] {
    this.flush();
    return this.sink.readAll();
  }

  private writeLog(level: LogLevel, message: string, context?: LogContext): void {
    if (!levelEnabled(this.minLevel, level)) return;

    const ts_ms = Date.now();
    const normalizedContext = normalizeContext({
      ...(this.defaultContext ?? {}),
      ...(context ?? {}),
    });

    const lineCore = {
      schema: 1 as const,
      kind: "log" as const,
      ts_ms,
      iso_ts: nowIso(ts_ms),
      level,
      logger: this.loggerName,
      session_id: this.sessionId,
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(this.spanId ? { span_id: this.spanId } : {}),
      message,
      ...(normalizedContext ? { context: normalizedContext } : {}),
    };

    const line: LogLine = {
      ...lineCore,
      hash: sha256(stableJson(lineCore)),
    };

    this.enqueue(stableJson(line));
  }

  private enqueue(line: string): void {
    this.buffer.push(line);
    if (this.mirrorToConsole) {
      process.stdout.write(`${line}\n`);
    }
    if (this.buffer.length >= this.bufferSize) {
      this.flush();
    }
  }

  private eventContext(): EventFactoryContext {
    return {
      source: this.source,
      session_id: this.sessionId,
      ...(this.traceId ? { trace_id: this.traceId } : {}),
      ...(this.spanId ? { span_id: this.spanId } : {}),
    };
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createObservabilityLogger(options: LoggingOptions & { loggerName?: string; defaultContext?: LogContext; minLevel?: LogLevel }): ObservabilityLogger {
  assert(options.rootDir.length > 0, "root_dir_empty");
  assert(options.sessionId.length > 0, "session_id_empty");
  assert(options.source.length > 0, "source_empty");
  return new ObservabilityLogger(options);
}

export function validateLoggingSnapshot(snapshot: LoggingSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  assert(snapshot.logger.length > 0, "snapshot_logger_invalid");
  assert(snapshot.session_id.length > 0, "snapshot_session_invalid");
  assert(snapshot.file_path.length > 0, "snapshot_file_path_invalid");

  const core = {
    schema: 1 as const,
    logger: snapshot.logger,
    session_id: snapshot.session_id,
    buffered_lines: snapshot.buffered_lines,
    file_path: snapshot.file_path,
    file_sha256: snapshot.file_sha256,
  };
  assert(sha256(stableJson(core)) === snapshot.hash, "snapshot_hash_drift");
}

export function serializeLoggingSnapshot(snapshot: LoggingSnapshot): string {
  validateLoggingSnapshot(snapshot);
  return stableJson(snapshot);
}
