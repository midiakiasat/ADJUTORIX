/**
 * ADJUTORIX APP — RENDERER / STATE / editor_buffers.ts
 *
 * Canonical renderer-side editor buffer state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for all open editor buffers
 * - unify disk snapshots, in-memory edits, preview overlays, diagnostics associations,
 *   dirty tracking, tab ordering, and focus state under a deterministic reducer
 * - prevent silent divergence between tabs, file tree, search, preview, and diagnostics
 *   views that each guess which file version is current
 * - provide pure transitions suitable for replay, recovery, and invariants testing
 *
 * Scope:
 * - open/close/focus/pin/reorder editor tabs
 * - immutable disk baseline and mutable working copy tracking
 * - dirty state, revision counters, and content hashes
 * - preview overlays and governed patch proposal views
 * - diagnostics linkage and language metadata
 * - ephemeral UI/editor metadata such as cursor, scroll, and selection
 *
 * Non-scope:
 * - direct filesystem I/O
 * - Monaco/CodeMirror adapter implementation
 * - patch generation or apply execution itself
 *
 * Hard invariants:
 * - identical prior state + identical action => identical next state hash
 * - every open buffer path is unique and normalized
 * - active buffer, if present, must exist in tab order and entity map
 * - dirty is derived from working content vs committed baseline, never guessed
 * - preview overlays never overwrite committed baseline content silently
 * - outputs are serialization-stable and audit-friendly
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// JSON TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// DOMAIN TYPES
// -----------------------------------------------------------------------------

export type BufferLifecycle = "opening" | "ready" | "error" | "closing";
export type BufferSource = "disk" | "generated" | "preview" | "scratch";
export type BufferEncoding = "utf8" | "utf16le" | "latin1" | "binary" | "unknown";
export type BufferLineEnding = "lf" | "crlf" | "cr" | "unknown";

export type CursorPosition = {
  line: number;
  column: number;
};

export type SelectionRange = {
  start: CursorPosition;
  end: CursorPosition;
};

export type EditorViewport = {
  cursor: CursorPosition;
  selections: SelectionRange[];
  scrollTop: number;
  scrollLeft: number;
};

export type DiagnosticsLink = {
  diagnosticIds: string[];
  severityCounts: {
    error: number;
    warn: number;
    info: number;
    hint: number;
  };
  lastLinkedAtMs: number | null;
};

export type PreviewOverlay = {
  previewHash: string | null;
  patchId: string | null;
  content: string | null;
  contentHash: string | null;
  appliedAtMs: number | null;
  visible: boolean;
};

export type BufferContentState = {
  baselineContent: string;
  baselineHash: string;
  workingContent: string;
  workingHash: string;
  preview: PreviewOverlay;
  revision: number;
};

export type EditorBuffer = {
  path: string;
  title: string;
  lifecycle: BufferLifecycle;
  source: BufferSource;
  language: string | null;
  encoding: BufferEncoding;
  lineEnding: BufferLineEnding;
  readOnly: boolean;
  pinned: boolean;
  touchedAtMs: number;
  openedAtMs: number;
  lastSavedAtMs: number | null;
  lastDiskSyncAtMs: number | null;
  content: BufferContentState;
  viewport: EditorViewport;
  diagnostics: DiagnosticsLink;
  lastError: string | null;
  hash: string;
};

export type EditorBuffersState = {
  schema: 1;
  byPath: Record<string, EditorBuffer>;
  tabOrder: string[];
  activePath: string | null;
  previousActivePath: string | null;
  untitledCounter: number;
  globalRevision: number;
  lastEventAtMs: number | null;
  hash: string;
};

export type EditorBufferOpenPayload = {
  path: string;
  title?: string | null;
  content?: string;
  source?: BufferSource;
  language?: string | null;
  encoding?: BufferEncoding;
  lineEnding?: BufferLineEnding;
  readOnly?: boolean;
  pinned?: boolean;
  atMs?: number;
};

export type EditorBufferDiskSyncPayload = {
  path: string;
  content: string;
  atMs?: number;
  preserveWorkingCopy?: boolean;
};

export type EditorBufferEditPayload = {
  path: string;
  content: string;
  atMs?: number;
};

export type EditorPreviewPayload = {
  path: string;
  previewHash: string;
  patchId: string;
  content: string;
  visible?: boolean;
  atMs?: number;
};

export type EditorViewportPayload = {
  path: string;
  viewport: Partial<EditorViewport>;
  atMs?: number;
};

export type EditorDiagnosticsPayload = {
  path: string;
  diagnosticIds: string[];
  severityCounts?: Partial<DiagnosticsLink["severityCounts"]>;
  atMs?: number;
};

export type EditorBuffersAction =
  | { type: "BUFFER_OPEN_REQUESTED"; payload: EditorBufferOpenPayload }
  | { type: "BUFFER_OPEN_SUCCEEDED"; payload: EditorBufferOpenPayload }
  | { type: "BUFFER_OPEN_FAILED"; path: string; error: string; atMs?: number }
  | { type: "BUFFER_CLOSE_REQUESTED"; path: string; atMs?: number }
  | { type: "BUFFER_CLOSED"; path: string; atMs?: number }
  | { type: "BUFFER_FOCUSED"; path: string; atMs?: number }
  | { type: "BUFFER_PIN_TOGGLED"; path: string }
  | { type: "BUFFER_REORDERED"; tabOrder: string[] }
  | { type: "BUFFER_WORKING_CONTENT_SET"; payload: EditorBufferEditPayload }
  | { type: "BUFFER_DISK_SYNCED"; payload: EditorBufferDiskSyncPayload }
  | { type: "BUFFER_SAVED"; path: string; atMs?: number }
  | { type: "BUFFER_PREVIEW_APPLIED"; payload: EditorPreviewPayload }
  | { type: "BUFFER_PREVIEW_VISIBILITY_SET"; path: string; visible: boolean }
  | { type: "BUFFER_PREVIEW_CLEARED"; path: string }
  | { type: "BUFFER_VIEWPORT_SET"; payload: EditorViewportPayload }
  | { type: "BUFFER_DIAGNOSTICS_LINKED"; payload: EditorDiagnosticsPayload }
  | { type: "BUFFER_READONLY_SET"; path: string; readOnly: boolean }
  | { type: "BUFFER_LANGUAGE_SET"; path: string; language: string | null }
  | { type: "BUFFER_ERROR_SET"; path: string; error: string | null }
  | { type: "BUFFER_RESET_WORKING_TO_BASELINE"; path: string }
  | { type: "BUFFERS_CLOSE_ALL"; keepPinned?: boolean; atMs?: number }
  | { type: "BUFFERS_RESET" };

export type EditorBuffersSelector<T> = (state: EditorBuffersState) => T;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

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

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function nowMs(input?: number): number {
  return input ?? Date.now();
}

function normalizePath(path: string): string {
  const p = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  return p.endsWith("/") && p !== "/" ? p.slice(0, -1) : p;
}

function basename(path: string): string {
  const normalized = normalizePath(path);
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function normalizeSelections(selections: SelectionRange[]): SelectionRange[] {
  return selections
    .map((s) => ({
      start: { line: Math.max(1, s.start.line), column: Math.max(1, s.start.column) },
      end: { line: Math.max(1, s.end.line), column: Math.max(1, s.end.column) },
    }))
    .sort((a, b) => (a.start.line - b.start.line) || (a.start.column - b.start.column) || (a.end.line - b.end.line) || (a.end.column - b.end.column));
}

function computeBufferHash(core: Omit<EditorBuffer, "hash">): string {
  return hashString(stableJson(core));
}

function computeStateHash(core: Omit<EditorBuffersState, "hash">): string {
  return hashString(stableJson(core));
}

function makeViewport(): EditorViewport {
  return {
    cursor: { line: 1, column: 1 },
    selections: [],
    scrollTop: 0,
    scrollLeft: 0,
  };
}

function makeDiagnosticsLink(): DiagnosticsLink {
  return {
    diagnosticIds: [],
    severityCounts: {
      error: 0,
      warn: 0,
      info: 0,
      hint: 0,
    },
    lastLinkedAtMs: null,
  };
}

function makePreviewOverlay(): PreviewOverlay {
  return {
    previewHash: null,
    patchId: null,
    content: null,
    contentHash: null,
    appliedAtMs: null,
    visible: false,
  };
}

function makeBuffer(payload: EditorBufferOpenPayload, lifecycle: BufferLifecycle): EditorBuffer {
  const atMs = nowMs(payload.atMs);
  const normalizedPath = normalizePath(payload.path);
  const baselineContent = payload.content ?? "";
  const baselineHash = hashString(baselineContent);
  const core: Omit<EditorBuffer, "hash"> = {
    path: normalizedPath,
    title: (payload.title?.trim() || basename(normalizedPath)),
    lifecycle,
    source: payload.source ?? "disk",
    language: payload.language ?? null,
    encoding: payload.encoding ?? "utf8",
    lineEnding: payload.lineEnding ?? "lf",
    readOnly: payload.readOnly ?? false,
    pinned: payload.pinned ?? false,
    touchedAtMs: atMs,
    openedAtMs: atMs,
    lastSavedAtMs: null,
    lastDiskSyncAtMs: lifecycle === "ready" ? atMs : null,
    content: {
      baselineContent,
      baselineHash,
      workingContent: baselineContent,
      workingHash: baselineHash,
      preview: makePreviewOverlay(),
      revision: 0,
    },
    viewport: makeViewport(),
    diagnostics: makeDiagnosticsLink(),
    lastError: null,
  };
  return { ...core, hash: computeBufferHash(core) };
}

function withBuffer(buffer: EditorBuffer, patch: Partial<Omit<EditorBuffer, "hash">>): EditorBuffer {
  const core: Omit<EditorBuffer, "hash"> = {
    path: patch.path ?? buffer.path,
    title: patch.title ?? buffer.title,
    lifecycle: patch.lifecycle ?? buffer.lifecycle,
    source: patch.source ?? buffer.source,
    language: patch.language ?? buffer.language,
    encoding: patch.encoding ?? buffer.encoding,
    lineEnding: patch.lineEnding ?? buffer.lineEnding,
    readOnly: patch.readOnly ?? buffer.readOnly,
    pinned: patch.pinned ?? buffer.pinned,
    touchedAtMs: patch.touchedAtMs ?? buffer.touchedAtMs,
    openedAtMs: patch.openedAtMs ?? buffer.openedAtMs,
    lastSavedAtMs: patch.lastSavedAtMs ?? buffer.lastSavedAtMs,
    lastDiskSyncAtMs: patch.lastDiskSyncAtMs ?? buffer.lastDiskSyncAtMs,
    content: patch.content ?? buffer.content,
    viewport: patch.viewport ?? buffer.viewport,
    diagnostics: patch.diagnostics ?? buffer.diagnostics,
    lastError: patch.lastError ?? buffer.lastError,
  };
  return { ...core, hash: computeBufferHash(core) };
}

function recomputeState(state: Omit<EditorBuffersState, "hash">): EditorBuffersState {
  return { ...state, hash: computeStateHash(state) };
}

function dirty(buffer: EditorBuffer): boolean {
  return buffer.content.workingHash !== buffer.content.baselineHash;
}

function visibleContent(buffer: EditorBuffer): string {
  if (buffer.content.preview.visible && buffer.content.preview.content !== null) return buffer.content.preview.content;
  return buffer.content.workingContent;
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialEditorBuffersState(): EditorBuffersState {
  const core: Omit<EditorBuffersState, "hash"> = {
    schema: 1,
    byPath: {},
    tabOrder: [],
    activePath: null,
    previousActivePath: null,
    untitledCounter: 0,
    globalRevision: 0,
    lastEventAtMs: null,
  };
  return recomputeState(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function editorBuffersReducer(state: EditorBuffersState, action: EditorBuffersAction): EditorBuffersState {
  const core: Omit<EditorBuffersState, "hash"> = {
    schema: state.schema,
    byPath: { ...state.byPath },
    tabOrder: [...state.tabOrder],
    activePath: state.activePath,
    previousActivePath: state.previousActivePath,
    untitledCounter: state.untitledCounter,
    globalRevision: state.globalRevision,
    lastEventAtMs: state.lastEventAtMs,
  };

  switch (action.type) {
    case "BUFFER_OPEN_REQUESTED": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (existing) {
        core.activePath = path;
        core.previousActivePath = state.activePath;
        core.lastEventAtMs = nowMs(action.payload.atMs);
        return recomputeState(core);
      }
      core.byPath[path] = makeBuffer(action.payload, "opening");
      core.tabOrder = uniqueSorted([...core.tabOrder, path]);
      core.previousActivePath = state.activePath;
      core.activePath = path;
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_OPEN_SUCCEEDED": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path] ?? makeBuffer(action.payload, "ready");
      core.byPath[path] = withBuffer(existing, {
        lifecycle: "ready",
        title: action.payload.title?.trim() || existing.title,
        source: action.payload.source ?? existing.source,
        language: action.payload.language ?? existing.language,
        encoding: action.payload.encoding ?? existing.encoding,
        lineEnding: action.payload.lineEnding ?? existing.lineEnding,
        readOnly: action.payload.readOnly ?? existing.readOnly,
        pinned: action.payload.pinned ?? existing.pinned,
        content: (() => {
          const content = action.payload.content ?? existing.content.baselineContent;
          const baselineHash = hashString(content);
          return {
            baselineContent: content,
            baselineHash,
            workingContent: content,
            workingHash: baselineHash,
            preview: makePreviewOverlay(),
            revision: existing.content.revision,
          };
        })(),
        touchedAtMs: nowMs(action.payload.atMs),
        lastDiskSyncAtMs: nowMs(action.payload.atMs),
        lastError: null,
      });
      core.tabOrder = uniqueSorted([...core.tabOrder, path]);
      core.previousActivePath = state.activePath;
      core.activePath = path;
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_OPEN_FAILED": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        lifecycle: "error",
        touchedAtMs: nowMs(action.atMs),
        lastError: action.error,
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFER_CLOSE_REQUESTED": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        lifecycle: "closing",
        touchedAtMs: nowMs(action.atMs),
      });
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFER_CLOSED": {
      const path = normalizePath(action.path);
      if (!core.byPath[path]) return state;
      delete core.byPath[path];
      core.tabOrder = core.tabOrder.filter((p) => p !== path);
      if (core.activePath === path) {
        core.previousActivePath = path;
        core.activePath = core.tabOrder[0] ?? null;
      }
      if (core.previousActivePath === path) {
        core.previousActivePath = null;
      }
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFER_FOCUSED": {
      const path = normalizePath(action.path);
      if (!core.byPath[path]) return state;
      core.previousActivePath = core.activePath;
      core.activePath = path;
      core.byPath[path] = withBuffer(core.byPath[path], {
        touchedAtMs: nowMs(action.atMs),
      });
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFER_PIN_TOGGLED": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        pinned: !existing.pinned,
      });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_REORDERED": {
      const ordered = action.tabOrder.map(normalizePath).filter((p) => core.byPath[p]);
      const missing = core.tabOrder.filter((p) => !ordered.includes(p));
      core.tabOrder = [...ordered, ...missing];
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_WORKING_CONTENT_SET": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      const workingContent = action.payload.content;
      const workingHash = hashString(workingContent);
      core.byPath[path] = withBuffer(existing, {
        touchedAtMs: nowMs(action.payload.atMs),
        content: {
          ...existing.content,
          workingContent,
          workingHash,
          revision: existing.content.revision + 1,
        },
        lastError: null,
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_DISK_SYNCED": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      const baselineContent = action.payload.content;
      const baselineHash = hashString(baselineContent);
      const preserve = action.payload.preserveWorkingCopy ?? false;
      const workingContent = preserve ? existing.content.workingContent : baselineContent;
      const workingHash = preserve ? existing.content.workingHash : baselineHash;
      core.byPath[path] = withBuffer(existing, {
        touchedAtMs: nowMs(action.payload.atMs),
        lastDiskSyncAtMs: nowMs(action.payload.atMs),
        content: {
          ...existing.content,
          baselineContent,
          baselineHash,
          workingContent,
          workingHash,
        },
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_SAVED": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        lastSavedAtMs: nowMs(action.atMs),
        lastDiskSyncAtMs: nowMs(action.atMs),
        content: {
          ...existing.content,
          baselineContent: existing.content.workingContent,
          baselineHash: existing.content.workingHash,
        },
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFER_PREVIEW_APPLIED": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        touchedAtMs: nowMs(action.payload.atMs),
        content: {
          ...existing.content,
          preview: {
            previewHash: action.payload.previewHash,
            patchId: action.payload.patchId,
            content: action.payload.content,
            contentHash: hashString(action.payload.content),
            appliedAtMs: nowMs(action.payload.atMs),
            visible: action.payload.visible ?? true,
          },
        },
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_PREVIEW_VISIBILITY_SET": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        content: {
          ...existing.content,
          preview: {
            ...existing.content.preview,
            visible: action.visible,
          },
        },
      });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_PREVIEW_CLEARED": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        content: {
          ...existing.content,
          preview: makePreviewOverlay(),
        },
      });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_VIEWPORT_SET": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      const incoming = action.payload.viewport;
      core.byPath[path] = withBuffer(existing, {
        viewport: {
          cursor: incoming.cursor
            ? { line: Math.max(1, incoming.cursor.line), column: Math.max(1, incoming.cursor.column) }
            : existing.viewport.cursor,
          selections: incoming.selections ? normalizeSelections(incoming.selections) : existing.viewport.selections,
          scrollTop: incoming.scrollTop ?? existing.viewport.scrollTop,
          scrollLeft: incoming.scrollLeft ?? existing.viewport.scrollLeft,
        },
        touchedAtMs: nowMs(action.payload.atMs),
      });
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_DIAGNOSTICS_LINKED": {
      const path = normalizePath(action.payload.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        diagnostics: {
          diagnosticIds: uniqueSorted(action.payload.diagnosticIds),
          severityCounts: {
            error: action.payload.severityCounts?.error ?? existing.diagnostics.severityCounts.error,
            warn: action.payload.severityCounts?.warn ?? existing.diagnostics.severityCounts.warn,
            info: action.payload.severityCounts?.info ?? existing.diagnostics.severityCounts.info,
            hint: action.payload.severityCounts?.hint ?? existing.diagnostics.severityCounts.hint,
          },
          lastLinkedAtMs: nowMs(action.payload.atMs),
        },
      });
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.payload.atMs);
      return recomputeState(core);
    }

    case "BUFFER_READONLY_SET": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, { readOnly: action.readOnly });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_LANGUAGE_SET": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, { language: action.language });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_ERROR_SET": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        lastError: action.error,
        lifecycle: action.error ? "error" : existing.lifecycle === "error" ? "ready" : existing.lifecycle,
      });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFER_RESET_WORKING_TO_BASELINE": {
      const path = normalizePath(action.path);
      const existing = core.byPath[path];
      if (!existing) return state;
      core.byPath[path] = withBuffer(existing, {
        content: {
          ...existing.content,
          workingContent: existing.content.baselineContent,
          workingHash: existing.content.baselineHash,
          revision: existing.content.revision + 1,
        },
      });
      core.globalRevision += 1;
      return recomputeState(core);
    }

    case "BUFFERS_CLOSE_ALL": {
      if (action.keepPinned) {
        const keepPaths = core.tabOrder.filter((path) => core.byPath[path]?.pinned);
        const nextByPath: Record<string, EditorBuffer> = {};
        for (const path of keepPaths) nextByPath[path] = core.byPath[path];
        core.byPath = nextByPath;
        core.tabOrder = keepPaths;
        core.activePath = keepPaths[0] ?? null;
        core.previousActivePath = null;
      } else {
        core.byPath = {};
        core.tabOrder = [];
        core.activePath = null;
        core.previousActivePath = null;
      }
      core.globalRevision += 1;
      core.lastEventAtMs = nowMs(action.atMs);
      return recomputeState(core);
    }

    case "BUFFERS_RESET": {
      return createInitialEditorBuffersState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectActiveBufferPath: EditorBuffersSelector<string | null> = (state) => state.activePath;
export const selectActiveBuffer: EditorBuffersSelector<EditorBuffer | null> = (state) => (state.activePath ? state.byPath[state.activePath] ?? null : null);
export const selectOpenBuffers: EditorBuffersSelector<EditorBuffer[]> = (state) => state.tabOrder.map((path) => state.byPath[path]).filter(Boolean);
export const selectDirtyBuffers: EditorBuffersSelector<EditorBuffer[]> = (state) => selectOpenBuffers(state).filter((buffer) => dirty(buffer));
export const selectPreviewVisibleBuffers: EditorBuffersSelector<EditorBuffer[]> = (state) =>
  selectOpenBuffers(state).filter((buffer) => buffer.content.preview.visible && !!buffer.content.preview.previewHash);
export const selectBufferByPath = (path: string): EditorBuffersSelector<EditorBuffer | null> => {
  const normalized = normalizePath(path);
  return (state) => state.byPath[normalized] ?? null;
};
export const selectVisibleBufferContent = (path: string): EditorBuffersSelector<string | null> => {
  const normalized = normalizePath(path);
  return (state) => {
    const buffer = state.byPath[normalized];
    return buffer ? visibleContent(buffer) : null;
  };
};

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateEditorBuffer(buffer: EditorBuffer): void {
  const core: Omit<EditorBuffer, "hash"> = {
    path: buffer.path,
    title: buffer.title,
    lifecycle: buffer.lifecycle,
    source: buffer.source,
    language: buffer.language,
    encoding: buffer.encoding,
    lineEnding: buffer.lineEnding,
    readOnly: buffer.readOnly,
    pinned: buffer.pinned,
    touchedAtMs: buffer.touchedAtMs,
    openedAtMs: buffer.openedAtMs,
    lastSavedAtMs: buffer.lastSavedAtMs,
    lastDiskSyncAtMs: buffer.lastDiskSyncAtMs,
    content: buffer.content,
    viewport: buffer.viewport,
    diagnostics: buffer.diagnostics,
    lastError: buffer.lastError,
  };

  if (buffer.hash !== computeBufferHash(core)) {
    throw new Error(`editor_buffer_hash_drift:${buffer.path}`);
  }

  if (buffer.content.baselineHash !== hashString(buffer.content.baselineContent)) {
    throw new Error(`editor_buffer_baseline_hash_invalid:${buffer.path}`);
  }

  if (buffer.content.workingHash !== hashString(buffer.content.workingContent)) {
    throw new Error(`editor_buffer_working_hash_invalid:${buffer.path}`);
  }

  if (buffer.content.preview.contentHash !== (buffer.content.preview.content !== null ? hashString(buffer.content.preview.content) : null)) {
    throw new Error(`editor_buffer_preview_hash_invalid:${buffer.path}`);
  }
}

export function validateEditorBuffersState(state: EditorBuffersState): void {
  if (state.schema !== 1) throw new Error("editor_buffers_state_schema_invalid");

  const core: Omit<EditorBuffersState, "hash"> = {
    schema: state.schema,
    byPath: state.byPath,
    tabOrder: state.tabOrder,
    activePath: state.activePath,
    previousActivePath: state.previousActivePath,
    untitledCounter: state.untitledCounter,
    globalRevision: state.globalRevision,
    lastEventAtMs: state.lastEventAtMs,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("editor_buffers_state_hash_drift");
  }

  const uniqueTabOrder = uniqueSorted(state.tabOrder);
  if (stableJson(uniqueTabOrder) !== stableJson([...state.tabOrder].sort((a, b) => a.localeCompare(b)))) {
    throw new Error("editor_buffers_tab_order_not_normalized");
  }

  for (const path of Object.keys(state.byPath)) {
    if (!state.tabOrder.includes(path)) {
      throw new Error(`editor_buffers_orphan_buffer:${path}`);
    }
    validateEditorBuffer(state.byPath[path]);
  }

  if (state.activePath && !state.byPath[state.activePath]) {
    throw new Error("editor_buffers_active_path_missing");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyEditorBuffersActions(initial: EditorBuffersState, actions: EditorBuffersAction[]): EditorBuffersState {
  return actions.reduce(editorBuffersReducer, initial);
}

export function serializeEditorBuffersState(state: EditorBuffersState): string {
  validateEditorBuffersState(state);
  return stableJson(state);
}
