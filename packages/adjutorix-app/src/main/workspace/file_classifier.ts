import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / WORKSPACE / file_classifier.ts
 *
 * Canonical semantic file classifier for workspace-scoped paths.
 *
 * Purpose:
 * - assign stable semantic classes to workspace files and directories
 * - unify how watcher, indexer, diagnostics, trust, and policy layers interpret paths
 * - separate source/config/test/generated/binary/secret/runtime-artifact concerns
 * - expose deterministic evidence and capability-relevant flags per path
 *
 * This module exists because "file type" is not just extension-based.
 * Example failure modes it prevents:
 * - treating generated artifacts as source-of-truth inputs
 * - leaking .env or key material into diagnostics/indexing by misclassification
 * - applying code-oriented workflows to binary assets or build outputs
 * - drifting heuristics across workspace subsystems
 *
 * Hard invariants:
 * - classification is rooted to one normalized workspace path
 * - no classification may escape the workspace root
 * - identical path + same observable metadata => identical classification hash
 * - explicit precedence resolves conflicts deterministically
 * - absence of content inspection never causes elevated trust; uncertainty is modeled
 * - classifier output is serialization-stable and auditable
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

export type FileSemanticClass =
  | "source"
  | "test"
  | "config"
  | "documentation"
  | "manifest"
  | "script"
  | "binary-asset"
  | "text-asset"
  | "generated"
  | "build-output"
  | "dependency-cache"
  | "secret"
  | "runtime-log"
  | "runtime-state"
  | "directory"
  | "unknown";

export type FileLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "css"
  | "html"
  | "xml"
  | "binary"
  | "text"
  | "unknown";

export type FileRiskLevel = "none" | "low" | "moderate" | "high" | "critical";

export type FileCapabilityHint =
  | "indexable"
  | "watchable"
  | "previewable"
  | "editable"
  | "diagnostics-exportable"
  | "trust-relevant"
  | "governed-target"
  | "secret-bearing"
  | "ignore-candidate";

export type FileClassifierEvidence = {
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  exists: boolean;
  isDirectory: boolean;
  extension: string;
  basename: string;
  sizeBytes: number | null;
  nameSignals: string[];
  pathSignals: string[];
  contentSignals: string[];
  shebang: string | null;
  fingerprint: string;
};

export type FileClassification = {
  schema: 1;
  rootPath: string;
  absolutePath: string;
  relativePath: string;
  class: FileSemanticClass;
  language: FileLanguage;
  risk: FileRiskLevel;
  generated: boolean;
  binaryLike: boolean;
  secretLike: boolean;
  testLike: boolean;
  configLike: boolean;
  documentationLike: boolean;
  runtimeArtifactLike: boolean;
  confidence: number;
  capabilityHints: FileCapabilityHint[];
  matchedSignals: string[];
  evidenceFingerprint: string;
  hash: string;
};

export type FileClassifierPolicy = {
  maxBytesForTextProbe: number;
  treatEnvAsCriticalSecret: boolean;
  treatNodeModulesAsDependencyCache: boolean;
  treatDistAsBuildOutput: boolean;
  treatCoverageAsGenerated: boolean;
  treatDotFilesAsConfigByDefault: boolean;
  trustShebangForScript: boolean;
};

export type FileClassifierAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: "classify" | "probe" | "deny";
  decision: "allow" | "deny";
  rootPath: string;
  absolutePath: string;
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type FileClassifierAuditFn = (record: FileClassifierAuditRecord) => void;

export type FileClassifierOptions = {
  rootPath: string;
  policy?: Partial<FileClassifierPolicy>;
  audit?: FileClassifierAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: FileClassifierPolicy = {
  maxBytesForTextProbe: 8192,
  treatEnvAsCriticalSecret: true,
  treatNodeModulesAsDependencyCache: true,
  treatDistAsBuildOutput: true,
  treatCoverageAsGenerated: true,
  treatDotFilesAsConfigByDefault: true,
  trustShebangForScript: true,
};

const SOURCE_EXTENSIONS: Record<string, FileLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".css": "css",
  ".html": "html",
  ".htm": "html",
  ".json": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
  ".xml": "xml",
};

const BINARY_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".icns", ".pdf", ".zip", ".gz", ".xz", ".7z", ".mp4", ".mp3", ".woff", ".woff2", ".ttf", ".otf", ".wasm", ".dll", ".so", ".dylib", ".exe", ".bin",
]);

