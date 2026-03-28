import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / workspace_trust.ts
 *
 * Canonical workspace trust model for the Electron main process.
 *
 * Purpose:
 * - classify workspace trust before privileged operations are allowed
 * - distinguish harmless workspace browsing from governed mutation authority
 * - make trust evidence explicit, serializable, and auditable
 * - persist trust decisions deterministically through injected storage
 * - support trust escalation / revocation without implicit side effects
 *
 * Trust is NOT binary convenience state. It gates higher-risk behaviors such as:
 * - RPC proxy allowance scoped to the workspace
 * - patch apply / verify execution against the workspace
 * - diagnostics export containing workspace-derived content
 * - external tool/service control decisions linked to workspace context
 *
 * Hard invariants:
 * - every workspace trust decision has explicit evidence and provenance
 * - identical evidence produces identical trust fingerprints
 * - revoked trust takes effect immediately
 * - missing trust defaults to least privilege
 * - trust state never implies filesystem ownership or authenticity by itself
 * - policy decisions must be derivable from trust level, not hidden flags
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

export type WorkspaceTrustLevel = "untrusted" | "restricted" | "trusted";
export type WorkspaceTrustSource = "default" | "user" | "policy" | "system" | "imported";
export type WorkspaceTrustDecision = "allow" | "deny";

export type WorkspaceTrustCapability =
  | "workspace.read"
  | "workspace.reveal"
  | "patch.preview"
  | "verify.run"
  | "patch.apply"
  | "rpc.proxy"
  | "agent.control"
  | "diagnostics.export.workspace"
  | "workspace.auto_watch";

export type WorkspaceTrustEvidence = {
  workspacePath: string;
  normalizedPath: string;
  name: string;
  hasGit: boolean;
  hasPackageJson: boolean;
  hasPyprojectToml: boolean;
  hasNodeModules: boolean;
  hasEnvFiles: boolean;
  hasExecutableScripts: boolean;
  symlinkRoot: boolean;
  insideHome: boolean;
  insideTemp: boolean;
  configFiles: string[];
  fileCountHint: number | null;
  directoryCountHint: number | null;
  fingerprint: string;
};

export type WorkspaceTrustRecord = {
  schema: 1;
  workspacePath: string;
  normalizedPath: string;
  level: WorkspaceTrustLevel;
  source: WorkspaceTrustSource;
  reason: string;
  decidedAtMs: number;
  evidenceFingerprint: string;
  notes?: string;
  hash: string;
};

