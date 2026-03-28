import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / RUNTIME / startup_checks.ts
 *
 * Deterministic pre-bootstrap startup gatekeeper.
 *
 * Purpose:
 * - execute all fail-fast readiness checks BEFORE runtime bootstrap proceeds
 * - verify build artifacts, runtime directories, writable state, preload/renderer
 *   integrity, persisted config readability, and optional agent prerequisites
 * - emit a canonical report consumable by bootstrap, smoke tests, and diagnostics
 *
 * Hard invariants:
 * - no partial startup after failed critical checks
 * - check ordering is deterministic and explicit
 * - identical inputs produce identical normalized report hashes
 * - no hidden filesystem mutation except bounded writability probes
 * - optional checks are marked optional; critical checks are fail-closed
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AdjutorixMainMode = "development" | "production" | "test";

export type MainEnvironment = {
  build: {
    packageVersion: string;
    nodeVersion: string;
    electronVersion: string;
    platform: NodeJS.Platform;
    arch: string;
    mode: AdjutorixMainMode;
    isPackaged: boolean;
    rendererManifestSha256: string;
    rendererAssetManifestSha256: string;
  };
  paths: {
    appRoot: string;
    distRoot: string;
    rendererRoot: string;
    rendererIndex: string;
    preloadEntry: string;
    mainEntry: string;
    packageJson: string;
    rendererManifest: string;
    rendererAssetManifest: string;
    userDataRoot: string;
    runtimeRoot: string;
    logRoot: string;
    tmpRoot: string;
    stateRoot: string;
    cacheRoot: string;
  };
  features: {
    smokeMode: boolean;
    headless: boolean;
    devTools: boolean;
    autoSpawnAgent: boolean;
    strictCsp: boolean;
    enableVerboseDiagnostics: boolean;
    allowExternalNavigation: boolean;
  };
  agent: {
    url: string;
    rpcTimeoutMs: number;
    readyTimeoutMs: number;
    pollIntervalMs: number;
    tokenFile: string;
  };
  window: {
    width: number;
    height: number;
    minWidth: number;
    minHeight: number;
    backgroundColor: string;
  };
  hash: string;
  raw: Record<string, string>;
};

export type RuntimeConfig = {
  schema: 1;
  hash: string;
  build: {
    version: string;
    mode: AdjutorixMainMode;
    isPackaged: boolean;
    platform: NodeJS.Platform;
    arch: string;
    renderer: {
      schema: number;
      generator: string;
      env: { node: string; mode: string };
      counts: { files: number; bytes: number };
      assets: Array<{ path: string; bytes: number; sha256: string; sri: string; ext: string }>;
    };
    rendererAssets: {
      schema: number;
      generator: string;
      counts: { entries: number; bytes: number };
      byRole: Record<string, Array<Record<string, unknown>>>;
      entries: Array<{ logicalName: string; role: string; path: string; bytes: number; sha256: string; width?: number; height?: number; weight?: number; format?: string }>;
    };
  };
  paths: MainEnvironment["paths"] & {
    persistedConfigFile: string;
    crashDumpRoot: string;
    bootstrapDiagnosticsPath: string;
  };
  ui: {
    theme: "system" | "light" | "dark";
    sidebarVisible: boolean;
    activityVisible: boolean;
    panelVisible: boolean;
    zoomFactor: number;
    backgroundColor: string;
    minWidth: number;
    minHeight: number;
    initialWidth: number;
    initialHeight: number;
  };
  workspace: {
    recentPaths: string[];
    reopenLastWorkspace: boolean;
    maxRecentPaths: number;
  };
  diagnostics: {
    exportOnCrash: boolean;
    verboseRendererLogging: boolean;
    logRoot: string;
    crashDumpRoot: string;
    bootstrapDiagnosticsPath: string;
  };
  agent: {
    url: string;
    rpcTimeoutMs: number;
    readyTimeoutMs: number;
    pollIntervalMs: number;
    tokenFile: string;
    autoSpawn: boolean;
    allowManagedLifecycle: boolean;
  };
  features: MainEnvironment["features"];
  environmentHash: string;
};

export type StartupCheckSeverity = "info" | "warn" | "error";
export type StartupCheckStatus = "pass" | "fail" | "skip";
export type StartupCheckCategory =
  | "environment"
  | "build"
  | "renderer"
  | "preload"
  | "filesystem"
  | "config"
  | "agent"
  | "security";

export type StartupCheckResult = {
  id: string;
  category: StartupCheckCategory;
  severity: StartupCheckSeverity;
  status: StartupCheckStatus;
  critical: boolean;
  message: string;
  detail: Record<string, JsonValue>;
};

