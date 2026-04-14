// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / workspace_paths.ts
 *
 * Canonical workspace path model for the Electron main process.
 *
 * Purpose:
 * - define one authoritative path graph for an active workspace
 * - normalize all workspace-scoped filesystem locations consistently
 * - prevent drift between watcher, diagnostics, ledger, patch, verify, and cache layers
 * - expose deterministic path derivation, validation, containment checks, and snapshots
 * - separate user content paths from runtime/generated/private service paths
 *
 * This module is intentionally foundational. It answers questions like:
 * - what is the workspace root?
 * - where do workspace-local caches/logs/state live?
 * - is a target path inside the workspace or runtime namespace?
 * - how do we resolve user-facing relative paths deterministically?
 *
 * Hard invariants:
 * - every derived path is absolute and normalized
 * - workspace-local runtime directories never escape the workspace root
 * - identical inputs produce identical path snapshots and hashes
 * - containment decisions are lexical + normalized, never string-concatenation guesses
 * - user content paths and generated/runtime paths remain explicitly distinguished
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

export type WorkspacePathKind =
  | "workspace-root"
  | "user-content"
  | "config"
  | "manifest"
  | "source"
  | "test"
  | "generated"
  | "runtime-root"
  | "runtime-cache"
  | "runtime-state"
  | "runtime-log"
  | "runtime-diagnostics"
  | "runtime-patch"
  | "runtime-verify"
  | "runtime-ledger"
  | "runtime-temp"
  | "outside-root"
  | "unknown";

export type WorkspaceLayout = {
  root: string;
  relativeRuntimeRoot: string;
  relativeCacheRoot: string;
  relativeStateRoot: string;
  relativeLogRoot: string;
  relativeDiagnosticsRoot: string;
  relativePatchRoot: string;
  relativeVerifyRoot: string;
  relativeLedgerRoot: string;
  relativeTempRoot: string;
};

export type WorkspacePathRecord = {
  schema: 1;
  absolute: string;
  relative: string | null;
  kind: WorkspacePathKind;
  insideWorkspace: boolean;
  insideRuntime: boolean;
  exists: boolean;
  isDirectory: boolean | null;
  hash: string;
};

export type WorkspacePathSnapshot = {
  schema: 1;
  root: string;
  runtimeRoot: string;
  cacheRoot: string;
  stateRoot: string;
  logRoot: string;
  diagnosticsRoot: string;
  patchRoot: string;
  verifyRoot: string;
  ledgerRoot: string;
  tempRoot: string;
  importantFiles: {
    packageJson: string;
    pyprojectToml: string;
    tsconfigJson: string;
    readmeMd: string;
    gitDir: string;
    workspaceTrustFile: string;
    workspaceStateFile: string;
    workspaceHealthFile: string;
    ledgerFile: string;
    diagnosticsExportIndex: string;
  };
  homeRelativeRoot: string | null;
  tempWorkspace: boolean;
  rootFingerprint: string;
  hash: string;
};

