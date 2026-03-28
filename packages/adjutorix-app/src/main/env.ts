import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { app } from "electron";

/**
 * ADJUTORIX APP — MAIN / env.ts
 *
 * Authoritative runtime environment normalization and validation for the
 * Electron main process.
 *
 * Responsibilities:
 * - read and normalize all allowed environment inputs
 * - compute canonical runtime paths
 * - validate required build/runtime artifacts exist
 * - derive deterministic feature flags and mode switches
 * - expose a single typed environment contract to the rest of main/
 * - prevent ambient process.env leakage from becoming implicit authority
 *
 * Hard invariants:
 * - only explicitly allow-listed env vars may affect runtime behavior
 * - all returned paths are absolute and normalized
 * - all booleans are parsed deterministically
 * - all numeric limits are range-checked
 * - missing required artifacts fail closed
 * - derived config hash is stable for identical inputs
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AdjutorixMainMode = "development" | "production" | "test";

export type AdjutorixBooleanSource = "1" | "0" | "true" | "false" | "yes" | "no" | "on" | "off";

export type MainEnvPaths = {
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

export type MainEnvFeatures = {
  smokeMode: boolean;
  headless: boolean;
  devTools: boolean;
  autoSpawnAgent: boolean;
  strictCsp: boolean;
  enableVerboseDiagnostics: boolean;
  allowExternalNavigation: boolean;
};

export type MainEnvAgent = {
  url: string;
  rpcTimeoutMs: number;
  readyTimeoutMs: number;
  pollIntervalMs: number;
  tokenFile: string;
};

export type MainEnvWindow = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  backgroundColor: string;
};

export type MainEnvBuild = {
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

export type MainEnvironment = {
  build: MainEnvBuild;
  paths: MainEnvPaths;
  features: MainEnvFeatures;
  agent: MainEnvAgent;
  window: MainEnvWindow;
  hash: string;
  raw: Record<string, string>;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_AGENT_URL = "http://127.0.0.1:8000/rpc";
const DEFAULT_AGENT_RPC_TIMEOUT_MS = 8_000;
const DEFAULT_AGENT_READY_TIMEOUT_MS = 10_000;
const DEFAULT_AGENT_POLL_INTERVAL_MS = 125;

const DEFAULT_WINDOW_WIDTH = 1540;
const DEFAULT_WINDOW_HEIGHT = 980;
const DEFAULT_WINDOW_MIN_WIDTH = 1180;
const DEFAULT_WINDOW_MIN_HEIGHT = 720;
const DEFAULT_BACKGROUND_COLOR = "#0b0f14";

const ALLOWED_ENV_KEYS = [
  "NODE_ENV",
  "ADJUTORIX_SMOKE_MODE",
  "ADJUTORIX_SMOKE_HEADLESS",
  "ADJUTORIX_AGENT_URL",
  "ADJUTORIX_AGENT_AUTOSPAWN",
  "ADJUTORIX_AGENT_RPC_TIMEOUT_MS",
  "ADJUTORIX_AGENT_READY_TIMEOUT_MS",
  "ADJUTORIX_AGENT_POLL_INTERVAL_MS",
  "ADJUTORIX_DEVTOOLS",
  "ADJUTORIX_VERBOSE_DIAGNOSTICS",
  "ADJUTORIX_ALLOW_EXTERNAL_NAVIGATION",
  "ADJUTORIX_STRICT_CSP",
  "ADJUTORIX_WINDOW_WIDTH",
  "ADJUTORIX_WINDOW_HEIGHT",
  "ADJUTORIX_WINDOW_MIN_WIDTH",
  "ADJUTORIX_WINDOW_MIN_HEIGHT",
  "ADJUTORIX_BACKGROUND_COLOR",
  "ADJUTORIX_RUNTIME_ROOT",
  "ADJUTORIX_TOKEN_FILE",
] as const;

const BOOLEAN_TRUE = new Set<AdjutorixBooleanSource>(["1", "true", "yes", "on"]);
const BOOLEAN_FALSE = new Set<AdjutorixBooleanSource>(["0", "false", "no", "off"]);

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:env:${message}`);
  }
}

function normalizePath(p: string): string {
  return path.resolve(p);
}

function ensureAbsoluteExistingFile(filePath: string, label: string): string {
  const normalized = normalizePath(filePath);
  assert(fs.existsSync(normalized), `${label}:missing`);
  assert(fs.statSync(normalized).isFile(), `${label}:not_file`);
  return normalized;
}

function ensureDir(dirPath: string): string {
  const normalized = normalizePath(dirPath);
  fs.mkdirSync(normalized, { recursive: true });
  assert(fs.statSync(normalized).isDirectory(), `dir_create_failed:${normalized}`);
  return normalized;
}

function ensureInside(base: string, target: string, label: string): void {
  const b = normalizePath(base);
  const t = normalizePath(target);
  assert(t === b || t.startsWith(`${b}${path.sep}`), `${label}:path_escape`);
}

function readPackageVersion(packageJsonPath: string): string {
  const raw = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  assert(typeof raw.version === "string" && raw.version.length > 0, "package_json:version_missing");
  return raw.version;
}

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function fileSha256(filePath: string): string {
  return sha256(fs.readFileSync(filePath));
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

function parseMode(value: string | undefined): AdjutorixMainMode {
  switch (value) {
    case undefined:
    case "production":
      return "production";
    case "development":
      return "development";
    case "test":
      return "test";
    default:
      throw new Error(`main:env:invalid_mode:${value}`);
  }
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim().toLowerCase() as AdjutorixBooleanSource;
  if (BOOLEAN_TRUE.has(normalized)) return true;
  if (BOOLEAN_FALSE.has(normalized)) return false;
  throw new Error(`main:env:invalid_boolean:${value}`);
}

function parseInteger(value: string | undefined, fallback: number, label: string, min: number, max: number): number {
  if (value === undefined || value === "") return fallback;
  assert(/^-?\d+$/.test(value.trim()), `${label}:invalid_integer`);
  const parsed = Number.parseInt(value, 10);
  assert(Number.isSafeInteger(parsed), `${label}:unsafe_integer`);
  assert(parsed >= min, `${label}:below_min`);
  assert(parsed <= max, `${label}:above_max`);
  return parsed;
}

function parseHexColor(value: string | undefined, fallback: string): string {
  if (value === undefined || value === "") return fallback;
  const normalized = value.trim();
  assert(/^#[0-9a-fA-F]{6}$/.test(normalized), `background_color:invalid:${normalized}`);
  return normalized.toLowerCase();
}

function filterRawEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function deriveAppRoots(): Pick<MainEnvPaths, "appRoot" | "distRoot" | "rendererRoot" | "rendererIndex" | "preloadEntry" | "mainEntry" | "packageJson" | "rendererManifest" | "rendererAssetManifest"> {
  const appRoot = normalizePath(path.resolve(__dirname, ".."));
  const distRoot = normalizePath(path.resolve(appRoot, ".."));
  const rendererRoot = normalizePath(path.join(distRoot, "renderer"));
  const rendererIndex = ensureAbsoluteExistingFile(path.join(rendererRoot, "index.html"), "renderer_index");
  const preloadEntry = ensureAbsoluteExistingFile(path.join(distRoot, "preload.js"), "preload_entry");
  const mainEntry = ensureAbsoluteExistingFile(path.join(distRoot, "main.js"), "main_entry");
  const packageJson = ensureAbsoluteExistingFile(path.resolve(appRoot, "..", "package.json"), "package_json");
  const rendererManifest = ensureAbsoluteExistingFile(path.join(rendererRoot, "manifest.json"), "renderer_manifest");
  const rendererAssetManifest = ensureAbsoluteExistingFile(path.join(rendererRoot, "assets", "asset-manifest.json"), "renderer_asset_manifest");

  return {
    appRoot,
    distRoot,
    rendererRoot,
    rendererIndex,
    preloadEntry,
    mainEntry,
    packageJson,
    rendererManifest,
    rendererAssetManifest,
  };
}

function deriveRuntimeRoots(rawEnv: Record<string, string>): Pick<MainEnvPaths, "userDataRoot" | "runtimeRoot" | "logRoot" | "tmpRoot" | "stateRoot" | "cacheRoot"> {
  const userDataRoot = normalizePath(app.getPath("userData"));
  const runtimeRoot = ensureDir(rawEnv.ADJUTORIX_RUNTIME_ROOT || path.join(userDataRoot, "runtime"));
  ensureInside(userDataRoot, runtimeRoot, "runtime_root");

  const logRoot = ensureDir(path.join(runtimeRoot, "logs"));
  const tmpRoot = ensureDir(path.join(runtimeRoot, "tmp"));
  const stateRoot = ensureDir(path.join(runtimeRoot, "state"));
  const cacheRoot = ensureDir(path.join(runtimeRoot, "cache"));

  return {
    userDataRoot,
    runtimeRoot,
    logRoot,
    tmpRoot,
    stateRoot,
    cacheRoot,
  };
}

function buildFeatures(rawEnv: Record<string, string>, mode: AdjutorixMainMode): MainEnvFeatures {
  const smokeMode = parseBoolean(rawEnv.ADJUTORIX_SMOKE_MODE, false);
  const headless = parseBoolean(rawEnv.ADJUTORIX_SMOKE_HEADLESS, smokeMode);
  const devTools = parseBoolean(rawEnv.ADJUTORIX_DEVTOOLS, mode !== "production");
  const autoSpawnAgent = parseBoolean(rawEnv.ADJUTORIX_AGENT_AUTOSPAWN, true);
  const strictCsp = parseBoolean(rawEnv.ADJUTORIX_STRICT_CSP, true);
  const enableVerboseDiagnostics = parseBoolean(rawEnv.ADJUTORIX_VERBOSE_DIAGNOSTICS, mode !== "production");
  const allowExternalNavigation = parseBoolean(rawEnv.ADJUTORIX_ALLOW_EXTERNAL_NAVIGATION, false);

  return {
    smokeMode,
    headless,
    devTools,
    autoSpawnAgent,
    strictCsp,
    enableVerboseDiagnostics,
    allowExternalNavigation,
  };
}

function buildWindow(rawEnv: Record<string, string>): MainEnvWindow {
  const width = parseInteger(rawEnv.ADJUTORIX_WINDOW_WIDTH, DEFAULT_WINDOW_WIDTH, "window_width", 800, 8192);
  const height = parseInteger(rawEnv.ADJUTORIX_WINDOW_HEIGHT, DEFAULT_WINDOW_HEIGHT, "window_height", 600, 8192);
  const minWidth = parseInteger(rawEnv.ADJUTORIX_WINDOW_MIN_WIDTH, DEFAULT_WINDOW_MIN_WIDTH, "window_min_width", 640, 8192);
  const minHeight = parseInteger(rawEnv.ADJUTORIX_WINDOW_MIN_HEIGHT, DEFAULT_WINDOW_MIN_HEIGHT, "window_min_height", 480, 8192);
  const backgroundColor = parseHexColor(rawEnv.ADJUTORIX_BACKGROUND_COLOR, DEFAULT_BACKGROUND_COLOR);

  assert(minWidth <= width, "window_min_width_exceeds_width");
  assert(minHeight <= height, "window_min_height_exceeds_height");

  return {
    width,
    height,
    minWidth,
    minHeight,
    backgroundColor,
  };
}

function buildAgent(rawEnv: Record<string, string>): MainEnvAgent {
  const tokenFile = normalizePath(rawEnv.ADJUTORIX_TOKEN_FILE || path.join(os.homedir(), ".adjutorix", "token"));
  return {
    url: rawEnv.ADJUTORIX_AGENT_URL || DEFAULT_AGENT_URL,
    rpcTimeoutMs: parseInteger(rawEnv.ADJUTORIX_AGENT_RPC_TIMEOUT_MS, DEFAULT_AGENT_RPC_TIMEOUT_MS, "agent_rpc_timeout_ms", 500, 120_000),
    readyTimeoutMs: parseInteger(rawEnv.ADJUTORIX_AGENT_READY_TIMEOUT_MS, DEFAULT_AGENT_READY_TIMEOUT_MS, "agent_ready_timeout_ms", 500, 300_000),
    pollIntervalMs: parseInteger(rawEnv.ADJUTORIX_AGENT_POLL_INTERVAL_MS, DEFAULT_AGENT_POLL_INTERVAL_MS, "agent_poll_interval_ms", 25, 10_000),
    tokenFile,
  };
}

function buildBuildInfo(paths: MainEnvPaths, mode: AdjutorixMainMode): MainEnvBuild {
  return {
    packageVersion: readPackageVersion(paths.packageJson),
    nodeVersion: process.version,
    electronVersion: process.versions.electron,
    platform: process.platform,
    arch: process.arch,
    mode,
    isPackaged: app.isPackaged,
    rendererManifestSha256: fileSha256(paths.rendererManifest),
    rendererAssetManifestSha256: fileSha256(paths.rendererAssetManifest),
  };
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function loadMainEnvironment(env: NodeJS.ProcessEnv = process.env): MainEnvironment {
  const raw = filterRawEnv(env);
  const mode = parseMode(raw.NODE_ENV);

  const appRoots = deriveAppRoots();
  const runtimeRoots = deriveRuntimeRoots(raw);

  const paths: MainEnvPaths = {
    ...appRoots,
    ...runtimeRoots,
  };

  const features = buildFeatures(raw, mode);
  const agent = buildAgent(raw);
  const window = buildWindow(raw);
  const build = buildBuildInfo(paths, mode);

  const assembled = {
    build,
    paths,
    features,
    agent,
    window,
    raw,
  };

  const hash = sha256(stableJson(assembled));

  return {
    ...assembled,
    hash,
  };
}

export function summarizeMainEnvironment(environment: MainEnvironment): Record<string, unknown> {
  return {
    mode: environment.build.mode,
    version: environment.build.packageVersion,
    platform: environment.build.platform,
    arch: environment.build.arch,
    isPackaged: environment.build.isPackaged,
    rendererManifestSha256: environment.build.rendererManifestSha256,
    rendererAssetManifestSha256: environment.build.rendererAssetManifestSha256,
    runtimeRoot: environment.paths.runtimeRoot,
    agentUrl: environment.agent.url,
    smokeMode: environment.features.smokeMode,
    headless: environment.features.headless,
    hash: environment.hash,
  };
}

export function validateMainEnvironment(environment: MainEnvironment): void {
  ensureAbsoluteExistingFile(environment.paths.rendererIndex, "renderer_index");
  ensureAbsoluteExistingFile(environment.paths.preloadEntry, "preload_entry");
  ensureAbsoluteExistingFile(environment.paths.mainEntry, "main_entry");
  ensureAbsoluteExistingFile(environment.paths.rendererManifest, "renderer_manifest");
  ensureAbsoluteExistingFile(environment.paths.rendererAssetManifest, "renderer_asset_manifest");
  ensureAbsoluteExistingFile(environment.paths.packageJson, "package_json");

  assert(environment.build.rendererManifestSha256 === fileSha256(environment.paths.rendererManifest), "renderer_manifest_hash_drift");
  assert(environment.build.rendererAssetManifestSha256 === fileSha256(environment.paths.rendererAssetManifest), "renderer_asset_manifest_hash_drift");

  ensureInside(environment.paths.userDataRoot, environment.paths.runtimeRoot, "runtime_root");
  ensureInside(environment.paths.runtimeRoot, environment.paths.logRoot, "log_root");
  ensureInside(environment.paths.runtimeRoot, environment.paths.tmpRoot, "tmp_root");
  ensureInside(environment.paths.runtimeRoot, environment.paths.stateRoot, "state_root");
  ensureInside(environment.paths.runtimeRoot, environment.paths.cacheRoot, "cache_root");

  assert(environment.window.minWidth <= environment.window.width, "window_min_width_exceeds_width");
  assert(environment.window.minHeight <= environment.window.height, "window_min_height_exceeds_height");
  assert(/^#[0-9a-f]{6}$/.test(environment.window.backgroundColor), "background_color_invalid");

  const recomputedHash = sha256(
    stableJson({
      build: environment.build,
      paths: environment.paths,
      features: environment.features,
      agent: environment.agent,
      window: environment.window,
      raw: environment.raw,
    }),
  );
  assert(recomputedHash === environment.hash, "environment_hash_drift");
}

export function redactMainEnvironment(environment: MainEnvironment): MainEnvironment {
  const redacted: MainEnvironment = JSON.parse(JSON.stringify(environment)) as MainEnvironment;
  if (redacted.agent.tokenFile) {
    redacted.agent.tokenFile = path.basename(redacted.agent.tokenFile);
  }
  return redacted;
}

export function runtimeEnvForRenderer(environment: MainEnvironment): Record<string, string> {
  return {
    ADJUTORIX_AGENT_URL: environment.agent.url,
    ADJUTORIX_APP_VERSION: environment.build.packageVersion,
    ADJUTORIX_SMOKE_MODE: environment.features.smokeMode ? "1" : "0",
    ADJUTORIX_HEADLESS: environment.features.headless ? "1" : "0",
    ADJUTORIX_ENV_HASH: environment.hash,
  };
}
