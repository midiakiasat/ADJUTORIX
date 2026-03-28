import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / SHELL / environment_fingerprint.ts
 *
 * Canonical runtime environment fingerprinting layer for the Electron main process.
 *
 * Purpose:
 * - derive a deterministic identity for the execution environment that materially affects
 *   shell commands, verification, patch application, diagnostics, and startup behavior
 * - detect semantic drift across PATH, shell, locale, cwd roots, runtime versions,
 *   token/tool locations, and selected env variables without leaking sensitive values
 * - provide reproducible hashes for replay, ledger annotations, diagnostics exports,
 *   and preflight checks
 *
 * This module does NOT attempt to capture the entire machine state.
 * It captures the load-bearing subset of environment facts that can change execution meaning.
 *
 * Responsibilities:
 * - normalize and classify selected environment variables
 * - fingerprint executable/tool resolution inputs without exposing secrets
 * - record runtime/platform/toolchain identity
 * - compare two fingerprints and emit explicit drift reports
 * - expose stable snapshots, hashes, and audit artifacts
 *
 * Hard invariants:
 * - no raw secret-bearing env values are emitted in snapshots or diffs
 * - identical observable environment inputs produce identical hashes
 * - comparisons are deterministic and key-order stable
 * - absent vs empty vs redacted values remain distinguishable
 * - fingerprinting is read-only and side-effect free
 * - outputs are serialization-stable and auditable
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

export type EnvironmentValueClass = "present" | "missing" | "empty" | "redacted";
export type EnvironmentDriftSeverity = "info" | "warn" | "error";
export type EnvironmentDriftKind =
  | "platform"
  | "runtime"
  | "path"
  | "locale"
  | "shell"
  | "workspace"
  | "toolchain"
  | "environment-variable"
  | "unknown";

export type EnvironmentVariableFingerprint = {
  key: string;
  classification: EnvironmentValueClass;
  fingerprint: string | null;
  length: number | null;
  pathLike: boolean;
};

export type RuntimeVersionFingerprint = {
  node: string;
  electron: string | null;
  chrome: string | null;
  platform: NodeJS.Platform;
  arch: string;
  release: string;
};

export type ToolResolutionFingerprint = {
  name: string;
  configuredPath: string | null;
  exists: boolean;
  executable: boolean;
  fingerprint: string | null;
};

export type EnvironmentFingerprint = {
  schema: 1;
  host: {
    platform: NodeJS.Platform;
    arch: string;
    release: string;
    hostnameFingerprint: string;
    homeDirFingerprint: string;
    tempDirFingerprint: string;
  };
  runtime: RuntimeVersionFingerprint;
  shell: {
    shellPath: string | null;
    shellFingerprint: string | null;
    pathDelimiter: string;
  };
  workspace: {
    cwd: string;
    cwdFingerprint: string;
    rootCandidate: string | null;
    rootCandidateFingerprint: string | null;
  };
  locale: {
    lang: EnvironmentVariableFingerprint;
    lcAll: EnvironmentVariableFingerprint;
    tz: EnvironmentVariableFingerprint;
  };
  pathing: {
    path: EnvironmentVariableFingerprint;
    pathSegmentsFingerprint: string | null;
    pathSegmentCount: number | null;
  };
  variables: EnvironmentVariableFingerprint[];
  toolchain: ToolResolutionFingerprint[];
  hash: string;
};

export type EnvironmentDrift = {
  kind: EnvironmentDriftKind;
  severity: EnvironmentDriftSeverity;
  key: string;
  message: string;
  detail: Record<string, JsonValue>;
};

export type EnvironmentComparison = {
  schema: 1;
  equal: boolean;
  fromHash: string;
  toHash: string;
  driftCount: number;
  drifts: EnvironmentDrift[];
  hash: string;
};

export type EnvironmentFingerprintPolicy = {
  trackedEnvKeys: string[];
  redactedEnvKeyPatterns: string[];
  toolchainEnvKeys: Record<string, string | null>;
  treatPathAsMaterial: boolean;
  treatLocaleAsMaterial: boolean;
  includeHostname: boolean;
  includeHomeDir: boolean;
  includeTempDir: boolean;
};