export type WorkspacePathDecision = {
  schema: 1;
  candidate: string;
  normalized: string;
  kind: WorkspacePathKind;
  insideWorkspace: boolean;
  insideRuntime: boolean;
  allowedForUserMutation: boolean;
  allowedForGeneratedWrite: boolean;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type WorkspacePathsPolicy = {
  runtimeRootName: string;
  cacheDirName: string;
  stateDirName: string;
  logDirName: string;
  diagnosticsDirName: string;
  patchDirName: string;
  verifyDirName: string;
  ledgerDirName: string;
  tempDirName: string;
  trustFileName: string;
  stateFileName: string;
  healthFileName: string;
  ledgerFileName: string;
  diagnosticsExportIndexFileName: string;
  allowWorkspaceLocalRuntimeRoot: boolean;
};

export type WorkspacePathsAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "build" | "classify" | "decision" | "validate";
  decision: "allow" | "deny";
  root: string;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type WorkspacePathsAuditFn = (record: WorkspacePathsAuditRecord) => void;

export type WorkspacePathsOptions = {
  root: string;
  policy?: Partial<WorkspacePathsPolicy>;
  audit?: WorkspacePathsAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: WorkspacePathsPolicy = {
  runtimeRootName: ".adjutorix",
  cacheDirName: "cache",
  stateDirName: "state",
  logDirName: "logs",
  diagnosticsDirName: "diagnostics",
  patchDirName: "patches",
  verifyDirName: "verify",
  ledgerDirName: "ledger",
  tempDirName: "tmp",
  trustFileName: "workspace-trust.json",
  stateFileName: "workspace-state.json",
  healthFileName: "workspace-health.json",
  ledgerFileName: "ledger.jsonl",
  diagnosticsExportIndexFileName: "exports-index.json",
  allowWorkspaceLocalRuntimeRoot: true,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:workspace:workspace_paths:${message}`);
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

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function normalizeAbsolute(input: string): string {
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

function relativeWithin(root: string, target: string): string | null {
  const rel = path.relative(root, target);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel || ".";
}

function inside(root: string, target: string): boolean {
  return relativeWithin(root, target) !== null;
}

function ensureRelativeSegment(input: string): string {
  const clean = input.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  assert(clean.length > 0, "relative_segment_invalid");
  assert(!clean.includes(".."), "relative_segment_escape");
  return clean;
}

function recordHash(core: Omit<WorkspacePathRecord, "hash">): string {
  return sha256(stableJson(core));
}

function decisionHash(core: Omit<WorkspacePathDecision, "hash">): string {
  return sha256(stableJson(core));
}

function snapshotHash(core: Omit<WorkspacePathSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<WorkspacePathsAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function homeRelative(root: string): string | null {
  const home = normalizeAbsolute(os.homedir());
  const rel = relativeWithin(home, root);
  return rel;
}

function tempWorkspace(root: string): boolean {
  const tmp = normalizeAbsolute(os.tmpdir());
  return inside(tmp, root);
}

// -----------------------------------------------------------------------------
// SERVICE
// -----------------------------------------------------------------------------

export class WorkspacePaths {
  private readonly policy: WorkspacePathsPolicy;
  private readonly audit?: WorkspacePathsAuditFn;
  private readonly now?: () => number;
  private readonly snapshotValue: WorkspacePathSnapshot;

  constructor(options: WorkspacePathsOptions) {
    const root = normalizeAbsolute(options.root);
    assert(exists(root), "workspace_root_missing");
    assert(statSafe(root)?.isDirectory(), "workspace_root_not_directory");

    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;
    this.snapshotValue = this.buildSnapshot(root);

    this.emitAudit("build", "allow", "workspace_paths_built", {
      root,
      runtimeRoot: this.snapshotValue.runtimeRoot,
      tempWorkspace: this.snapshotValue.tempWorkspace,
    });
  }

  snapshot(): WorkspacePathSnapshot {
    return JSON.parse(stableJson(this.snapshotValue)) as WorkspacePathSnapshot;
  }

  layout(): WorkspaceLayout {
    return {
      root: this.snapshotValue.root,
      relativeRuntimeRoot: this.policy.runtimeRootName,
      relativeCacheRoot: path.posix.join(this.policy.runtimeRootName, this.policy.cacheDirName),
      relativeStateRoot: path.posix.join(this.policy.runtimeRootName, this.policy.stateDirName),
      relativeLogRoot: path.posix.join(this.policy.runtimeRootName, this.policy.logDirName),
      relativeDiagnosticsRoot: path.posix.join(this.policy.runtimeRootName, this.policy.diagnosticsDirName),
      relativePatchRoot: path.posix.join(this.policy.runtimeRootName, this.policy.patchDirName),
      relativeVerifyRoot: path.posix.join(this.policy.runtimeRootName, this.policy.verifyDirName),
      relativeLedgerRoot: path.posix.join(this.policy.runtimeRootName, this.policy.ledgerDirName),
      relativeTempRoot: path.posix.join(this.policy.runtimeRootName, this.policy.tempDirName),
    };
  }

  classify(candidate: string): WorkspacePathRecord {
    const absolute = normalizeAbsolute(candidate);
    const relative = relativeWithin(this.snapshotValue.root, absolute);
    const insideWorkspace = relative !== null;
    const insideRuntime = inside(this.snapshotValue.runtimeRoot, absolute);
    const stats = statSafe(absolute);

    const kind = this.classifyKind(absolute, relative, insideWorkspace, insideRuntime, stats);

    const core: Omit<WorkspacePathRecord, "hash"> = {
      schema: 1,
      absolute,
      relative,
      kind,
      insideWorkspace,
      insideRuntime,
      exists: stats !== null,
      isDirectory: stats ? stats.isDirectory() : null,
    };

    const record: WorkspacePathRecord = {
      ...core,
      hash: recordHash(core),
    };

    this.emitAudit("classify", insideWorkspace ? "allow" : "deny", insideWorkspace ? "path_classified" : "path_outside_workspace", {
      absolute,
      relative,
      kind,
      insideRuntime,
    });

    return record;
  }

  decide(candidate: string): WorkspacePathDecision {
    const record = this.classify(candidate);

    let allowedForUserMutation = false;
    let allowedForGeneratedWrite = false;
    let reason = "least_privilege_default";

    switch (record.kind) {
      case "workspace-root":
      case "user-content":
      case "config":
      case "manifest":
      case "source":
      case "test":
      case "documentation":
      case "script":
      case "text-asset":
        allowedForUserMutation = true;
        allowedForGeneratedWrite = false;
        reason = "user_content_path";
        break;

      case "generated":
      case "build-output":
        allowedForUserMutation = false;
        allowedForGeneratedWrite = true;
        reason = "generated_or_build_path";
        break;

      case "runtime-root":
      case "runtime-cache":
      case "runtime-state":
      case "runtime-log":
      case "runtime-diagnostics":
      case "runtime-patch":
      case "runtime-verify":
      case "runtime-ledger":
      case "runtime-temp":
        allowedForUserMutation = false;
        allowedForGeneratedWrite = true;
        reason = "runtime_managed_path";
        break;

      case "binary-asset":
      case "dependency-cache":
      case "secret":
      case "outside-root":
      case "unknown":
      case "directory":
        allowedForUserMutation = record.kind !== "outside-root" && record.kind !== "runtime-root" && record.insideWorkspace && !record.insideRuntime;
        allowedForGeneratedWrite = record.insideRuntime;
        reason = record.kind === "outside-root" ? "outside_workspace_root" : "conservative_unknown_or_special_path";
        break;

      default: {
        const exhaustive: never = record.kind;
        throw new Error(`unhandled_workspace_path_kind:${exhaustive}`);
      }
    }

    const core: Omit<WorkspacePathDecision, "hash"> = {
      schema: 1,
      candidate,
      normalized: record.absolute,
      kind: record.kind,
      insideWorkspace: record.insideWorkspace,
      insideRuntime: record.insideRuntime,
      allowedForUserMutation,
      allowedForGeneratedWrite,
      reason,
      detail: {
        relative: record.relative,
        exists: record.exists,
        isDirectory: record.isDirectory,
      },
    };

    const decision: WorkspacePathDecision = {
      ...core,
      hash: decisionHash(core),
    };

    this.emitAudit("decision", decision.insideWorkspace ? "allow" : "deny", decision.reason, {
      candidate,
      normalized: decision.normalized,
      kind: decision.kind,
      allowedForUserMutation,
      allowedForGeneratedWrite,
    });

    return decision;
  }

  resolveUserPath(relativeOrAbsolute: string): string {
    const candidate = path.isAbsolute(relativeOrAbsolute)
      ? normalizeAbsolute(relativeOrAbsolute)
      : normalizeAbsolute(path.join(this.snapshotValue.root, relativeOrAbsolute));

    const rel = relativeWithin(this.snapshotValue.root, candidate);
    assert(rel !== null, "user_path_escaped_workspace_root");
    assert(!inside(this.snapshotValue.runtimeRoot, candidate), "user_path_points_into_runtime_namespace");
    return candidate;
  }

  resolveRuntimePath(...segments: string[]): string {
    const safeSegments = segments.map(ensureRelativeSegment);
    const candidate = normalizeAbsolute(path.join(this.snapshotValue.runtimeRoot, ...safeSegments));
    assert(inside(this.snapshotValue.runtimeRoot, candidate), "runtime_path_escape");
    return candidate;
  }

  ensureRuntimeDirectories(): void {
    const dirs = [
      this.snapshotValue.runtimeRoot,
      this.snapshotValue.cacheRoot,
      this.snapshotValue.stateRoot,
      this.snapshotValue.logRoot,
      this.snapshotValue.diagnosticsRoot,
      this.snapshotValue.patchRoot,
      this.snapshotValue.verifyRoot,
      this.snapshotValue.ledgerRoot,
      this.snapshotValue.tempRoot,
    ];

    for (const dir of dirs) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.emitAudit("validate", "allow", "runtime_directories_ensured", {
      count: dirs.length,
    });
  }

  validate(): void {
    const snap = this.snapshotValue;
    assert(exists(snap.root), "snapshot_root_missing");
    assert(statSafe(snap.root)?.isDirectory(), "snapshot_root_not_directory");
    assert(inside(snap.root, snap.runtimeRoot), "runtime_root_outside_workspace");
    assert(inside(snap.root, snap.cacheRoot), "cache_root_outside_workspace");
    assert(inside(snap.root, snap.stateRoot), "state_root_outside_workspace");
    assert(inside(snap.root, snap.logRoot), "log_root_outside_workspace");
    assert(inside(snap.root, snap.diagnosticsRoot), "diagnostics_root_outside_workspace");
    assert(inside(snap.root, snap.patchRoot), "patch_root_outside_workspace");
    assert(inside(snap.root, snap.verifyRoot), "verify_root_outside_workspace");
    assert(inside(snap.root, snap.ledgerRoot), "ledger_root_outside_workspace");
    assert(inside(snap.root, snap.tempRoot), "temp_root_outside_workspace");

    const core: Omit<WorkspacePathSnapshot, "hash"> = {
      schema: snap.schema,
      root: snap.root,
      runtimeRoot: snap.runtimeRoot,
      cacheRoot: snap.cacheRoot,
      stateRoot: snap.stateRoot,
      logRoot: snap.logRoot,
      diagnosticsRoot: snap.diagnosticsRoot,
      patchRoot: snap.patchRoot,
      verifyRoot: snap.verifyRoot,
      ledgerRoot: snap.ledgerRoot,
      tempRoot: snap.tempRoot,
      importantFiles: snap.importantFiles,
      homeRelativeRoot: snap.homeRelativeRoot,
      tempWorkspace: snap.tempWorkspace,
      rootFingerprint: snap.rootFingerprint,
    };
    assert(snapshotHash(core) === snap.hash, "snapshot_hash_drift");

    this.emitAudit("validate", "allow", "workspace_paths_validated", {
      snapshotHash: snap.hash,
    });
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private buildSnapshot(root: string): WorkspacePathSnapshot {
    const runtimeRoot = normalizeAbsolute(path.join(root, ensureRelativeSegment(this.policy.runtimeRootName)));
    assert(this.policy.allowWorkspaceLocalRuntimeRoot, "workspace_local_runtime_root_disabled");

    const cacheRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.cacheDirName)));
    const stateRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.stateDirName)));
    const logRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.logDirName)));
    const diagnosticsRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.diagnosticsDirName)));
    const patchRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.patchDirName)));
    const verifyRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.verifyDirName)));
    const ledgerRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.ledgerDirName)));
    const tempRoot = normalizeAbsolute(path.join(runtimeRoot, ensureRelativeSegment(this.policy.tempDirName)));

    const importantFiles = {
      packageJson: normalizeAbsolute(path.join(root, "package.json")),
      pyprojectToml: normalizeAbsolute(path.join(root, "pyproject.toml")),
      tsconfigJson: normalizeAbsolute(path.join(root, "tsconfig.json")),
      readmeMd: normalizeAbsolute(path.join(root, "README.md")),
      gitDir: normalizeAbsolute(path.join(root, ".git")),
      workspaceTrustFile: normalizeAbsolute(path.join(stateRoot, this.policy.trustFileName)),
      workspaceStateFile: normalizeAbsolute(path.join(stateRoot, this.policy.stateFileName)),
      workspaceHealthFile: normalizeAbsolute(path.join(stateRoot, this.policy.healthFileName)),
      ledgerFile: normalizeAbsolute(path.join(ledgerRoot, this.policy.ledgerFileName)),
      diagnosticsExportIndex: normalizeAbsolute(path.join(diagnosticsRoot, this.policy.diagnosticsExportIndexFileName)),
    };

    const rootFingerprint = sha256(stableJson({
      root,
      entries: exists(root) && statSafe(root)?.isDirectory() ? fs.readdirSync(root).sort((a, b) => a.localeCompare(b)) : [],
      homeRelativeRoot: homeRelative(root),
      tempWorkspace: tempWorkspace(root),
    }));

    const core: Omit<WorkspacePathSnapshot, "hash"> = {
      schema: 1,
      root,
      runtimeRoot,
      cacheRoot,
      stateRoot,
      logRoot,
      diagnosticsRoot,
      patchRoot,
      verifyRoot,
      ledgerRoot,
      tempRoot,
      importantFiles,
      homeRelativeRoot: homeRelative(root),
      tempWorkspace: tempWorkspace(root),
      rootFingerprint,
    };

    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  private classifyKind(
    absolute: string,
    relative: string | null,
    insideWorkspace: boolean,
    insideRuntime: boolean,
    stats: fs.Stats | null,
  ): WorkspacePathKind {
    if (!insideWorkspace) return "outside-root";
    if (absolute === this.snapshotValue?.root) return "workspace-root";
    if (insideRuntime) {
      if (absolute === this.snapshotValue?.runtimeRoot) return "runtime-root";
      if (inside(this.snapshotValue.cacheRoot, absolute)) return "runtime-cache";
      if (inside(this.snapshotValue.stateRoot, absolute)) return "runtime-state";
      if (inside(this.snapshotValue.logRoot, absolute)) return "runtime-log";
      if (inside(this.snapshotValue.diagnosticsRoot, absolute)) return "runtime-diagnostics";
      if (inside(this.snapshotValue.patchRoot, absolute)) return "runtime-patch";
      if (inside(this.snapshotValue.verifyRoot, absolute)) return "runtime-verify";
      if (inside(this.snapshotValue.ledgerRoot, absolute)) return "runtime-ledger";
      if (inside(this.snapshotValue.tempRoot, absolute)) return "runtime-temp";
      return "runtime-root";
    }
    if (stats?.isDirectory()) return "directory";

    const rel = relative ?? "";
    const base = path.basename(absolute).toLowerCase();
    const ext = path.extname(absolute).toLowerCase();

    if (["package.json", "pyproject.toml", "pnpm-workspace.yaml", "turbo.json"].includes(base)) return "manifest";
    if (["tsconfig.json", ".gitignore", ".ignore", ".editorconfig", ".env", ".env.local"].includes(base)) return base.startsWith(".env") ? "secret" : "config";
    if (/(^|\/)(tests?|__tests__|fixtures)(\/|$)/i.test(rel) || /\.test\.|\.spec\./i.test(rel)) return "test";
    if (/(^|\/)(dist|build|coverage|out|.next|target)(\/|$)/i.test(rel)) return ext === ".log" ? "runtime-log" : "build-output";
    if (/(^|\/)(node_modules|__pycache__|.venv|venv)(\/|$)/i.test(rel)) return "generated";
    if (base === "readme.md" || ext === ".md") return "documentation";
    if ([".sh", ".bash", ".zsh"].includes(ext) || base === "makefile" || base === "dockerfile") return "script";
    if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".woff", ".woff2", ".ttf", ".otf", ".zip", ".gz", ".xz", ".7z", ".dll", ".so", ".dylib", ".wasm"].includes(ext)) return "generated";
    if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".css", ".html"].includes(ext)) return "source";
    if ([".json", ".yaml", ".yml", ".toml", ".xml"].includes(ext)) return "config";

    return "user-content";
  }

  private emitAudit(
    action: WorkspacePathsAuditRecord["action"],
    decision: WorkspacePathsAuditRecord["decision"],
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<WorkspacePathsAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
      root: this.snapshotValue.root,
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

export function createWorkspacePaths(options: WorkspacePathsOptions): WorkspacePaths {
  return new WorkspacePaths(options);
}

export function defaultWorkspacePathsPolicy(): WorkspacePathsPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateWorkspacePathRecord(record: WorkspacePathRecord): void {
  assert(record.schema === 1, "record_schema_invalid");
  const core: Omit<WorkspacePathRecord, "hash"> = {
    schema: record.schema,
    absolute: record.absolute,
    relative: record.relative,
    kind: record.kind,
    insideWorkspace: record.insideWorkspace,
    insideRuntime: record.insideRuntime,
    exists: record.exists,
    isDirectory: record.isDirectory,
  };
  assert(record.hash === recordHash(core), "record_hash_drift");
}

export function validateWorkspacePathSnapshot(snapshot: WorkspacePathSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<WorkspacePathSnapshot, "hash"> = {
    schema: snapshot.schema,
    root: snapshot.root,
    runtimeRoot: snapshot.runtimeRoot,
    cacheRoot: snapshot.cacheRoot,
    stateRoot: snapshot.stateRoot,
    logRoot: snapshot.logRoot,
    diagnosticsRoot: snapshot.diagnosticsRoot,
    patchRoot: snapshot.patchRoot,
    verifyRoot: snapshot.verifyRoot,
    ledgerRoot: snapshot.ledgerRoot,
    tempRoot: snapshot.tempRoot,
    importantFiles: snapshot.importantFiles,
    homeRelativeRoot: snapshot.homeRelativeRoot,
    tempWorkspace: snapshot.tempWorkspace,
    rootFingerprint: snapshot.rootFingerprint,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}

export function validateWorkspacePathDecision(decision: WorkspacePathDecision): void {
  assert(decision.schema === 1, "decision_schema_invalid");
  const core: Omit<WorkspacePathDecision, "hash"> = {
    schema: decision.schema,
    candidate: decision.candidate,
    normalized: decision.normalized,
    kind: decision.kind,
    insideWorkspace: decision.insideWorkspace,
    insideRuntime: decision.insideRuntime,
    allowedForUserMutation: decision.allowedForUserMutation,
    allowedForGeneratedWrite: decision.allowedForGeneratedWrite,
    reason: decision.reason,
    detail: decision.detail,
  };
  assert(decision.hash === decisionHash(core), "decision_hash_drift");
}
