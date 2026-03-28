import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / AGENT / agent_auth.ts
 *
 * Canonical authentication boundary for Adjutorix agent access from the Electron
 * main process.
 *
 * Purpose:
 * - centralize token discovery, loading, validation, and header projection
 * - prevent auth logic from fragmenting across agent client, process, IPC, and diagnostics
 * - support rotation-safe token refresh with deterministic cache invalidation
 * - classify auth posture explicitly rather than treating missing/invalid token as
 *   generic transport failure
 * - expose snapshots and auditable auth decisions without leaking token contents
 *
 * Responsibilities:
 * - resolve canonical token file paths from runtime/user environment
 * - load token material safely and normalize whitespace/newline variants
 * - validate token shape and classify auth state
 * - generate request header projections for agent-bound calls
 * - provide cache refresh/invalidation and rotation detection
 * - emit deterministic snapshots for diagnostics/tests
 *
 * Hard invariants:
 * - token values are never emitted in snapshots, audit logs, or hashes directly
 * - identical token file contents produce identical token fingerprints
 * - missing token != invalid token != unreadable token; states remain distinct
 * - header projection is deterministic and side-effect free
 * - cache invalidation is explicit and refreshable
 * - auth state is serialization-stable and auditable
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

export type AgentAuthStateKind =
  | "uninitialized"
  | "ready"
  | "missing"
  | "empty"
  | "invalid"
  | "unreadable"
  | "error";

export type AgentAuthTrust = "none" | "weak" | "usable";

export type AgentAuthAction =
  | "resolve_path"
  | "load_token"
  | "refresh"
  | "invalidate"
  | "project_headers"
  | "classify";

export type AgentTokenSource = "explicit" | "env" | "default-home";

export type AgentAuthPolicy = {
  tokenHeaderName: string;
  allowEmptyToken: boolean;
  minTokenLength: number;
  maxTokenLength: number;
  trimWhitespace: boolean;
  strictAscii: boolean;
  requireFile: boolean;
  cacheStatFingerprint: boolean;
};

export type AgentTokenFileInfo = {
  path: string;
  exists: boolean;
  readable: boolean;
  sizeBytes: number | null;
  mtimeMs: number | null;
  inodeFingerprint: string | null;
};

export type AgentAuthMaterial = {
  source: AgentTokenSource;
  resolvedPath: string;
  state: AgentAuthStateKind;
  trust: AgentAuthTrust;
  tokenLoadedAtMs: number | null;
  tokenFingerprint: string | null;
  tokenLength: number | null;
  fileInfo: AgentTokenFileInfo;
  reason: string;
};

export type AgentAuthHeaderProjection = {
  schema: 1;
  headers: Record<string, string>;
  tokenPresent: boolean;
  tokenFingerprint: string | null;
  hash: string;
};

export type AgentAuthSnapshot = {
  schema: 1;
  policy: AgentAuthPolicy;
  material: AgentAuthMaterial;
  cached: boolean;
  hash: string;
};

export type AgentAuthAuditRecord = {
  schema: 1;
  ts_ms: number;
  action: AgentAuthAction;
  decision: "allow" | "deny";
  reason: string;
  detail: Record<string, JsonValue>;
  hash: string;
};

export type AgentAuthAuditFn = (record: AgentAuthAuditRecord) => void;

