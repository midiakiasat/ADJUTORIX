import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / workspace_service.ts
 *
 * Canonical workspace domain service for the Electron main process.
 *
 * This module is the single source of truth for workspace lifecycle and
 * workspace-scoped runtime state. It is intentionally deeper than the IPC
 * adapter layer and intentionally narrower than the global runtime bootstrap.
 *
 * Responsibilities:
 * - open / close / reopen workspace lifecycle
 * - normalize and validate workspace roots
 * - maintain deterministic recent-workspace history
 * - persist current/previous workspace state through injected storage hooks
 * - expose workspace-scoped metadata, capabilities, and derived summaries
 * - manage filesystem watchers and workspace invalidation signals
 * - coordinate workspace dirty-state, selection-state, and patch/verify lineage
 * - emit stable snapshots and auditable domain events
 *
 * Hard invariants:
 * - there is at most one active workspace at a time
 * - workspace root is always an absolute normalized directory path
 * - recent workspace list is deduplicated, bounded, and deterministic
 * - closing a workspace clears workspace-scoped lineage and transient state
 * - watcher ownership belongs to the service and is fully torn down on close
 * - identical semantic workspace state produces identical snapshot hashes
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

export type WorkspaceOpenSource = "menu" | "ipc" | "startup" | "system" | "reopen";
export type WorkspaceEventKind =
  | "workspace.opening"
  | "workspace.opened"
  | "workspace.closing"
  | "workspace.closed"
  | "workspace.changed"
  | "workspace.deleted"
  | "workspace.invalidated"
  | "workspace.selection.changed"
  | "workspace.dirty.changed"
  | "workspace.lineage.changed"
  | "workspace.recents.changed";

export type WorkspaceSelectionState = {
  hasSelection: boolean;
  selectionCount: number;
  selectedPaths: string[];
};

export type WorkspaceLineageState = {
  currentPreviewHash: string | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
  latestPatchId: string | null;
};

export type WorkspaceWatchState = {
  watching: boolean;
  startedAtMs: number | null;
  lastEventAtMs: number | null;
  lastEventKind: "rename" | "change" | "delete" | "unknown" | null;
};

export type WorkspaceMetadata = {
  rootPath: string;
  name: string;
  openedAtMs: number;
  exists: boolean;
  entryCountHint: number | null;
  configFiles: string[];
  hash: string;
};

export type WorkspaceState = {
  rootPath: string | null;
  previousRootPath: string | null;
  reopenedFromRecent: boolean;
  openedAtMs: number | null;
  dirty: boolean;
  selection: WorkspaceSelectionState;
  lineage: WorkspaceLineageState;
  watch: WorkspaceWatchState;
  metadata: WorkspaceMetadata | null;
  recents: string[];
};

export type WorkspaceSnapshot = {
  schema: 1;
  currentPath: string | null;
  previousPath: string | null;
  reopenedFromRecent: boolean;
  openedAtMs: number | null;
  dirty: boolean;
  selection: WorkspaceSelectionState;
  lineage: WorkspaceLineageState;
  watch: WorkspaceWatchState;
  metadata: WorkspaceMetadata | null;
  recents: string[];
  hash: string;
};

export type WorkspacePolicy = {
  maxRecentWorkspaces: number;
  requireDirectory: boolean;
  allowReopenLastWorkspace: boolean;
  autoWatch: boolean;
  watchIgnoreHidden: boolean;
  watchDebounceMs: number;
  maxSelectedPaths: number;
};

export type WorkspaceStorage = {
  loadCurrentPath?: () => Promise<string | null> | string | null;
  saveCurrentPath?: (currentPath: string | null) => Promise<void> | void;
  loadRecentPaths?: () => Promise<string[]> | string[];
  saveRecentPaths?: (recentPaths: string[]) => Promise<void> | void;
};

export type WorkspaceHooks = {
  beforeOpen?: (rootPath: string, source: WorkspaceOpenSource) => Promise<void> | void;
  afterOpen?: (snapshot: WorkspaceSnapshot) => Promise<void> | void;
  beforeClose?: (snapshot: WorkspaceSnapshot) => Promise<void> | void;
  afterClose?: (snapshot: WorkspaceSnapshot) => Promise<void> | void;
  onInvalidated?: (snapshot: WorkspaceSnapshot, reason: string) => Promise<void> | void;
  onChanged?: (snapshot: WorkspaceSnapshot, eventKind: string, relativePath: string | null) => Promise<void> | void;
};

