import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / workspace_health.ts
 *
 * Canonical workspace health and readiness monitor for the Electron main process.
 *
 * Purpose:
 * - evaluate whether a workspace is structurally valid and operationally ready
 * - centralize health checks used by indexing, preview, verify, apply, and diagnostics
 * - distinguish hard failures from degraded-but-usable states
 * - produce deterministic health reports with explicit evidence and hashes
 * - avoid scattered ad hoc "is workspace okay?" checks across runtime modules
 *
 * Scope of evaluation:
 * - root existence and accessibility
 * - watcher/index/trust/ledger prerequisites
 * - suspicious/degraded workspace states
 * - patch/verify lineage coherence
 * - configuration/readability signals
 * - capacity hints that affect runtime behavior
 *
 * Hard invariants:
 * - identical observable workspace state yields identical health hash
 * - health evaluation is pure and read-only
 * - missing workspace defaults to unhealthy, never healthy by omission
 * - critical failures always dominate degraded warnings
 * - health outputs are serialization-stable and auditable
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

export type WorkspaceHealthLevel = "healthy" | "degraded" | "unhealthy";
export type WorkspaceHealthSeverity = "info" | "warn" | "error" | "fatal";
export type WorkspaceHealthCheckCategory =
  | "root"
  | "permissions"
  | "structure"
  | "signals"
  | "lineage"
  | "capacity"
  | "tooling"
  | "runtime";

export type WorkspaceLineageSnapshot = {
  currentPreviewHash: string | null;
  approvedPreviewHash: string | null;
  verifiedPreviewHash: string | null;
  verifyId: string | null;
  latestPatchId: string | null;
};

export type WorkspaceRuntimeSnapshot = {
  rootPath: string | null;
  dirty: boolean;
  selectionCount: number;
  recentPaths: string[];
  watcherActive: boolean;
  watcherLastEventAtMs: number | null;
  metadataHash: string | null;
  lineage: WorkspaceLineageSnapshot;
};

export type WorkspaceTrustSnapshot = {
  level: "untrusted" | "restricted" | "trusted" | null;
  evidenceFingerprint: string | null;
};

export type WorkspaceIndexerSnapshot = {
  ready: boolean;
  symbolIndexReady: boolean;
  repoIndexReady: boolean;
  relatedFilesReady: boolean;
  lastIndexedAtMs: number | null;
};

export type WorkspaceLedgerSnapshot = {
  headEntryId: string | null;
  headSeq: number | null;
  totalEntries: number;
  stateHash: string | null;
};

export type WorkspaceHealthInputs = {
  runtime: WorkspaceRuntimeSnapshot;
  trust?: WorkspaceTrustSnapshot | null;
  indexer?: WorkspaceIndexerSnapshot | null;
  ledger?: WorkspaceLedgerSnapshot | null;
};

export type WorkspaceHealthCheck = {
  id: string;
  category: WorkspaceHealthCheckCategory;
  severity: WorkspaceHealthSeverity;
  ok: boolean;
  message: string;
  detail: Record<string, JsonValue>;
};

export type WorkspaceHealthReport = {
  schema: 1;
  rootPath: string | null;
  level: WorkspaceHealthLevel;
  ready: {
    browsing: boolean;
    indexing: boolean;
    preview: boolean;
    verify: boolean;
    apply: boolean;
    diagnostics: boolean;
  };
  counts: {
    total: number;
    info: number;
    warn: number;
    error: number;
    fatal: number;
    failed: number;
  };
  checks: WorkspaceHealthCheck[];
  evidence: {
    rootFingerprint: string | null;
    structureFingerprint: string | null;
    stateFingerprint: string;
  };
  hash: string;
};

export type WorkspaceHealthPolicy = {
  staleWatcherMs: number;
  staleIndexerMs: number;
  maxRecommendedEntries: number;
  maxRecommendedTopLevelEntries: number;
  requireWatcherForIndexing: boolean;
  requireRestrictedOrTrustedForPreview: boolean;
  requireTrustedForApply: boolean;
  requireVerifyBindingForApply: boolean;
};

export type WorkspaceHealthAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "evaluate";
  decision: "allow" | "deny";
  rootPath: string | null;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type WorkspaceHealthAuditFn = (record: WorkspaceHealthAuditRecord) => void;

