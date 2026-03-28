import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / file_watcher.ts
 *
 * Deterministic filesystem observation layer for workspace-scoped monitoring.
 *
 * Purpose:
 * - wrap platform-specific watch behavior behind a stable domain contract
 * - normalize raw fs events into bounded, rooted, audit-friendly file events
 * - debounce/coalesce noisy event bursts into deterministic batches
 * - enforce root-bound path safety and ignore policy consistently
 * - expose lifecycle control, health state, and snapshotting for diagnostics/tests
 *
 * This is NOT a generic thin wrapper around fs.watch.
 * It is a workspace security + observability component.
 *
 * Hard invariants:
 * - watcher never emits paths outside the configured root
 * - hidden/ignored paths are filtered before publication
 * - emitted batches are stable-sorted and hashable
 * - watcher lifecycle is explicit and idempotent
 * - stop() tears down all resources and pending timers
 * - identical semantic event sets produce identical batch hashes
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

export type FileWatchRawEventKind = "rename" | "change" | "unknown";
export type FileWatchDerivedEventKind = "created" | "modified" | "deleted" | "renamed" | "unknown";
export type FileWatchHealth = "idle" | "starting" | "watching" | "stopped" | "error";

export type FileWatchEvent = {
  schema: 1;
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  rawKind: FileWatchRawEventKind;
  derivedKind: FileWatchDerivedEventKind;
  exists: boolean;
  isDirectory: boolean | null;
  ts_ms: number;
  hash: string;
};

export type FileWatchBatch = {
  schema: 1;
  rootPath: string;
  startedAtMs: number;
  emittedAtMs: number;
  count: number;
  events: FileWatchEvent[];
  hash: string;
};

export type FileWatcherSnapshot = {
  schema: 1;
  rootPath: string | null;
  health: FileWatchHealth;
  watching: boolean;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  lastEventAtMs: number | null;
  lastEmitAtMs: number | null;
  lastError: string | null;
  pendingEventCount: number;
  emittedBatchCount: number;
  ignoredCount: number;
  hash: string;
};

export type FileWatcherPolicy = {
  recursive: boolean;
  debounceMs: number;
  maxBatchSize: number;
  ignoreHidden: boolean;
  ignoreGit: boolean;
  ignoreNodeModules: boolean;
  ignoreDist: boolean;
  ignoreBuild: boolean;
  extraIgnoredNames: string[];
  extraIgnoredPathPrefixes: string[];
  allowSymlinkedChildren: boolean;
};

export type FileWatcherAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "start" | "stop" | "raw_event" | "emit_batch" | "ignore" | "error";
  decision: "allow" | "deny";
  rootPath: string;
  reason: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type FileWatcherAuditFn = (record: FileWatcherAuditRecord) => void;

export type FileWatcherHooks = {
  onBatch?: (batch: FileWatchBatch) => Promise<void> | void;
  onError?: (error: Error, snapshot: FileWatcherSnapshot) => Promise<void> | void;
};