export type EnvironmentFingerprintAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "fingerprint" | "compare";
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type EnvironmentFingerprintAuditFn = (record: EnvironmentFingerprintAuditRecord) => void;

export type EnvironmentFingerprintOptions = {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  workspaceRootCandidate?: string | null;
  policy?: Partial<EnvironmentFingerprintPolicy>;
  audit?: EnvironmentFingerprintAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: EnvironmentFingerprintPolicy = {
  trackedEnvKeys: [
    "PATH",
    "SHELL",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "COLORTERM",
    "PYTHONPATH",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "NVM_BIN",
    "NVM_DIR",
    "PNPM_HOME",
    "npm_config_userconfig",
    "GIT_EXEC_PATH",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_STATE_HOME",
    "ADJUTORIX_TOKEN_FILE",
    "ADJUTORIX_AGENT_TOKEN_FILE",
  ],
  redactedEnvKeyPatterns: [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "KEY",
    "AUTH",
    "COOKIE",
  ],
  toolchainEnvKeys: {
    node: null,
    npm: null,
    pnpm: "PNPM_HOME",
    python: null,
    pip: null,
    git: null,
    bash: "SHELL",
    zsh: "SHELL",
  },
  treatPathAsMaterial: true,
  treatLocaleAsMaterial: true,
  includeHostname: true,
  includeHomeDir: true,
  includeTempDir: true,
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:shell:environment_fingerprint:${message}`);
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

function normalizePathValue(input: string): string {
  return path.resolve(input.trim());
}

function classifyEnvValue(value: string | undefined): EnvironmentValueClass {
  if (value === undefined) return "missing";
  if (value.length === 0) return "empty";
  return "present";
}

function looksSensitiveKey(key: string, patterns: string[]): boolean {
  const upper = key.toUpperCase();
  return patterns.some((p) => upper.includes(p.toUpperCase()));
}

function pathLikeKey(key: string): boolean {
  return /PATH|DIR|HOME|ROOT|PREFIX|FILE|BIN/i.test(key);
}

function fingerprintValue(value: string): string {
  return sha256(value);
}

function envVarFingerprint(
  key: string,
  env: NodeJS.ProcessEnv,
  policy: EnvironmentFingerprintPolicy,
): EnvironmentVariableFingerprint {
  const raw = env[key];
  const classification = classifyEnvValue(raw);
  const sensitive = looksSensitiveKey(key, policy.redactedEnvKeyPatterns);
  const normalized = raw ?? "";

  if (classification === "missing") {
    return {
      key,
      classification,
      fingerprint: null,
      length: null,
      pathLike: pathLikeKey(key),
    };
  }

  if (classification === "empty") {
    return {
      key,
      classification,
      fingerprint: sha256(""),
      length: 0,
      pathLike: pathLikeKey(key),
    };
  }

  if (sensitive) {
    return {
      key,
      classification: "redacted",
      fingerprint: fingerprintValue(normalized),
      length: normalized.length,
      pathLike: pathLikeKey(key),
    };
  }

  return {
    key,
    classification,
    fingerprint: fingerprintValue(normalized),
    length: normalized.length,
    pathLike: pathLikeKey(key),
  };
}

function resolvedExecutableFingerprint(name: string, env: NodeJS.ProcessEnv, configuredPath: string | null): ToolResolutionFingerprint {
  const direct = configuredPath && configuredPath.trim().length > 0 ? configuredPath.trim() : null;
  const candidates: string[] = [];

  if (direct) {
    candidates.push(path.resolve(direct));
  }

  const pathEnv = env.PATH ?? "";
  for (const segment of pathEnv.split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(segment, name));
    if (process.platform === "win32") {
      candidates.push(path.join(segment, `${name}.exe`));
      candidates.push(path.join(segment, `${name}.cmd`));
      candidates.push(path.join(segment, `${name}.bat`));
    }
  }

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.F_OK | fs.constants.X_OK);
      return {
        name,
        configuredPath: direct,
        exists: true,
        executable: true,
        fingerprint: sha256(`${candidate}:${fs.statSync(candidate).mtimeMs}:${fs.statSync(candidate).size}`),
      };
    } catch {
      // continue
    }
  }

  return {
    name,
    configuredPath: direct,
    exists: false,
    executable: false,
    fingerprint: null,
  };
}

function fingerprintCoreHash<T extends object>(core: T): string {
  return sha256(stableJson(core));
}

function comparisonHash(core: Omit<EnvironmentComparison, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<EnvironmentFingerprintAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function emitAudit(
  audit: EnvironmentFingerprintAuditFn | undefined,
  now: (() => number) | undefined,
  action: EnvironmentFingerprintAuditRecord["action"],
  decision: EnvironmentFingerprintAuditRecord["decision"],
  reason: string,
  detail: Record<string, JsonValue>,
): void {
  if (!audit) return;
  const core: Omit<EnvironmentFingerprintAuditRecord, "hash"> = {
    schema: 1,
    ts_ms: nowMs(now),
    action,
    decision,
    reason,
    detail,
  };
  audit({
    ...core,
    hash: auditHash(core),
  });
}

// -----------------------------------------------------------------------------
// FINGERPRINTING
// -----------------------------------------------------------------------------

export function createEnvironmentFingerprint(options: EnvironmentFingerprintOptions = {}): EnvironmentFingerprint {
  const env = options.env ?? process.env;
  const cwd = normalizePathValue(options.cwd ?? process.cwd());
  const policy: EnvironmentFingerprintPolicy = {
    ...DEFAULT_POLICY,
    ...(options.policy ?? {}),
    trackedEnvKeys: [...new Set(options.policy?.trackedEnvKeys ?? DEFAULT_POLICY.trackedEnvKeys)].sort((a, b) => a.localeCompare(b)),
    redactedEnvKeyPatterns: [...new Set(options.policy?.redactedEnvKeyPatterns ?? DEFAULT_POLICY.redactedEnvKeyPatterns)].sort((a, b) => a.localeCompare(b)),
    toolchainEnvKeys: { ...DEFAULT_POLICY.toolchainEnvKeys, ...(options.policy?.toolchainEnvKeys ?? {}) },
  };

  const tracked = policy.trackedEnvKeys
    .map((key) => envVarFingerprint(key, env, policy))
    .sort((a, b) => a.key.localeCompare(b.key));

  const lang = envVarFingerprint("LANG", env, policy);
  const lcAll = envVarFingerprint("LC_ALL", env, policy);
  const tz = envVarFingerprint("TZ", env, policy);
  const pathVar = envVarFingerprint("PATH", env, policy);

  const pathSegments = (env.PATH ?? "")
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter(Boolean)
    .map((segment) => normalizePathValue(segment));

  const toolchain = Object.entries(policy.toolchainEnvKeys)
    .map(([tool, envKey]) => resolvedExecutableFingerprint(tool, env, envKey ? env[envKey] ?? null : null))
    .sort((a, b) => a.name.localeCompare(b.name));

  const runtime: RuntimeVersionFingerprint = {
    node: process.version,
    electron: process.versions.electron ?? null,
    chrome: process.versions.chrome ?? null,
    platform: process.platform,
    arch: process.arch,
    release: os.release(),
  };

  const shellPath = env.SHELL?.trim() || null;
  const shellFingerprint = shellPath ? sha256(shellPath) : null;
  const rootCandidate = options.workspaceRootCandidate ? normalizePathValue(options.workspaceRootCandidate) : null;

  const core: Omit<EnvironmentFingerprint, "hash"> = {
    schema: 1,
    host: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      hostnameFingerprint: policy.includeHostname ? sha256(os.hostname()) : sha256("<omitted>"),
      homeDirFingerprint: policy.includeHomeDir ? sha256(os.homedir()) : sha256("<omitted>"),
      tempDirFingerprint: policy.includeTempDir ? sha256(os.tmpdir()) : sha256("<omitted>"),
    },
    runtime,
    shell: {
      shellPath,
      shellFingerprint,
      pathDelimiter: path.delimiter,
    },
    workspace: {
      cwd,
      cwdFingerprint: sha256(cwd),
      rootCandidate,
      rootCandidateFingerprint: rootCandidate ? sha256(rootCandidate) : null,
    },
    locale: {
      lang,
      lcAll,
      tz,
    },
    pathing: {
      path: pathVar,
      pathSegmentsFingerprint: pathSegments.length > 0 ? sha256(stableJson(pathSegments)) : null,
      pathSegmentCount: pathSegments.length || null,
    },
    variables: tracked,
    toolchain,
  };

  const fingerprint: EnvironmentFingerprint = {
    ...core,
    hash: fingerprintCoreHash(core),
  };

  emitAudit(options.audit, options.now, "fingerprint", "allow", "environment_fingerprint_created", {
    hash: fingerprint.hash,
    variableCount: fingerprint.variables.length,
    toolchainCount: fingerprint.toolchain.length,
    cwd: fingerprint.workspace.cwd,
  });

  return fingerprint;
}

// -----------------------------------------------------------------------------
// COMPARISON
// -----------------------------------------------------------------------------

function compareEnvVar(
  key: string,
  fromVars: Map<string, EnvironmentVariableFingerprint>,
  toVars: Map<string, EnvironmentVariableFingerprint>,
): EnvironmentDrift | null {
  const a = fromVars.get(key) ?? null;
  const b = toVars.get(key) ?? null;
  if (!a && !b) return null;
  if (!a || !b) {
    return {
      kind: "environment-variable",
      severity: "warn",
      key,
      message: "Tracked environment variable presence changed.",
      detail: {
        fromPresent: !!a,
        toPresent: !!b,
      },
    };
  }
  if (stableJson(a) !== stableJson(b)) {
    return {
      kind: "environment-variable",
      severity: key === "PATH" ? "error" : "warn",
      key,
      message: "Tracked environment variable fingerprint changed.",
      detail: {
        fromClassification: a.classification,
        toClassification: b.classification,
        fromFingerprint: a.fingerprint,
        toFingerprint: b.fingerprint,
      },
    };
  }
  return null;
}

export function compareEnvironmentFingerprints(
  from: EnvironmentFingerprint,
  to: EnvironmentFingerprint,
  options?: Pick<EnvironmentFingerprintOptions, "audit" | "now">,
): EnvironmentComparison {
  const drifts: EnvironmentDrift[] = [];

  if (stableJson(from.runtime) !== stableJson(to.runtime)) {
    drifts.push({
      kind: "runtime",
      severity: "error",
      key: "runtime",
      message: "Runtime version or platform identity changed.",
      detail: {
        from: from.runtime as unknown as JsonValue,
        to: to.runtime as unknown as JsonValue,
      },
    });
  }

  if (from.shell.shellFingerprint !== to.shell.shellFingerprint) {
    drifts.push({
      kind: "shell",
      severity: "warn",
      key: "SHELL",
      message: "Shell identity changed.",
      detail: {
        fromShellFingerprint: from.shell.shellFingerprint,
        toShellFingerprint: to.shell.shellFingerprint,
      },
    });
  }

  if (from.pathing.pathSegmentsFingerprint !== to.pathing.pathSegmentsFingerprint) {
    drifts.push({
      kind: "path",
      severity: "error",
      key: "PATH",
      message: "Executable search path changed.",
      detail: {
        fromPathSegmentsFingerprint: from.pathing.pathSegmentsFingerprint,
        toPathSegmentsFingerprint: to.pathing.pathSegmentsFingerprint,
        fromPathSegmentCount: from.pathing.pathSegmentCount,
        toPathSegmentCount: to.pathing.pathSegmentCount,
      },
    });
  }

  if (stableJson(from.locale) !== stableJson(to.locale)) {
    drifts.push({
      kind: "locale",
      severity: "warn",
      key: "locale",
      message: "Locale-related environment changed.",
      detail: {
        from: from.locale as unknown as JsonValue,
        to: to.locale as unknown as JsonValue,
      },
    });
  }

  if (from.workspace.cwdFingerprint !== to.workspace.cwdFingerprint || from.workspace.rootCandidateFingerprint !== to.workspace.rootCandidateFingerprint) {
    drifts.push({
      kind: "workspace",
      severity: "warn",
      key: "workspace",
      message: "Working directory or root candidate changed.",
      detail: {
        fromCwdFingerprint: from.workspace.cwdFingerprint,
        toCwdFingerprint: to.workspace.cwdFingerprint,
        fromRootCandidateFingerprint: from.workspace.rootCandidateFingerprint,
        toRootCandidateFingerprint: to.workspace.rootCandidateFingerprint,
      },
    });
  }

  const fromVars = new Map(from.variables.map((v) => [v.key, v]));
  const toVars = new Map(to.variables.map((v) => [v.key, v]));
  const allVarKeys = [...new Set([...fromVars.keys(), ...toVars.keys()])].sort((a, b) => a.localeCompare(b));
  for (const key of allVarKeys) {
    const drift = compareEnvVar(key, fromVars, toVars);
    if (drift) drifts.push(drift);
  }

  const fromTools = new Map(from.toolchain.map((t) => [t.name, t]));
  const toTools = new Map(to.toolchain.map((t) => [t.name, t]));
  const toolNames = [...new Set([...fromTools.keys(), ...toTools.keys()])].sort((a, b) => a.localeCompare(b));
  for (const name of toolNames) {
    const a = fromTools.get(name) ?? null;
    const b = toTools.get(name) ?? null;
    if (!a || !b || stableJson(a) !== stableJson(b)) {
      drifts.push({
        kind: "toolchain",
        severity: "warn",
        key: name,
        message: "Toolchain resolution changed.",
        detail: {
          from: a as unknown as JsonValue,
          to: b as unknown as JsonValue,
        },
      });
    }
  }

  const core: Omit<EnvironmentComparison, "hash"> = {
    schema: 1,
    equal: drifts.length === 0,
    fromHash: from.hash,
    toHash: to.hash,
    driftCount: drifts.length,
    drifts,
  };

  const comparison: EnvironmentComparison = {
    ...core,
    hash: comparisonHash(core),
  };

  emitAudit(options?.audit, options?.now, "compare", comparison.equal ? "allow" : "deny", comparison.equal ? "environment_fingerprints_equal" : "environment_fingerprints_differ", {
    fromHash: comparison.fromHash,
    toHash: comparison.toHash,
    driftCount: comparison.driftCount,
  });

  return comparison;
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function defaultEnvironmentFingerprintPolicy(): EnvironmentFingerprintPolicy {
  return {
    ...DEFAULT_POLICY,
    trackedEnvKeys: [...DEFAULT_POLICY.trackedEnvKeys],
    redactedEnvKeyPatterns: [...DEFAULT_POLICY.redactedEnvKeyPatterns],
    toolchainEnvKeys: { ...DEFAULT_POLICY.toolchainEnvKeys },
  };
}

export function validateEnvironmentFingerprint(fingerprint: EnvironmentFingerprint): void {
  assert(fingerprint.schema === 1, "fingerprint_schema_invalid");
  const core: Omit<EnvironmentFingerprint, "hash"> = {
    schema: fingerprint.schema,
    host: fingerprint.host,
    runtime: fingerprint.runtime,
    shell: fingerprint.shell,
    workspace: fingerprint.workspace,
    locale: fingerprint.locale,
    pathing: fingerprint.pathing,
    variables: fingerprint.variables,
    toolchain: fingerprint.toolchain,
  };
  assert(fingerprint.hash === fingerprintCoreHash(core), "fingerprint_hash_drift");
}

export function validateEnvironmentComparison(comparison: EnvironmentComparison): void {
  assert(comparison.schema === 1, "comparison_schema_invalid");
  const core: Omit<EnvironmentComparison, "hash"> = {
    schema: comparison.schema,
    equal: comparison.equal,
    fromHash: comparison.fromHash,
    toHash: comparison.toHash,
    driftCount: comparison.driftCount,
    drifts: comparison.drifts,
  };
  assert(comparison.hash === comparisonHash(core), "comparison_hash_drift");
}