export type WorkspaceHealthOptions = {
  policy?: Partial<WorkspaceHealthPolicy>;
  audit?: WorkspaceHealthAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: WorkspaceHealthPolicy = {
  staleWatcherMs: 5 * 60 * 1000,
  staleIndexerMs: 15 * 60 * 1000,
  maxRecommendedEntries: 100_000,
  maxRecommendedTopLevelEntries: 2_000,
  requireWatcherForIndexing: true,
  requireRestrictedOrTrustedForPreview: true,
  requireTrustedForApply: true,
  requireVerifyBindingForApply: true,
};

const RECOMMENDED_CONFIGS = [
  "package.json",
  "pyproject.toml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "README.md",
] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:workspace:workspace_health:${message}`);
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

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function canRead(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function canWrite(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function topLevelEntries(p: string): string[] {
  try {
    return fs.readdirSync(p).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function countTreeEntries(rootPath: string, limit = 20_000): number | null {
  let count = 0;
  const queue = [rootPath];
  while (queue.length > 0) {
    const current = queue.shift()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const entry of entries) {
      count += 1;
      if (count > limit) return count;
      if (entry.isDirectory()) {
        queue.push(path.join(current, entry.name));
      }
    }
  }
  return count;
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function check(
  id: string,
  category: WorkspaceHealthCheckCategory,
  severity: WorkspaceHealthSeverity,
  ok: boolean,
  message: string,
  detail: Record<string, JsonValue> = {},
): WorkspaceHealthCheck {
  return { id, category, severity, ok, message, detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue> };
}

function countChecks(checks: WorkspaceHealthCheck[]) {
  return {
    total: checks.length,
    info: checks.filter((c) => c.severity === "info").length,
    warn: checks.filter((c) => c.severity === "warn").length,
    error: checks.filter((c) => c.severity === "error").length,
    fatal: checks.filter((c) => c.severity === "fatal").length,
    failed: checks.filter((c) => !c.ok).length,
  };
}

function reportHash(core: Omit<WorkspaceHealthReport, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<WorkspaceHealthAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

// -----------------------------------------------------------------------------
// EVALUATION
// -----------------------------------------------------------------------------

export class WorkspaceHealthService {
  private readonly policy: WorkspaceHealthPolicy;
  private readonly audit?: WorkspaceHealthAuditFn;
  private readonly now?: () => number;

  constructor(options: WorkspaceHealthOptions = {}) {
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;
  }

  evaluate(inputs: WorkspaceHealthInputs): WorkspaceHealthReport {
    const checks: WorkspaceHealthCheck[] = [];
    const rootPath = inputs.runtime.rootPath;
    const ts = nowMs(this.now);

    if (!rootPath) {
      checks.push(check("root.missing", "root", "fatal", false, "No active workspace is open."));
      return this.finalize(null, checks, inputs, ts, "workspace_missing");
    }

    const normalizedRoot = normalizePath(rootPath);
    const rootExists = exists(normalizedRoot);
    const rootIsDirectory = rootExists && isDirectory(normalizedRoot);
    const readable = rootExists && canRead(normalizedRoot);
    const writable = rootExists && canWrite(normalizedRoot);

    checks.push(check("root.exists", "root", rootExists ? "info" : "fatal", rootExists, "Workspace root must exist.", {
      rootPath: normalizedRoot,
    }));
    checks.push(check("root.directory", "root", rootIsDirectory ? "info" : "fatal", rootIsDirectory, "Workspace root must be a directory."));
    checks.push(check("root.readable", "permissions", readable ? "info" : "fatal", readable, "Workspace root must be readable."));
    checks.push(check("root.writable", "permissions", writable ? "info" : "error", writable, "Workspace root should be writable for local state and tooling."));

    const entries = rootExists && rootIsDirectory ? topLevelEntries(normalizedRoot) : [];
    const topLevelCount = entries.length;
    const totalEntries = rootExists && rootIsDirectory ? countTreeEntries(normalizedRoot, this.policy.maxRecommendedEntries + 1) : null;
    const configPresence = RECOMMENDED_CONFIGS.filter((name) => entries.includes(name));

    checks.push(check(
      "structure.recommended_configs",
      "structure",
      configPresence.length > 0 ? "info" : "warn",
      configPresence.length > 0,
      "Workspace should expose at least one recognizable project/config artifact.",
      { configPresence },
    ));
    checks.push(check(
      "capacity.top_level_reasonable",
      "capacity",
      topLevelCount <= this.policy.maxRecommendedTopLevelEntries ? "info" : "warn",
      topLevelCount <= this.policy.maxRecommendedTopLevelEntries,
      "Top-level workspace entry count should remain within a recommended bound.",
      { topLevelCount, limit: this.policy.maxRecommendedTopLevelEntries },
    ));
    checks.push(check(
      "capacity.total_entries_reasonable",
      "capacity",
      totalEntries === null || totalEntries <= this.policy.maxRecommendedEntries ? "info" : "warn",
      totalEntries === null || totalEntries <= this.policy.maxRecommendedEntries,
      "Workspace total entry count should remain within a recommended bound.",
      { totalEntries, limit: this.policy.maxRecommendedEntries },
    ));

    const watcherHealthy = inputs.runtime.watcherActive;
    const watcherFresh = !inputs.runtime.watcherLastEventAtMs || ts - inputs.runtime.watcherLastEventAtMs <= this.policy.staleWatcherMs;

    checks.push(check(
      "runtime.watcher_active",
      "runtime",
      watcherHealthy ? "info" : (this.policy.requireWatcherForIndexing ? "warn" : "info"),
      watcherHealthy,
      "Workspace watcher should be active.",
      { watcherActive: inputs.runtime.watcherActive },
    ));
    checks.push(check(
      "runtime.watcher_fresh",
      "runtime",
      watcherFresh ? "info" : "warn",
      watcherFresh,
      "Watcher activity should not be stale for long-running sessions.",
      {
        watcherLastEventAtMs: inputs.runtime.watcherLastEventAtMs,
        staleWatcherMs: this.policy.staleWatcherMs,
      },
    ));

    const trustLevel = inputs.trust?.level ?? null;
    checks.push(check(
      "signals.trust_present",
      "signals",
      trustLevel ? "info" : "warn",
      trustLevel !== null,
      "Workspace trust classification should be available.",
      { trustLevel },
    ));

    const indexer = inputs.indexer ?? null;
    if (indexer) {
      const indexFresh = !indexer.lastIndexedAtMs || ts - indexer.lastIndexedAtMs <= this.policy.staleIndexerMs;
      checks.push(check(
        "tooling.repo_index_ready",
        "tooling",
        indexer.repoIndexReady ? "info" : "warn",
        indexer.repoIndexReady,
        "Repository index should be ready.",
      ));
      checks.push(check(
        "tooling.symbol_index_ready",
        "tooling",
        indexer.symbolIndexReady ? "info" : "warn",
        indexer.symbolIndexReady,
        "Symbol index should be ready.",
      ));
      checks.push(check(
        "tooling.index_fresh",
        "tooling",
        indexFresh ? "info" : "warn",
        indexFresh,
        "Index data should not be stale.",
        { lastIndexedAtMs: indexer.lastIndexedAtMs, staleIndexerMs: this.policy.staleIndexerMs },
      ));
    } else {
      checks.push(check("tooling.index_snapshot_present", "tooling", "warn", false, "Indexer health snapshot is unavailable."));
    }

    const lineage = inputs.runtime.lineage;
    checks.push(check(
      "lineage.approved_current_coherence",
      "lineage",
      lineage.approvedPreviewHash && lineage.currentPreviewHash && lineage.approvedPreviewHash !== lineage.currentPreviewHash ? "error" : "info",
      !(lineage.approvedPreviewHash && lineage.currentPreviewHash && lineage.approvedPreviewHash !== lineage.currentPreviewHash),
      "Approved preview hash should match current preview hash when both are present.",
      {
        currentPreviewHash: lineage.currentPreviewHash,
        approvedPreviewHash: lineage.approvedPreviewHash,
      },
    ));
    checks.push(check(
      "lineage.verified_requires_verify_id",
      "lineage",
      lineage.verifiedPreviewHash && !lineage.verifyId ? "error" : "info",
      !(lineage.verifiedPreviewHash && !lineage.verifyId),
      "Verified preview lineage should be accompanied by a verify id.",
      {
        verifiedPreviewHash: lineage.verifiedPreviewHash,
        verifyId: lineage.verifyId,
      },
    ));
    checks.push(check(
      "lineage.verified_matches_approved",
      "lineage",
      lineage.verifiedPreviewHash && lineage.approvedPreviewHash && lineage.verifiedPreviewHash !== lineage.approvedPreviewHash ? "error" : "info",
      !(lineage.verifiedPreviewHash && lineage.approvedPreviewHash && lineage.verifiedPreviewHash !== lineage.approvedPreviewHash),
      "Verified preview hash should match approved preview hash when both exist.",
      {
        verifiedPreviewHash: lineage.verifiedPreviewHash,
        approvedPreviewHash: lineage.approvedPreviewHash,
      },
    ));

    if (inputs.ledger) {
      checks.push(check(
        "signals.ledger_present",
        "signals",
        inputs.ledger.stateHash ? "info" : "warn",
        inputs.ledger.stateHash !== null,
        "Ledger snapshot should be available for workspace state continuity.",
        {
          headEntryId: inputs.ledger.headEntryId,
          totalEntries: inputs.ledger.totalEntries,
        },
      ));
    }

    return this.finalize(normalizedRoot, checks, inputs, ts, "workspace_evaluated");
  }

  private finalize(
    rootPath: string | null,
    checks: WorkspaceHealthCheck[],
    inputs: WorkspaceHealthInputs,
    ts: number,
    reason: string,
  ): WorkspaceHealthReport {
    const counts = countChecks(checks);
    const hasFatal = checks.some((c) => !c.ok && c.severity === "fatal");
    const hasError = checks.some((c) => !c.ok && c.severity === "error");
    const hasWarn = checks.some((c) => !c.ok && c.severity === "warn");

    const level: WorkspaceHealthLevel = hasFatal || hasError
      ? "unhealthy"
      : hasWarn
        ? "degraded"
        : "healthy";

    const trustLevel = inputs.trust?.level ?? null;
    const indexerReady = !!inputs.indexer?.ready;
    const watcherActive = inputs.runtime.watcherActive;
    const lineage = inputs.runtime.lineage;

    const ready = {
      browsing: level !== "unhealthy",
      indexing: level !== "unhealthy" && indexerReady && (!this.policy.requireWatcherForIndexing || watcherActive),
      preview:
        level !== "unhealthy" &&
        (!this.policy.requireRestrictedOrTrustedForPreview || trustLevel === "restricted" || trustLevel === "trusted"),
      verify:
        level !== "unhealthy" &&
        (trustLevel === "restricted" || trustLevel === "trusted"),
      apply:
        level !== "unhealthy" &&
        (!this.policy.requireTrustedForApply || trustLevel === "trusted") &&
        (!this.policy.requireVerifyBindingForApply || !!lineage.verifiedPreviewHash),
      diagnostics: level !== "unhealthy",
    };

    const rootFingerprint = rootPath && exists(rootPath)
      ? sha256(stableJson({
          rootPath,
          readable: canRead(rootPath),
          writable: canWrite(rootPath),
          topLevelEntries: topLevelEntries(rootPath),
        }))
      : null;

    const structureFingerprint = rootPath && exists(rootPath)
      ? sha256(stableJson({
          rootPath,
          totalEntriesHint: countTreeEntries(rootPath, 20_000),
          recommendedConfigs: RECOMMENDED_CONFIGS.filter((name) => exists(path.join(rootPath, name))),
        }))
      : null;

    const stateFingerprint = sha256(stableJson({
      runtime: inputs.runtime,
      trust: inputs.trust ?? null,
      indexer: inputs.indexer ?? null,
      ledger: inputs.ledger ?? null,
    }));

    const core: Omit<WorkspaceHealthReport, "hash"> = {
      schema: 1,
      rootPath,
      level,
      ready,
      counts,
      checks,
      evidence: {
        rootFingerprint,
        structureFingerprint,
        stateFingerprint,
      },
    };

    const report: WorkspaceHealthReport = {
      ...core,
      hash: reportHash(core),
    };

    this.audit?.({
      schema: 1,
      ts_ms: ts,
      action: "evaluate",
      decision: level === "unhealthy" ? "deny" : "allow",
      rootPath,
      reason,
      detail: {
        level,
        ready,
        failedChecks: checks.filter((c) => !c.ok).map((c) => c.id),
      },
      hash: auditHash({
        schema: 1,
        ts_ms: ts,
        action: "evaluate",
        decision: level === "unhealthy" ? "deny" : "allow",
        rootPath,
        reason,
        detail: {
          level,
          ready,
          failedChecks: checks.filter((c) => !c.ok).map((c) => c.id),
        },
      }),
    });

    return report;
  }
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createWorkspaceHealthService(options: WorkspaceHealthOptions = {}): WorkspaceHealthService {
  return new WorkspaceHealthService(options);
}

export function defaultWorkspaceHealthPolicy(): WorkspaceHealthPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateWorkspaceHealthReport(report: WorkspaceHealthReport): void {
  assert(report.schema === 1, "report_schema_invalid");
  const core: Omit<WorkspaceHealthReport, "hash"> = {
    schema: report.schema,
    rootPath: report.rootPath,
    level: report.level,
    ready: report.ready,
    counts: report.counts,
    checks: report.checks,
    evidence: report.evidence,
  };
  assert(report.hash === reportHash(core), "report_hash_drift");
}
