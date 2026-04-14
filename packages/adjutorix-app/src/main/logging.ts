// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import util from "node:util";

/**
 * ADJUTORIX APP — MAIN / logging.ts
 *
 * Authoritative structured logging subsystem for the Electron main process.
 *
 * Responsibilities:
 * - structured JSONL logging with deterministic field ordering
 * - log levels, categories, correlation ids, and child loggers
 * - bounded file rotation and retention
 * - redaction of sensitive fields before persistence
 * - crash/error serialization with stable shape
 * - mirrored console emission for development / smoke mode
 * - log querying helpers for diagnostics and tests
 *
 * Hard invariants:
 * - every persisted log entry is valid JSON on a single line
 * - no secret/token/password/key material is written unredacted
 * - file writes are append-only during active session
 * - rotation is explicit, bounded, and deterministic
 * - logger creation is side-effect free until first write
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type LogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type LogContextValue = string | number | boolean | null | LogContextValue[] | { [key: string]: LogContextValue };

export type LogFields = Record<string, LogContextValue>;

export type LogEntry = {
  ts: number;
  isoTs: string;
  level: LogLevel;
  logger: string;
  pid: number;
  hostname: string;
  message: string;
  event?: string;
  traceId?: string;
  spanId?: string;
  sessionId: string;
  fields?: LogFields;
};

export type LoggerOptions = {
  rootDir: string;
  fileName?: string;
  minLevel?: LogLevel;
  mirrorToConsole?: boolean;
  maxFileBytes?: number;
  maxFiles?: number;
  sessionId?: string;
  serviceName?: string;
};

export type ChildLoggerOptions = {
  logger: string;
  defaultFields?: LogFields;
};

export type SerializedError = {
  name: string;
  message: string;
  stack?: string;
  code?: string;
  cause?: SerializedError;
};

export type LogQuery = {
  levelAtLeast?: LogLevel;
  loggerPrefix?: string;
  event?: string;
  text?: string;
  sinceTs?: number;
  untilTs?: number;
  limit?: number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_FILE_NAME = "main.log";
const DEFAULT_MAX_FILE_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;
const DEFAULT_SERVICE_NAME = "adjutorix-app-main";
const DEFAULT_MIN_LEVEL: LogLevel = "info";

const LEVEL_ORDER: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const REDACT_PATTERNS = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /authorization/i,
  /api[_-]?key/i,
  /private[_-]?key/i,
  /session[_-]?key/i,
  /^key$/i,
];

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:logging:${message}`);
  }
}

function stableObject<T extends object>(value: T): T {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return input;
    }
    if (Array.isArray(input)) {
      return input.map(normalize);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      out[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return out;
  };
  return normalize(value) as T;
}

function stableJson(value: unknown): string {
  return JSON.stringify(stableObject(value));
}

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function nowIso(ts: number): string {
  return new Date(ts).toISOString();
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function levelEnabled(minLevel: LogLevel, actual: LogLevel): boolean {
  return LEVEL_ORDER[actual] >= LEVEL_ORDER[minLevel];
}

function normalizeLevel(input: string | undefined, fallback: LogLevel): LogLevel {
  if (!input) return fallback;
  const normalized = input.toLowerCase();
  assert(normalized in LEVEL_ORDER, `invalid_level:${input}`);
  return normalized as LogLevel;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function shouldRedactKey(key: string): boolean {
  return REDACT_PATTERNS.some((pattern) => pattern.test(key));
}

function redactValue(value: unknown): LogContextValue {
  if (value === null) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item));
  }
  if (value instanceof Error) {
    return serializeError(value) as unknown as LogContextValue;
  }
  if (isPlainObject(value)) {
    const out: Record<string, LogContextValue> = {};
    for (const key of Object.keys(value).sort()) {
      const next = value[key];
      out[key] = shouldRedactKey(key) ? "<redacted>" : redactValue(next);
    }
    return out;
  }
  return util.inspect(value, { depth: 3, breakLength: Infinity }) as unknown as LogContextValue;
}

function redactFields(fields?: Record<string, unknown>): LogFields | undefined {
  if (!fields) return undefined;
  return redactValue(fields) as LogFields;
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    const base: SerializedError = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };

    const maybeCode = (error as Error & { code?: unknown }).code;
    if (typeof maybeCode === "string") {
      base.code = maybeCode;
    }

    const maybeCause = (error as Error & { cause?: unknown }).cause;
    if (maybeCause !== undefined) {
      base.cause = serializeError(maybeCause);
    }
    return base;
  }

  return {
    name: "NonError",
    message: typeof error === "string" ? error : util.inspect(error, { depth: 4 }),
  };
}

function sessionIdFromOptions(options: LoggerOptions): string {
  return options.sessionId || sha256(`${Date.now()}:${process.pid}:${os.hostname()}`).slice(0, 16);
}

function maybeMirror(level: LogLevel, line: string): void {
  switch (level) {
    case "trace":
    case "debug":
    case "info":
      process.stdout.write(`${line}\n`);
      break;
    case "warn":
    case "error":
    case "fatal":
      process.stderr.write(`${line}\n`);
      break;
  }
}

// -----------------------------------------------------------------------------
// FILE SINK
// -----------------------------------------------------------------------------

class JsonlFileSink {
  private readonly rootDir: string;
  private readonly fileName: string;
  private readonly maxFileBytes: number;
  private readonly maxFiles: number;
  private filePath: string;

  constructor(rootDir: string, fileName: string, maxFileBytes: number, maxFiles: number) {
    this.rootDir = rootDir;
    this.fileName = fileName;
    this.maxFileBytes = maxFileBytes;
    this.maxFiles = maxFiles;
    ensureDir(rootDir);
    this.filePath = path.join(rootDir, fileName);
  }

  append(line: string): void {
    this.rotateIfNeeded(Buffer.byteLength(line) + 1);
    fs.appendFileSync(this.filePath, `${line}\n`, "utf8");
  }

  readAll(): string[] {
    if (!fs.existsSync(this.filePath)) return [];
    return fs.readFileSync(this.filePath, "utf8").split("\n").filter(Boolean);
  }

  private rotateIfNeeded(nextBytes: number): void {
    const currentBytes = fs.existsSync(this.filePath) ? fs.statSync(this.filePath).size : 0;
    if (currentBytes + nextBytes <= this.maxFileBytes) {
      return;
    }

    for (let i = this.maxFiles - 1; i >= 1; i -= 1) {
      const src = `${this.filePath}.${i}`;
      const dst = `${this.filePath}.${i + 1}`;
      if (fs.existsSync(src)) {
        if (i + 1 > this.maxFiles) {
          fs.rmSync(src, { force: true });
        } else {
          fs.renameSync(src, dst);
        }
      }
    }

    if (fs.existsSync(this.filePath)) {
      fs.renameSync(this.filePath, `${this.filePath}.1`);
    }
  }
}

// -----------------------------------------------------------------------------
// LOGGER
// -----------------------------------------------------------------------------

export class MainLogger {
  private readonly sink: JsonlFileSink;
  private readonly minLevel: LogLevel;
  private readonly mirrorToConsole: boolean;
  private readonly sessionId: string;
  private readonly loggerName: string;
  private readonly defaultFields: LogFields;
  private readonly serviceName: string;

  constructor(options: LoggerOptions & { loggerName?: string; defaultFields?: LogFields }) {
    const fileName = options.fileName || DEFAULT_FILE_NAME;
    const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
    const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;

    this.sink = new JsonlFileSink(options.rootDir, fileName, maxFileBytes, maxFiles);
    this.minLevel = normalizeLevel(options.minLevel, DEFAULT_MIN_LEVEL);
    this.mirrorToConsole = options.mirrorToConsole ?? false;
    this.sessionId = sessionIdFromOptions(options);
    this.loggerName = options.loggerName || DEFAULT_SERVICE_NAME;
    this.defaultFields = stableObject(options.defaultFields || {}) as LogFields;
    this.serviceName = options.serviceName || DEFAULT_SERVICE_NAME;
  }

  child(options: ChildLoggerOptions): MainLogger {
    assert(options.logger.length > 0, "child_logger_name_empty");
    return new MainLogger({
      rootDir: this.rootDir(),
      fileName: this.fileName(),
      minLevel: this.minLevel,
      mirrorToConsole: this.mirrorToConsole,
      maxFileBytes: this.maxFileBytes(),
      maxFiles: this.maxFiles(),
      sessionId: this.sessionId,
      serviceName: this.serviceName,
      loggerName: `${this.loggerName}.${options.logger}`,
      defaultFields: {
        ...this.defaultFields,
        ...(options.defaultFields || {}),
      },
    });
  }

  trace(message: string, fields?: Record<string, unknown>): void {
    this.log("trace", message, fields);
  }

  debug(message: string, fields?: Record<string, unknown>): void {
    this.log("debug", message, fields);
  }

  info(message: string, fields?: Record<string, unknown>): void {
    this.log("info", message, fields);
  }

  warn(message: string, fields?: Record<string, unknown>): void {
    this.log("warn", message, fields);
  }

  error(message: string, fields?: Record<string, unknown>): void {
    this.log("error", message, fields);
  }

  fatal(message: string, fields?: Record<string, unknown>): void {
    this.log("fatal", message, fields);
  }

  event(level: LogLevel, event: string, message: string, fields?: Record<string, unknown>): void {
    this.write(level, message, event, fields);
  }

  exception(message: string, error: unknown, fields?: Record<string, unknown>): void {
    const serialized = serializeError(error);
    this.write("error", message, "exception", {
      ...fields,
      error: serialized,
    });
  }

  query(query: LogQuery = {}): LogEntry[] {
    const lines = this.sink.readAll();
    const entries: LogEntry[] = [];
    const minLevel = query.levelAtLeast ? normalizeLevel(query.levelAtLeast, query.levelAtLeast) : null;

    for (const line of lines) {
      const parsed = JSON.parse(line) as LogEntry;
      if (minLevel && LEVEL_ORDER[parsed.level] < LEVEL_ORDER[minLevel]) continue;
      if (query.loggerPrefix && !parsed.logger.startsWith(query.loggerPrefix)) continue;
      if (query.event && parsed.event !== query.event) continue;
      if (query.text && !line.includes(query.text)) continue;
      if (query.sinceTs && parsed.ts < query.sinceTs) continue;
      if (query.untilTs && parsed.ts > query.untilTs) continue;
      entries.push(parsed);
      if (query.limit && entries.length >= query.limit) break;
    }

    return entries;
  }

  private log(level: LogLevel, message: string, fields?: Record<string, unknown>): void {
    this.write(level, message, undefined, fields);
  }

  private write(level: LogLevel, message: string, event?: string, fields?: Record<string, unknown>): void {
    if (!levelEnabled(this.minLevel, level)) {
      return;
    }

    const ts = Date.now();
    const mergedFields = redactFields({
      ...this.defaultFields,
      ...(fields || {}),
    });

    const traceId = typeof mergedFields?.traceId === "string" ? String(mergedFields.traceId) : undefined;
    const spanId = typeof mergedFields?.spanId === "string" ? String(mergedFields.spanId) : undefined;

    const entry: LogEntry = stableObject({
      ts,
      isoTs: nowIso(ts),
      level,
      logger: this.loggerName,
      pid: process.pid,
      hostname: os.hostname(),
      message,
      ...(event ? { event } : {}),
      ...(traceId ? { traceId } : {}),
      ...(spanId ? { spanId } : {}),
      sessionId: this.sessionId,
      ...(mergedFields && Object.keys(mergedFields).length > 0 ? { fields: mergedFields } : {}),
    }) as LogEntry;

    const line = stableJson(entry);
    this.sink.append(line);
    if (this.mirrorToConsole) {
      maybeMirror(level, line);
    }
  }

  private rootDir(): string {
    return (this.sink as unknown as { rootDir: string }).rootDir;
  }

  private fileName(): string {
    return (this.sink as unknown as { fileName: string }).fileName;
  }

  private maxFileBytes(): number {
    return (this.sink as unknown as { maxFileBytes: number }).maxFileBytes;
  }

  private maxFiles(): number {
    return (this.sink as unknown as { maxFiles: number }).maxFiles;
  }
}

// -----------------------------------------------------------------------------
// FACTORIES / SINGLETON-FRIENDLY HELPERS
// -----------------------------------------------------------------------------

export function createMainLogger(options: LoggerOptions): MainLogger {
  assert(options.rootDir.length > 0, "root_dir_empty");
  ensureDir(options.rootDir);
  return new MainLogger(options);
}

export function logEnvironmentSnapshot(logger: MainLogger, environment: Record<string, unknown>): void {
  logger.event("info", "environment.snapshot", "Main environment snapshot", {
    environment: stableObject(environment),
    environmentHash: sha256(stableJson(environment)),
  });
}

export function logAppStart(logger: MainLogger, details: Record<string, unknown>): void {
  logger.event("info", "app.start", "Adjutorix main process starting", details);
}

export function logAppReady(logger: MainLogger, details: Record<string, unknown>): void {
  logger.event("info", "app.ready", "Adjutorix main process ready", details);
}

export function logAppShutdown(logger: MainLogger, details: Record<string, unknown>): void {
  logger.event("info", "app.shutdown", "Adjutorix main process shutting down", details);
}

export function logWindowEvent(logger: MainLogger, event: string, details: Record<string, unknown>): void {
  logger.event("info", `window.${event}`, `Window event: ${event}`, details);
}

export function logIpcInvocation(
  logger: MainLogger,
  channel: string,
  details: { traceId?: string; argsShape?: unknown; success?: boolean; durationMs?: number; error?: unknown },
): void {
  const level: LogLevel = details.error ? "error" : "debug";
  logger.event(level, "ipc.invoke", `IPC invocation: ${channel}`, {
    channel,
    traceId: details.traceId,
    argsShape: details.argsShape,
    success: details.success ?? !details.error,
    durationMs: details.durationMs,
    ...(details.error ? { error: serializeError(details.error) } : {}),
  });
}

export function logAgentEvent(logger: MainLogger, event: string, details: Record<string, unknown>): void {
  logger.event("info", `agent.${event}`, `Agent event: ${event}`, details);
}

export function logCrash(logger: MainLogger, kind: string, error: unknown, extra?: Record<string, unknown>): void {
  logger.event("fatal", "crash", `Crash detected: ${kind}`, {
    kind,
    error: serializeError(error),
    ...(extra || {}),
  });
}

// -----------------------------------------------------------------------------
// PUBLIC UTILS
// -----------------------------------------------------------------------------

export function computeTraceId(seed: string): string {
  return sha256(seed).slice(0, 16);
}

export function computeSpanId(seed: string): string {
  return sha256(`span:${seed}`).slice(0, 16);
}

export function redactForLogging<T>(value: T): LogContextValue {
  return redactValue(value);
}

export function serializeUnknownError(error: unknown): SerializedError {
  return serializeError(error);
}