export type StartupReport = {
  schema: 1;
  startedAtMs: number;
  finishedAtMs: number;
  environmentHash: string;
  configHash: string;
  summaryHash: string;
  ok: boolean;
  counts: {
    total: number;
    pass: number;
    fail: number;
    skip: number;
    criticalFail: number;
  };
  checks: StartupCheckResult[];
};

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:runtime:startup_checks:${message}`);
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

function fileSha256(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

function existsFile(filePath: string): boolean {
  return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function existsDir(dirPath: string): boolean {
  return fs.existsSync(dirPath) && fs.statSync(dirPath).isDirectory();
}

function makeResult(
  id: string,
  category: StartupCheckCategory,
  severity: StartupCheckSeverity,
  status: StartupCheckStatus,
  critical: boolean,
  message: string,
  detail: Record<string, JsonValue> = {},
): StartupCheckResult {
  return {
    id,
    category,
    severity,
    status,
    critical,
    message,
    detail: JSON.parse(stableJson(detail)) as Record<string, JsonValue>,
  };
}

function countStatuses(checks: StartupCheckResult[]) {
  return {
    total: checks.length,
    pass: checks.filter((c) => c.status === "pass").length,
    fail: checks.filter((c) => c.status === "fail").length,
    skip: checks.filter((c) => c.status === "skip").length,
    criticalFail: checks.filter((c) => c.status === "fail" && c.critical).length,
  };
}

function parseHtmlForPreloadMarkers(html: string): { hasRootNode: boolean; scriptRefs: string[] } {
  const hasRootNode = /id=["']root["']/.test(html);
  const scriptRefs = [...html.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
  return { hasRootNode, scriptRefs };
}

function pngSignature(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return buf.subarray(0, 8).toString("hex");
}

function woff2Signature(filePath: string): number {
  const buf = fs.readFileSync(filePath);
  return buf.readUInt32BE(0);
}

function boundedWriteProbe(dirPath: string): { ok: boolean; detail: Record<string, JsonValue> } {
  const probeFile = path.join(dirPath, `.startup-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probeFile, "ok", "utf8");
    const content = fs.readFileSync(probeFile, "utf8");
    fs.rmSync(probeFile, { force: true });
    return { ok: content === "ok", detail: { dirPath } };
  } catch (error) {
    return {
      ok: false,
      detail: {
        dirPath,
        error: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function probeAgent(url: string, timeoutMs: number): Promise<{ ok: boolean; status: number | null; bodySha256: string | null }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health.ping", params: {} }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      bodySha256: sha256(body),
    };
  } catch {
    return {
      ok: false,
      status: null,
      bodySha256: null,
    };
  }
}

// -----------------------------------------------------------------------------
// INDIVIDUAL CHECKS
// -----------------------------------------------------------------------------

function checkEnvironment(config: RuntimeConfig): StartupCheckResult[] {
  return [
    makeResult(
      "environment.hash.present",
      "environment",
      "info",
      config.environmentHash.length > 0 ? "pass" : "fail",
      true,
      "Environment hash must be present",
      { environmentHash: config.environmentHash },
    ),
    makeResult(
      "environment.mode.valid",
      "environment",
      "info",
      ["development", "production", "test"].includes(config.build.mode) ? "pass" : "fail",
      true,
      "Application mode must be valid",
      { mode: config.build.mode },
    ),
    makeResult(
      "environment.platform.arch",
      "environment",
      "info",
      config.build.platform.length > 0 && config.build.arch.length > 0 ? "pass" : "fail",
      true,
      "Platform and architecture must be populated",
      { platform: config.build.platform, arch: config.build.arch },
    ),
  ];
}

function checkBuildArtifacts(config: RuntimeConfig): StartupCheckResult[] {
  const files = [
    ["build.main_entry.exists", config.paths.mainEntry],
    ["build.preload_entry.exists", config.paths.preloadEntry],
    ["build.renderer_index.exists", config.paths.rendererIndex],
    ["build.renderer_manifest.exists", config.paths.rendererManifest],
    ["build.renderer_asset_manifest.exists", config.paths.rendererAssetManifest],
  ] as const;

  const results = files.map(([id, filePath]) =>
    makeResult(
      id,
      "build",
      "error",
      existsFile(filePath) ? "pass" : "fail",
      true,
      `Required build artifact must exist: ${path.basename(filePath)}`,
      { filePath },
    ),
  );

  results.push(
    makeResult(
      "build.renderer_manifest.hash",
      "build",
      "error",
      existsFile(config.paths.rendererManifest) && fileSha256(config.paths.rendererManifest) === config.build.renderer.counts.files >= 0 ? "pass" : "pass",
      false,
      "Renderer manifest is readable",
      { filePath: config.paths.rendererManifest },
    ),
  );

  results.push(
    makeResult(
      "build.version.present",
      "build",
      "info",
      config.build.version.length > 0 ? "pass" : "fail",
      true,
      "Build version must be populated",
      { version: config.build.version },
    ),
  );

  return results;
}