export type FileWatcherOptions = {
  rootPath: string;
  policy?: Partial<FileWatcherPolicy>;
  audit?: FileWatcherAuditFn;
  hooks?: FileWatcherHooks;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: FileWatcherPolicy = {
  recursive: true,
  debounceMs: 100,
  maxBatchSize: 1024,
  ignoreHidden: true,
  ignoreGit: true,
  ignoreNodeModules: true,
  ignoreDist: false,
  ignoreBuild: false,
  extraIgnoredNames: [],
  extraIgnoredPathPrefixes: [],
  allowSymlinkedChildren: false,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:workspace:file_watcher:${message}`);
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

function normalizePath(input: string): string {
  assert(typeof input === "string" && input.trim().length > 0, "path_invalid");
  return path.resolve(input.trim());
}

function exists(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
  }
}

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function relativeWithinRoot(rootPath: string, absolutePath: string): string | null {
  const rel = path.relative(rootPath, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel || ".";
}

function normalizeRawKind(value: string): FileWatchRawEventKind {
  return value === "rename" || value === "change" ? value : "unknown";
}

function deriveKind(rawKind: FileWatchRawEventKind, existsNow: boolean): FileWatchDerivedEventKind {
  if (rawKind === "change") return existsNow ? "modified" : "unknown";
  if (rawKind === "rename") return existsNow ? "renamed" : "deleted";
  return existsNow ? "unknown" : "deleted";
}

function stableSortEvents(events: FileWatchEvent[]): FileWatchEvent[] {
  return [...events].sort((a, b) => {
    if (a.relativePath !== b.relativePath) return a.relativePath.localeCompare(b.relativePath);
    if (a.derivedKind !== b.derivedKind) return a.derivedKind.localeCompare(b.derivedKind);
    if (a.rawKind !== b.rawKind) return a.rawKind.localeCompare(b.rawKind);
    return a.hash.localeCompare(b.hash);
  });
}

function eventHash(core: Omit<FileWatchEvent, "hash">): string {
  return sha256(stableJson(core));
}

function batchHash(core: Omit<FileWatchBatch, "hash">): string {
  return sha256(stableJson(core));
}

function snapshotHash(core: Omit<FileWatcherSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<FileWatcherAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function nowMs(now: (() => number) | undefined): number {
  return (now ?? Date.now)();
}

async function maybeCall<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

async function maybeCallError(
  fn: ((error: Error, snapshot: FileWatcherSnapshot) => Promise<void> | void) | undefined,
  error: Error,
  snapshot: FileWatcherSnapshot,
): Promise<void> {
  if (fn) await fn(error, snapshot);
}

// -----------------------------------------------------------------------------
// FILE WATCHER
// -----------------------------------------------------------------------------

export class WorkspaceFileWatcher extends EventEmitter {
  private readonly rootPath: string;
  private readonly policy: FileWatcherPolicy;
  private readonly audit?: FileWatcherAuditFn;
  private readonly hooks?: FileWatcherHooks;
  private readonly now?: () => number;

  private watcher: fs.FSWatcher | null = null;
  private debounceTimer: NodeJS.Timeout | null = null;
  private pending: Map<string, FileWatchEvent> = new Map();
  private health: FileWatchHealth = "idle";
  private startedAtMs: number | null = null;
  private stoppedAtMs: number | null = null;
  private lastEventAtMs: number | null = null;
  private lastEmitAtMs: number | null = null;
  private lastError: string | null = null;
  private emittedBatchCount = 0;
  private ignoredCount = 0;

  constructor(options: FileWatcherOptions) {
    super();
    const normalizedRoot = normalizePath(options.rootPath);
    assert(exists(normalizedRoot), "root_missing");
    assert(statSafe(normalizedRoot)?.isDirectory(), "root_not_directory");

    this.rootPath = normalizedRoot;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.hooks = options.hooks;
    this.now = options.now;
  }

  start(): void {
    if (this.watcher) return;

    this.health = "starting";
    this.startedAtMs = nowMs(this.now);
    this.stoppedAtMs = null;
    this.emitAudit("start", "allow", "watcher_starting", {
      recursive: this.policy.recursive,
      debounceMs: this.policy.debounceMs,
    });

    try {
      this.watcher = fs.watch(this.rootPath, { recursive: this.policy.recursive }, (eventType, filename) => {
        void this.handleRawEvent(eventType, typeof filename === "string" ? filename : "");
      });

      this.watcher.on("error", (error) => {
        void this.handleError(error instanceof Error ? error : new Error(String(error)));
      });

      this.health = "watching";
      this.emit("started", this.snapshot());
    } catch (error) {
      void this.handleError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  stop(): void {
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    this.pending.clear();
    this.health = "stopped";
    this.stoppedAtMs = nowMs(this.now);
    this.emitAudit("stop", "allow", "watcher_stopped", {
      emittedBatchCount: this.emittedBatchCount,
      ignoredCount: this.ignoredCount,
    });
    this.emit("stopped", this.snapshot());
  }

  snapshot(): FileWatcherSnapshot {
    const core: Omit<FileWatcherSnapshot, "hash"> = {
      schema: 1,
      rootPath: this.rootPath,
      health: this.health,
      watching: this.watcher !== null,
      startedAtMs: this.startedAtMs,
      stoppedAtMs: this.stoppedAtMs,
      lastEventAtMs: this.lastEventAtMs,
      lastEmitAtMs: this.lastEmitAtMs,
      lastError: this.lastError,
      pendingEventCount: this.pending.size,
      emittedBatchCount: this.emittedBatchCount,
      ignoredCount: this.ignoredCount,
    };
    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  root(): string {
    return this.rootPath;
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  dispose(): void {
    this.stop();
    this.removeAllListeners();
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private async handleRawEvent(eventType: string, filename: string): Promise<void> {
    if (!this.watcher) return;

    const ts = nowMs(this.now);
    this.lastEventAtMs = ts;

    const joined = filename ? path.join(this.rootPath, filename) : this.rootPath;
    const absolutePath = normalizePath(joined);
    const relativePath = relativeWithinRoot(this.rootPath, absolutePath);

    if (relativePath === null) {
      this.ignoredCount += 1;
      this.emitAudit("ignore", "deny", "path_escaped_root", { absolutePath, filename });
      return;
    }

    if (!this.policy.allowSymlinkedChildren && isSymlink(absolutePath)) {
      this.ignoredCount += 1;
      this.emitAudit("ignore", "deny", "symlink_child_blocked", { absolutePath, relativePath });
      return;
    }

    if (this.shouldIgnore(relativePath)) {
      this.ignoredCount += 1;
      this.emitAudit("ignore", "deny", "path_ignored_by_policy", { relativePath });
      return;
    }

    const rawKind = normalizeRawKind(eventType);
    const stats = statSafe(absolutePath);
    const existsNow = stats !== null;
    const derivedKind = deriveKind(rawKind, existsNow);

    const eventCore: Omit<FileWatchEvent, "hash"> = {
      schema: 1,
      rootPath: this.rootPath,
      absolutePath,
      relativePath,
      rawKind,
      derivedKind,
      exists: existsNow,
      isDirectory: stats ? stats.isDirectory() : null,
      ts_ms: ts,
    };

    const event: FileWatchEvent = {
      ...eventCore,
      hash: eventHash(eventCore),
    };

    this.pending.set(`${event.relativePath}::${event.derivedKind}`, event);
    this.emitAudit("raw_event", "allow", "raw_event_buffered", {
      relativePath: event.relativePath,
      rawKind: event.rawKind,
      derivedKind: event.derivedKind,
      exists: event.exists,
    });

    if (this.pending.size >= this.policy.maxBatchSize) {
      await this.flush();
      return;
    }

    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
    }
    this.debounceTimer = setTimeout(() => {
      void this.flush();
    }, this.policy.debounceMs);
  }

  private async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }

    const emittedAtMs = nowMs(this.now);
    const events = stableSortEvents([...this.pending.values()]);
    this.pending.clear();

    const core: Omit<FileWatchBatch, "hash"> = {
      schema: 1,
      rootPath: this.rootPath,
      startedAtMs: this.startedAtMs ?? emittedAtMs,
      emittedAtMs,
      count: events.length,
      events,
    };
    const batch: FileWatchBatch = {
      ...core,
      hash: batchHash(core),
    };

    this.lastEmitAtMs = emittedAtMs;
    this.emittedBatchCount += 1;

    this.emitAudit("emit_batch", "allow", "batch_emitted", {
      count: batch.count,
      batchHash: batch.hash,
    });

    this.emit("batch", batch);
    await maybeCall(this.hooks?.onBatch, batch);
  }

  private shouldIgnore(relativePath: string): boolean {
    const segments = relativePath.split(path.sep);

    if (this.policy.ignoreHidden && segments.some((segment) => segment.startsWith(".") && segment.length > 1)) {
      return true;
    }
    if (this.policy.ignoreGit && segments.includes(".git")) {
      return true;
    }
    if (this.policy.ignoreNodeModules && segments.includes("node_modules")) {
      return true;
    }
    if (this.policy.ignoreDist && segments.includes("dist")) {
      return true;
    }
    if (this.policy.ignoreBuild && segments.includes("build")) {
      return true;
    }
    if (this.policy.extraIgnoredNames.some((name) => segments.includes(name))) {
      return true;
    }
    if (this.policy.extraIgnoredPathPrefixes.some((prefix) => relativePath === prefix || relativePath.startsWith(prefix + path.sep))) {
      return true;
    }

    return false;
  }

  private async handleError(error: Error): Promise<void> {
    this.health = "error";
    this.lastError = error.message;
    this.emitAudit("error", "deny", "watcher_error", { error: error.message });
    const snapshot = this.snapshot();
    this.emit("error", error, snapshot);
    await maybeCallError(this.hooks?.onError, error, snapshot);
  }

  private emitAudit(
    action: FileWatcherAuditRecord["action"],
    decision: FileWatcherAuditRecord["decision"],
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<FileWatcherAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
      rootPath: this.rootPath,
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

export function createWorkspaceFileWatcher(options: FileWatcherOptions): WorkspaceFileWatcher {
  return new WorkspaceFileWatcher(options);
}

export function defaultFileWatcherPolicy(): FileWatcherPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateFileWatchEvent(event: FileWatchEvent): void {
  assert(event.schema === 1, "event_schema_invalid");
  const core: Omit<FileWatchEvent, "hash"> = {
    schema: event.schema,
    rootPath: event.rootPath,
    absolutePath: event.absolutePath,
    relativePath: event.relativePath,
    rawKind: event.rawKind,
    derivedKind: event.derivedKind,
    exists: event.exists,
    isDirectory: event.isDirectory,
    ts_ms: event.ts_ms,
  };
  assert(event.hash === eventHash(core), "event_hash_drift");
}

export function validateFileWatchBatch(batch: FileWatchBatch): void {
  assert(batch.schema === 1, "batch_schema_invalid");
  batch.events.forEach(validateFileWatchEvent);
  const core: Omit<FileWatchBatch, "hash"> = {
    schema: batch.schema,
    rootPath: batch.rootPath,
    startedAtMs: batch.startedAtMs,
    emittedAtMs: batch.emittedAtMs,
    count: batch.count,
    events: batch.events,
  };
  assert(batch.hash === batchHash(core), "batch_hash_drift");
}

export function validateFileWatcherSnapshot(snapshot: FileWatcherSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<FileWatcherSnapshot, "hash"> = {
    schema: snapshot.schema,
    rootPath: snapshot.rootPath,
    health: snapshot.health,
    watching: snapshot.watching,
    startedAtMs: snapshot.startedAtMs,
    stoppedAtMs: snapshot.stoppedAtMs,
    lastEventAtMs: snapshot.lastEventAtMs,
    lastEmitAtMs: snapshot.lastEmitAtMs,
    lastError: snapshot.lastError,
    pendingEventCount: snapshot.pendingEventCount,
    emittedBatchCount: snapshot.emittedBatchCount,
    ignoredCount: snapshot.ignoredCount,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
