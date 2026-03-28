/*
 * ADJUTORIX APP — RENDERER / LIB / monaco_models.ts
 *
 * Canonical Monaco model registry, identity, lifecycle, diff pairing, dirty tracking,
 * language inference, and view-state boundary.
 *
 * Purpose:
 * - provide one deterministic renderer-side authority for Monaco text models so editor tabs,
 *   patch review, preview models, diff viewers, search jump targets, and diagnostics overlays
 *   all reference the same governed model graph
 * - centralize model identity, URI policy, creation/update/disposal, original-vs-modified diff model
 *   pairing, content version tracking, dirty state semantics, and view-state persistence
 * - prevent feature-local model creation from fragmenting editor state or leaking undisposed models
 *
 * Architectural role:
 * - pure-ish registry/service-layer module designed to sit above Monaco but below React UI
 * - no filesystem I/O, no Electron APIs, no hidden singleton requirement
 * - caller provides Monaco namespace/adapter and workspace/buffer metadata
 * - module owns deterministic model records and explicit lifecycle decisions
 *
 * Hard invariants:
 * - one canonical editable model per logical document identity per registry
 * - preview/read-only/original models are explicitly typed and never confused with editable models
 * - identical logical identities resolve to identical canonical URIs
 * - dirty state is explicit and derivable from baseline snapshots, not inferred from tab chrome
 * - disposal is reference- and purpose-aware; diff/original/preview models never outlive their need silently
 * - identical inputs and mutations yield identical registry state
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type MonacoModelPurpose = "editor" | "original" | "modified" | "preview" | "search-preview" | "scratch";
export type MonacoDirtyState = "clean" | "dirty" | "unknown";
export type MonacoLanguageSource = "explicit" | "path" | "monaco" | "fallback";

export interface MonacoPositionLike {
  lineNumber: number;
  column: number;
}

export interface MonacoRangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export interface MonacoSelectionLike extends MonacoRangeLike {
  selectionStartLineNumber: number;
  selectionStartColumn: number;
  positionLineNumber: number;
  positionColumn: number;
}

export interface MonacoViewStateLike {
  scrollTop?: number;
  scrollLeft?: number;
  firstPosition?: MonacoPositionLike;
  firstPositionDeltaTop?: number;
  selection?: MonacoSelectionLike | null;
  selections?: MonacoSelectionLike[] | null;
}

export interface MonacoUriLike {
  toString(): string;
  scheme?: string;
  path?: string;
}

export interface MonacoTextModelLike {
  id?: string | number;
  uri: MonacoUriLike;
  getValue(eol?: unknown, preserveBOM?: boolean): string;
  setValue(value: string): void;
  getVersionId(): number;
  getAlternativeVersionId?(): number;
  getLanguageId(): string;
  isDisposed(): boolean;
  dispose(): void;
  onDidChangeContent(listener: (event: unknown) => void): { dispose(): void };
}

export interface MonacoNamespaceLike {
  Uri: {
    parse(value: string): MonacoUriLike;
  };
  editor: {
    createModel(value: string, language?: string | null, uri?: MonacoUriLike): MonacoTextModelLike;
    getModel(uri: MonacoUriLike): MonacoTextModelLike | null | undefined;
    setModelLanguage(model: MonacoTextModelLike, language: string): void;
  };
}

export interface MonacoLogicalIdentity {
  path?: string | null;
  workspaceId?: string | null;
  bufferId?: string | null;
  purpose?: MonacoModelPurpose;
  revisionId?: string | null;
}

export interface MonacoModelInput {
  identity: MonacoLogicalIdentity;
  initialValue: string;
  language?: string | null;
  readOnly?: boolean;
  pinned?: boolean;
  metadata?: Record<string, unknown>;
}

export interface MonacoModelRecord {
  key: string;
  uri: string;
  purpose: MonacoModelPurpose;
  logicalIdentity: MonacoLogicalIdentity;
  language: string;
  languageSource: MonacoLanguageSource;
  baselineValue: string;
  lastKnownValue: string;
  dirtyState: MonacoDirtyState;
  readOnly: boolean;
  pinned: boolean;
  refCount: number;
  model: MonacoTextModelLike;
  versionId: number;
  alternativeVersionId: number | null;
  metadata: Record<string, unknown>;
  createdAtMs: number;
  updatedAtMs: number;
  viewState?: MonacoViewStateLike | null;
  disposer?: { dispose(): void } | null;
}

export interface MonacoDiffHandle {
  id: string;
  originalKey: string;
  modifiedKey: string;
  createdAtMs: number;
  metadata: Record<string, unknown>;
}

export interface MonacoRegistrySnapshot {
  models: MonacoModelRecordSummary[];
  diffs: MonacoDiffHandle[];
}

export interface MonacoModelRecordSummary {
  key: string;
  uri: string;
  purpose: MonacoModelPurpose;
  language: string;
  dirtyState: MonacoDirtyState;
  refCount: number;
  readOnly: boolean;
  pinned: boolean;
  versionId: number;
  logicalIdentity: MonacoLogicalIdentity;
}

export interface MonacoRegistryOptions {
  uriScheme?: string;
  fallbackLanguage?: string;
  inferLanguageFromPath?: (path: string) => string | null;
  now?: () => number;
}

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

export const MONACO_MODELS_VERSION = "1.0.0";

const DEFAULT_OPTIONS: Required<Pick<MonacoRegistryOptions, "uriScheme" | "fallbackLanguage" | "now">> & Pick<MonacoRegistryOptions, "inferLanguageFromPath"> = {
  uriScheme: "adjutorix",
  fallbackLanguage: "plaintext",
  inferLanguageFromPath: undefined,
  now: () => Date.now(),
};

const EXTENSION_LANGUAGE_MAP: Readonly<Record<string, string>> = Object.freeze({
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".py": "python",
  ".rs": "rust",
  ".go": "go",
  ".java": "java",
  ".c": "c",
  ".h": "c",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".cs": "csharp",
  ".php": "php",
  ".rb": "ruby",
  ".swift": "swift",
  ".kt": "kotlin",
  ".lua": "lua",
  ".sql": "sql",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".xml": "xml",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".sh": "shell",
  ".zsh": "shell",
  ".toml": "toml",
});

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function withOptions(options?: MonacoRegistryOptions): typeof DEFAULT_OPTIONS {
  return {
    uriScheme: options?.uriScheme ?? DEFAULT_OPTIONS.uriScheme,
    fallbackLanguage: options?.fallbackLanguage ?? DEFAULT_OPTIONS.fallbackLanguage,
    inferLanguageFromPath: options?.inferLanguageFromPath ?? DEFAULT_OPTIONS.inferLanguageFromPath,
    now: options?.now ?? DEFAULT_OPTIONS.now,
  };
}

function normalizePath(path?: string | null): string | null {
  if (!path) return null;
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return normalized.length > 0 ? normalized : null;
}

function normalizeLogicalIdentity(identity: MonacoLogicalIdentity): Required<Pick<MonacoLogicalIdentity, "purpose">> & MonacoLogicalIdentity {
  return {
    path: normalizePath(identity.path),
    workspaceId: identity.workspaceId?.trim() || null,
    bufferId: identity.bufferId?.trim() || null,
    purpose: identity.purpose ?? "editor",
    revisionId: identity.revisionId?.trim() || null,
  };
}

function getExtension(path: string | null | undefined): string {
  const normalized = normalizePath(path);
  if (!normalized) return "";
  const base = normalized.split("/").pop() ?? "";
  const match = base.match(/(\.[^.]+)$/);
  return match?.[1]?.toLowerCase() ?? "";
}

function inferLanguage(path: string | null | undefined, options: ReturnType<typeof withOptions>): { language: string; source: MonacoLanguageSource } {
  if (path && options.inferLanguageFromPath) {
    const inferred = options.inferLanguageFromPath(path);
    if (inferred) return { language: inferred, source: "path" };
  }

  const ext = getExtension(path);
  if (ext && EXTENSION_LANGUAGE_MAP[ext]) {
    return { language: EXTENSION_LANGUAGE_MAP[ext], source: "path" };
  }

  return { language: options.fallbackLanguage, source: "fallback" };
}

function escapeUriComponent(value: string): string {
  return encodeURIComponent(value).replace(/%2F/g, "/");
}

function identityKey(identity: MonacoLogicalIdentity): string {
  const normalized = normalizeLogicalIdentity(identity);
  return [
    normalized.workspaceId ?? "_",
    normalized.path ?? "_",
    normalized.bufferId ?? "_",
    normalized.purpose,
    normalized.revisionId ?? "_",
  ].join("::");
}

function canonicalUriString(identity: MonacoLogicalIdentity, options: ReturnType<typeof withOptions>): string {
  const normalized = normalizeLogicalIdentity(identity);
  const pathComponent = normalized.path ?? `/virtual/${normalized.bufferId ?? "untitled"}`;
  const params = new URLSearchParams();
  if (normalized.workspaceId) params.set("workspace", normalized.workspaceId);
  if (normalized.bufferId) params.set("buffer", normalized.bufferId);
  if (normalized.purpose) params.set("purpose", normalized.purpose);
  if (normalized.revisionId) params.set("revision", normalized.revisionId);

  const query = params.toString();
  return `${options.uriScheme}://${escapeUriComponent(pathComponent.startsWith("/") ? pathComponent.slice(1) : pathComponent)}${query ? `?${query}` : ""}`;
}

function stableDiffId(originalKey: string, modifiedKey: string): string {
  return `${originalKey}=>${modifiedKey}`;
}

function cloneViewState(state?: MonacoViewStateLike | null): MonacoViewStateLike | null {
  return state ? JSON.parse(JSON.stringify(state)) : null;
}

function computeDirtyState(model: MonacoTextModelLike, baselineValue: string, readOnly: boolean): MonacoDirtyState {
  if (readOnly) return model.getValue() === baselineValue ? "clean" : "dirty";
  return model.getValue() === baselineValue ? "clean" : "dirty";
}

// -----------------------------------------------------------------------------
// REGISTRY
// -----------------------------------------------------------------------------

export class MonacoModelRegistry {
  private readonly monaco: MonacoNamespaceLike;
  private readonly options: ReturnType<typeof withOptions>;
  private readonly records = new Map<string, MonacoModelRecord>();
  private readonly uriToKey = new Map<string, string>();
  private readonly diffs = new Map<string, MonacoDiffHandle>();

  public constructor(monaco: MonacoNamespaceLike, options?: MonacoRegistryOptions) {
    this.monaco = monaco;
    this.options = withOptions(options);
  }

  public ensureModel(input: MonacoModelInput): MonacoModelRecord {
    const logicalIdentity = normalizeLogicalIdentity(input.identity);
    const key = identityKey(logicalIdentity);
    const existing = this.records.get(key);
    if (existing) {
      this.retain(key);
      if (input.language && existing.language !== input.language) {
        this.setLanguage(key, input.language, "explicit");
      }
      return existing;
    }

    const languageResolution = input.language
      ? { language: input.language, source: "explicit" as MonacoLanguageSource }
      : inferLanguage(logicalIdentity.path, this.options);

    const uriString = canonicalUriString(logicalIdentity, this.options);
    const uri = this.monaco.Uri.parse(uriString);
    const reusedModel = this.monaco.editor.getModel(uri) ?? undefined;
    const model = reusedModel ?? this.monaco.editor.createModel(input.initialValue, languageResolution.language, uri);

    if (reusedModel && reusedModel.getLanguageId() !== languageResolution.language) {
      this.monaco.editor.setModelLanguage(reusedModel, languageResolution.language);
    }

    const now = this.options.now();
    const record: MonacoModelRecord = {
      key,
      uri: uriString,
      purpose: logicalIdentity.purpose,
      logicalIdentity,
      language: languageResolution.language,
      languageSource: languageResolution.source,
      baselineValue: input.initialValue,
      lastKnownValue: model.getValue(),
      dirtyState: computeDirtyState(model, input.initialValue, Boolean(input.readOnly)),
      readOnly: Boolean(input.readOnly),
      pinned: Boolean(input.pinned),
      refCount: 1,
      model,
      versionId: model.getVersionId(),
      alternativeVersionId: model.getAlternativeVersionId ? model.getAlternativeVersionId() : null,
      metadata: { ...(input.metadata ?? {}) },
      createdAtMs: now,
      updatedAtMs: now,
      viewState: null,
      disposer: null,
    };

    record.disposer = model.onDidChangeContent(() => {
      this.refreshRecordFromModel(record.key);
    });

    this.records.set(key, record);
    this.uriToKey.set(uriString, key);
    return record;
  }

  public getRecord(key: string): MonacoModelRecord | null {
    return this.records.get(key) ?? null;
  }

  public getRecordByUri(uri: string): MonacoModelRecord | null {
    const key = this.uriToKey.get(uri);
    return key ? this.records.get(key) ?? null : null;
  }

  public retain(key: string): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.refCount += 1;
    record.updatedAtMs = this.options.now();
    return record;
  }

  public release(key: string): boolean {
    const record = this.requireRecord(key);
    record.refCount = Math.max(0, record.refCount - 1);
    record.updatedAtMs = this.options.now();

    if (record.refCount === 0 && !record.pinned) {
      this.disposeModel(key);
      return true;
    }

    return false;
  }

  public pin(key: string, pinned = true): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.pinned = pinned;
    record.updatedAtMs = this.options.now();
    return record;
  }

  public setBaseline(key: string, baselineValue: string): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.baselineValue = baselineValue;
    this.refreshRecordFromModel(key);
    return record;
  }

  public setValue(key: string, value: string, resetBaseline = false): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.model.setValue(value);
    if (resetBaseline) {
      record.baselineValue = value;
    }
    this.refreshRecordFromModel(key);
    return record;
  }

  public markClean(key: string): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.baselineValue = record.model.getValue();
    this.refreshRecordFromModel(key);
    return record;
  }

  public setLanguage(key: string, language: string, source: MonacoLanguageSource = "explicit"): MonacoModelRecord {
    const record = this.requireRecord(key);
    if (record.model.getLanguageId() !== language) {
      this.monaco.editor.setModelLanguage(record.model, language);
    }
    record.language = language;
    record.languageSource = source;
    record.updatedAtMs = this.options.now();
    return record;
  }

  public saveViewState(key: string, viewState?: MonacoViewStateLike | null): MonacoModelRecord {
    const record = this.requireRecord(key);
    record.viewState = cloneViewState(viewState);
    record.updatedAtMs = this.options.now();
    return record;
  }

  public loadViewState(key: string): MonacoViewStateLike | null {
    const record = this.requireRecord(key);
    return cloneViewState(record.viewState);
  }

  public ensureDiffPair(args: {
    original: MonacoModelInput;
    modified: MonacoModelInput;
    metadata?: Record<string, unknown>;
  }): { diff: MonacoDiffHandle; original: MonacoModelRecord; modified: MonacoModelRecord } {
    const original = this.ensureModel({ ...args.original, identity: { ...args.original.identity, purpose: args.original.identity.purpose ?? "original" }, readOnly: true });
    const modified = this.ensureModel({ ...args.modified, identity: { ...args.modified.identity, purpose: args.modified.identity.purpose ?? "modified" } });

    const diffId = stableDiffId(original.key, modified.key);
    const existing = this.diffs.get(diffId);
    if (existing) {
      return { diff: existing, original, modified };
    }

    const diff: MonacoDiffHandle = {
      id: diffId,
      originalKey: original.key,
      modifiedKey: modified.key,
      createdAtMs: this.options.now(),
      metadata: { ...(args.metadata ?? {}) },
    };

    this.diffs.set(diffId, diff);
    return { diff, original, modified };
  }

  public removeDiff(diffId: string): boolean {
    return this.diffs.delete(diffId);
  }

  public listDiffs(): MonacoDiffHandle[] {
    return [...this.diffs.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  public listRecords(): MonacoModelRecord[] {
    return [...this.records.values()].sort((a, b) => a.key.localeCompare(b.key));
  }

  public snapshot(): MonacoRegistrySnapshot {
    return {
      models: this.listRecords().map((record) => this.toSummary(record)),
      diffs: this.listDiffs(),
    };
  }

  public disposeModel(key: string): void {
    const record = this.requireRecord(key);
    record.disposer?.dispose();
    record.disposer = null;

    if (!record.model.isDisposed()) {
      record.model.dispose();
    }

    this.records.delete(key);
    this.uriToKey.delete(record.uri);

    for (const [diffId, diff] of this.diffs.entries()) {
      if (diff.originalKey === key || diff.modifiedKey === key) {
        this.diffs.delete(diffId);
      }
    }
  }

  public disposeAll(): void {
    for (const key of [...this.records.keys()]) {
      this.disposeModel(key);
    }
    this.diffs.clear();
  }

  private refreshRecordFromModel(key: string): void {
    const record = this.requireRecord(key);
    record.lastKnownValue = record.model.getValue();
    record.versionId = record.model.getVersionId();
    record.alternativeVersionId = record.model.getAlternativeVersionId ? record.model.getAlternativeVersionId() : null;
    record.dirtyState = computeDirtyState(record.model, record.baselineValue, record.readOnly);
    record.updatedAtMs = this.options.now();
  }

  private toSummary(record: MonacoModelRecord): MonacoModelRecordSummary {
    return {
      key: record.key,
      uri: record.uri,
      purpose: record.purpose,
      language: record.language,
      dirtyState: record.dirtyState,
      refCount: record.refCount,
      readOnly: record.readOnly,
      pinned: record.pinned,
      versionId: record.versionId,
      logicalIdentity: { ...record.logicalIdentity },
    };
  }

  private requireRecord(key: string): MonacoModelRecord {
    const record = this.records.get(key);
    if (!record) {
      throw new Error(`Monaco model record not found: ${key}`);
    }
    return record;
  }
}

// -----------------------------------------------------------------------------
// PURE HELPERS
// -----------------------------------------------------------------------------

export function buildMonacoLogicalKey(identity: MonacoLogicalIdentity): string {
  return identityKey(identity);
}

export function buildCanonicalMonacoUri(identity: MonacoLogicalIdentity, options?: MonacoRegistryOptions): string {
  return canonicalUriString(identity, withOptions(options));
}

export function inferMonacoLanguageFromPath(path: string | null | undefined, options?: MonacoRegistryOptions): {
  language: string;
  source: MonacoLanguageSource;
} {
  return inferLanguage(path, withOptions(options));
}

export function isRecordDirty(record: Pick<MonacoModelRecord, "dirtyState">): boolean {
  return record.dirtyState === "dirty";
}

export function buildModelDisplayLabel(record: Pick<MonacoModelRecord, "logicalIdentity" | "purpose" | "dirtyState" | "language">): {
  title: string;
  subtitle: string;
  badges: string[];
} {
  const path = normalizePath(record.logicalIdentity.path) ?? record.logicalIdentity.bufferId ?? "untitled";
  const basename = path.split("/").pop() ?? path;

  return {
    title: basename,
    subtitle: `${record.purpose} • ${path}`,
    badges: [record.language, record.purpose, record.dirtyState],
  };
}

// -----------------------------------------------------------------------------
// TEST-ORIENTED PURE UTILITIES
// -----------------------------------------------------------------------------

export function __private__normalizePath(path?: string | null): string | null {
  return normalizePath(path);
}

export function __private__getExtension(path: string | null | undefined): string {
  return getExtension(path);
}

export function __private__identityKey(identity: MonacoLogicalIdentity): string {
  return identityKey(identity);
}

export function __private__stableDiffId(originalKey: string, modifiedKey: string): string {
  return stableDiffId(originalKey, modifiedKey);
}