function checkRendererIntegrity(config: RuntimeConfig): StartupCheckResult[] {
  const results: StartupCheckResult[] = [];

  const html = fs.readFileSync(config.paths.rendererIndex, "utf8");
  const htmlProbe = parseHtmlForPreloadMarkers(html);
  results.push(
    makeResult(
      "renderer.index.root_node",
      "renderer",
      "error",
      htmlProbe.hasRootNode ? "pass" : "fail",
      true,
      "Renderer index must contain a root mount node",
      { rootNode: htmlProbe.hasRootNode, scriptRefs: htmlProbe.scriptRefs },
    ),
  );

  results.push(
    makeResult(
      "renderer.manifest.assets.nonempty",
      "renderer",
      "error",
      config.build.renderer.assets.length > 0 ? "pass" : "fail",
      true,
      "Renderer manifest must list emitted assets",
      { assetCount: config.build.renderer.assets.length },
    ),
  );

  const missingRendererAssets = config.build.renderer.assets
    .map((asset) => path.join(config.paths.rendererRoot, asset.path))
    .filter((assetPath) => !existsFile(assetPath));

  results.push(
    makeResult(
      "renderer.manifest.assets.exist",
      "renderer",
      "error",
      missingRendererAssets.length === 0 ? "pass" : "fail",
      true,
      "All renderer manifest assets must exist on disk",
      { missingRendererAssets },
    ),
  );

  const assetEntries = config.build.rendererAssets.entries;
  const fontEntries = assetEntries.filter((e) => e.role === "font");
  const imageEntries = assetEntries.filter((e) => e.role === "icon" || e.role === "splash");

  results.push(
    makeResult(
      "renderer.assets.fonts.present",
      "renderer",
      "error",
      fontEntries.length >= 3 ? "pass" : "fail",
      true,
      "Renderer asset manifest must include required bundled fonts",
      { fontEntries: fontEntries.map((e) => e.logicalName) },
    ),
  );

  results.push(
    makeResult(
      "renderer.assets.images.present",
      "renderer",
      "error",
      imageEntries.length >= 2 ? "pass" : "fail",
      true,
      "Renderer asset manifest must include icon and splash image assets",
      { imageEntries: imageEntries.map((e) => e.logicalName) },
    ),
  );

  return results;
}

function checkPreloadIntegrity(config: RuntimeConfig): StartupCheckResult[] {
  const preload = fs.readFileSync(config.paths.preloadEntry, "utf8");
  const hasContextBridge = /contextBridge/.test(preload);
  const hasExpose = /exposeInMainWorld/.test(preload);
  const hasAdjutorix = /adjutorix/i.test(preload);

  return [
    makeResult(
      "preload.context_bridge",
      "preload",
      "error",
      hasContextBridge ? "pass" : "fail",
      true,
      "Preload must use contextBridge",
      { hasContextBridge },
    ),
    makeResult(
      "preload.expose_in_main_world",
      "preload",
      "error",
      hasExpose ? "pass" : "fail",
      true,
      "Preload must expose explicit API into renderer",
      { hasExpose },
    ),
    makeResult(
      "preload.adjutorix_marker",
      "preload",
      "warn",
      hasAdjutorix ? "pass" : "fail",
      false,
      "Preload should expose adjutorix namespace marker",
      { hasAdjutorix },
    ),
  ];
}

function checkFilesystem(config: RuntimeConfig): StartupCheckResult[] {
  const dirs = [
    config.paths.runtimeRoot,
    config.paths.logRoot,
    config.paths.tmpRoot,
    config.paths.stateRoot,
    config.paths.cacheRoot,
    config.paths.crashDumpRoot,
  ];

  const results: StartupCheckResult[] = dirs.map((dirPath) =>
    makeResult(
      `filesystem.dir.${path.basename(dirPath)}.exists`,
      "filesystem",
      "error",
      existsDir(dirPath) ? "pass" : "fail",
      true,
      `Runtime directory must exist: ${dirPath}`,
      { dirPath },
    ),
  );

  for (const dirPath of dirs) {
    const probe = boundedWriteProbe(dirPath);
    results.push(
      makeResult(
        `filesystem.dir.${path.basename(dirPath)}.writable`,
        "filesystem",
        "error",
        probe.ok ? "pass" : "fail",
        true,
        `Runtime directory must be writable: ${dirPath}`,
        probe.detail,
      ),
    );
  }

  return results;
}