export type WorkspaceAuditRecord = {
  schema: 1;
  ts_ms: number;
  action:
    | "initialize"
    | "open"
    | "close"
    | "reopen"
    | "watch_start"
    | "watch_stop"
    | "watch_event"
    | "mark_dirty"
    | "set_selection"
    | "set_lineage"
    | "set_recents";
  decision: "allow" | "deny";
  reason: string;
  rootPath?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type WorkspaceAuditFn = (record: WorkspaceAuditRecord) => void;

export type WorkspaceEvent = {
  kind: WorkspaceEventKind;
  snapshot: WorkspaceSnapshot;
  detail: Record<string, JsonValue>;
};

export type WorkspaceServiceOptions = {
  policy?: Partial<WorkspacePolicy>;
  storage?: WorkspaceStorage;
  hooks?: WorkspaceHooks;
  audit?: WorkspaceAuditFn;
};

export type WorkspaceOpenResult = {
  ok: true;
  snapshot: WorkspaceSnapshot;
};

export type WorkspaceCloseResult = {
  ok: true;
  snapshot: WorkspaceSnapshot;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: WorkspacePolicy = {
  maxRecentWorkspaces: 20,
  requireDirectory: true,
  allowReopenLastWorkspace: true,
  autoWatch: true,
  watchIgnoreHidden: true,
  watchDebounceMs: 100,
  maxSelectedPaths: 1024,
};

const CONFIG_FILE_CANDIDATES = [
  "package.json",
  "pyproject.toml",
  "tsconfig.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  ".git",
  ".editorconfig",
  "README.md",
] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:workspace:workspace_service:${message}`);
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

function nowMs(): number {
  return Date.now();
}

function normalizePath(input: string): string {
  assert(typeof input === "string" && input.trim().length > 0, "path_invalid");
  return path.resolve(input.trim());
}

function exists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function isDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function dedupeBounded(paths: string[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of paths) {
    const normalized = normalizePath(raw);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
    if (out.length >= max) break;
  }
  return out;
}

function relativeToRoot(rootPath: string, targetPath: string): string | null {
  const rel = path.relative(rootPath, targetPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel || ".";
}

function shouldIgnoreRelativePath(relativePath: string | null, ignoreHidden: boolean): boolean {
  if (!ignoreHidden || !relativePath) return false;
  return relativePath.split(path.sep).some((segment) => segment.startsWith(".") && segment.length > 1);
}

function directoryEntryCountHint(rootPath: string): number | null {
  try {
    const entries = fs.readdirSync(rootPath, { withFileTypes: true });
    return entries.length;
  } catch {
    return null;
  }
}

function discoverConfigFiles(rootPath: string): string[] {
  const found: string[] = [];
  for (const candidate of CONFIG_FILE_CANDIDATES) {
    const target = path.join(rootPath, candidate);
    if (exists(target)) found.push(candidate);
  }
  return found.sort((a, b) => a.localeCompare(b));
}

function workspaceMetadata(rootPath: string, openedAtMs: number): WorkspaceMetadata {
  const core: Omit<WorkspaceMetadata, "hash"> = {
    rootPath,
    name: path.basename(rootPath),
    openedAtMs,
    exists: exists(rootPath),
    entryCountHint: directoryEntryCountHint(rootPath),
    configFiles: discoverConfigFiles(rootPath),
  };

  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function createEmptyState(): WorkspaceState {
  return {
    rootPath: null,
    previousRootPath: null,
    reopenedFromRecent: false,
    openedAtMs: null,
    dirty: false,
    selection: {
      hasSelection: false,
      selectionCount: 0,
      selectedPaths: [],
    },
    lineage: {
      currentPreviewHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
      latestPatchId: null,
    },
    watch: {
      watching: false,
      startedAtMs: null,
      lastEventAtMs: null,
      lastEventKind: null,
    },
    metadata: null,
    recents: [],
  };
}

function createSnapshot(state: WorkspaceState): WorkspaceSnapshot {
  const core: Omit<WorkspaceSnapshot, "hash"> = {
    schema: 1,
    currentPath: state.rootPath,
    previousPath: state.previousRootPath,
    reopenedFromRecent: state.reopenedFromRecent,
    openedAtMs: state.openedAtMs,
    dirty: state.dirty,
    selection: JSON.parse(stableJson(state.selection)) as WorkspaceSelectionState,
    lineage: JSON.parse(stableJson(state.lineage)) as WorkspaceLineageState,
    watch: JSON.parse(stableJson(state.watch)) as WorkspaceWatchState,
    metadata: state.metadata ? (JSON.parse(stableJson(state.metadata)) as WorkspaceMetadata) : null,
    recents: [...state.recents],
  };

  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function auditRecord(
  action: WorkspaceAuditRecord["action"],
  decision: WorkspaceAuditRecord["decision"],
  reason: string,
  detail: Record<string, JsonValue>,
  rootPath?: string,
): WorkspaceAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    action,
    decision,
    reason,
    ...(rootPath ? { rootPath } : {}),
    detail,
  };

  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T1, T2>(fn: ((a: T1, b: T2) => Promise<void> | void) | undefined, a: T1, b: T2): Promise<void> {
  if (fn) await fn(a, b);
}

async function maybeCallArg<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// SERVICE
// -----------------------------------------------------------------------------

export class WorkspaceService extends EventEmitter {
  private readonly policy: WorkspacePolicy;
  private readonly storage?: WorkspaceStorage;
  private readonly hooks?: WorkspaceHooks;
  private readonly audit?: WorkspaceAuditFn;
  private readonly state: WorkspaceState;
  private watcher: fs.FSWatcher | null = null;
  private watchDebounceTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(options: WorkspaceServiceOptions = {}) {
    super();
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.storage = options.storage;
    this.hooks = options.hooks;
    this.audit = options.audit;
    this.state = createEmptyState();
  }

  async initialize(): Promise<void> {
    this.assertNotDisposed();

    const loadedRecents = this.storage?.loadRecentPaths ? await this.storage.loadRecentPaths() : [];
    const loadedCurrent = this.storage?.loadCurrentPath ? await this.storage.loadCurrentPath() : null;

    this.state.recents = dedupeBounded(Array.isArray(loadedRecents) ? loadedRecents : [], this.policy.maxRecentWorkspaces);

    this.audit?.(auditRecord("initialize", "allow", "workspace_service_initialized", {
      recentCount: this.state.recents.length,
      loadedCurrentPath: loadedCurrent,
    }));

    if (
      this.policy.allowReopenLastWorkspace &&
      typeof loadedCurrent === "string" &&
      loadedCurrent.length > 0 &&
      exists(normalizePath(loadedCurrent))
    ) {
      await this.open(loadedCurrent, "reopen");
    }
  }

  snapshot(): WorkspaceSnapshot {
    this.assertNotDisposed();
    return createSnapshot(this.state);
  }

  currentPath(): string | null {
    return this.state.rootPath;
  }

  recents(): string[] {
    return [...this.state.recents];
  }

  isOpen(): boolean {
    return this.state.rootPath !== null;
  }

  isDirty(): boolean {
    return this.state.dirty;
  }

  async open(rootPath: string, source: WorkspaceOpenSource = "system"): Promise<WorkspaceOpenResult> {
    this.assertNotDisposed();

    const normalized = normalizePath(rootPath);
    if (!exists(normalized)) {
      const record = auditRecord("open", "deny", "workspace_path_not_found", { source }, normalized);
      this.audit?.(record);
      throw new Error(`workspace_open_denied:${record.reason}`);
    }
    if (this.policy.requireDirectory && !isDirectory(normalized)) {
      const record = auditRecord("open", "deny", "workspace_path_not_directory", { source }, normalized);
      this.audit?.(record);
      throw new Error(`workspace_open_denied:${record.reason}`);
    }

    if (this.state.rootPath === normalized) {
      this.state.reopenedFromRecent = source === "reopen";
      this.pushRecent(normalized);
      const snapshot = this.snapshot();
      this.audit?.(auditRecord("open", "allow", "workspace_already_open", { source }, normalized));
      return { ok: true, snapshot };
    }

    await maybeCallArg(this.hooks?.beforeOpen ? ((arg) => this.hooks!.beforeOpen!(arg, source)) : undefined, normalized);

    if (this.state.rootPath) {
      await this.close("switch_before_open");
    }

    const openedAtMs = nowMs();
    this.state.previousRootPath = this.state.rootPath;
    this.state.rootPath = normalized;
    this.state.reopenedFromRecent = source === "reopen";
    this.state.openedAtMs = openedAtMs;
    this.state.dirty = false;
    this.state.selection = { hasSelection: false, selectionCount: 0, selectedPaths: [] };
    this.state.lineage = {
      currentPreviewHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
      latestPatchId: null,
    };
    this.state.metadata = workspaceMetadata(normalized, openedAtMs);
    this.pushRecent(normalized);

    await this.persist();
    if (this.policy.autoWatch) {
      this.startWatcher();
    }

    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.opened", snapshot, { source, rootPath: normalized });
    this.audit?.(auditRecord("open", "allow", "workspace_opened", { source }, normalized));
    await maybeCallArg(this.hooks?.afterOpen, snapshot);

    return { ok: true, snapshot };
  }

  async close(reason = "explicit_close"): Promise<WorkspaceCloseResult> {
    this.assertNotDisposed();

    const before = this.snapshot();
    const current = this.state.rootPath;
    this.audit?.(auditRecord("close", "allow", "workspace_closing", { reason }, current ?? undefined));
    this.emitWorkspaceEvent("workspace.closing", before, { reason });
    await maybeCallArg(this.hooks?.beforeClose, before);

    this.stopWatcher();

    this.state.previousRootPath = this.state.rootPath;
    this.state.rootPath = null;
    this.state.reopenedFromRecent = false;
    this.state.openedAtMs = null;
    this.state.dirty = false;
    this.state.selection = { hasSelection: false, selectionCount: 0, selectedPaths: [] };
    this.state.lineage = {
      currentPreviewHash: null,
      approvedPreviewHash: null,
      verifiedPreviewHash: null,
      verifyId: null,
      latestPatchId: null,
    };
    this.state.metadata = null;

    await this.persist();

    const after = this.snapshot();
    this.emitWorkspaceEvent("workspace.closed", after, { reason, previousPath: current });
    this.audit?.(auditRecord("close", "allow", "workspace_closed", { reason }, current ?? undefined));
    await maybeCallArg(this.hooks?.afterClose, after);

    return { ok: true, snapshot: after };
  }

  async reopenLast(): Promise<WorkspaceOpenResult> {
    this.assertNotDisposed();
    const candidate = this.state.recents[0] ?? null;
    if (!candidate) {
      const record = auditRecord("reopen", "deny", "no_recent_workspace", {});
      this.audit?.(record);
      throw new Error(`workspace_reopen_denied:${record.reason}`);
    }
    return this.open(candidate, "reopen");
  }

  markDirty(dirty: boolean, reason = "unspecified"): void {
    this.assertNotDisposed();
    this.state.dirty = !!dirty;
    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.dirty.changed", snapshot, { dirty, reason });
    this.audit?.(auditRecord("mark_dirty", "allow", "workspace_dirty_state_updated", { dirty, reason }, this.state.rootPath ?? undefined));
  }

  setSelection(paths: string[]): void {
    this.assertNotDisposed();
    const root = this.state.rootPath;
    const bounded = paths.slice(0, this.policy.maxSelectedPaths);
    const normalized = [...new Set(
      bounded
        .map((p) => normalizePath(p))
        .filter((p) => (root ? relativeToRoot(root, p) !== null : true)),
    )].sort((a, b) => a.localeCompare(b));

    this.state.selection = {
      hasSelection: normalized.length > 0,
      selectionCount: normalized.length,
      selectedPaths: normalized,
    };

    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.selection.changed", snapshot, { selectionCount: normalized.length });
    this.audit?.(auditRecord("set_selection", "allow", "workspace_selection_updated", { selectionCount: normalized.length }, root ?? undefined));
  }

  setLineage(next: Partial<WorkspaceLineageState>, reason = "lineage_update"): void {
    this.assertNotDisposed();
    this.state.lineage = {
      ...this.state.lineage,
      ...next,
    };
    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.lineage.changed", snapshot, {
      reason,
      approvedPreviewHash: this.state.lineage.approvedPreviewHash,
      verifiedPreviewHash: this.state.lineage.verifiedPreviewHash,
      verifyId: this.state.lineage.verifyId,
      latestPatchId: this.state.lineage.latestPatchId,
    });
    this.audit?.(auditRecord("set_lineage", "allow", "workspace_lineage_updated", { reason }, this.state.rootPath ?? undefined));
  }

  setRecents(recents: string[]): void {
    this.assertNotDisposed();
    this.state.recents = dedupeBounded(recents, this.policy.maxRecentWorkspaces);
    void this.persistRecents();
    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.recents.changed", snapshot, { recentCount: this.state.recents.length });
    this.audit?.(auditRecord("set_recents", "allow", "workspace_recents_updated", { recentCount: this.state.recents.length }));
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopWatcher();
    this.removeAllListeners();
    this.disposed = true;
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private assertNotDisposed(): void {
    assert(!this.disposed, "service_disposed");
  }

  private pushRecent(rootPath: string): void {
    this.state.recents = dedupeBounded([rootPath, ...this.state.recents], this.policy.maxRecentWorkspaces);
    void this.persistRecents();
    const snapshot = this.snapshot();
    this.emitWorkspaceEvent("workspace.recents.changed", snapshot, { recentCount: this.state.recents.length });
  }

  private async persist(): Promise<void> {
    await this.persistCurrent();
    await this.persistRecents();
  }

  private async persistCurrent(): Promise<void> {
    if (this.storage?.saveCurrentPath) {
      await this.storage.saveCurrentPath(this.state.rootPath);
    }
  }

  private async persistRecents(): Promise<void> {
    if (this.storage?.saveRecentPaths) {
      await this.storage.saveRecentPaths([...this.state.recents]);
    }
  }

  private emitWorkspaceEvent(kind: WorkspaceEventKind, snapshot: WorkspaceSnapshot, detail: Record<string, JsonValue>): void {
    const event: WorkspaceEvent = { kind, snapshot, detail };
    this.emit(kind, event);
    this.emit("workspace:event", event);
  }

  private startWatcher(): void {
    this.stopWatcher();
    const root = this.state.rootPath;
    if (!root) return;

    this.watcher = fs.watch(root, { recursive: true }, (eventType, filename) => {
      const eventTs = nowMs();
      const absolute = typeof filename === "string" && filename.length > 0 ? path.join(root, filename) : root;
      const relative = relativeToRoot(root, absolute);

      if (shouldIgnoreRelativePath(relative, this.policy.watchIgnoreHidden)) {
        return;
      }

      this.state.watch.lastEventAtMs = eventTs;
      this.state.watch.lastEventKind = eventType === "rename" ? (exists(absolute) ? "rename" : "delete") : eventType === "change" ? "change" : "unknown";

      if (this.watchDebounceTimer) {
        clearTimeout(this.watchDebounceTimer);
      }

      this.watchDebounceTimer = setTimeout(async () => {
        if (!this.state.rootPath) return;

        if (!exists(this.state.rootPath)) {
          const snapshot = this.snapshot();
          this.emitWorkspaceEvent("workspace.deleted", snapshot, { rootPath: this.state.rootPath });
          this.audit?.(auditRecord("watch_event", "allow", "workspace_root_deleted", { rootPath: this.state.rootPath }, this.state.rootPath));
          await maybeCallWith(this.hooks?.onInvalidated, snapshot, "workspace_deleted");
          return;
        }

        const snapshot = this.snapshot();
        const detail = {
          eventType,
          relativePath: relative,
          absolutePath: absolute,
        } as Record<string, JsonValue>;

        this.emitWorkspaceEvent("workspace.changed", snapshot, detail);
        this.audit?.(auditRecord("watch_event", "allow", "workspace_fs_event", detail, this.state.rootPath));
        await maybeCallWith(this.hooks?.onChanged ? ((snap, _detail) => this.hooks!.onChanged!(snap, String(detail.eventType), relative)) : undefined, snapshot, detail);
      }, this.policy.watchDebounceMs);
    });

    this.state.watch = {
      watching: true,
      startedAtMs: nowMs(),
      lastEventAtMs: null,
      lastEventKind: null,
    };
    this.audit?.(auditRecord("watch_start", "allow", "workspace_watcher_started", {}, root));
  }

  private stopWatcher(): void {
    if (this.watchDebounceTimer) {
      clearTimeout(this.watchDebounceTimer);
      this.watchDebounceTimer = null;
    }
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this.state.watch.watching) {
      this.audit?.(auditRecord("watch_stop", "allow", "workspace_watcher_stopped", {}, this.state.rootPath ?? undefined));
    }
    this.state.watch.watching = false;
    this.state.watch.startedAtMs = null;
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createWorkspaceService(options: WorkspaceServiceOptions = {}): WorkspaceService {
  return new WorkspaceService(options);
}

export function validateWorkspaceSnapshot(snapshot: WorkspaceSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<WorkspaceSnapshot, "hash"> = {
    schema: snapshot.schema,
    currentPath: snapshot.currentPath,
    previousPath: snapshot.previousPath,
    reopenedFromRecent: snapshot.reopenedFromRecent,
    openedAtMs: snapshot.openedAtMs,
    dirty: snapshot.dirty,
    selection: snapshot.selection,
    lineage: snapshot.lineage,
    watch: snapshot.watch,
    metadata: snapshot.metadata,
    recents: snapshot.recents,
  };
  assert(sha256(stableJson(core)) === snapshot.hash, "snapshot_hash_drift");
}

export function defaultWorkspacePolicy(): WorkspacePolicy {
  return { ...DEFAULT_POLICY };
}