export type WorkspaceTrustDecisionResult = {
  schema: 1;
  workspacePath: string;
  normalizedPath: string;
  capability: WorkspaceTrustCapability;
  level: WorkspaceTrustLevel;
  decision: WorkspaceTrustDecision;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type WorkspaceTrustAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "evaluate" | "set" | "revoke" | "capability_check" | "load" | "save";
  decision: "allow" | "deny";
  workspacePath: string;
  level?: WorkspaceTrustLevel;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type WorkspaceTrustStorage = {
  loadRecords?: () => Promise<WorkspaceTrustRecord[]> | WorkspaceTrustRecord[];
  saveRecords?: (records: WorkspaceTrustRecord[]) => Promise<void> | void;
};

export type WorkspaceTrustPolicy = {
  defaultLevel: WorkspaceTrustLevel;
  allowTrustedPatchApply: boolean;
  allowRestrictedVerifyRun: boolean;
  allowRestrictedPatchPreview: boolean;
  allowTrustedRpcProxy: boolean;
  allowTrustedAgentControl: boolean;
  allowRestrictedDiagnosticsExport: boolean;
  treatTempAsUntrusted: boolean;
  treatSymlinkRootAsRestricted: boolean;
};

export type WorkspaceTrustOptions = {
  storage?: WorkspaceTrustStorage;
  policy?: Partial<WorkspaceTrustPolicy>;
  audit?: (record: WorkspaceTrustAuditRecord) => void;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: WorkspaceTrustPolicy = {
  defaultLevel: "untrusted",
  allowTrustedPatchApply: true,
  allowRestrictedVerifyRun: true,
  allowRestrictedPatchPreview: true,
  allowTrustedRpcProxy: true,
  allowTrustedAgentControl: true,
  allowRestrictedDiagnosticsExport: true,
  treatTempAsUntrusted: true,
  treatSymlinkRootAsRestricted: true,
};

const CONFIG_CANDIDATES = [
  ".git",
  "package.json",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  ".env",
  ".env.local",
  "Makefile",
  "Dockerfile",
  "README.md",
] as const;

const EXECUTABLE_SCRIPT_CANDIDATES = [
  "package.json",
  "Makefile",
  "docker-compose.yml",
  "docker-compose.yaml",
  "justfile",
] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:workspace:workspace_trust:${message}`);
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
  assert(typeof input === "string" && input.trim().length > 0, "workspace_path_invalid");
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

function isSymlink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function readDirNames(p: string): string[] {
  try {
    return fs.readdirSync(p).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function countDirKinds(p: string): { files: number | null; directories: number | null } {
  try {
    const entries = fs.readdirSync(p, { withFileTypes: true });
    let files = 0;
    let directories = 0;
    for (const entry of entries) {
      if (entry.isFile()) files += 1;
      else if (entry.isDirectory()) directories += 1;
    }
    return { files, directories };
  } catch {
    return { files: null, directories: null };
  }
}

function insideHome(p: string): boolean {
  const home = path.resolve(process.env.HOME || process.env.USERPROFILE || "/");
  return p === home || p.startsWith(home + path.sep);
}

function insideTemp(p: string): boolean {
  const tmp = path.resolve(require("node:os").tmpdir());
  return p === tmp || p.startsWith(tmp + path.sep);
}

function recordHash(core: Omit<WorkspaceTrustRecord, "hash">): string {
  return sha256(stableJson(core));
}

function decisionHash(core: Omit<WorkspaceTrustDecisionResult, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<WorkspaceTrustAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

// -----------------------------------------------------------------------------
// EVIDENCE
// -----------------------------------------------------------------------------

export function evaluateWorkspaceTrustEvidence(workspacePath: string): WorkspaceTrustEvidence {
  const normalizedPath = normalizePath(workspacePath);
  assert(exists(normalizedPath), "workspace_missing");
  assert(isDirectory(normalizedPath), "workspace_not_directory");

  const dirNames = new Set(readDirNames(normalizedPath));
  const counts = countDirKinds(normalizedPath);

  const configFiles = [...CONFIG_CANDIDATES].filter((name) => dirNames.has(name)).sort((a, b) => a.localeCompare(b));
  const evidenceCore: Omit<WorkspaceTrustEvidence, "fingerprint"> = {
    workspacePath,
    normalizedPath,
    name: path.basename(normalizedPath),
    hasGit: dirNames.has(".git"),
    hasPackageJson: dirNames.has("package.json"),
    hasPyprojectToml: dirNames.has("pyproject.toml"),
    hasNodeModules: dirNames.has("node_modules"),
    hasEnvFiles: dirNames.has(".env") || dirNames.has(".env.local"),
    hasExecutableScripts: EXECUTABLE_SCRIPT_CANDIDATES.some((name) => dirNames.has(name)),
    symlinkRoot: isSymlink(normalizedPath),
    insideHome: insideHome(normalizedPath),
    insideTemp: insideTemp(normalizedPath),
    configFiles,
    fileCountHint: counts.files,
    directoryCountHint: counts.directories,
  };

  return {
    ...evidenceCore,
    fingerprint: sha256(stableJson(evidenceCore)),
  };
}

// -----------------------------------------------------------------------------
// SERVICE
// -----------------------------------------------------------------------------

export class WorkspaceTrustService {
  private readonly storage?: WorkspaceTrustStorage;
  private readonly policy: WorkspaceTrustPolicy;
  private readonly audit?: (record: WorkspaceTrustAuditRecord) => void;
  private readonly now: () => number;
  private readonly records: Map<string, WorkspaceTrustRecord>;

  constructor(options: WorkspaceTrustOptions = {}) {
    this.storage = options.storage;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now ?? Date.now;
    this.records = new Map();
  }

  async initialize(): Promise<void> {
    const loaded = this.storage?.loadRecords ? await this.storage.loadRecords() : [];
    for (const record of loaded ?? []) {
      validateWorkspaceTrustRecord(record);
      this.records.set(record.normalizedPath, record);
    }
    this.emitAudit("load", "allow", "trust_records_loaded", "<all>", {
      count: this.records.size,
    });
  }

  evaluate(workspacePath: string): WorkspaceTrustEvidence {
    const evidence = evaluateWorkspaceTrustEvidence(workspacePath);
    this.emitAudit("evaluate", "allow", "workspace_trust_evidence_evaluated", evidence.normalizedPath, {
      fingerprint: evidence.fingerprint,
      hasGit: evidence.hasGit,
      hasEnvFiles: evidence.hasEnvFiles,
      symlinkRoot: evidence.symlinkRoot,
      insideTemp: evidence.insideTemp,
    });
    return evidence;
  }

  getRecord(workspacePath: string): WorkspaceTrustRecord | null {
    const normalizedPath = normalizePath(workspacePath);
    return this.records.get(normalizedPath) ?? null;
  }

  currentLevel(workspacePath: string): WorkspaceTrustLevel {
    const normalizedPath = normalizePath(workspacePath);
    return this.records.get(normalizedPath)?.level ?? this.policy.defaultLevel;
  }

  async setTrust(
    workspacePath: string,
    level: WorkspaceTrustLevel,
    source: WorkspaceTrustSource,
    reason: string,
    notes?: string,
  ): Promise<WorkspaceTrustRecord> {
    const evidence = this.evaluate(workspacePath);
    const core: Omit<WorkspaceTrustRecord, "hash"> = {
      schema: 1,
      workspacePath,
      normalizedPath: evidence.normalizedPath,
      level,
      source,
      reason,
      decidedAtMs: this.now(),
      evidenceFingerprint: evidence.fingerprint,
      ...(notes ? { notes } : {}),
    };

    const record: WorkspaceTrustRecord = {
      ...core,
      hash: recordHash(core),
    };

    this.records.set(evidence.normalizedPath, record);
    await this.persist();
    this.emitAudit("set", "allow", "workspace_trust_set", evidence.normalizedPath, {
      level,
      source,
      evidenceFingerprint: evidence.fingerprint,
    });
    return record;
  }

  async revoke(workspacePath: string, reason = "revoked"): Promise<void> {
    const normalizedPath = normalizePath(workspacePath);
    this.records.delete(normalizedPath);
    await this.persist();
    this.emitAudit("revoke", "allow", "workspace_trust_revoked", normalizedPath, { reason });
  }

  decideCapability(workspacePath: string, capability: WorkspaceTrustCapability): WorkspaceTrustDecisionResult {
    const evidence = this.evaluate(workspacePath);
    const level = this.currentLevel(evidence.normalizedPath);

    let decision: WorkspaceTrustDecision = "deny";
    let reason = "least_privilege_default";
    const detail: Record<string, JsonValue> = {
      capability,
      level,
      evidenceFingerprint: evidence.fingerprint,
      hasEnvFiles: evidence.hasEnvFiles,
      symlinkRoot: evidence.symlinkRoot,
      insideTemp: evidence.insideTemp,
    };

    switch (capability) {
      case "workspace.read":
      case "workspace.reveal":
      case "workspace.auto_watch":
        decision = "allow";
        reason = "safe_read_capability_allowed";
        break;

      case "patch.preview":
        if (level === "trusted") {
          decision = "allow";
          reason = "trusted_preview_allowed";
        } else if (level === "restricted" && this.policy.allowRestrictedPatchPreview) {
          decision = "allow";
          reason = "restricted_preview_allowed_by_policy";
        } else {
          decision = "deny";
          reason = "preview_requires_restricted_or_trusted";
        }
        break;

      case "verify.run":
        if (level === "trusted") {
          decision = "allow";
          reason = "trusted_verify_allowed";
        } else if (level === "restricted" && this.policy.allowRestrictedVerifyRun) {
          decision = "allow";
          reason = "restricted_verify_allowed_by_policy";
        } else {
          decision = "deny";
          reason = "verify_requires_restricted_or_trusted";
        }
        break;

      case "patch.apply":
        if (level === "trusted" && this.policy.allowTrustedPatchApply) {
          decision = "allow";
          reason = "trusted_apply_allowed";
        } else {
          decision = "deny";
          reason = "apply_requires_trusted";
        }
        break;

      case "rpc.proxy":
        if (level === "trusted" && this.policy.allowTrustedRpcProxy) {
          decision = "allow";
          reason = "trusted_rpc_proxy_allowed";
        } else {
          decision = "deny";
          reason = "rpc_proxy_requires_trusted";
        }
        break;

      case "agent.control":
        if (level === "trusted" && this.policy.allowTrustedAgentControl) {
          decision = "allow";
          reason = "trusted_agent_control_allowed";
        } else {
          decision = "deny";
          reason = "agent_control_requires_trusted";
        }
        break;

      case "diagnostics.export.workspace":
        if (level === "trusted") {
          decision = "allow";
          reason = "trusted_diagnostics_export_allowed";
        } else if (level === "restricted" && this.policy.allowRestrictedDiagnosticsExport) {
          decision = "allow";
          reason = "restricted_diagnostics_export_allowed_by_policy";
        } else {
          decision = "deny";
          reason = "diagnostics_export_requires_restricted_or_trusted";
        }
        break;

      default: {
        const exhaustive: never = capability;
        throw new Error(`unhandled_workspace_trust_capability:${exhaustive}`);
      }
    }

    if (evidence.insideTemp && this.policy.treatTempAsUntrusted && capability !== "workspace.read" && capability !== "workspace.reveal") {
      decision = "deny";
      reason = "temp_workspace_forces_untrusted";
    }

    if (evidence.symlinkRoot && this.policy.treatSymlinkRootAsRestricted && level === "trusted") {
      if (capability === "patch.apply" || capability === "rpc.proxy" || capability === "agent.control") {
        decision = "deny";
        reason = "symlink_root_blocks_high_privilege_capability";
      }
    }

    const core: Omit<WorkspaceTrustDecisionResult, "hash"> = {
      schema: 1,
      workspacePath,
      normalizedPath: evidence.normalizedPath,
      capability,
      level,
      decision,
      reason,
      detail,
    };
    const result: WorkspaceTrustDecisionResult = {
      ...core,
      hash: decisionHash(core),
    };

    this.emitAudit("capability_check", decision, reason, evidence.normalizedPath, detail);
    return result;
  }

  summary(): Record<string, JsonValue> {
    const records = [...this.records.values()]
      .sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath))
      .map((record) => ({
        normalizedPath: record.normalizedPath,
        level: record.level,
        source: record.source,
        decidedAtMs: record.decidedAtMs,
        evidenceFingerprint: record.evidenceFingerprint,
      }));

    return {
      count: records.length,
      defaultLevel: this.policy.defaultLevel,
      records,
      summaryHash: sha256(stableJson(records)),
    };
  }

  private async persist(): Promise<void> {
    if (!this.storage?.saveRecords) return;
    const ordered = [...this.records.values()].sort((a, b) => a.normalizedPath.localeCompare(b.normalizedPath));
    await this.storage.saveRecords(ordered);
    this.emitAudit("save", "allow", "trust_records_saved", "<all>", { count: ordered.length });
  }

  private emitAudit(
    action: WorkspaceTrustAuditRecord["action"],
    decision: WorkspaceTrustAuditRecord["decision"],
    reason: string,
    workspacePath: string,
    detail: Record<string, JsonValue>,
    level?: WorkspaceTrustLevel,
  ): void {
    if (!this.audit) return;
    const core: Omit<WorkspaceTrustAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: this.now(),
      action,
      decision,
      workspacePath,
      ...(level ? { level } : {}),
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
// VALIDATION / FACTORIES
// -----------------------------------------------------------------------------

export function createWorkspaceTrustService(options: WorkspaceTrustOptions = {}): WorkspaceTrustService {
  return new WorkspaceTrustService(options);
}

export function validateWorkspaceTrustRecord(record: WorkspaceTrustRecord): void {
  assert(record.schema === 1, "record_schema_invalid");
  assert(record.normalizedPath === normalizePath(record.normalizedPath), "record_path_not_normalized");
  const core: Omit<WorkspaceTrustRecord, "hash"> = {
    schema: record.schema,
    workspacePath: record.workspacePath,
    normalizedPath: record.normalizedPath,
    level: record.level,
    source: record.source,
    reason: record.reason,
    decidedAtMs: record.decidedAtMs,
    evidenceFingerprint: record.evidenceFingerprint,
    ...(record.notes ? { notes: record.notes } : {}),
  };
  assert(record.hash === recordHash(core), "record_hash_drift");
}

export function validateWorkspaceTrustDecisionResult(result: WorkspaceTrustDecisionResult): void {
  assert(result.schema === 1, "decision_schema_invalid");
  const core: Omit<WorkspaceTrustDecisionResult, "hash"> = {
    schema: result.schema,
    workspacePath: result.workspacePath,
    normalizedPath: result.normalizedPath,
    capability: result.capability,
    level: result.level,
    decision: result.decision,
    reason: result.reason,
    detail: result.detail,
  };
  assert(result.hash === decisionHash(core), "decision_hash_drift");
}

export function defaultWorkspaceTrustPolicy(): WorkspaceTrustPolicy {
  return { ...DEFAULT_POLICY };
}