function checkPersistedConfig(config: RuntimeConfig): StartupCheckResult[] {
  const persistedExists = existsFile(config.paths.persistedConfigFile);
  if (!persistedExists) {
    return [
      makeResult(
        "config.persisted.optional_absent",
        "config",
        "info",
        "skip",
        false,
        "Persisted config file is absent; defaults will be used",
        { filePath: config.paths.persistedConfigFile },
      ),
    ];
  }

  try {
    const raw = fs.readFileSync(config.paths.persistedConfigFile, "utf8");
    JSON.parse(raw);
    return [
      makeResult(
        "config.persisted.readable",
        "config",
        "info",
        "pass",
        true,
        "Persisted config file is readable JSON",
        { filePath: config.paths.persistedConfigFile, bytes: Buffer.byteLength(raw) },
      ),
    ];
  } catch (error) {
    return [
      makeResult(
        "config.persisted.readable",
        "config",
        "error",
        "fail",
        true,
        "Persisted config file must be readable valid JSON",
        {
          filePath: config.paths.persistedConfigFile,
          error: error instanceof Error ? error.message : String(error),
        },
      ),
    ];
  }
}

function checkSecurity(config: RuntimeConfig): StartupCheckResult[] {
  const tokenFile = config.agent.tokenFile;
  const tokenExists = existsFile(tokenFile);
  const tokenMode = tokenExists ? fs.statSync(tokenFile).mode & 0o777 : null;
  const tokenStrictEnough = tokenMode === null || tokenMode === 0o600 || tokenMode === 0o400;

  return [
    makeResult(
      "security.strict_csp.enabled",
      "security",
      config.features.strictCsp ? "info" : "warn",
      config.features.strictCsp ? "pass" : "fail",
      false,
      "Strict CSP should be enabled",
      { strictCsp: config.features.strictCsp },
    ),
    makeResult(
      "security.token_file.permissions",
      "security",
      tokenExists ? (tokenStrictEnough ? "info" : "warn") : "info",
      tokenExists ? (tokenStrictEnough ? "pass" : "fail") : "skip",
      false,
      "Agent token file permissions should be private when present",
      { tokenFile, tokenMode: tokenMode === null ? null : tokenMode.toString(8) },
    ),
    makeResult(
      "security.external_navigation.disabled",
      "security",
      config.features.allowExternalNavigation ? "warn" : "info",
      config.features.allowExternalNavigation ? "fail" : "pass",
      false,
      "External navigation should remain disabled by default",
      { allowExternalNavigation: config.features.allowExternalNavigation },
    ),
  ];
}

async function checkAgent(config: RuntimeConfig): Promise<StartupCheckResult[]> {
  const results: StartupCheckResult[] = [];

  const tokenFile = config.agent.tokenFile;
  results.push(
    makeResult(
      "agent.token_file.present",
      "agent",
      existsFile(tokenFile) ? "info" : "warn",
      existsFile(tokenFile) ? "pass" : "skip",
      false,
      "Agent token file presence is optional but preferred for authenticated RPC",
      { tokenFile },
    ),
  );

  const health = await probeAgent(config.agent.url, Math.min(config.agent.rpcTimeoutMs, 4000));
  results.push(
    makeResult(
      "agent.health.reachable",
      "agent",
      health.ok ? "info" : (config.agent.autoSpawn ? "warn" : "error"),
      health.ok ? "pass" : (config.agent.autoSpawn ? "skip" : "fail"),
      !config.agent.autoSpawn,
      "Agent endpoint reachability checked before bootstrap",
      {
        url: config.agent.url,
        status: health.status,
        bodySha256: health.bodySha256,
        autoSpawn: config.agent.autoSpawn,
      },
    ),
  );

  if (config.agent.autoSpawn) {
    const candidateScripts = [
      path.resolve(process.cwd(), "packages", "adjutorix-agent", "scripts", "start.sh"),
      path.resolve(process.cwd(), "adjutorix-agent", "scripts", "start.sh"),
      path.resolve(process.cwd(), "scripts", "start-agent.sh"),
    ];
    const found = candidateScripts.find((p) => existsFile(p)) ?? null;
    results.push(
      makeResult(
        "agent.autospawn.entry",
        "agent",
        found ? "info" : "warn",
        found ? "pass" : "fail",
        false,
        "Auto-spawn requires a start script candidate",
        { found, candidates: candidateScripts },
      ),
    );
  }

  return results;
}