export type AgentAuthOptions = {
  tokenFile?: string;
  env?: NodeJS.ProcessEnv;
  policy?: Partial<AgentAuthPolicy>;
  audit?: AgentAuthAuditFn;
  now?: () => number;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_POLICY: AgentAuthPolicy = {
  tokenHeaderName: "x-adjutorix-token",
  allowEmptyToken: false,
  minTokenLength: 16,
  maxTokenLength: 4096,
  trimWhitespace: true,
  strictAscii: true,
  requireFile: true,
  cacheStatFingerprint: true,
};

const DEFAULT_RELATIVE_TOKEN_PATH = path.join(".adjutorix", "token");

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:agent:agent_auth:${message}`);
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

function normalizeAbsolutePath(input: string): string {
  assert(typeof input === "string" && input.trim().length > 0, "token_path_invalid");
  return path.resolve(input.trim());
}

function fileInfo(targetPath: string): AgentTokenFileInfo {
  try {
    const stat = fs.statSync(targetPath);
    fs.accessSync(targetPath, fs.constants.R_OK);
    return {
      path: targetPath,
      exists: true,
      readable: true,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      inodeFingerprint: sha256(`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`),
    };
  } catch (error) {
    const exists = fs.existsSync(targetPath);
    return {
      path: targetPath,
      exists,
      readable: false,
      sizeBytes: null,
      mtimeMs: null,
      inodeFingerprint: exists ? sha256(`exists:${targetPath}`) : null,
    };
  }
}

function normalizeToken(raw: string, policy: AgentAuthPolicy): string {
  const normalized = policy.trimWhitespace ? raw.trim() : raw;
  return normalized.replace(/\r\n/g, "\n");
}

function tokenFingerprint(token: string): string | null {
  return token.length > 0 ? sha256(token) : null;
}

function isAsciiPrintable(value: string): boolean {
  return /^[\x20-\x7E\n\t]+$/.test(value);
}

function headerProjectionHash(core: Omit<AgentAuthHeaderProjection, "hash">): string {
  return sha256(stableJson(core));
}

function snapshotHash(core: Omit<AgentAuthSnapshot, "hash">): string {
  return sha256(stableJson(core));
}

function auditHash(core: Omit<AgentAuthAuditRecord, "hash">): string {
  return sha256(stableJson(core));
}

// -----------------------------------------------------------------------------
// AUTH MANAGER
// -----------------------------------------------------------------------------

export class AgentAuthManager {
  private readonly env: NodeJS.ProcessEnv;
  private readonly policy: AgentAuthPolicy;
  private readonly audit?: AgentAuthAuditFn;
  private readonly now?: () => number;
  private readonly source: AgentTokenSource;
  private readonly resolvedPath: string;

  private cachedToken: string | null = null;
  private cachedInfo: AgentTokenFileInfo | null = null;
  private cachedMaterial: AgentAuthMaterial | null = null;

  constructor(options: AgentAuthOptions = {}) {
    this.env = options.env ?? process.env;
    this.policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) };
    this.audit = options.audit;
    this.now = options.now;

    const resolved = this.resolveTokenPath(options.tokenFile, this.env);
    this.source = resolved.source;
    this.resolvedPath = resolved.path;

    this.emitAudit("resolve_path", "allow", "token_path_resolved", {
      source: this.source,
      resolvedPath: this.resolvedPath,
    });
  }

  resolvePath(): string {
    return this.resolvedPath;
  }

  classify(): AgentAuthMaterial {
    const material = this.loadMaterial();
    this.emitAudit("classify", material.state === "ready" ? "allow" : "deny", material.reason, {
      state: material.state,
      trust: material.trust,
      tokenFingerprint: material.tokenFingerprint,
    });
    return material;
  }

  loadToken(): string | null {
    const material = this.loadMaterial();
    if (material.state !== "ready") return null;
    return this.cachedToken;
  }

  refresh(): AgentAuthMaterial {
    this.cachedToken = null;
    this.cachedInfo = null;
    this.cachedMaterial = null;
    const material = this.loadMaterial(true);
    this.emitAudit("refresh", material.state === "ready" ? "allow" : "deny", material.reason, {
      state: material.state,
      tokenFingerprint: material.tokenFingerprint,
    });
    return material;
  }

  invalidate(): void {
    this.cachedToken = null;
    this.cachedInfo = null;
    this.cachedMaterial = null;
    this.emitAudit("invalidate", "allow", "auth_cache_invalidated", {
      resolvedPath: this.resolvedPath,
    });
  }

  projectHeaders(extraHeaders: Record<string, string> = {}): AgentAuthHeaderProjection {
    const material = this.loadMaterial();
    const headers: Record<string, string> = { ...extraHeaders };

    if (material.state === "ready" && this.cachedToken) {
      headers[this.policy.tokenHeaderName] = this.cachedToken;
    }

    const core: Omit<AgentAuthHeaderProjection, "hash"> = {
      schema: 1,
      headers,
      tokenPresent: material.state === "ready" && !!this.cachedToken,
      tokenFingerprint: material.tokenFingerprint,
    };

    const projection: AgentAuthHeaderProjection = {
      ...core,
      hash: headerProjectionHash(core),
    };

    this.emitAudit("project_headers", projection.tokenPresent ? "allow" : "deny", projection.tokenPresent ? "auth_headers_projected" : "auth_headers_without_token", {
      tokenFingerprint: projection.tokenFingerprint,
      headerNames: Object.keys(headers).sort(),
    });

    return projection;
  }

  snapshot(): AgentAuthSnapshot {
    const material = this.loadMaterial();
    const core: Omit<AgentAuthSnapshot, "hash"> = {
      schema: 1,
      policy: this.policy,
      material,
      cached: this.cachedMaterial !== null,
    };

    return {
      ...core,
      hash: snapshotHash(core),
    };
  }

  // ---------------------------------------------------------------------------
  // INTERNALS
  // ---------------------------------------------------------------------------

  private resolveTokenPath(explicitTokenFile: string | undefined, env: NodeJS.ProcessEnv): { source: AgentTokenSource; path: string } {
    if (explicitTokenFile && explicitTokenFile.trim().length > 0) {
      return { source: "explicit", path: normalizeAbsolutePath(explicitTokenFile) };
    }

    const envPath = env.ADJUTORIX_TOKEN_FILE ?? env.ADJUTORIX_AGENT_TOKEN_FILE;
    if (envPath && envPath.trim().length > 0) {
      return { source: "env", path: normalizeAbsolutePath(envPath) };
    }

    return {
      source: "default-home",
      path: normalizeAbsolutePath(path.join(os.homedir(), DEFAULT_RELATIVE_TOKEN_PATH)),
    };
  }

  private loadMaterial(force = false): AgentAuthMaterial {
    if (!force && this.cachedMaterial && this.isCacheFresh()) {
      return this.cachedMaterial;
    }

    const info = fileInfo(this.resolvedPath);
    this.cachedInfo = info;

    if (!info.exists) {
      const material: AgentAuthMaterial = {
        source: this.source,
        resolvedPath: this.resolvedPath,
        state: this.policy.requireFile ? "missing" : "uninitialized",
        trust: "none",
        tokenLoadedAtMs: null,
        tokenFingerprint: null,
        tokenLength: null,
        fileInfo: info,
        reason: this.policy.requireFile ? "token_file_missing" : "token_file_optional_missing",
      };
      this.cachedToken = null;
      this.cachedMaterial = material;
      return material;
    }

    if (!info.readable) {
      const material: AgentAuthMaterial = {
        source: this.source,
        resolvedPath: this.resolvedPath,
        state: "unreadable",
        trust: "none",
        tokenLoadedAtMs: null,
        tokenFingerprint: null,
        tokenLength: null,
        fileInfo: info,
        reason: "token_file_unreadable",
      };
      this.cachedToken = null;
      this.cachedMaterial = material;
      return material;
    }

    try {
      const raw = fs.readFileSync(this.resolvedPath, "utf8");
      const token = normalizeToken(raw, this.policy);

      if (token.length === 0 && !this.policy.allowEmptyToken) {
        const material: AgentAuthMaterial = {
          source: this.source,
          resolvedPath: this.resolvedPath,
          state: "empty",
          trust: "none",
          tokenLoadedAtMs: null,
          tokenFingerprint: null,
          tokenLength: 0,
          fileInfo: info,
          reason: "token_empty",
        };
        this.cachedToken = null;
        this.cachedMaterial = material;
        return material;
      }

      if (token.length < this.policy.minTokenLength || token.length > this.policy.maxTokenLength) {
        const material: AgentAuthMaterial = {
          source: this.source,
          resolvedPath: this.resolvedPath,
          state: "invalid",
          trust: "none",
          tokenLoadedAtMs: null,
          tokenFingerprint: tokenFingerprint(token),
          tokenLength: token.length,
          fileInfo: info,
          reason: "token_length_out_of_bounds",
        };
        this.cachedToken = null;
        this.cachedMaterial = material;
        return material;
      }

      if (this.policy.strictAscii && !isAsciiPrintable(token)) {
        const material: AgentAuthMaterial = {
          source: this.source,
          resolvedPath: this.resolvedPath,
          state: "invalid",
          trust: "none",
          tokenLoadedAtMs: null,
          tokenFingerprint: tokenFingerprint(token),
          tokenLength: token.length,
          fileInfo: info,
          reason: "token_contains_non_ascii_or_control_bytes",
        };
        this.cachedToken = null;
        this.cachedMaterial = material;
        return material;
      }

      const loadedAt = nowMs(this.now);
      const material: AgentAuthMaterial = {
        source: this.source,
        resolvedPath: this.resolvedPath,
        state: "ready",
        trust: token.length >= 32 ? "usable" : "weak",
        tokenLoadedAtMs: loadedAt,
        tokenFingerprint: tokenFingerprint(token),
        tokenLength: token.length,
        fileInfo: info,
        reason: "token_loaded",
      };

      this.cachedToken = token;
      this.cachedMaterial = material;
      this.emitAudit("load_token", "allow", material.reason, {
        tokenFingerprint: material.tokenFingerprint,
        tokenLength: material.tokenLength,
        source: material.source,
      });
      return material;
    } catch (error) {
      const material: AgentAuthMaterial = {
        source: this.source,
        resolvedPath: this.resolvedPath,
        state: "error",
        trust: "none",
        tokenLoadedAtMs: null,
        tokenFingerprint: null,
        tokenLength: null,
        fileInfo: info,
        reason: error instanceof Error ? error.message : String(error),
      };
      this.cachedToken = null;
      this.cachedMaterial = material;
      this.emitAudit("load_token", "deny", "token_load_error", {
        error: material.reason,
      });
      return material;
    }
  }

  private isCacheFresh(): boolean {
    if (!this.policy.cacheStatFingerprint) return true;
    if (!this.cachedInfo) return false;
    const latest = fileInfo(this.resolvedPath);
    return stableJson(latest) === stableJson(this.cachedInfo);
  }

  private emitAudit(
    action: AgentAuthAction,
    decision: "allow" | "deny",
    reason: string,
    detail: Record<string, JsonValue>,
  ): void {
    if (!this.audit) return;
    const core: Omit<AgentAuthAuditRecord, "hash"> = {
      schema: 1,
      ts_ms: nowMs(this.now),
      action,
      decision,
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

export function createAgentAuthManager(options: AgentAuthOptions = {}): AgentAuthManager {
  return new AgentAuthManager(options);
}

export function defaultAgentAuthPolicy(): AgentAuthPolicy {
  return { ...DEFAULT_POLICY };
}

export function validateAgentAuthHeaderProjection(projection: AgentAuthHeaderProjection): void {
  assert(projection.schema === 1, "header_projection_schema_invalid");
  const core: Omit<AgentAuthHeaderProjection, "hash"> = {
    schema: projection.schema,
    headers: projection.headers,
    tokenPresent: projection.tokenPresent,
    tokenFingerprint: projection.tokenFingerprint,
  };
  assert(projection.hash === headerProjectionHash(core), "header_projection_hash_drift");
}

export function validateAgentAuthSnapshot(snapshot: AgentAuthSnapshot): void {
  assert(snapshot.schema === 1, "snapshot_schema_invalid");
  const core: Omit<AgentAuthSnapshot, "hash"> = {
    schema: snapshot.schema,
    policy: snapshot.policy,
    material: snapshot.material,
    cached: snapshot.cached,
  };
  assert(snapshot.hash === snapshotHash(core), "snapshot_hash_drift");
}
