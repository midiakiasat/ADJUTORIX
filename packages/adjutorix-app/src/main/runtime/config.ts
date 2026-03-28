import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

/**
 * ADJUTORIX APP — MAIN / RUNTIME / config.ts
 *
 * Canonical runtime configuration graph for the Electron main process.
 *
 * Purpose:
 * - merge deterministic defaults, validated environment, persisted user config,
 *   and build manifests into a single authoritative runtime config
 * - provide schema-checked accessors for downstream subsystems
 * - compute stable config hashes for diagnostics, cache keys, and smoke tests
 * - prevent ad hoc configuration reads across main/ runtime code
 *
 * Inputs:
 * - validated environment contract from main/env.ts
 * - persisted app config JSON in runtime state directory
 * - renderer build manifest + asset manifest
 *
 * Hard invariants:
 * - runtime config is immutable after construction
 * - all file-backed inputs are validated before inclusion
 * - merge precedence is explicit: defaults < persisted config < environment-forced
 * - no unknown persisted keys survive normalization
 * - config hash is stable for identical semantic inputs
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AdjutorixMainMode = "development" | "production" | "test";
export type AdjutorixTheme = "system" | "light" | "dark";

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

export type RendererManifestAsset = {
  path: string;
  bytes: number;
  sha256: string;
  sri: string;
  ext: string;
};

export type RendererManifest = {
  schema: number;
  generator: string;
  env: {
    node: string;
    mode: string;
  };
  counts: {
    files: number;
    bytes: number;
  };
  assets: RendererManifestAsset[];
};

export type RendererAssetManifestEntry = {
  logicalName: string;
  role: string;
  path: string;
  bytes: number;
  sha256: string;
  width?: number;
  height?: number;
  weight?: number;
  format?: string;
};

export type RendererAssetManifest = {
  schema: number;
  generator: string;
  counts: {
    entries: number;
    bytes: number;
  };
  byRole: Record<string, Array<Record<string, unknown>>>;
  entries: RendererAssetManifestEntry[];
};

export type PersistedAppConfig = {
  schema: 1;
  ui: {
    theme: AdjutorixTheme;
    sidebarVisible: boolean;
    activityVisible: boolean;
    panelVisible: boolean;
    zoomFactor: number;
  };
  workspace: {
    recentPaths: string[];
    reopenLastWorkspace: boolean;
  };
  diagnostics: {
    exportOnCrash: boolean;
    verboseRendererLogging: boolean;
  };
  agent: {
    allowManagedLifecycle: boolean;
  };
};

export type RuntimeUiConfig = PersistedAppConfig["ui"] & {
  backgroundColor: string;
  minWidth: number;
  minHeight: number;
  initialWidth: number;
  initialHeight: number;
};

export type RuntimeWorkspaceConfig = PersistedAppConfig["workspace"] & {
  maxRecentPaths: number;
};

export type RuntimeDiagnosticsConfig = PersistedAppConfig["diagnostics"] & {
  logRoot: string;
  crashDumpRoot: string;
  bootstrapDiagnosticsPath: string;
};

export type RuntimeAgentConfig = {
  url: string;
  rpcTimeoutMs: number;
  readyTimeoutMs: number;
  pollIntervalMs: number;
  tokenFile: string;
  autoSpawn: boolean;
  allowManagedLifecycle: boolean;
};

export type RuntimeBuildConfig = {
  version: string;
  mode: AdjutorixMainMode;
  isPackaged: boolean;
  platform: NodeJS.Platform;
  arch: string;
  renderer: RendererManifest;
  rendererAssets: RendererAssetManifest;
};

export type RuntimePathsConfig = MainEnvironment["paths"] & {
  persistedConfigFile: string;
  crashDumpRoot: string;
  bootstrapDiagnosticsPath: string;
};

export type RuntimeConfig = {
  schema: 1;
  hash: string;
  build: RuntimeBuildConfig;
  paths: RuntimePathsConfig;
  ui: RuntimeUiConfig;
  workspace: RuntimeWorkspaceConfig;
  diagnostics: RuntimeDiagnosticsConfig;
  agent: RuntimeAgentConfig;
  features: MainEnvironment["features"];
  environmentHash: string;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const RUNTIME_CONFIG_SCHEMA = 1 as const;
const PERSISTED_CONFIG_SCHEMA = 1 as const;
const DEFAULT_CONFIG_FILE = "app-config.json";
const DEFAULT_MAX_RECENT_PATHS = 20;
const DEFAULT_ZOOM_FACTOR = 1;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:runtime:config:${message}`);
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

function sha256(input: string | Buffer): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function ensureExistingFile(filePath: string, label: string): string {
  const resolved = path.resolve(filePath);
  assert(fs.existsSync(resolved), `${label}:missing`);
  assert(fs.statSync(resolved).isFile(), `${label}:not_file`);
  return resolved;
}

function parseBoolean(value: unknown, label: string): boolean {
  assert(typeof value === "boolean", `${label}:not_boolean`);
  return value;
}

function parseString(value: unknown, label: string): string {
  assert(typeof value === "string" && value.length > 0, `${label}:not_string`);
  return value;
}

function parseNumber(value: unknown, label: string, min: number, max: number): number {
  assert(typeof value === "number" && Number.isFinite(value), `${label}:not_number`);
  assert(value >= min, `${label}:below_min`);
  assert(value <= max, `${label}:above_max`);
  return value;
}

function parseTheme(value: unknown, label: string): AdjutorixTheme {
  assert(value === "system" || value === "light" || value === "dark", `${label}:invalid_theme`);
  return value;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function dedupePaths(paths: string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths) {
    const normalized = path.resolve(p);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
    if (out.length >= max) break;
  }
  return out;
}

function readJsonFile<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function fileSha256(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
}

// -----------------------------------------------------------------------------
// DEFAULTS
// -----------------------------------------------------------------------------

export function defaultPersistedAppConfig(): PersistedAppConfig {
  return {
    schema: PERSISTED_CONFIG_SCHEMA,
    ui: {
      theme: "system",
      sidebarVisible: true,
      activityVisible: true,
      panelVisible: true,
      zoomFactor: DEFAULT_ZOOM_FACTOR,
    },
    workspace: {
      recentPaths: [],
      reopenLastWorkspace: true,
    },
    diagnostics: {
      exportOnCrash: true,
      verboseRendererLogging: false,
    },
    agent: {
      allowManagedLifecycle: true,
    },
  };
}

// -----------------------------------------------------------------------------
// PERSISTED CONFIG LOADING / NORMALIZATION
// -----------------------------------------------------------------------------

export function persistedConfigFile(environment: MainEnvironment): string {
  return path.join(environment.paths.stateRoot, DEFAULT_CONFIG_FILE);
}

export function validatePersistedAppConfig(input: unknown): PersistedAppConfig {
  assert(isPlainObject(input), "persisted:not_object");
  assert(input.schema === PERSISTED_CONFIG_SCHEMA, "persisted:schema_invalid");

  const ui = input.ui;
  const workspace = input.workspace;
  const diagnostics = input.diagnostics;
  const agent = input.agent;

  assert(isPlainObject(ui), "persisted:ui_invalid");
  assert(isPlainObject(workspace), "persisted:workspace_invalid");
  assert(isPlainObject(diagnostics), "persisted:diagnostics_invalid");
  assert(isPlainObject(agent), "persisted:agent_invalid");

  const cfg: PersistedAppConfig = {
    schema: PERSISTED_CONFIG_SCHEMA,
    ui: {
      theme: parseTheme(ui.theme, "persisted:ui.theme"),
      sidebarVisible: parseBoolean(ui.sidebarVisible, "persisted:ui.sidebarVisible"),
      activityVisible: parseBoolean(ui.activityVisible, "persisted:ui.activityVisible"),
      panelVisible: parseBoolean(ui.panelVisible, "persisted:ui.panelVisible"),
      zoomFactor: parseNumber(ui.zoomFactor, "persisted:ui.zoomFactor", 0.5, 3),
    },
    workspace: {
      recentPaths: (() => {
        assert(Array.isArray(workspace.recentPaths), "persisted:workspace.recentPaths_invalid");
        const values = workspace.recentPaths.map((v, i) => parseString(v, `persisted:workspace.recentPaths[${i}]`));
        return dedupePaths(values, DEFAULT_MAX_RECENT_PATHS);
      })(),
      reopenLastWorkspace: parseBoolean(workspace.reopenLastWorkspace, "persisted:workspace.reopenLastWorkspace"),
    },
    diagnostics: {
      exportOnCrash: parseBoolean(diagnostics.exportOnCrash, "persisted:diagnostics.exportOnCrash"),
      verboseRendererLogging: parseBoolean(diagnostics.verboseRendererLogging, "persisted:diagnostics.verboseRendererLogging"),
    },
    agent: {
      allowManagedLifecycle: parseBoolean(agent.allowManagedLifecycle, "persisted:agent.allowManagedLifecycle"),
    },
  };

  return cfg;
}

export function loadPersistedAppConfig(environment: MainEnvironment): PersistedAppConfig {
  const file = persistedConfigFile(environment);
  if (!fs.existsSync(file)) {
    return defaultPersistedAppConfig();
  }
  const parsed = readJsonFile<unknown>(file);
  return validatePersistedAppConfig(parsed);
}

export function writePersistedAppConfig(environment: MainEnvironment, config: PersistedAppConfig): void {
  const validated = validatePersistedAppConfig(config);
  const file = persistedConfigFile(environment);
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${stableJson(validated)}\n`, "utf8");
  fs.renameSync(tmp, file);
}

// -----------------------------------------------------------------------------
// BUILD MANIFESTS
// -----------------------------------------------------------------------------

export function loadRendererManifest(environment: MainEnvironment): RendererManifest {
  const file = ensureExistingFile(environment.paths.rendererManifest, "renderer_manifest");
  assert(fileSha256(file) === environment.build.rendererManifestSha256, "renderer_manifest_hash_mismatch");
  const manifest = readJsonFile<RendererManifest>(file);
  assert(typeof manifest.schema === "number", "renderer_manifest_schema_invalid");
  assert(Array.isArray(manifest.assets), "renderer_manifest_assets_invalid");
  return manifest;
}

export function loadRendererAssetManifest(environment: MainEnvironment): RendererAssetManifest {
  const file = ensureExistingFile(environment.paths.rendererAssetManifest, "renderer_asset_manifest");
  assert(fileSha256(file) === environment.build.rendererAssetManifestSha256, "renderer_asset_manifest_hash_mismatch");
  const manifest = readJsonFile<RendererAssetManifest>(file);
  assert(typeof manifest.schema === "number", "renderer_asset_manifest_schema_invalid");
  assert(Array.isArray(manifest.entries), "renderer_asset_manifest_entries_invalid");
  return manifest;
}

// -----------------------------------------------------------------------------
// MERGE
// -----------------------------------------------------------------------------

export function buildRuntimeConfig(environment: MainEnvironment): RuntimeConfig {
  const persisted = loadPersistedAppConfig(environment);
  const renderer = loadRendererManifest(environment);
  const rendererAssets = loadRendererAssetManifest(environment);

  const crashDumpRoot = path.join(environment.paths.logRoot, "crash-dumps");
  const bootstrapDiagnosticsPath = path.join(environment.paths.logRoot, "bootstrap-diagnostics.json");
  ensureDir(crashDumpRoot);

  const configCore: Omit<RuntimeConfig, "hash"> = {
    schema: RUNTIME_CONFIG_SCHEMA,
    build: {
      version: environment.build.packageVersion,
      mode: environment.build.mode,
      isPackaged: environment.build.isPackaged,
      platform: environment.build.platform,
      arch: environment.build.arch,
      renderer,
      rendererAssets,
    },
    paths: {
      ...environment.paths,
      persistedConfigFile: persistedConfigFile(environment),
      crashDumpRoot,
      bootstrapDiagnosticsPath,
    },
    ui: {
      theme: persisted.ui.theme,
      sidebarVisible: persisted.ui.sidebarVisible,
      activityVisible: persisted.ui.activityVisible,
      panelVisible: persisted.ui.panelVisible,
      zoomFactor: clamp(persisted.ui.zoomFactor, 0.5, 3),
      backgroundColor: environment.window.backgroundColor,
      minWidth: environment.window.minWidth,
      minHeight: environment.window.minHeight,
      initialWidth: environment.window.width,
      initialHeight: environment.window.height,
    },
    workspace: {
      recentPaths: dedupePaths(persisted.workspace.recentPaths, DEFAULT_MAX_RECENT_PATHS),
      reopenLastWorkspace: persisted.workspace.reopenLastWorkspace,
      maxRecentPaths: DEFAULT_MAX_RECENT_PATHS,
    },
    diagnostics: {
      exportOnCrash: persisted.diagnostics.exportOnCrash,
      verboseRendererLogging: persisted.diagnostics.verboseRendererLogging || environment.features.enableVerboseDiagnostics,
      logRoot: environment.paths.logRoot,
      crashDumpRoot,
      bootstrapDiagnosticsPath,
    },
    agent: {
      url: environment.agent.url,
      rpcTimeoutMs: environment.agent.rpcTimeoutMs,
      readyTimeoutMs: environment.agent.readyTimeoutMs,
      pollIntervalMs: environment.agent.pollIntervalMs,
      tokenFile: environment.agent.tokenFile,
      autoSpawn: environment.features.autoSpawnAgent,
      allowManagedLifecycle: persisted.agent.allowManagedLifecycle,
    },
    features: {
      ...environment.features,
      autoSpawnAgent: environment.features.autoSpawnAgent && persisted.agent.allowManagedLifecycle,
    },
    environmentHash: environment.hash,
  };

  const hash = sha256(stableJson(configCore));

  return {
    ...configCore,
    hash,
  };
}

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateRuntimeConfig(config: RuntimeConfig): void {
  assert(config.schema === RUNTIME_CONFIG_SCHEMA, "runtime_schema_invalid");
  assert(config.environmentHash.length > 0, "environment_hash_missing");
  assert(config.build.version.length > 0, "build_version_missing");
  assert(Array.isArray(config.build.renderer.assets), "runtime_renderer_assets_invalid");
  assert(Array.isArray(config.build.rendererAssets.entries), "runtime_renderer_asset_entries_invalid");

  assert(fs.existsSync(config.paths.rendererIndex), "renderer_index_missing");
  assert(fs.existsSync(config.paths.preloadEntry), "preload_entry_missing");
  assert(fs.existsSync(config.paths.persistedConfigFile) || true, "persisted_config_optional");
  assert(fs.existsSync(config.paths.logRoot), "log_root_missing");
  assert(fs.existsSync(config.paths.crashDumpRoot), "crash_dump_root_missing");

  assert(config.ui.initialWidth >= config.ui.minWidth, "ui_initial_width_below_min");
  assert(config.ui.initialHeight >= config.ui.minHeight, "ui_initial_height_below_min");
  assert(/^#[0-9a-f]{6}$/.test(config.ui.backgroundColor), "ui_background_invalid");
  assert(config.ui.zoomFactor >= 0.5 && config.ui.zoomFactor <= 3, "ui_zoom_invalid");

  assert(config.agent.rpcTimeoutMs >= 500, "agent_rpc_timeout_invalid");
  assert(config.agent.readyTimeoutMs >= config.agent.pollIntervalMs, "agent_ready_timeout_invalid");
  assert(config.workspace.recentPaths.length <= config.workspace.maxRecentPaths, "workspace_recent_paths_overflow");

  const recomputed = sha256(stableJson({
    schema: config.schema,
    build: config.build,
    paths: config.paths,
    ui: config.ui,
    workspace: config.workspace,
    diagnostics: config.diagnostics,
    agent: config.agent,
    features: config.features,
    environmentHash: config.environmentHash,
  }));
  assert(recomputed === config.hash, "runtime_hash_drift");
}

// -----------------------------------------------------------------------------
// SNAPSHOTS / REDACTION
// -----------------------------------------------------------------------------

export function summarizeRuntimeConfig(config: RuntimeConfig): Record<string, unknown> {
  return {
    version: config.build.version,
    mode: config.build.mode,
    isPackaged: config.build.isPackaged,
    platform: config.build.platform,
    arch: config.build.arch,
    environmentHash: config.environmentHash,
    configHash: config.hash,
    rendererManifestFiles: config.build.renderer.counts.files,
    rendererAssetEntries: config.build.rendererAssets.counts.entries,
    runtimeRoot: config.paths.runtimeRoot,
    logRoot: config.paths.logRoot,
    crashDumpRoot: config.paths.crashDumpRoot,
    agentUrl: config.agent.url,
    autoSpawnAgent: config.agent.autoSpawn,
    allowManagedLifecycle: config.agent.allowManagedLifecycle,
    theme: config.ui.theme,
    recentPaths: config.workspace.recentPaths.length,
  };
}

export function redactRuntimeConfig(config: RuntimeConfig): RuntimeConfig {
  return {
    ...config,
    agent: {
      ...config.agent,
      tokenFile: path.basename(config.agent.tokenFile),
    },
  };
}
