import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { BrowserWindow, dialog, ipcMain, shell } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / workspace_ipc.ts
 *
 * Dedicated workspace IPC adapter for the Electron main process.
 *
 * This module owns the workspace-facing IPC surface, including:
 * - request normalization for workspace open / reveal flows
 * - path validation and safe path resolution
 * - recent-workspace state projection and persistence hooks
 * - guarded integration with boundary/capability/router layers
 * - explicit registration of workspace IPC handlers
 * - structured audit records for every accepted or denied action
 *
 * It is intentionally NOT a generic IPC helper.
 * It is the domain adapter for workspace lifecycle interactions.
 *
 * Hard invariants:
 * - no raw renderer path is trusted without normalization
 * - reveal/open operations must target existing filesystem entries where required
 * - recent workspaces are deduplicated and bounded deterministically
 * - IPC registration is explicit and idempotent
 * - identical semantic requests produce identical normalized hashes
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

export type WorkspaceIntent = "open" | "reveal" | "close";

export type WorkspaceOpenPayload = {
  workspacePath: string;
};

export type WorkspaceRevealPayload = {
  targetPath: string;
};

export type WorkspaceClosePayload = Record<string, never>;

export type WorkspaceOpenResult = {
  ok: true;
  path: string;
  recentPaths: string[];
  openedAtMs: number;
};

export type WorkspaceRevealResult = {
  ok: true;
  path: string;
  exists: true;
};

export type WorkspaceCloseResult = {
  ok: true;
  previousPath: string | null;
  recentPaths: string[];
};

export type WorkspaceRuntimeState = {
  currentPath: string | null;
  recentPaths: string[];
  reopenLastWorkspace: boolean;
  maxRecentPaths: number;
};

export type WorkspacePolicy = {
  allowOpen: boolean;
  allowReveal: boolean;
  allowClose: boolean;
  requireDirectoryForOpen: boolean;
  allowFileReveal: boolean;
};

