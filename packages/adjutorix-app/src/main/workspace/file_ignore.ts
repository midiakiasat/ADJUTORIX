import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / file_ignore.ts
 *
 * Canonical workspace file-ignore engine for the Electron main process.
 *
 * Purpose:
 * - provide one deterministic ignore model for workspace-scoped path filtering
 * - unify ignore behavior across watcher, indexer, diagnostics, trust, and UI
 * - merge built-in policy rules with workspace-local ignore files and explicit overrides
 * - expose stable per-path decisions, matched rules, and snapshot hashes
 *
 * This module exists because fragmented ignore logic causes silent drift:
 * - watcher sees files indexer ignores
 * - diagnostics exports files UI never showed
 * - trust or verification reasons over paths hidden elsewhere
 *
 * Hard invariants:
 * - all decisions are rooted to one normalized workspace path
 * - no match may escape the workspace root
 * - identical rules + identical path produce identical decisions
 * - rule precedence is explicit and stable
 * - ignore files are treated as data, not executed semantics
 * - all outputs are serialization-stable and auditable
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

export type IgnoreEngineKind = "watcher" | "indexer" | "diagnostics" | "trust" | "generic";
export type IgnoreRuleSource = "builtin" | "workspace-file" | "override-include" | "override-exclude";
export type IgnoreDecisionKind = "include" | "exclude";

export type IgnoreBuiltinPolicy = {
  ignoreHidden: boolean;
  ignoreGit: boolean;
  ignoreNodeModules: boolean;
  ignoreDist: boolean;
  ignoreBuild: boolean;
  ignoreCoverage: boolean;
  ignorePythonCache: boolean;
  ignoreVenv: boolean;
  ignoreLogs: boolean;
  ignoreBinaryLike: boolean;
  extraExcludedNames: string[];
  extraIncludedPrefixes: string[];
  extraExcludedPrefixes: string[];
};

export type IgnoreRule = {
  schema: 1;
  id: string;
  source: IgnoreRuleSource;
  filePath: string | null;
  pattern: string;
  normalizedPattern: string;
  negated: boolean;
  decision: IgnoreDecisionKind;
  kind: "name" | "prefix" | "suffix" | "glob-lite" | "exact";
  order: number;
  hash: string;
};

