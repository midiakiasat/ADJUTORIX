import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { ipcMain, dialog, BrowserWindow } from "electron";

/**
 * ADJUTORIX APP — MAIN / IPC / diagnostics_ipc.ts
 *
 * Dedicated diagnostics IPC adapter for the Electron main process.
 *
 * Responsibilities:
 * - expose a guarded diagnostics read/export surface over IPC
 * - normalize requests for runtime snapshots, startup reports, observability bundles,
 *   log tailing, crash context, and full diagnostic export
 * - keep diagnostics access explicit, bounded, deterministic, and auditable
 * - centralize export packaging instead of leaking ad hoc file reads to renderer
 * - register/unregister diagnostics handlers idempotently
 *
 * Hard invariants:
 * - diagnostics IPC never grants arbitrary filesystem reads
 * - all exported artifacts are built from allow-listed sources only
 * - log tail requests are bounded by max lines/max bytes
 * - identical semantic requests produce identical query/export hashes
 * - registration and teardown are explicit and total
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

export type DiagnosticsIntent =
  | "runtime_snapshot"
  | "startup_report"
  | "observability_bundle"
  | "log_tail"
  | "crash_context"
  | "export_bundle";

export type DiagnosticsRuntimeSnapshot = {
  schema: 1;
  app: {
    version: string;
    platform: NodeJS.Platform;
    arch: string;
    electron: string;
    node: string;
    pid: number;
    uptime_seconds: number;
  };
  runtime: {
    workspacePath: string | null;
    agentUrl: string | null;
    agentHealthy: boolean;
    configHash: string | null;
    environmentHash: string | null;
    phase: string | null;
  };
  resources: {
    rss_bytes: number;
    heap_total_bytes: number;
    heap_used_bytes: number;
    external_bytes: number;
    cpu_load_avg: number[];
  };
  stateHash: string;
};

export type DiagnosticsStartupReport = {
  schema: 1;
  ok: boolean;
  startedAtMs: number;
  finishedAtMs: number;
  environmentHash: string;
  configHash: string;
  summaryHash: string;
  counts: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    criticalFail: number;
  };
  checks: Array<{
    id: string;
    category: string;
    severity: string;
    status: string;
    critical: boolean;
    message: string;
    detail: Record<string, JsonValue>;
  }>;
};

export type DiagnosticsObservabilityBundle = {
  schema: 1;
  loggerSnapshot: Record<string, JsonValue> | null;
  metricsSnapshot: Record<string, JsonValue> | null;
  lastEventHash: string | null;
  lastErrorHash: string | null;
  bundleHash: string;
};

export type DiagnosticsCrashContext = {
  schema: 1;
  lastCrashAtMs: number | null;
  lastCrashKind: string | null;
  lastCrashFingerprint: string | null;
  lastCrashMessage: string | null;
  crashDumpRoot: string | null;
  stateHash: string;
};

export type DiagnosticsLogTailPayload = {
  target: "main" | "observability" | "custom";
  lines?: number;
  bytes?: number;
  customFileName?: string;
};

export type DiagnosticsExportPayload = {
  includeRuntimeSnapshot?: boolean;
  includeStartupReport?: boolean;
  includeObservability?: boolean;
  includeLogTail?: boolean;
  includeCrashContext?: boolean;
  logTailLines?: number;
  promptForPath?: boolean;
};

export type DiagnosticsAuditRecord = {
  schema: 1;
  ts_ms: number;
  intent: DiagnosticsIntent;
  decision: "allow" | "deny";
  reason: string;
  queryHash?: string;
  hash: string;
  detail: Record<string, JsonValue>;
};

export type DiagnosticsAuditFn = (record: DiagnosticsAuditRecord) => void;

export type DiagnosticsPolicy = {
  allowRuntimeSnapshot: boolean;
  allowStartupReport: boolean;
  allowObservabilityBundle: boolean;
  allowLogTail: boolean;
  allowCrashContext: boolean;
  allowExportBundle: boolean;
  maxTailLines: number;
  maxTailBytes: number;
  allowCustomLogTarget: boolean;
};

export type DiagnosticsPaths = {
  logRoot: string;
  diagnosticsRoot: string;
  startupReportPath: string | null;
  mainLogFile: string | null;
  observabilityLogFile: string | null;
  crashDumpRoot: string | null;
};

export type DiagnosticsSources = {
  getRuntimeSnapshot: () => Promise<DiagnosticsRuntimeSnapshot> | DiagnosticsRuntimeSnapshot;
  getStartupReport: () => Promise<DiagnosticsStartupReport | null> | DiagnosticsStartupReport | null;
  getObservabilityBundle: () => Promise<DiagnosticsObservabilityBundle> | DiagnosticsObservabilityBundle;
  getCrashContext: () => Promise<DiagnosticsCrashContext> | DiagnosticsCrashContext;
};

export type DiagnosticsBoundaryHooks = {
  beforeRuntimeSnapshot?: () => Promise<void> | void;
  beforeStartupReport?: () => Promise<void> | void;
  beforeObservabilityBundle?: () => Promise<void> | void;
  beforeLogTail?: (payload: DiagnosticsLogTailPayload) => Promise<void> | void;
  beforeCrashContext?: () => Promise<void> | void;
  beforeExport?: (payload: DiagnosticsExportPayload) => Promise<void> | void;
};

export type DiagnosticsIpcOptions = {
  window: BrowserWindow | null;
  policy: DiagnosticsPolicy;
  paths: DiagnosticsPaths;
  sources: DiagnosticsSources;
  audit?: DiagnosticsAuditFn;
  boundary?: DiagnosticsBoundaryHooks;
  channels?: {
    runtimeSnapshot?: string;
    startupReport?: string;
    observabilityBundle?: string;
    logTail?: string;
    crashContext?: string;
    exportBundle?: string;
  };
};

export type DiagnosticsRuntimeSnapshotResult = {
  ok: true;
  snapshot: DiagnosticsRuntimeSnapshot;
  queryHash: string;
};

export type DiagnosticsStartupReportResult = {
  ok: true;
  report: DiagnosticsStartupReport | null;
  queryHash: string;
};

export type DiagnosticsObservabilityBundleResult = {
  ok: true;
  bundle: DiagnosticsObservabilityBundle;
  queryHash: string;
};

export type DiagnosticsLogTailResult = {
  ok: true;
  target: string;
  filePath: string;
  lines: string[];
  lineCount: number;
  queryHash: string;
};

export type DiagnosticsCrashContextResult = {
  ok: true;
  crashContext: DiagnosticsCrashContext;
  queryHash: string;
};

export type DiagnosticsExportBundleResult = {
  ok: true;
  filePath: string;
  bytes: number;
  exportHash: string;
};

export type DiagnosticsHandlerBundle = {
  getRuntimeSnapshot: () => Promise<DiagnosticsRuntimeSnapshotResult>;
  getStartupReport: () => Promise<DiagnosticsStartupReportResult>;
  getObservabilityBundle: () => Promise<DiagnosticsObservabilityBundleResult>;
  getLogTail: (payload: DiagnosticsLogTailPayload) => Promise<DiagnosticsLogTailResult>;
  getCrashContext: () => Promise<DiagnosticsCrashContextResult>;
  exportBundle: (payload: DiagnosticsExportPayload) => Promise<DiagnosticsExportBundleResult>;
  register: () => void;
  unregister: () => void;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_CHANNELS = {
  runtimeSnapshot: "adjutorix:diagnostics:runtimeSnapshot",
  startupReport: "adjutorix:diagnostics:startupReport",
  observabilityBundle: "adjutorix:diagnostics:observabilityBundle",
  logTail: "adjutorix:diagnostics:logTail",
  crashContext: "adjutorix:diagnostics:crashContext",
  exportBundle: "adjutorix:diagnostics:exportBundle",
} as const;

const DEFAULT_EXPORT_BASENAME = "adjutorix-diagnostics";

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:ipc:diagnostics_ipc:${message}`);
}

function stableJson(value: unknown): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = normalize((v as Record<string, unknown>)[key]);
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
    for (const key of Object.keys(value as Record<string, unknown>).sort()) out[key] = normalizeJson((value as Record<string, unknown>)[key]);
    return out;
  }
  return String(value);
}

function queryHash(intent: DiagnosticsIntent, payload: Record<string, JsonValue>): string {
  return sha256(stableJson({ schema: 1, intent, payload }));
}

function auditRecord(
  intent: DiagnosticsIntent,
  decision: "allow" | "deny",
  reason: string,
  detail: Record<string, JsonValue>,
  queryHashValue?: string,
): DiagnosticsAuditRecord {
  const core = {
    schema: 1 as const,
    ts_ms: nowMs(),
    intent,
    decision,
    reason,
    ...(queryHashValue ? { queryHash: queryHashValue } : {}),
    detail,
  };
  return {
    ...core,
    hash: sha256(stableJson(core)),
  };
}

function emitAudit(audit: DiagnosticsAuditFn | undefined, record: DiagnosticsAuditRecord): void {
  audit?.(record);
}

async function maybeCall(fn: (() => Promise<void> | void) | undefined): Promise<void> {
  if (fn) await fn();
}

async function maybeCallWith<T>(fn: ((arg: T) => Promise<void> | void) | undefined, arg: T): Promise<void> {
  if (fn) await fn(arg);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readTail(filePath: string, maxLines: number, maxBytes: number): string[] {
  const raw = fs.readFileSync(filePath, "utf8");
  const sliced = raw.length > maxBytes ? raw.slice(raw.length - maxBytes) : raw;
  const lines = sliced.split(/\r?\n/).filter(Boolean);
  return lines.slice(-maxLines);
}

function resolveLogFile(paths: DiagnosticsPaths, payload: DiagnosticsLogTailPayload, policy: DiagnosticsPolicy): { target: string; filePath: string } {
  switch (payload.target) {
    case "main":
      assert(paths.mainLogFile, "main_log_file_missing");
      return { target: "main", filePath: paths.mainLogFile };
    case "observability":
      assert(paths.observabilityLogFile, "observability_log_file_missing");
      return { target: "observability", filePath: paths.observabilityLogFile };
    case "custom":
      assert(policy.allowCustomLogTarget, "custom_log_target_not_allowed");
      assert(typeof payload.customFileName === "string" && payload.customFileName.length > 0, "custom_log_filename_invalid");
      const filePath = path.resolve(paths.logRoot, payload.customFileName);
      assert(filePath.startsWith(path.resolve(paths.logRoot) + path.sep) || filePath === path.resolve(paths.logRoot), "custom_log_path_escape");
      return { target: "custom", filePath };
    default: {
      const exhaustive: never = payload.target;
      throw new Error(`unhandled_log_target:${exhaustive}`);
    }
  }
}

function normalizeTailPayload(payload: DiagnosticsLogTailPayload, policy: DiagnosticsPolicy): DiagnosticsLogTailPayload {
  const lines = payload.lines ?? Math.min(200, policy.maxTailLines);
  const bytes = payload.bytes ?? Math.min(256 * 1024, policy.maxTailBytes);
  assert(Number.isInteger(lines) && lines > 0 && lines <= policy.maxTailLines, "tail_lines_invalid");
  assert(Number.isInteger(bytes) && bytes > 0 && bytes <= policy.maxTailBytes, "tail_bytes_invalid");
  return {
    target: payload.target,
    lines,
    bytes,
    ...(payload.customFileName ? { customFileName: payload.customFileName } : {}),
  };
}

// -----------------------------------------------------------------------------
// FACTORY
// -----------------------------------------------------------------------------

export function createDiagnosticsIpc(options: DiagnosticsIpcOptions): DiagnosticsHandlerBundle {
  const policy = options.policy;
  const paths = options.paths;
  const sources = options.sources;
  const audit = options.audit;
  const boundary = options.boundary;

  const channels = {
    runtimeSnapshot: options.channels?.runtimeSnapshot ?? DEFAULT_CHANNELS.runtimeSnapshot,
    startupReport: options.channels?.startupReport ?? DEFAULT_CHANNELS.startupReport,
    observabilityBundle: options.channels?.observabilityBundle ?? DEFAULT_CHANNELS.observabilityBundle,
    logTail: options.channels?.logTail ?? DEFAULT_CHANNELS.logTail,
    crashContext: options.channels?.crashContext ?? DEFAULT_CHANNELS.crashContext,
    exportBundle: options.channels?.exportBundle ?? DEFAULT_CHANNELS.exportBundle,
  };

  let registered = false;

  const getRuntimeSnapshot = async (): Promise<DiagnosticsRuntimeSnapshotResult> => {
    if (!policy.allowRuntimeSnapshot) {
      const record = auditRecord("runtime_snapshot", "deny", "runtime_snapshot_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_runtime_snapshot_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeRuntimeSnapshot);
    const snapshot = normalizeJson(await sources.getRuntimeSnapshot()) as unknown as DiagnosticsRuntimeSnapshot;
    const qh = queryHash("runtime_snapshot", {});

    emitAudit(audit, auditRecord("runtime_snapshot", "allow", "runtime_snapshot_returned", {
      stateHash: snapshot.stateHash,
    }, qh));

    return { ok: true, snapshot, queryHash: qh };
  };

  const getStartupReport = async (): Promise<DiagnosticsStartupReportResult> => {
    if (!policy.allowStartupReport) {
      const record = auditRecord("startup_report", "deny", "startup_report_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_startup_report_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeStartupReport);
    const report = (await sources.getStartupReport()) as DiagnosticsStartupReport | null;
    const qh = queryHash("startup_report", {});

    emitAudit(audit, auditRecord("startup_report", "allow", report ? "startup_report_returned" : "startup_report_absent", {
      hasReport: report !== null,
      summaryHash: report?.summaryHash ?? null,
    }, qh));

    return { ok: true, report, queryHash: qh };
  };

  const getObservabilityBundle = async (): Promise<DiagnosticsObservabilityBundleResult> => {
    if (!policy.allowObservabilityBundle) {
      const record = auditRecord("observability_bundle", "deny", "observability_bundle_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_observability_bundle_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeObservabilityBundle);
    const bundle = normalizeJson(await sources.getObservabilityBundle()) as unknown as DiagnosticsObservabilityBundle;
    const qh = queryHash("observability_bundle", {});

    emitAudit(audit, auditRecord("observability_bundle", "allow", "observability_bundle_returned", {
      bundleHash: bundle.bundleHash,
    }, qh));

    return { ok: true, bundle, queryHash: qh };
  };

  const getLogTail = async (payload: DiagnosticsLogTailPayload): Promise<DiagnosticsLogTailResult> => {
    if (!policy.allowLogTail) {
      const record = auditRecord("log_tail", "deny", "log_tail_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_log_tail_denied:${record.reason}`);
    }

    const normalized = normalizeTailPayload(payload, policy);
    await maybeCallWith(boundary?.beforeLogTail, normalized);

    const resolved = resolveLogFile(paths, normalized, policy);
    assert(fs.existsSync(resolved.filePath) && fs.statSync(resolved.filePath).isFile(), "log_file_missing");

    const lines = readTail(resolved.filePath, normalized.lines!, normalized.bytes!);
    const qh = queryHash("log_tail", normalizeJson(normalized) as Record<string, JsonValue>);

    emitAudit(audit, auditRecord("log_tail", "allow", "log_tail_returned", {
      target: resolved.target,
      filePath: resolved.filePath,
      lineCount: lines.length,
    }, qh));

    return {
      ok: true,
      target: resolved.target,
      filePath: resolved.filePath,
      lines,
      lineCount: lines.length,
      queryHash: qh,
    };
  };

  const getCrashContext = async (): Promise<DiagnosticsCrashContextResult> => {
    if (!policy.allowCrashContext) {
      const record = auditRecord("crash_context", "deny", "crash_context_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_crash_context_denied:${record.reason}`);
    }

    await maybeCall(boundary?.beforeCrashContext);
    const crashContext = normalizeJson(await sources.getCrashContext()) as unknown as DiagnosticsCrashContext;
    const qh = queryHash("crash_context", {});

    emitAudit(audit, auditRecord("crash_context", "allow", "crash_context_returned", {
      lastCrashAtMs: crashContext.lastCrashAtMs,
      stateHash: crashContext.stateHash,
    }, qh));

    return { ok: true, crashContext, queryHash: qh };
  };

  const exportBundle = async (payload: DiagnosticsExportPayload): Promise<DiagnosticsExportBundleResult> => {
    if (!policy.allowExportBundle) {
      const record = auditRecord("export_bundle", "deny", "export_bundle_denied_by_policy", {});
      emitAudit(audit, record);
      throw new Error(`diagnostics_export_denied:${record.reason}`);
    }

    const normalized: DiagnosticsExportPayload = {
      includeRuntimeSnapshot: payload.includeRuntimeSnapshot ?? true,
      includeStartupReport: payload.includeStartupReport ?? true,
      includeObservability: payload.includeObservability ?? true,
      includeLogTail: payload.includeLogTail ?? true,
      includeCrashContext: payload.includeCrashContext ?? true,
      logTailLines: payload.logTailLines ?? Math.min(200, policy.maxTailLines),
      promptForPath: payload.promptForPath ?? false,
    };

    await maybeCallWith(boundary?.beforeExport, normalized);

    const bundle: Record<string, JsonValue> = {
      schema: 1,
      exportedAtMs: nowMs(),
      host: os.hostname(),
    };

    if (normalized.includeRuntimeSnapshot) {
      bundle.runtimeSnapshot = (await getRuntimeSnapshot()).snapshot as unknown as JsonValue;
    }
    if (normalized.includeStartupReport) {
      bundle.startupReport = (await getStartupReport()).report as unknown as JsonValue;
    }
    if (normalized.includeObservability) {
      bundle.observability = (await getObservabilityBundle()).bundle as unknown as JsonValue;
    }
    if (normalized.includeLogTail) {
      bundle.logTail = (await getLogTail({ target: "main", lines: normalized.logTailLines })).lines as unknown as JsonValue;
    }
    if (normalized.includeCrashContext) {
      bundle.crashContext = (await getCrashContext()).crashContext as unknown as JsonValue;
    }

    const exportHash = sha256(stableJson(bundle));
    ensureDir(paths.diagnosticsRoot);

    let filePath = path.join(paths.diagnosticsRoot, `${DEFAULT_EXPORT_BASENAME}-${exportHash.slice(0, 12)}.json`);

    if (normalized.promptForPath && options.window) {
      const chosen = await dialog.showSaveDialog(options.window, {
        title: "Export Diagnostics Bundle",
        defaultPath: filePath,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (!chosen.canceled && chosen.filePath) {
        filePath = chosen.filePath;
      }
    }

    const serialized = `${stableJson(bundle)}\n`;
    fs.writeFileSync(filePath, serialized, "utf8");
    const bytes = Buffer.byteLength(serialized, "utf8");

    const qh = queryHash("export_bundle", normalizeJson(normalized) as Record<string, JsonValue>);
    emitAudit(audit, auditRecord("export_bundle", "allow", "diagnostics_bundle_exported", {
      filePath,
      bytes,
      exportHash,
    }, qh));

    return {
      ok: true,
      filePath,
      bytes,
      exportHash,
    };
  };

  const register = (): void => {
    if (registered) return;

    ipcMain.handle(channels.runtimeSnapshot, async () => getRuntimeSnapshot());
    ipcMain.handle(channels.startupReport, async () => getStartupReport());
    ipcMain.handle(channels.observabilityBundle, async () => getObservabilityBundle());
    ipcMain.handle(channels.logTail, async (_event, payload: DiagnosticsLogTailPayload) => getLogTail(payload));
    ipcMain.handle(channels.crashContext, async () => getCrashContext());
    ipcMain.handle(channels.exportBundle, async (_event, payload: DiagnosticsExportPayload) => exportBundle(payload));

    registered = true;
  };

  const unregister = (): void => {
    ipcMain.removeHandler(channels.runtimeSnapshot);
    ipcMain.removeHandler(channels.startupReport);
    ipcMain.removeHandler(channels.observabilityBundle);
    ipcMain.removeHandler(channels.logTail);
    ipcMain.removeHandler(channels.crashContext);
    ipcMain.removeHandler(channels.exportBundle);
    registered = false;
  };

  return {
    getRuntimeSnapshot,
    getStartupReport,
    getObservabilityBundle,
    getLogTail,
    getCrashContext,
    exportBundle,
    register,
    unregister,
  };
}

// -----------------------------------------------------------------------------
// DEFAULTS / VALIDATION
// -----------------------------------------------------------------------------

export function createDefaultDiagnosticsPolicy(): DiagnosticsPolicy {
  return {
    allowRuntimeSnapshot: true,
    allowStartupReport: true,
    allowObservabilityBundle: true,
    allowLogTail: true,
    allowCrashContext: true,
    allowExportBundle: true,
    maxTailLines: 2000,
    maxTailBytes: 2 * 1024 * 1024,
    allowCustomLogTarget: false,
  };
}

export function validateDiagnosticsPaths(paths: DiagnosticsPaths): void {
  assert(typeof paths.logRoot === "string" && paths.logRoot.length > 0, "log_root_invalid");
  assert(typeof paths.diagnosticsRoot === "string" && paths.diagnosticsRoot.length > 0, "diagnostics_root_invalid");
}