export type WorkspaceAuditRecord = {
  schema: 1;
  ts_ms: number;
  intent: WorkspaceIntent;
  decision: "allow" | "deny";
  reason: string;
  path?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type WorkspaceAuditFn = (record: WorkspaceAuditRecord) => void;

export type WorkspacePersistence = {
  saveRecentPaths: (recentPaths: string[]) => Promise<void> | void;
  saveCurrentPath: (currentPath: string | null) => Promise<void> | void;
};

export type WorkspaceBoundaryHooks = {
  beforeOpen?: (normalizedPath: string) => Promise<void> | void;
  afterOpen?: (normalizedPath: string) => Promise<void> | void;
  beforeReveal?: (normalizedPath: string) => Promise<void> | void;
  beforeClose?: (currentPath: string | null) => Promise<void> | void;
  afterClose?: (previousPath: string | null) => Promise<void> | void;
};

export type WorkspaceIpcOptions = {
  window: BrowserWindow | null;
  state: WorkspaceRuntimeState;
  policy: WorkspacePolicy;
  persistence?: WorkspacePersistence;
  boundary?: WorkspaceBoundaryHooks;
  audit?: WorkspaceAuditFn;
  openChannel?: string;
  revealChannel?: string;
  closeChannel?: string;
};

export type WorkspaceHandlerBundle = {
  openWorkspace: (payload: WorkspaceOpenPayload) => Promise<WorkspaceOpenResult>;
  revealPath: (payload: WorkspaceRevealPayload) => Promise<WorkspaceRevealResult>;
  closeWorkspace: (payload?: WorkspaceClosePayload) => Promise<WorkspaceCloseResult>;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_OPEN_CHANNEL = "adjutorix:workspace:open";
const DEFAULT_REVEAL_CHANNEL = "adjutorix:workspace:revealInShell";
const DEFAULT_CLOSE_CHANNEL = "adjutorix:workspace:close";
const DEFAULT_MAX_RECENT = 20;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:ipc:workspace_ipc:${message}`);
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

function nowMs(): number {
  return Date.now();
}

function normalizePath(input: string): string {
  assert(typeof input === "string" && input.trim().length > 0, "path_invalid");
  return path.resolve(input.trim());
}

function pathExists(targetPath: string): boolean {
  try {
    fs.accessSync(targetPath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function pathIsDirectory(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
}

function pathIsFile(targetPath: string): boolean {
  try {
    return fs.statSync(targetPath).isFile();
  } catch {
    return false;
  }
}

function dedupeRecent(paths: string[], maxRecentPaths: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of paths.map((p) => normalizePath(p))) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      out.push(candidate);
    }
    if (out.length >= maxRecentPaths) break;
  }
  return out;
}

function auditRecord(
  intent: WorkspaceIntent,
  decision: "allow" | "deny",
  reason: string,
  detail: Record<string, JsonValue>,
  pathValue?: string,
): WorkspaceAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    intent,
    decision,
    reason,
    ...(pathValue ? { path: pathValue } : {}),
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

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createWorkspaceIpc(options: WorkspaceIpcOptions): WorkspaceHandlerBundle {
  const state = options.state;
  const policy = options.policy;
  const persistence = options.persistence;
  const boundary = options.boundary;
  const audit = options.audit;

  const openChannel = options.openChannel ?? DEFAULT_OPEN_CHANNEL;
  const revealChannel = options.revealChannel ?? DEFAULT_REVEAL_CHANNEL;
  const closeChannel = options.closeChannel ?? DEFAULT_CLOSE_CHANNEL;
  const maxRecentPaths = state.maxRecentPaths > 0 ? state.maxRecentPaths : DEFAULT_MAX_RECENT;

  let registered = false;

  const emitAudit = (record: WorkspaceAuditRecord): void => {
    audit?.(record);
  };

  const persistState = async (): Promise<void> => {
    await maybeCallWith(persistence?.saveRecentPaths, state.recentPaths);
    await maybeCallWith(persistence?.saveCurrentPath, state.currentPath);
  };

  const openWorkspace = async (payload: WorkspaceOpenPayload): Promise<WorkspaceOpenResult> => {
    if (!policy.allowOpen) {
      const record = auditRecord("open", "deny", "workspace_open_denied_by_policy", {});
      emitAudit(record);
      throw new Error(`workspace_open_denied:${record.reason}`);
    }

    const normalizedPath = normalizePath(payload.workspacePath);

    if (!pathExists(normalizedPath)) {
      const record = auditRecord("open", "deny", "workspace_path_not_found", {}, normalizedPath);
      emitAudit(record);
      throw new Error(`workspace_open_denied:${record.reason}`);
    }

    if (policy.requireDirectoryForOpen && !pathIsDirectory(normalizedPath)) {
      const record = auditRecord("open", "deny", "workspace_path_not_directory", {}, normalizedPath);
      emitAudit(record);
      throw new Error(`workspace_open_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.beforeOpen, normalizedPath);

    state.currentPath = normalizedPath;
    state.recentPaths = dedupeRecent([normalizedPath, ...state.recentPaths], maxRecentPaths);

    await persistState();
    await maybeCallWith(boundary?.afterOpen, normalizedPath);

    const record = auditRecord(
      "open",
      "allow",
      "workspace_opened",
      { recent_count: state.recentPaths.length, require_directory: policy.requireDirectoryForOpen },
      normalizedPath,
    );
    emitAudit(record);

    return {
      ok: true,
      path: normalizedPath,
      recentPaths: [...state.recentPaths],
      openedAtMs: nowMs(),
    };
  };

  const revealPath = async (payload: WorkspaceRevealPayload): Promise<WorkspaceRevealResult> => {
    if (!policy.allowReveal) {
      const record = auditRecord("reveal", "deny", "workspace_reveal_denied_by_policy", {});
      emitAudit(record);
      throw new Error(`workspace_reveal_denied:${record.reason}`);
    }

    const normalizedPath = normalizePath(payload.targetPath);
    if (!pathExists(normalizedPath)) {
      const record = auditRecord("reveal", "deny", "reveal_target_not_found", {}, normalizedPath);
      emitAudit(record);
      throw new Error(`workspace_reveal_denied:${record.reason}`);
    }

    if (!policy.allowFileReveal && pathIsFile(normalizedPath)) {
      const record = auditRecord("reveal", "deny", "file_reveal_not_allowed", {}, normalizedPath);
      emitAudit(record);
      throw new Error(`workspace_reveal_denied:${record.reason}`);
    }

    await maybeCallWith(boundary?.beforeReveal, normalizedPath);
    shell.showItemInFolder(normalizedPath);

    const record = auditRecord("reveal", "allow", "workspace_revealed", { is_file: pathIsFile(normalizedPath) }, normalizedPath);
    emitAudit(record);

    return {
      ok: true,
      path: normalizedPath,
      exists: true,
    };
  };

  const closeWorkspace = async (_payload: WorkspaceClosePayload = {}): Promise<WorkspaceCloseResult> => {
    if (!policy.allowClose) {
      const record = auditRecord("close", "deny", "workspace_close_denied_by_policy", {});
      emitAudit(record);
      throw new Error(`workspace_close_denied:${record.reason}`);
    }

    const previousPath = state.currentPath;
    await maybeCallWith(boundary?.beforeClose, previousPath);

    state.currentPath = null;
    await persistState();
    await maybeCallWith(boundary?.afterClose, previousPath);

    const record = auditRecord("close", "allow", "workspace_closed", { had_previous: previousPath !== null }, previousPath ?? undefined);
    emitAudit(record);

    return {
      ok: true,
      previousPath,
      recentPaths: [...state.recentPaths],
    };
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(openChannel, async (_event, payload: WorkspaceOpenPayload) => openWorkspace(payload));
    ipcMain.handle(revealChannel, async (_event, payload: WorkspaceRevealPayload) => revealPath(payload));
    ipcMain.handle(closeChannel, async (_event, payload?: WorkspaceClosePayload) => closeWorkspace(payload));

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(openChannel);
    ipcMain.removeHandler(revealChannel);
    ipcMain.removeHandler(closeChannel);
    registered = false;
  };

  return {
    openWorkspace,
    revealPath,
    closeWorkspace,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / UTILITIES
// -----------------------------------------------------------------------------

export function createDefaultWorkspaceRuntimeState(): WorkspaceRuntimeState {
  return {
    currentPath: null,
    recentPaths: [],
    reopenLastWorkspace: true,
    maxRecentPaths: DEFAULT_MAX_RECENT,
  };
}

export function createDefaultWorkspacePolicy(): WorkspacePolicy {
  return {
    allowOpen: true,
    allowReveal: true,
    allowClose: true,
    requireDirectoryForOpen: true,
    allowFileReveal: true,
  };
}

export function validateWorkspaceRuntimeState(state: WorkspaceRuntimeState): void {
  assert(Array.isArray(state.recentPaths), "recent_paths_invalid");
  assert(typeof state.reopenLastWorkspace === "boolean", "reopen_last_workspace_invalid");
  assert(Number.isInteger(state.maxRecentPaths) && state.maxRecentPaths > 0, "max_recent_paths_invalid");
  if (state.currentPath !== null) {
    assert(typeof state.currentPath === "string" && state.currentPath.length > 0, "current_path_invalid");
  }
}