export type IgnoreDecision = {
  schema: 1;
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  engine: IgnoreEngineKind;
  ignored: boolean;
  matchedRule: IgnoreRule | null;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type IgnoreSnapshot = {
  schema: 1;
  rootPath: string;
  engine: IgnoreEngineKind;
  ruleCount: number;
  builtinPolicy: IgnoreBuiltinPolicy;
  ignoreFiles: string[];
  rules: IgnoreRule[];
  hash: string;
};

export type IgnoreAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "load" | "decision" | "reload";
  decision: "allow" | "deny";
  rootPath: string;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type IgnoreAuditFn = (record: IgnoreAuditRecord) => void;

export type IgnoreEngineOptions = {
  rootPath: string;
  engine?: IgnoreEngineKind;
  builtinPolicy?: Partial<IgnoreBuiltinPolicy>;
  ignoreFileNames?: string[];
  includePrefixes?: string[];
  excludePrefixes?: string[];
  audit?: IgnoreAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: IgnoreBuiltinPolicy = {
  ignoreHidden: true,
  ignoreGit: true,
  ignoreNodeModules: true,
  ignoreDist: false,
  ignoreBuild: false,
  ignoreCoverage: true,
  ignorePythonCache: true,
  ignoreVenv: true,
  ignoreLogs: false,
  ignoreBinaryLike: false,
  extraExcludedNames: [],
  extraIncludedPrefixes: [],
  extraExcludedPrefixes: [],
};

const DEFAULT_IGNORE_FILES = [
  ".gitignore",
  ".ignore",
  ".adjutorixignore",
] as const;

const BINARY_LIKE_SUFFIXES = [
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".xz", ".7z", ".mp4", ".mp3", ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".dll", ".so", ".dylib",
] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:workspace:file_ignore:${message}`);
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

function relativeWithinRoot(rootPath: string, absolutePath: string): string | null {
  const rel = path.relative(rootPath, absolutePath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return rel || ".";
}

function nowMs(now?: () => number): number {
  return (now ?? Date.now)();
}

function normalizePattern(pattern: string): string {
  const clean = pattern.trim().replace(/\\/g, "/");
  assert(clean.length > 0, "empty_pattern");
  return clean;
}

function splitSegments(relativePath: string): string[] {
  return relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
}

function looksBinaryLike(relativePath: string): boolean {
  const lower = relativePath.toLowerCase();
  return BINARY_LIKE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function ruleHash(core: Omit<IgnoreRule, "hash">): string {
  return sha256(stableJson(core));
}

function decisionHash(core: Omit<IgnoreDecision, "hash">): string {
  return sha256(stableJson(core));
}

function snapshotHash(core: Omit<IgnoreSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<IgnoreAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function globLiteToRegex(pattern: string): RegExp {
  const normalized = normalizePattern(pattern);
  const rx = "^" + normalized
    .split("**").map((part) => part.split("*").map(escapeRegex).join("[^/]*")).join(".*")
    .replace(/\?/g, "[^/]") + "$";
  return new RegExp(rx);
}

function isCommentOrBlank(line: string): boolean {
  const t = line.trim();
  return t.length === 0 || t.startsWith("#");
}

// -----------------------------------------------------------------------------
// BUILTIN RULE GENERATION
// -----------------------------------------------------------------------------

function builtinRules(policy: IgnoreBuiltinPolicy): Array<Omit<IgnoreRule, "hash">> {
  const rules: Array<Omit<IgnoreRule, "hash">> = [];
  let order = 0;
  const push = (
    source: IgnoreRuleSource,
    pattern: string,
    decision: IgnoreDecisionKind,
    kind: IgnoreRule["kind"],
    filePath: string | null = null,
  ) => {
    const normalizedPattern = normalizePattern(pattern);
    rules.push({
      schema: 1,
      id: `${source}:${order}:${normalizedPattern}`,
      source,
      filePath,
      pattern,
      normalizedPattern,
      negated: decision === "include",
      decision,
      kind,
      order: order++,
    });
  };

  if (policy.ignoreHidden) push("builtin", ".*", "exclude", "name");
  if (policy.ignoreGit) push("builtin", ".git", "exclude", "name");
  if (policy.ignoreNodeModules) push("builtin", "node_modules", "exclude", "name");
  if (policy.ignoreDist) push("builtin", "dist", "exclude", "name");
  if (policy.ignoreBuild) push("builtin", "build", "exclude", "name");
  if (policy.ignoreCoverage) push("builtin", "coverage", "exclude", "name");
  if (policy.ignorePythonCache) push("builtin", "__pycache__", "exclude", "name");
  if (policy.ignoreVenv) {
    push("builtin", ".venv", "exclude", "name");
    push("builtin", "venv", "exclude", "name");
    push("builtin", "env", "exclude", "name");
  }
  if (policy.ignoreLogs) push("builtin", ".log", "exclude", "suffix");
  if (policy.ignoreBinaryLike) {
    for (const suffix of BINARY_LIKE_SUFFIXES) push("builtin", suffix, "exclude", "suffix");
  }
  for (const name of policy.extraExcludedNames) push("builtin", name, "exclude", "name");
  for (const prefix of policy.extraIncludedPrefixes) push("override-include", prefix, "include", "prefix");
  for (const prefix of policy.extraExcludedPrefixes) push("override-exclude", prefix, "exclude", "prefix");

  return rules;
}

function workspaceFileRules(rootPath: string, fileNames: string[]): Array<Omit<IgnoreRule, "hash">> {
  const rules: Array<Omit<IgnoreRule, "hash">> = [];
  let order = 10_000;

  for (const fileName of fileNames) {
    const filePath = path.join(rootPath, fileName);
    if (!exists(filePath) || !fs.statSync(filePath).isFile()) continue;

    const content = fs.readFileSync(filePath, "utf8");
    for (const line of content.split(/\r?\n/)) {
      if (isCommentOrBlank(line)) continue;
      const trimmed = line.trim();
      const negated = trimmed.startsWith("!");
      const rawPattern = negated ? trimmed.slice(1) : trimmed;
      const normalizedPattern = normalizePattern(rawPattern);

      let kind: IgnoreRule["kind"] = "glob-lite";
      if (!normalizedPattern.includes("*") && !normalizedPattern.includes("?")) {
        if (normalizedPattern.endsWith("/")) kind = "prefix";
        else if (normalizedPattern.includes("/")) kind = "exact";
        else kind = "name";
      }

      rules.push({
        schema: 1,
        id: `workspace-file:${order}:${normalizedPattern}`,
        source: "workspace-file",
        filePath,
        pattern: rawPattern,
        normalizedPattern,
        negated,
        decision: negated ? "include" : "exclude",
        kind,
        order: order++,
      });
    }
  }

  return rules;
}

// -----------------------------------------------------------------------------
// MATCHING
// -----------------------------------------------------------------------------

function matchesRule(rule: IgnoreRule, relativePath: string): boolean {
  const normalizedRelative = relativePath.replace(/\\/g, "/");
  const segments = splitSegments(normalizedRelative);

  switch (rule.kind) {
    case "name":
      return segments.includes(rule.normalizedPattern);
    case "prefix": {
      const prefix = rule.normalizedPattern.replace(/\/$/, "");
      return normalizedRelative === prefix || normalizedRelative.startsWith(prefix + "/");
    }
    case "suffix":
      return normalizedRelative.toLowerCase().endsWith(rule.normalizedPattern.toLowerCase());
    case "exact":
      return normalizedRelative === rule.normalizedPattern.replace(/\/$/, "");
    case "glob-lite":
      return globLiteToRegex(rule.normalizedPattern).test(normalizedRelative);
    default: {
      const exhaustive: never = rule.kind;
      throw new Error(`unhandled_ignore_rule_kind:${exhaustive}`);
    }
  }
}

// -----------------------------------------------------------------------------
// ENGINE
// -----------------------------------------------------------------------------

export class WorkspaceFileIgnore {
  private readonly rootPath: string;
  private readonly engine: IgnoreEngineKind;
  private readonly policy: IgnoreBuiltinPolicy;
  private readonly ignoreFileNames: string[];
  private readonly audit?: IgnoreAuditFn;
  private readonly now?: () => number;
  private rules: IgnoreRule[] = [];
  private ignoreFiles: string[] = [];

  constructor(options: IgnoreEngineOptions) {
    const normalizedRoot = normalizePath(options.rootPath);
    assert(exists(normalizedRoot), "root_missing");
    assert(fs.statSync(normalizedRoot).isDirectory(), "root_not_directory");

    this.rootPath = normalizedRoot;
    this.engine = options.engine ?? "generic";
    this.policy = {
      ...DEFAULT_POLICY,
      ...(options.builtinPolicy ?? {}),
      extraIncludedPrefixes: options.includePrefixes ?? options.builtinPolicy?.extraIncludedPrefixes ?? DEFAULT_POLICY.extraIncludedPrefixes,
      extraExcludedPrefixes: options.excludePrefixes ?? options.builtinPolicy?.extraExcludedPrefixes ?? DEFAULT_POLICY.extraExcludedPrefixes,
    };
    this.ignoreFileNames = [...new Set(options.ignoreFileNames ?? [...DEFAULT_IGNORE_FILES])].sort((a, b) => a.localeCompare(b));
    this.audit = options.audit;
    this.now = options.now;

    this.reload();
  }

  reload(): void {
    const builtin = builtinRules(this.policy);
    const fileRules = workspaceFileRules(this.rootPath, this.ignoreFileNames);
    this.rules = [...builtin, ...fileRules]
      .map((core) => ({ ...core, hash: ruleHash(core) }))
      .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    this.ignoreFiles = this.ignoreFileNames
      .map((name) => path.join(this.rootPath, name))
      .filter((p) => exists(p) && fs.statSync(p).isFile())
      .sort((a, b) => a.localeCompare(b));

    this.emitAudit("reload", "allow", "ignore_rules_reloaded", {
      ruleCount: this.rules.length,
      ignoreFiles: this.ignoreFiles,
      engine: this.engine,
    });
  }

  snapshot(): IgnoreSnapshot {
    const core: Omit<IgnoreSnapshot, "hash"> = {
      schema: 1,
      rootPath: this.rootPath,
      engine: this.engine,
      ruleCount: this.rules.length,
      builtinPolicy: JSON.parse(stableJson(this.policy)) as IgnoreBuiltinPolicy,
      ignoreFiles: [...this.ignoreFiles],
      rules: this.rules.map((rule) => JSON.parse(stableJson(rule)) as IgnoreRule),
    };
    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  decide(targetPath: string): IgnoreDecision {
    const absolutePath = normalizePath(targetPath);
    const relativePath = relativeWithinRoot(this.rootPath, absolutePath);

    if (relativePath === null) {
      const core: Omit<IgnoreDecision, "hash"> = {
        schema: 1,
        rootPath: this.rootPath,
        absolutePath,
        relativePath: "<outside-root>",
        engine: this.engine,
        ignored: true,
        matchedRule: null,
        reason: "path_outside_workspace_root",
        detail: { rootPath: this.rootPath },
      };
      const result = { ...core, hash: decisionHash(core) };
      this.emitAudit("decision", "deny", core.reason, { absolutePath, engine: this.engine });
      return result;
    }

    let ignored = false;
    let matchedRule: IgnoreRule | null = null;
    let reason = "no_matching_rule";

    for (const rule of this.rules) {
      if (!matchesRule(rule, relativePath)) continue;
      matchedRule = rule;
      ignored = rule.decision === "exclude";
      reason = ignored ? "matched_exclude_rule" : "matched_include_rule";
    }

    const core: Omit<IgnoreDecision, "hash"> = {
      schema: 1,
      rootPath: this.rootPath,
      absolutePath,
      relativePath,
      engine: this.engine,
      ignored,
      matchedRule,
      reason,
      detail: {
        matchedRuleId: matchedRule?.id ?? null,
        matchedRuleSource: matchedRule?.source ?? null,
        binaryLike: looksBinaryLike(relativePath),
      },
    };

    const result: IgnoreDecision = {
      ...core,
      hash: decisionHash(core),
    };

    this.emitAudit("decision", ignored ? "deny" : "allow", reason, {
      relativePath,
      matchedRuleId: matchedRule?.id ?? null,
      matchedRuleSource: matchedRule?.source ?? null,
      engine: this.engine,
    });

    return result;
  }

  included(targetPath: string): boolean {
    return !this.decide(targetPath).ignored;
  }

  rulesList(): IgnoreRule[] {
    return this.rules.map((rule) => JSON.parse(stableJson(rule)) as IgnoreRule);
  }

  private emitAudit(
    action: IgnoreAuditRecord["action"],
    decision: IgnoreAuditRecord["decision"],
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<IgnoreAuditRecord, "hash"> = {
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

export function createWorkspaceFileIgnore(options: IgnoreEngineOptions): WorkspaceFileIgnore {
  return new WorkspaceFileIgnore(options);
}

export function defaultIgnoreBuiltinPolicy(): IgnoreBuiltinPolicy {
  return {
    ...DEFAULT_POLICY,
    extraExcludedNames: [...DEFAULT_POLICY.extraExcludedNames],
    extraIncludedPrefixes: [...DEFAULT_POLICY.extraIncludedPrefixes],
    extraExcludedPrefixes: [...DEFAULT_POLICY.extraExcludedPrefixes],
  };
}

export function validateIgnoreRule(rule: IgnoreRule): void {
  assert(rule.schema === 1, "rule_schema_invalid");
  const core: Omit<IgnoreRule, "hash"> = {
    schema: rule.schema,
    id: rule.id,
    source: rule.source,
    filePath: rule.filePath,
    pattern: rule.pattern,
    normalizedPattern: rule.normalizedPattern,
    negated: rule.negated,
    decision: rule.decision,
    kind: rule.kind,
    order: rule.order,
  };
  assert(rule.hash === ruleHash(core), "rule_hash_drift");
}

export function validateIgnoreDecision(decision: IgnoreDecision): void {
  assert(decision.schema === 1, "decision_schema_invalid");
  if (decision.matchedRule) validateIgnoreRule(decision.matchedRule);
  const core: Omit<IgnoreDecision, "hash"> = {
    schema: decision.schema,
    rootPath: decision.rootPath,
    absolutePath: decision.absolutePath,
    relativePath: decision.relativePath,
    engine: decision.engine,
    ignored: decision.ignored,
    matchedRule: decision.matchedRule,
    reason: decision.reason,
    detail: decision.detail,
  };
  assert(decision.hash === decisionHash(core), "decision_hash_drift");
}

export function validateIgnoreSnapshot(snapshot: IgnoreSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  snapshot.rules.forEach(validateIgnoreRule);
  const core: Omit<IgnoreSnapshot, "hash"> = {
    schema: snapshot.schema,
    rootPath: snapshot.rootPath,
    engine: snapshot.engine,
    ruleCount: snapshot.ruleCount,
    builtinPolicy: snapshot.builtinPolicy,
    ignoreFiles: snapshot.ignoreFiles,
    rules: snapshot.rules,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