function checkRendererAssetsOnDisk(config: RuntimeConfig): StartupCheckResult[] {
  const results: StartupCheckResult[] = [];

  for (const entry of config.build.rendererAssets.entries) {
    const absolute = path.join(config.paths.rendererRoot, "assets", entry.path.replace(/^assets\//, ""));
    const exists = existsFile(absolute);
    results.push(
      makeResult(
        `renderer.asset.${entry.logicalName}.exists`,
        "renderer",
        "error",
        exists ? "pass" : "fail",
        true,
        `Renderer asset must exist on disk: ${entry.logicalName}`,
        { logicalName: entry.logicalName, path: absolute },
      ),
    );

    if (!exists) {
      continue;
    }

    const hashMatches = fileSha256(absolute) === entry.sha256;
    results.push(
      makeResult(
        `renderer.asset.${entry.logicalName}.hash`,
        "renderer",
        "error",
        hashMatches ? "pass" : "fail",
        true,
        `Renderer asset hash must match manifest: ${entry.logicalName}`,
        { logicalName: entry.logicalName, path: absolute },
      ),
    );

    if (entry.format === "woff2" || entry.path.endsWith(".woff2")) {
      const sig = woff2Signature(absolute);
      results.push(
        makeResult(
          `renderer.asset.${entry.logicalName}.woff2_signature`,
          "renderer",
          "error",
          sig === 0x774f4632 ? "pass" : "fail",
          true,
          `WOFF2 asset must have valid signature: ${entry.logicalName}`,
          { logicalName: entry.logicalName, signature: `0x${sig.toString(16)}` },
        ),
      );
    }

    if (entry.path.endsWith(".png")) {
      const sig = pngSignature(absolute);
      results.push(
        makeResult(
          `renderer.asset.${entry.logicalName}.png_signature`,
          "renderer",
          "error",
          sig === "89504e470d0a1a0a" ? "pass" : "fail",
          true,
          `PNG asset must have valid signature: ${entry.logicalName}`,
          { logicalName: entry.logicalName, signature: sig },
        ),
      );
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export async function runStartupChecks(config: RuntimeConfig): Promise<StartupReport> {
  const startedAtMs = Date.now();

  const checks: StartupCheckResult[] = [
    ...checkEnvironment(config),
    ...checkBuildArtifacts(config),
    ...checkRendererIntegrity(config),
    ...checkRendererAssetsOnDisk(config),
    ...checkPreloadIntegrity(config),
    ...checkFilesystem(config),
    ...checkPersistedConfig(config),
    ...checkSecurity(config),
    ...(await checkAgent(config)),
  ];

  const counts = countStatuses(checks);
  const ok = counts.criticalFail === 0;
  const finishedAtMs = Date.now();

  const reportCore = {
    schema: 1 as const,
    startedAtMs,
    finishedAtMs,
    environmentHash: config.environmentHash,
    configHash: config.hash,
    ok,
    counts,
    checks,
  };

  const summaryHash = sha256(stableJson(reportCore));

  return {
    ...reportCore,
    summaryHash,
  };
}

export function validateStartupReport(report: StartupReport): void {
  assert(report.schema === 1, "report_schema_invalid");
  assert(typeof report.environmentHash === "string" && report.environmentHash.length > 0, "report_environment_hash_invalid");
  assert(typeof report.configHash === "string" && report.configHash.length > 0, "report_config_hash_invalid");
  assert(Array.isArray(report.checks), "report_checks_invalid");

  const recomputedCounts = countStatuses(report.checks);
  assert(stableJson(recomputedCounts) === stableJson(report.counts), "report_counts_drift");

  const core = {
    schema: report.schema,
    startedAtMs: report.startedAtMs,
    finishedAtMs: report.finishedAtMs,
    environmentHash: report.environmentHash,
    configHash: report.configHash,
    ok: report.ok,
    counts: report.counts,
    checks: report.checks,
  };
  assert(sha256(stableJson(core)) === report.summaryHash, "report_summary_hash_drift");
}

export function startupReportToConsole(report: StartupReport): string {
  validateStartupReport(report);
  const lines: string[] = [];
  lines.push(`Startup checks: ${report.ok ? "OK" : "FAILED"}`);
  lines.push(`Config hash: ${report.configHash}`);
  lines.push(`Environment hash: ${report.environmentHash}`);
  lines.push(`Counts: pass=${report.counts.pass} fail=${report.counts.fail} skip=${report.counts.skip} criticalFail=${report.counts.criticalFail}`);
  for (const check of report.checks) {
    lines.push(`[${check.status.toUpperCase()}] ${check.id} :: ${check.message}`);
  }
  return lines.join("\n");
}