const TEXT_ASSET_EXTENSIONS = new Set([".svg", ".txt", ".csv", ".graphql", ".env.example"]);
const SECRET_BASENAMES = new Set([".env", ".env.local", ".env.production", ".npmrc", ".pypirc", "id_rsa", "id_ed25519"]);
const CONFIG_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "pnpm-workspace.yaml",
  "turbo.json",
  "vite.config.ts",
  "vite.config.js",
  "jest.config.js",
  "jest.config.ts",
  "docker-compose.yml",
  "docker-compose.yaml",
  "Dockerfile",
  ".editorconfig",
  ".gitignore",
  ".ignore",
  ".adjutorixignore",
]);

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`main:workspace:file_classifier:${message}`);
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

function statSafe(p: string): fs.Stats | null {
  try {
    return fs.statSync(p);
  } catch {
    return null;
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

function basenameLower(p: string): string {
  return path.basename(p).toLowerCase();
}

function extensionLower(p: string): string {
  return path.extname(p).toLowerCase();
}

function readProbe(filePath: string, maxBytes: number): Buffer | null {
  try {
    const fd = fs.openSync(filePath, "r");
    try {
      const buf = Buffer.alloc(maxBytes);
      const read = fs.readSync(fd, buf, 0, maxBytes, 0);
      return buf.subarray(0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return null;
  }
}

function isBinaryBuffer(buf: Buffer): boolean {
  if (buf.length === 0) return false;
  let suspicious = 0;
  for (const byte of buf) {
    if (byte === 0) return true;
    if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
  }
  return suspicious / buf.length > 0.2;
}

function shebang(buf: Buffer): string | null {
  if (buf.length < 2) return null;
  const firstLine = buf.toString("utf8").split(/\r?\n/, 1)[0] ?? "";
  return firstLine.startsWith("#!") ? firstLine : null;
}

function textSignals(buf: Buffer): string[] {
  const text = buf.toString("utf8");
  const signals: string[] = [];
  if (/BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY/.test(text)) signals.push("private-key-material");
  if (/api[_-]?key\s*=|secret\s*=|token\s*=|password\s*=|x-adjutorix-token/i.test(text)) signals.push("secret-assignment");
  if (/generated by|do not edit|auto-generated|autogenerated/i.test(text)) signals.push("generated-banner");
  if (/^#!/.test(text)) signals.push("shebang");
  if (/describe\(|it\(|pytest|unittest|vitest|jest/i.test(text)) signals.push("test-content");
  return [...new Set(signals)].sort((a, b) => a.localeCompare(b));
}

function evidenceFingerprint(core: Omit<FileClassifierEvidence, "fingerprint">): string {
  return sha256(stableJson(core));
}

function classificationHash(core: Omit<FileClassification, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<FileClassifierAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

// -----------------------------------------------------------------------------
// EVIDENCE
// -----------------------------------------------------------------------------

export function evaluateFileClassifierEvidence(rootPath: string, targetPath: string, policy: FileClassifierPolicy = DEFAULT_POLICY): FileClassifierEvidence {
  const normalizedRoot = normalizePath(rootPath);
  const absolutePath = normalizePath(targetPath);
  const relativePath = relativeWithinRoot(normalizedRoot, absolutePath);
  assert(relativePath !== null, "path_outside_workspace_root");

  const stats = statSafe(absolutePath);
  const existsNow = stats !== null;
  const isDir = stats?.isDirectory() ?? false;
  const ext = isDir ? "" : extensionLower(absolutePath);
  const base = basenameLower(absolutePath);
  const probe = existsNow && !isDir ? readProbe(absolutePath, policy.maxBytesForTextProbe) : null;
  const shebangValue = probe ? shebang(probe) : null;

  const nameSignals: string[] = [];
  const pathSignals: string[] = [];
  const contentSignals = probe ? textSignals(probe) : [];

  if (SECRET_BASENAMES.has(base)) nameSignals.push("secret-basename");
  if (CONFIG_BASENAMES.has(path.basename(absolutePath))) nameSignals.push("config-basename");
  if (/\.test\.|\.spec\.|(^|\/)(tests?|__tests__|fixtures)(\/|$)/i.test(relativePath)) pathSignals.push("test-path");
  if (/(^|\/)(dist|build|coverage|out|.next|target)(\/|$)/i.test(relativePath)) pathSignals.push("build-path");
  if (/(^|\/)(node_modules|__pycache__|.venv|venv)(\/|$)/i.test(relativePath)) pathSignals.push("dependency-path");
  if (/(^|\/)(logs?|runtime|state|tmp|temp)(\/|$)/i.test(relativePath)) pathSignals.push("runtime-path");
  if (base === "readme.md" || base.startsWith("readme.")) nameSignals.push("documentation-basename");
  if (base.startsWith(".") && policy.treatDotFilesAsConfigByDefault) nameSignals.push("dotfile-config");
  if (BINARY_EXTENSIONS.has(ext)) nameSignals.push("binary-extension");
  if (TEXT_ASSET_EXTENSIONS.has(ext)) nameSignals.push("text-asset-extension");
  if (SOURCE_EXTENSIONS[ext]) nameSignals.push(`language:${SOURCE_EXTENSIONS[ext]}`);

  const core: Omit<FileClassifierEvidence, "fingerprint"> = {
    rootPath: normalizedRoot,
    absolutePath,
    relativePath,
    exists: existsNow,
    isDirectory: isDir,
    extension: ext,
    basename: base,
    sizeBytes: stats?.size ?? null,
    nameSignals: uniqueSorted(nameSignals),
    pathSignals: uniqueSorted(pathSignals),
    contentSignals: uniqueSorted(contentSignals),
    shebang: shebangValue,
  };

  return {
    ...core,
    fingerprint: evidenceFingerprint(core),
  };
}

// -----------------------------------------------------------------------------
// CLASSIFIER
// -----------------------------------------------------------------------------

export class WorkspaceFileClassifier {
  private readonly rootPath: string;
  private readonly policy: FileClassifierPolicy;
  private readonly audit?: FileClassifierAuditFn;
  private readonly now?: () => number;

  constructor(options: FileClassifierOptions) {
    const normalizedRoot = normalizePath(options.rootPath);
    assert(exists(normalizedRoot), "root_missing");
    assert(statSafe(normalizedRoot)?.isDirectory(), "root_not_directory");
    this.rootPath = normalizedRoot;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;
  }

  classify(targetPath: string): FileClassification {
    const evidence = evaluateFileClassifierEvidence(this.rootPath, targetPath, this.policy);

    let klass: FileSemanticClass = "unknown";
    let language: FileLanguage = "unknown";
    let risk: FileRiskLevel = "low";
    let confidence = 0.5;
    let generated = false;
    let binaryLike = false;
    let secretLike = false;
    let testLike = false;
    let configLike = false;
    let documentationLike = false;
    let runtimeArtifactLike = false;
    const matchedSignals = uniqueSorted([
      ...evidence.nameSignals,
      ...evidence.pathSignals,
      ...evidence.contentSignals,
      ...(evidence.shebang ? ["shebang"] : []),
    ]);

    if (!evidence.exists) {
      klass = "unknown";
      risk = "none";
      confidence = 0.2;
    } else if (evidence.isDirectory) {
      klass = "directory";
      language = "unknown";
      risk = evidence.pathSignals.includes("dependency-path") ? "moderate" : "low";
      confidence = 1;
    } else {
      language = SOURCE_EXTENSIONS[evidence.extension] ?? (BINARY_EXTENSIONS.has(evidence.extension) ? "binary" : "text");
      binaryLike = evidence.nameSignals.includes("binary-extension");

      if (evidence.nameSignals.includes("secret-basename") || evidence.contentSignals.includes("private-key-material") || evidence.contentSignals.includes("secret-assignment")) {
        klass = "secret";
        secretLike = true;
        risk = this.policy.treatEnvAsCriticalSecret ? "critical" : "high";
        confidence = 0.98;
      } else if (evidence.pathSignals.includes("dependency-path")) {
        klass = "dependency-cache";
        risk = "moderate";
        confidence = 0.95;
      } else if (evidence.pathSignals.includes("build-path")) {
        klass = evidence.pathSignals.includes("runtime-path") ? "runtime-state" : (this.policy.treatDistAsBuildOutput ? "build-output" : "generated");
        generated = true;
        runtimeArtifactLike = klass === "runtime-state";
        risk = "low";
        confidence = 0.92;
      } else if (evidence.contentSignals.includes("generated-banner")) {
        klass = "generated";
        generated = true;
        risk = "low";
        confidence = 0.96;
      } else if (evidence.pathSignals.includes("test-path") || evidence.contentSignals.includes("test-content") || /\.test\.|\.spec\./i.test(evidence.relativePath)) {
        klass = "test";
        testLike = true;
        risk = "low";
        confidence = 0.9;
      } else if (evidence.nameSignals.includes("documentation-basename") || language === "markdown") {
        klass = "documentation";
        documentationLike = true;
        risk = "none";
        confidence = 0.92;
      } else if (evidence.nameSignals.includes("config-basename") || evidence.nameSignals.includes("dotfile-config") || ["json", "yaml", "toml", "xml"].includes(language)) {
        klass = baseManifestLike(evidence.basename) ? "manifest" : "config";
        configLike = true;
        risk = klass === "manifest" ? "moderate" : "low";
        confidence = 0.88;
      } else if ((this.policy.trustShebangForScript && evidence.shebang) || language === "shell") {
        klass = "script";
        risk = "moderate";
        confidence = 0.9;
      } else if (binaryLike) {
        klass = "binary-asset";
        risk = "low";
        confidence = 0.97;
      } else if (evidence.nameSignals.includes("text-asset-extension")) {
        klass = "text-asset";
        risk = "none";
        confidence = 0.84;
      } else if (["typescript", "javascript", "python", "css", "html"].includes(language)) {
        klass = "source";
        risk = "moderate";
        confidence = 0.86;
      } else if (evidence.pathSignals.includes("runtime-path") || /\.log$/i.test(evidence.basename)) {
        klass = /\.log$/i.test(evidence.basename) ? "runtime-log" : "runtime-state";
        runtimeArtifactLike = true;
        risk = "low";
        confidence = 0.84;
      } else {
        klass = "unknown";
        risk = language === "binary" ? "moderate" : "low";
        confidence = 0.4;
      }
    }

    const capabilityHints: FileCapabilityHint[] = [];
    if (["source", "test", "config", "manifest", "documentation", "script", "text-asset"].includes(klass)) capabilityHints.push("indexable", "previewable");
    if (["source", "test", "config", "manifest", "documentation", "script", "text-asset"].includes(klass) && !secretLike && !generated) capabilityHints.push("editable");
    if (!secretLike && !binaryLike && klass !== "dependency-cache") capabilityHints.push("diagnostics-exportable");
    if (klass !== "dependency-cache") capabilityHints.push("watchable");
    if (["config", "manifest", "secret", "script"].includes(klass)) capabilityHints.push("trust-relevant");
    if (["source", "config", "manifest", "script", "test"].includes(klass)) capabilityHints.push("governed-target");
    if (secretLike) capabilityHints.push("secret-bearing");
    if (["dependency-cache", "build-output", "generated", "runtime-log", "runtime-state", "binary-asset"].includes(klass)) capabilityHints.push("ignore-candidate");

    const core: Omit<FileClassification, "hash"> = {
      schema: 1,
      rootPath: evidence.rootPath,
      absolutePath: evidence.absolutePath,
      relativePath: evidence.relativePath,
      class: klass,
      language,
      risk,
      generated,
      binaryLike,
      secretLike,
      testLike,
      configLike,
      documentationLike,
      runtimeArtifactLike,
      confidence,
      capabilityHints: uniqueSorted(capabilityHints) as FileCapabilityHint[],
      matchedSignals,
      evidenceFingerprint: evidence.fingerprint,
    };

    const classification: FileClassification = {
      ...core,
      hash: classificationHash(core),
    };

    this.emitAudit("classify", "allow", "file_classified", {
      relativePath: classification.relativePath,
      class: classification.class,
      language: classification.language,
      risk: classification.risk,
      confidence: classification.confidence,
      matchedSignals: classification.matchedSignals,
    }, classification.absolutePath);

    return classification;
  }

  private emitAudit(
    action: FileClassifierAuditRecord["action"],
    decision: FileClassifierAuditRecord["decision"],
    reason: string,
    detail: Record<string, JsonValue>,
    absolutePath: string,
  ): void {
    if (!this.audit) return;
    const core: Omit<FileClassifierAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
      rootPath: this.rootPath,
      absolutePath,
      reason,
      detail,
    };
    this.audit({
      ...core,
      hash: auditHash(core),
    });
  }
}

function baseManifestLike(basename: string): boolean {
  return ["package.json", "pyproject.toml", "requirements.txt", "pnpm-workspace.yaml", "turbo.json"].includes(basename);
}

// -----------------------------------------------------------------------------
// FACTORY / VALIDATION
// -----------------------------------------------------------------------------

export function createWorkspaceFileClassifier(options: FileClassifierOptions): WorkspaceFileClassifier {
  return new WorkspaceFileClassifier(options);
}

export function defaultFileClassifierPolicy(): FileClassifierPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateFileClassification(classification: FileClassification): void {
  assert(classification.schema === 1, "classification_schema_invalid");
  const core: Omit<FileClassification, "hash"> = {
    schema: classification.schema,
    rootPath: classification.rootPath,
    absolutePath: classification.absolutePath,
    relativePath: classification.relativePath,
    class: classification.class,
    language: classification.language,
    risk: classification.risk,
    generated: classification.generated,
    binaryLike: classification.binaryLike,
    secretLike: classification.secretLike,
    testLike: classification.testLike,
    configLike: classification.configLike,
    documentationLike: classification.documentationLike,
    runtimeArtifactLike: classification.runtimeArtifactLike,
    confidence: classification.confidence,
    capabilityHints: classification.capabilityHints,
    matchedSignals: classification.matchedSignals,
    evidenceFingerprint: classification.evidenceFingerprint,
  };
  assert(classification.hash === classificationHash(core), "classification_hash_drift");
}
