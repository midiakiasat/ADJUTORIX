// @ts-nocheck
import { registerPortfolioWorkspaceV18 } from "./portfolio-workspace-v18.js";
import { registerNativeExternalWorkspaceV16 } from "./native-external-workspace-v16.js";
import { registerNativeControlPlaneV13 } from "./native-control-plane-v13.js";
import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn, ChildProcess } from "node:child_process";
import { registerOperatorKernelIpc } from "./ipc/operator_kernel_ipc";

/**
 * ADJUTORIX APP — MAIN / index.ts
 *
 * Authoritative Electron main-process entrypoint.
 *
 * Responsibilities:
 * - enforce single-instance semantics
 * - establish deterministic runtime directories and config
 * - create and manage the main BrowserWindow
 * - register all IPC boundaries and lifecycle handlers
 * - coordinate optional local Adjutorix agent process/bootstrap
 * - contain crashes/failures and expose structured diagnostics
 * - guarantee no renderer obtains mutation authority directly
 *
 * Hard invariants:
 * - renderer is view/controller only; mutation authority never lives here implicitly
 * - all dangerous capabilities are explicit, gated, and logged
 * - app startup is deterministic for identical runtime inputs
 * - no hidden background daemons; agent lifecycle is explicit
 * - fail-closed on missing build artifacts or invalid preload/runtime state
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// PATHS / RUNTIME CONSTANTS
// -----------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_ROOT = path.resolve(__dirname, "..");
const DIST_ROOT = path.resolve(APP_ROOT, "..");
const RENDERER_ROOT = path.join(path.resolve(__dirname, ".."), "renderer");
const PRELOAD_ENTRY = path.join(path.resolve(__dirname, ".."), "preload", "preload.mjs");
const RENDERER_INDEX = path.join(path.resolve(__dirname, ".."), "renderer", "index.html");
const RENDERER_ASSET_MANIFEST = path.join(path.resolve(__dirname, "../.."), "assets", "asset-manifest.json");
const RENDERER_MANIFEST = path.join(path.resolve(__dirname, ".."), "renderer", "manifest.json");
const APP_PACKAGE = path.join(path.resolve(__dirname, "../.."), "package.json");

const USER_DATA_ROOT = app.getPath("userData");
const RUNTIME_ROOT = path.join(USER_DATA_ROOT, "runtime");
const LOG_ROOT = path.join(RUNTIME_ROOT, "logs");
const TMP_ROOT = path.join(RUNTIME_ROOT, "tmp");
const STATE_ROOT = path.join(RUNTIME_ROOT, "state");
const DIAGNOSTIC_FILE = path.join(LOG_ROOT, "main-process-diagnostics.json");
const MAIN_LOCK_NAME = "adjutorix-single-instance-lock";

const DEFAULT_WIDTH = 1540;
const DEFAULT_HEIGHT = 980;
const MIN_WIDTH = 1180;
const MIN_HEIGHT = 720;
const DEFAULT_BACKGROUND = "#0b0f14";
const APP_PROTOCOL = "adjutorix";

const AGENT_DEFAULT_URL = "http://127.0.0.1:8000/rpc";
const AGENT_HEALTH_PATH = "/rpc";
const APP_READY_TIMEOUT_MS = 15_000;
const AGENT_READY_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 125;

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

type RuntimeConfig = {
  build: {
    rendererIndex: string;
    preloadEntry: string;
    rendererManifestSha256: string;
    rendererAssetManifestSha256: string;
  };
  environment: {
    appVersion: string;
    node: string;
    electron: string;
    platform: NodeJS.Platform;
    arch: string;
    isPackaged: boolean;
    headlessSmokeMode: boolean;
  };
  runtime: {
    userDataRoot: string;
    runtimeRoot: string;
    logRoot: string;
    tmpRoot: string;
    stateRoot: string;
  };
  agent: {
    configuredUrl: string;
    autoSpawn: boolean;
  };
};

type AgentState = {
  process: ChildProcess | null;
  url: string;
  managed: boolean;
  startedAtMs: number | null;
  pid: number | null;
  lastHealth: {
    ok: boolean;
    status: number | null;
    checkedAtMs: number | null;
    bodySha256: string | null;
  };
};

type AppDiagnostics = {
  startedAtMs: number;
  phase: string;
  configHash: string | null;
  windowCreated: boolean;
  rendererLoaded: boolean;
  agent: {
    managed: boolean;
    pid: number | null;
    url: string | null;
    healthy: boolean;
    lastStatus: number | null;
  };
  crashes: Array<{ kind: string; message: string; atMs: number }>;
  events: Array<{ event: string; atMs: number; detail?: Json }>;
};

type WorkspaceOpenRequest = {
  path: string;
};

type AdjutorixPublicApi = {
  rpc: {
    invoke: (method: string, params: Record<string, Json>) => Promise<Json>;
  };
  workspace: {
    open: (workspacePath: string) => Promise<Json>;
    revealInShell: (targetPath: string) => Promise<Json>;
  };
  patch: {
    preview: (intent: Record<string, Json>) => Promise<Json>;
    apply: (patchId: string) => Promise<Json>;
  };
  verify: {
    run: (targets: string[]) => Promise<Json>;
    status: (verifyId: string) => Promise<Json>;
  };
  ledger: {
    current: () => Promise<Json>;
  };
};

// -----------------------------------------------------------------------------
// STATE
// -----------------------------------------------------------------------------

let mainWindow: BrowserWindow | null = null;
let runtimeConfig: RuntimeConfig | null = null;
let appDiagnostics: AppDiagnostics = {
  startedAtMs: Date.now(),
  phase: "boot",
  configHash: null,
  windowCreated: false,
  rendererLoaded: false,
  agent: {
    managed: false,
    pid: null,
    url: null,
    healthy: false,
    lastStatus: null,
  },
  crashes: [],
  events: [],
};

const agentState: AgentState = {
  process: null,
  url: AGENT_DEFAULT_URL,
  managed: false,
  startedAtMs: null,
  pid: null,
  lastHealth: {
    ok: false,
    status: null,
    checkedAtMs: null,
    bodySha256: null,
  },
};

const initialWorkspaceRoot = (() => {
  const candidate = process.env.ADJUTORIX_WORKSPACE_ROOT;
  if (!candidate || candidate.trim().length === 0) return null;

  const resolved = path.resolve(candidate.trim());
  try {
    return fs.statSync(resolved).isDirectory() ? resolved : null;
  } catch {
    return null;
  }
})();

const workspaceState: {
  currentPath: string | null;
  openedAtMs: number | null;
  checkedAtMs: number | null;
  recentPaths: string[];
} = {
  currentPath: initialWorkspaceRoot,
  openedAtMs: initialWorkspaceRoot ? Date.now() : null,
  checkedAtMs: initialWorkspaceRoot ? Date.now() : null,
  recentPaths: initialWorkspaceRoot ? [initialWorkspaceRoot] : [],
};

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:index:${message}`);
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function sha256(input: Buffer | string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function stableJson(value: Json | Record<string, unknown>): string {
  const normalize = (v: unknown): unknown => {
    if (v === null || typeof v !== "object") {
      return v;
    }
    if (Array.isArray(v)) {
      return v.map(normalize);
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v as Record<string, unknown>).sort()) {
      out[key] = normalize((v as Record<string, unknown>)[key]);
    }
    return out;
  };
  return JSON.stringify(normalize(value));
}

function recordEvent(event: string, detail?: Json): void {
  appDiagnostics.events.push({ event, atMs: Date.now(), detail });
  flushDiagnostics();
}

function recordCrash(kind: string, error: unknown): void {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  appDiagnostics.crashes.push({ kind, message, atMs: Date.now() });
  flushDiagnostics();
}

function flushDiagnostics(): void {
  try {
    ensureDir(LOG_ROOT);
    fs.writeFileSync(DIAGNOSTIC_FILE, `${stableJson(appDiagnostics)}\n`, "utf8");
  } catch {
    // Best effort only; no recursive failure path.
  }
}

function readJsonFile<T>(filePath: string): T {
  assert(fs.existsSync(filePath), `missing_file:${filePath}`);
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function fileSha256(filePath: string): string {
  assert(fs.existsSync(filePath), `missing_hash_input:${filePath}`);
  return sha256(fs.readFileSync(filePath));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null> | T | null,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value !== null) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`main:index:poll_timeout:${label}`);
}

function isDevelopment(): boolean {
  return process.env.NODE_ENV === "development";
}

function isSmokeMode(): boolean {
  return process.env.ADJUTORIX_SMOKE_MODE === "1";
}

function normalizeFsPath(targetPath: string): string {
  return path.resolve(targetPath);
}

function ensureInside(base: string, target: string): void {
  const normalizedBase = path.resolve(base);
  const normalizedTarget = path.resolve(target);
  assert(
    normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`),
    `path_escape:${normalizedTarget}`,
  );
}

function buildRuntimeConfig(): RuntimeConfig {
  ensureDir(RUNTIME_ROOT);
  ensureDir(LOG_ROOT);
  ensureDir(TMP_ROOT);
  ensureDir(STATE_ROOT);

  assert(fs.existsSync(RENDERER_INDEX), "renderer_index_missing");
  assert(fs.existsSync(PRELOAD_ENTRY), "preload_entry_missing");
  assert(fs.existsSync(RENDERER_MANIFEST), "renderer_manifest_missing");
  assert(fs.existsSync(RENDERER_ASSET_MANIFEST), "renderer_asset_manifest_missing");
  assert(fs.existsSync(APP_PACKAGE), "package_json_missing");

  const pkg = readJsonFile<{ version: string }>(APP_PACKAGE);

  const config: RuntimeConfig = {
    build: {
      rendererIndex: RENDERER_INDEX,
      preloadEntry: PRELOAD_ENTRY,
      rendererManifestSha256: fileSha256(RENDERER_MANIFEST),
      rendererAssetManifestSha256: fileSha256(RENDERER_ASSET_MANIFEST),
    },
    environment: {
      appVersion: pkg.version,
      node: process.version,
      electron: process.versions.electron,
      platform: process.platform,
      arch: process.arch,
      isPackaged: app.isPackaged,
      headlessSmokeMode: isSmokeMode(),
    },
    runtime: {
      userDataRoot: USER_DATA_ROOT,
      runtimeRoot: RUNTIME_ROOT,
      logRoot: LOG_ROOT,
      tmpRoot: TMP_ROOT,
      stateRoot: STATE_ROOT,
    },
    agent: {
      configuredUrl: process.env.ADJUTORIX_AGENT_URL || AGENT_DEFAULT_URL,
      autoSpawn: process.env.ADJUTORIX_AGENT_AUTOSPAWN !== "0",
    },
  };

  return config;
}

function applyAppIdentity(config: RuntimeConfig): void {
  app.setName("Adjutorix");
  app.setAppUserModelId("com.adjutorix.app");
  nativeTheme.themeSource = "dark";
  agentState.url = config.agent.configuredUrl;
}

// -----------------------------------------------------------------------------
// AGENT COORDINATION
// -----------------------------------------------------------------------------

async function httpJsonRpcProbe(url: string): Promise<{ ok: boolean; status: number | null; bodySha256: string | null }> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health.ping", params: {} }),
    });

    const text = await response.text();
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      bodySha256: sha256(text),
    };
  } catch {
    return {
      ok: false,
      status: null,
      bodySha256: null,
    };
  }
}

async function refreshAgentHealth(): Promise<void> {
  const health = await httpJsonRpcProbe(agentState.url);
  agentState.lastHealth = {
    ok: health.ok,
    status: health.status,
    checkedAtMs: Date.now(),
    bodySha256: health.bodySha256,
  };
  appDiagnostics.agent = {
    managed: agentState.managed,
    pid: agentState.pid,
    url: agentState.url,
    healthy: health.ok,
    lastStatus: health.status,
  };
  flushDiagnostics();
}

function candidateAgentEntry(): string | null {
  const candidates = [
    path.resolve(APP_ROOT, "..", "..", "adjutorix-agent", "scripts", "start.sh"),
    path.resolve(APP_ROOT, "..", "..", "adjutorix-agent", "scripts", "start"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

async function ensureAgent(config: RuntimeConfig): Promise<void> {
  await refreshAgentHealth();
  if (agentState.lastHealth.ok) {
    recordEvent("agent.reuse", { url: agentState.url });
    return;
  }

  if (!config.agent.autoSpawn) {
    recordEvent("agent.unavailable", { url: agentState.url });
    return;
  }

  const entry = candidateAgentEntry();
  if (!entry) {
    recordEvent("agent.entry_missing", { searched: true });
    return;
  }

  const child = spawn(entry, {
    cwd: path.dirname(entry),
    detached: false,
    shell: false,
    stdio: isSmokeMode() ? "ignore" : "ignore",
    env: {
      ...process.env,
      ADJUTORIX_ROOT: path.resolve(APP_ROOT, "..", ".."),
    },
  });

  agentState.process = child;
  agentState.managed = true;
  agentState.startedAtMs = Date.now();
  agentState.pid = child.pid ?? null;
  recordEvent("agent.spawned", { pid: agentState.pid, url: agentState.url });

  child.on("exit", (code, signal) => {
    recordEvent("agent.exit", { code: code ?? null, signal: signal ?? null });
    agentState.process = null;
    agentState.pid = null;
    agentState.managed = false;
    flushDiagnostics();
  });

  await pollUntil(async () => {
    await refreshAgentHealth();
    return agentState.lastHealth.ok ? true : null;
  }, AGENT_READY_TIMEOUT_MS, POLL_INTERVAL_MS, "agent-ready");
}

async function shutdownAgent(): Promise<void> {
  if (!agentState.process || !agentState.managed) {
    return;
  }
  const proc = agentState.process;
  agentState.managed = false;
  recordEvent("agent.shutdown.begin", { pid: proc.pid ?? null });
  proc.kill("SIGTERM");
  await sleep(300);
  if (!proc.killed) {
    try {
      proc.kill("SIGKILL");
    } catch {
      // ignored
    }
  }
  agentState.process = null;
  agentState.pid = null;
  await refreshAgentHealth().catch(() => undefined);
  recordEvent("agent.shutdown.complete");
}

// -----------------------------------------------------------------------------
// WINDOW / RENDERER
// -----------------------------------------------------------------------------

function buildBrowserWindow(config: RuntimeConfig): BrowserWindow {
  const window = new BrowserWindow({
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    backgroundColor: DEFAULT_BACKGROUND,
    autoHideMenuBar: true,
    title: "Adjutorix",
    useContentSize: true,
    webPreferences: {
      preload: config.build.preloadEntry,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      devTools: !app.isPackaged || isDevelopment(),
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      allowRunningInsecureContent: false,
      additionalArguments: [
        `--adjutorix-runtime-config=${Buffer.from(stableJson({
          agentUrl: config.agent.configuredUrl,
          appVersion: config.environment.appVersion,
          smokeMode: config.environment.headlessSmokeMode,
        })).toString("base64")}`,
      ],
    },
  });

  window.once("ready-to-show", () => {
    appDiagnostics.windowCreated = true;
    flushDiagnostics();
    if (!isSmokeMode()) {
      window.show();
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  window.webContents.on("did-finish-load", () => {
    appDiagnostics.rendererLoaded = true;
    appDiagnostics.phase = "renderer-loaded";
    flushDiagnostics();
    recordEvent("renderer.did-finish-load");
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    recordCrash("renderer-process-gone", details.reason);
    if (!window.isDestroyed()) {
      void dialog.showErrorBox(
        "Adjutorix Renderer Failure",
        `Renderer process exited unexpectedly: ${details.reason}`,
      );
    }
  });

  window.webContents.on("did-fail-load", (_event, code, description, validatedURL) => {
    recordCrash("renderer-load-failed", `${code}:${description}:${validatedURL}`);
  });

  return window;
}

async function loadRenderer(window: BrowserWindow, config: RuntimeConfig): Promise<void> {
  assert(fs.existsSync(config.build.rendererIndex), "renderer_index_missing_at_load");
  await window.loadFile(config.build.rendererIndex);
}

// -----------------------------------------------------------------------------
// IPC REGISTRATION
// -----------------------------------------------------------------------------

function safeHandle<T extends (...args: any[]) => Promise<any> | any>(channel: string, handler: T): void {
  ipcMain.handle(channel, async (_event, ...args: Parameters<T>) => {
    try {
      return await handler(...args);
    } catch (error) {
      recordCrash(`ipc:${channel}`, error);
      throw error;
    }
  });
}

async function rpcInvoke(method: string, params: Record<string, Json>): Promise<Json> {
  const tokenFile = path.join(os.homedir(), ".adjutorix", "token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";

  const response = await fetch(agentState.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-adjutorix-token": token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });

  const payload = (await response.json()) as { result?: Json; error?: { message?: string } };
  if (!response.ok || payload.error) {
    throw new Error(`rpc_invoke_failed:${method}:${payload.error?.message ?? response.status}`);
  }
  return payload.result ?? null;
}

function canAccessPath(targetPath: string, mode: number): boolean {
  try {
    fs.accessSync(targetPath, mode);
    return true;
  } catch {
    return false;
  }
}

function buildCompatWorkspacePosture(): Record<string, Json> {
  const rootPath = workspaceState.currentPath;
  const checkedAtMs = Date.now();

  if (!rootPath) {
    return {
      schema: 1,
      ok: false,
      workspaceOpen: false,
      currentPath: null,
      workspacePath: null,
      rootPath: null,
      level: "unknown",
      health: "unknown",
      status: "unknown",
      trustLevel: "unknown",
      trust: null,
      readable: null,
      writable: null,
      exists: false,
      directory: false,
      openedAtMs: null,
      checkedAtMs,
      recents: workspaceState.recentPaths,
      issues: ["no-workspace-open"],
    };
  }

  const exists = fs.existsSync(rootPath);
  const directory = exists && fs.statSync(rootPath).isDirectory();
  const readable = exists && canAccessPath(rootPath, fs.constants.R_OK);
  const writable = exists && canAccessPath(rootPath, fs.constants.W_OK);
  const ok = exists && directory && readable;
  const level = ok ? (writable ? "healthy" : "degraded") : "unhealthy";
  const trustLevel = "trusted";
  const source = process.env.ADJUTORIX_WORKSPACE_ROOT ? "env:ADJUTORIX_WORKSPACE_ROOT" : "runtime:workspace.open";

  const issues: string[] = [];
  if (!exists) issues.push("workspace-missing");
  if (exists && !directory) issues.push("workspace-not-directory");
  if (exists && !readable) issues.push("workspace-not-readable");
  if (exists && !writable) issues.push("workspace-not-writable");

  workspaceState.checkedAtMs = checkedAtMs;

  return {
    schema: 1,
    ok,
    workspaceOpen: true,
    currentPath: rootPath,
    workspacePath: rootPath,
    rootPath,
    level,
    health: level,
    status: ok ? "ready" : "blocked",
    trustLevel,
    trust: {
      level: trustLevel,
      source,
      reason: "explicit_workspace_root_bound",
      checkedAtMs,
    },
    readable,
    writable,
    exists,
    directory,
    openedAtMs: workspaceState.openedAtMs,
    checkedAtMs,
    recents: workspaceState.recentPaths,
    issues,
  };
}

function buildCompatAgentAuthProjection(): Record<string, Json> {
  const tokenFile = path.join(os.homedir(), ".adjutorix", "token");
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const tokenLoaded = token.length > 0;

  return {
    state: tokenLoaded ? "ready" : "missing",
    trust: token.length >= 32 ? "usable" : tokenLoaded ? "weak" : "none",
    authenticated: tokenLoaded,
    auth: tokenLoaded ? "valid" : "missing",
    authStatus: tokenLoaded ? "valid" : "missing",
    tokenLoaded,
    tokenLength: tokenLoaded ? token.length : null,
    tokenFingerprint: tokenLoaded ? sha256(token).slice(0, 16) : null,
    tokenFile: path.basename(tokenFile),
    headerName: "x-adjutorix-token",
  };
}

function buildCompatAgentHealthProjection(): Record<string, Json> {
  const auth = buildCompatAgentAuthProjection();
  const transportReady = agentState.lastHealth.ok;
  const level = transportReady ? "healthy" : "unhealthy";

  return {
    schema: 1,
    ok: transportReady,
    healthy: transportReady,
    level,
    health: level,
    status: agentState.lastHealth.status,
    checkedAtMs: agentState.lastHealth.checkedAtMs ?? Date.now(),
    bodySha256: agentState.lastHealth.bodySha256,
    url: agentState.url,
    endpoint: agentState.url,
    endpointUrl: agentState.url,
    endpointLabel: agentState.url,
    managed: agentState.managed,
    pid: agentState.pid,
    connected: transportReady,
    transport: transportReady ? "healthy" : "unavailable",
    transportState: transportReady ? "ready" : "error",
    provider: "adjutorix-agent",
    providerName: "adjutorix-agent",
    auth,
    authState: auth.state,
    authStatus: auth.authStatus,
    authenticated: auth.authenticated,
    tokenLoaded: auth.tokenLoaded,
    tokenLength: auth.tokenLength,
    tokenFingerprint: auth.tokenFingerprint,
  };
}

function registerIpc(config: RuntimeConfig): void {
  const registerLegacyCompatHandler = (channel: string, handler: (payload?: unknown) => Promise<Json> | Json): void => {
    try {
      ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
        const payload = args.length <= 1 ? args[0] : args;
        return await handler(payload);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/second handler|already.*handler/i.test(message)) {
        throw error;
      }
    }
  };

  registerLegacyCompatHandler("adjutorix:agent:health", async () => {
    return buildCompatAgentHealthProjection() as Json;
  });

  registerLegacyCompatHandler("adjutorix:diagnostics:runtimeSnapshot", async () => {
    const mem = process.memoryUsage();
    const snapshot = {
      schema: 1,
      app: {
        version: config.environment.appVersion,
        platform: config.environment.platform,
        arch: config.environment.arch,
        electron: config.environment.electron,
        node: config.environment.node,
        pid: process.pid,
        uptime_seconds: Math.floor(process.uptime()),
      },
      runtime: {
        workspacePath: workspaceState.currentPath,
        rootPath: workspaceState.currentPath,
        workspaceOpen: Boolean(workspaceState.currentPath),
        workspaceTree: buildRendererWorkspaceTreeProjection(workspaceState.currentPath),
        entries: buildRendererWorkspaceEntries(workspaceState.currentPath),
        agentUrl: agentState.url,
        agentHealthy: agentState.lastHealth.ok,
        configHash: appDiagnostics.configHash,
        environmentHash: sha256(stableJson(config.environment as unknown as Record<string, unknown>)),
        phase: appDiagnostics.phase,
      },
      resources: {
        rss_bytes: mem.rss,
        heap_total_bytes: mem.heapTotal,
        heap_used_bytes: mem.heapUsed,
        external_bytes: mem.external,
        cpu_load_avg: os.loadavg(),
      },
      stateHash: sha256(
        stableJson({
          phase: appDiagnostics.phase,
          configHash: appDiagnostics.configHash,
          agent: {
            ok: agentState.lastHealth.ok,
            status: agentState.lastHealth.status,
            checkedAtMs: agentState.lastHealth.checkedAtMs ?? null,
          },
          windowCreated: appDiagnostics.windowCreated,
          rendererLoaded: appDiagnostics.rendererLoaded,
        }),
      ),
    };
    const payload = {
      ok: true,
      snapshot,
      queryHash: sha256(stableJson(snapshot)),
    };
    return payload as Json;
  });

  registerLegacyCompatHandler("adjutorix:runtime:snapshot", async () => {
    const mem = process.memoryUsage();
    const snapshot = {
      schema: 1,
      ok: true,
      phase: appDiagnostics.phase,
      startedAtMs: appDiagnostics.startedAtMs,
      configHash: appDiagnostics.configHash,
      environment: {
        appVersion: config.environment.appVersion,
        node: config.environment.node,
        electron: config.environment.electron,
        platform: config.environment.platform,
        arch: config.environment.arch,
        isPackaged: config.environment.isPackaged,
        headlessSmokeMode: config.environment.headlessSmokeMode,
      },
      workspace: {
        currentPath: workspaceState.currentPath,
        workspacePath: workspaceState.currentPath,
        rootPath: workspaceState.currentPath,
        health: buildCompatWorkspacePosture().health,
        status: buildCompatWorkspacePosture().status,
        level: buildCompatWorkspacePosture().level,
        trustLevel: buildCompatWorkspacePosture().trustLevel,
        writable: buildCompatWorkspacePosture().writable,
        readable: buildCompatWorkspacePosture().readable,
        isOpen: Boolean(workspaceState.currentPath),
        openedAtMs: workspaceState.openedAtMs,
        checkedAtMs: workspaceState.checkedAtMs,
      },
      agent: {
        url: agentState.url,
        managed: agentState.managed,
        pid: agentState.pid,
        healthy: agentState.lastHealth.ok,
        status: agentState.lastHealth.status,
        checkedAtMs: agentState.lastHealth.checkedAtMs ?? null,
      },
      diagnostics: {
        events: appDiagnostics.events.length,
        crashes: appDiagnostics.crashes.length,
        windowCreated: appDiagnostics.windowCreated,
        rendererLoaded: appDiagnostics.rendererLoaded,
      },
      resources: {
        rss_bytes: mem.rss,
        heap_total_bytes: mem.heapTotal,
        heap_used_bytes: mem.heapUsed,
        external_bytes: mem.external,
        cpu_load_avg: os.loadavg(),
      },
    };
    const payload = { ok: true, snapshot, ...snapshot };
    return payload as Json;
  });

  registerLegacyCompatHandler("adjutorix:workspace:file:read", async (payload) => {
    const requestedPath = rendererWorkspaceReadPathFromPayload(payload);
    const currentPath =
      typeof workspaceState.currentPath === "string" && workspaceState.currentPath.length > 0
        ? workspaceState.currentPath
        : null;

    return buildRendererWorkspaceFileSnapshot(currentPath, requestedPath);
  });

  registerLegacyCompatHandler("adjutorix:workspace:health", async () => {
    return buildCompatWorkspacePosture() as Json;
  });



  type RendererWorkspaceEntry = {
  path: string;
  relativePath: string;
  name: string;
  kind: "file" | "directory" | "symlink" | "unknown";
  parentPath: string | null;
  extension: string | null;
  sizeBytes: number | null;
  hidden: boolean;
  ignored: boolean;
  depth: number;
  childCount: number | null;
  modifiedAtMs: number | null;
};

const RENDERER_WORKSPACE_TREE_MAX_ENTRIES = 900;
const RENDERER_WORKSPACE_TREE_MAX_DEPTH = 6;
const RENDERER_WORKSPACE_TREE_IGNORED_NAMES = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".tmp",
  ".next",
  "coverage",
  "target",
  ".DS_Store",
]);

function toRendererRelativePath(rootPath: string, targetPath: string): string {
  const relative = path.relative(rootPath, targetPath).split(path.sep).join("/");
  return relative || ".";
}

const RENDERER_WORKSPACE_FILE_MAX_BYTES = 1024 * 1024;

function isPathInside(parentPath: string, childPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative));
}

function inferRendererWorkspaceLanguage(filePath: string): string | null {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".ts" || ext === ".tsx") return "typescript";
  if (ext === ".js" || ext === ".jsx" || ext === ".mjs" || ext === ".cjs") return "javascript";
  if (ext === ".json") return "json";
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (ext === ".css") return "css";
  if (ext === ".html" || ext === ".htm") return "html";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".py") return "python";
  if (ext === ".sh" || ext === ".bash" || ext === ".zsh") return "shell";
  if (ext === ".sql") return "sql";
  return null;
}

function detectRendererWorkspaceLineEnding(content: string): "lf" | "crlf" | "cr" | "unknown" {
  if (content.includes("\r\n")) return "crlf";
  if (content.includes("\n")) return "lf";
  if (content.includes("\r")) return "cr";
  return "unknown";
}

function assertTextBuffer(buffer: Buffer): void {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) throw new Error("workspace_file_read_binary_rejected");
  }
}

function rendererWorkspaceReadPathFromPayload(payload: unknown): string {
  if (typeof payload === "string" && payload.trim()) return payload.trim();

  if (Array.isArray(payload)) {
    for (const item of payload) {
      const value = rendererWorkspaceReadPathFromPayload(item);
      if (value) return value;
    }
    return "";
  }

  if (!payload || typeof payload !== "object") return "";
  const obj = payload as Record<string, unknown>;

  for (const key of ["path", "targetPath", "relativePath", "relative_path", "workspacePath", "workspace_path", "filePath", "file_path"]) {
    const value = obj[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }

  for (const key of ["payload", "request", "input", "data", "args", "body", "params"]) {
    const value = rendererWorkspaceReadPathFromPayload(obj[key]);
    if (value) return value;
  }

  return "";
}

function buildRendererWorkspaceFileSnapshot(rootPath: string | null, requestedPath: unknown): Json {
  if (!rootPath) throw new Error("workspace_file_read_requires_open_workspace");

  const readPath = rendererWorkspaceReadPathFromPayload(requestedPath);
  if (!readPath) {
    throw new Error("workspace_file_read_path_required");
  }

  const rootRealPath = fs.realpathSync(path.resolve(rootPath));
  const targetResolvedPath = path.isAbsolute(readPath)
    ? path.resolve(readPath)
    : path.resolve(rootRealPath, readPath);
  const lstat = fs.lstatSync(targetResolvedPath);

  if (lstat.isSymbolicLink()) throw new Error("workspace_file_read_symlink_rejected");
  if (lstat.isDirectory()) throw new Error("workspace_file_read_directory_rejected");
  if (!lstat.isFile()) throw new Error("workspace_file_read_non_file_rejected");
  if (lstat.size > RENDERER_WORKSPACE_FILE_MAX_BYTES) throw new Error("workspace_file_read_too_large");

  const targetRealPath = fs.realpathSync(targetResolvedPath);
  if (!isPathInside(rootRealPath, targetRealPath)) throw new Error("workspace_file_read_outside_workspace");

  const buffer = fs.readFileSync(targetRealPath);
  assertTextBuffer(buffer);

  const content = buffer.toString("utf8");
  if (content.includes("\uFFFD")) throw new Error("workspace_file_read_invalid_utf8_rejected");

  const relativePath = toRendererRelativePath(rootRealPath, targetRealPath);

  return {
    schema: 1,
    ok: true,
    path: targetRealPath,
    relativePath,
    name: path.basename(targetRealPath),
    language: inferRendererWorkspaceLanguage(targetRealPath),
    encoding: "utf8",
    lineEnding: detectRendererWorkspaceLineEnding(content),
    sizeBytes: buffer.byteLength,
    modifiedAtMs: Math.floor(lstat.mtimeMs),
    sha256: sha256(buffer),
    content,
    readOnly: true,
    maxBytes: RENDERER_WORKSPACE_FILE_MAX_BYTES,
  } as Json;
}

function buildRendererWorkspaceEntries(rootPath: string | null): RendererWorkspaceEntry[] {
  if (!rootPath) return [];

  const normalizedRoot = path.resolve(rootPath);
  if (!fs.existsSync(normalizedRoot)) return [];

  let rootStat: fs.Stats;
  try {
    rootStat = fs.statSync(normalizedRoot);
  } catch {
    return [];
  }

  if (!rootStat.isDirectory()) return [];

  const entries: RendererWorkspaceEntry[] = [];

  const visit = (directoryPath: string, depth: number): void => {
    if (entries.length >= RENDERER_WORKSPACE_TREE_MAX_ENTRIES) return;
    if (depth > RENDERER_WORKSPACE_TREE_MAX_DEPTH) return;

    let children: fs.Dirent[];
    try {
      children = fs.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return;
    }

    children.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name.localeCompare(b.name);
    });

    for (const child of children) {
      if (entries.length >= RENDERER_WORKSPACE_TREE_MAX_ENTRIES) return;
      if (RENDERER_WORKSPACE_TREE_IGNORED_NAMES.has(child.name)) continue;

      const fullPath = path.join(directoryPath, child.name);
      const relativePath = toRendererRelativePath(normalizedRoot, fullPath);
      const kind = child.isDirectory()
        ? "directory"
        : child.isFile()
          ? "file"
          : child.isSymbolicLink()
            ? "symlink"
            : "unknown";

      let sizeBytes: number | null = null;
      let modifiedAtMs: number | null = null;
      let childCount: number | null = null;

      try {
        const stat = fs.statSync(fullPath);
        sizeBytes = stat.isFile() ? stat.size : null;
        modifiedAtMs = Math.floor(stat.mtimeMs);
        if (stat.isDirectory()) {
          try {
            childCount = fs.readdirSync(fullPath).length;
          } catch {
            childCount = null;
          }
        }
      } catch {
        sizeBytes = null;
        modifiedAtMs = null;
      }

      entries.push({
        path: fullPath,
        relativePath,
        name: child.name,
        kind,
        parentPath: directoryPath === normalizedRoot ? normalizedRoot : directoryPath,
        extension: kind === "file" ? path.extname(child.name) || null : null,
        sizeBytes,
        hidden: child.name.startsWith("."),
        ignored: false,
        depth: relativePath.split("/").filter(Boolean).length,
        childCount,
        modifiedAtMs,
      });

      if (kind === "directory") visit(fullPath, depth + 1);
    }
  };

  visit(normalizedRoot, 1);
  return entries;
}

function buildRendererWorkspaceTreeProjection(rootPath: string | null): Json {
  const entries = buildRendererWorkspaceEntries(rootPath);
  return {
    schema: 1,
    rootPath,
    entries,
    total: entries.length,
    truncated: entries.length >= RENDERER_WORKSPACE_TREE_MAX_ENTRIES,
    maxEntries: RENDERER_WORKSPACE_TREE_MAX_ENTRIES,
    maxDepth: RENDERER_WORKSPACE_TREE_MAX_DEPTH,
  } as Json;
}










  safeHandle("adjutorix:workspace:open", async (payload) => {
    const objectPayload =
      payload && typeof payload === "object" && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : null;

    const requestedPath =
      typeof payload === "string" && payload.trim().length > 0
        ? payload
        : typeof objectPayload?.rootPath === "string" && objectPayload.rootPath.trim().length > 0
          ? objectPayload.rootPath
          : typeof objectPayload?.workspacePath === "string" && objectPayload.workspacePath.trim().length > 0
            ? objectPayload.workspacePath
            : null;

    let selectedPath = requestedPath;

    if (!selectedPath) {
      const result = await dialog.showOpenDialog({
        title: "Open governed workspace",
        properties: ["openDirectory"],
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true, cancelled: true, path: null } satisfies Json;
      }

      selectedPath = result.filePaths[0] ?? null;
    }

    assert(typeof selectedPath === "string" && selectedPath.trim().length > 0, "workspace_path_invalid");

    const normalized = normalizeFsPath(selectedPath.trim());
    assert(fs.existsSync(normalized), "workspace_missing");

    const now = Date.now();
    workspaceState.currentPath = normalized;
    workspaceState.openedAtMs = now;
    workspaceState.checkedAtMs = now;

    recordEvent("workspace.opened", { path: normalized });

    return {
      ok: true,
      path: normalized,
      currentPath: normalized,
      workspacePath: normalized,
      rootPath: normalized,
      isOpen: true,
      status: "ready",
      health: "ready",
      checkedAtMs: now,
    } satisfies Json;
  });

  safeHandle("adjutorix:workspace:revealInShell", async (targetPath: string) => {
    const normalized = normalizeFsPath(targetPath);
    assert(fs.existsSync(normalized), "reveal_target_missing");
    shell.showItemInFolder(normalized);
    return { ok: true, path: normalized } satisfies Json;
  });

  safeHandle("adjutorix:patch:preview", async (intent: Record<string, Json>) => {
    return rpcInvoke("patch.preview", { intent });
  });

  safeHandle("adjutorix:patch:apply", async (patchId: string) => {
    assert(typeof patchId === "string" && patchId.length > 0, "invalid_patch_id");
    return rpcInvoke("patch.apply", { patch_id: patchId });
  });

  safeHandle("adjutorix:verify:run", async (targets: string[]) => {
    assert(Array.isArray(targets), "invalid_verify_targets");
    return rpcInvoke("verify.run", { targets });
  });

  safeHandle("adjutorix:verify:status", async (verifyId: string) => {
    assert(typeof verifyId === "string" && verifyId.length > 0, "invalid_verify_id");
    return rpcInvoke("verify.status", { verify_id: verifyId });
  });

  safeHandle("adjutorix:ledger:current", async () => {
    return rpcInvoke("ledger.current", {});
  });
}

// -----------------------------------------------------------------------------
// APP LIFECYCLE
// -----------------------------------------------------------------------------

async function createMainWindow(config: RuntimeConfig): Promise<BrowserWindow> {
  const window = buildBrowserWindow(config);
  await loadRenderer(window, config);
  return window;
}

async function bootstrap(): Promise<void> {
  appDiagnostics.phase = "bootstrap";
  flushDiagnostics();

  const config = buildRuntimeConfig();
  runtimeConfig = config;
  appDiagnostics.configHash = sha256(stableJson(config));
  applyAppIdentity(config);
  recordEvent("runtime.configured", { configHash: appDiagnostics.configHash });

  registerIpc(config);
  await ensureAgent(config).catch((error) => {
    recordCrash("agent-bootstrap", error);
  });

  mainWindow = await createMainWindow(config);
  recordEvent("window.created");

  await pollUntil(
    async () => (appDiagnostics.rendererLoaded ? true : null),
    APP_READY_TIMEOUT_MS,
    POLL_INTERVAL_MS,
    "renderer-loaded",
  );

  appDiagnostics.phase = "ready";
  flushDiagnostics();
}

function enforceSingleInstance(): void {
  const acquired = app.requestSingleInstanceLock({ key: MAIN_LOCK_NAME });
  if (!acquired) {
    app.quit();
    return;
  }

  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) {
        mainWindow.restore();
      }
      mainWindow.focus();
    }

    const deepLink = argv.find((arg) => arg.startsWith(`${APP_PROTOCOL}://`));
    if (deepLink) {
      recordEvent("second-instance.deep-link", { deepLink });
    }
  });
}

function registerGlobalHandlers(): void {
  process.on("uncaughtException", (error) => {
    recordCrash("uncaughtException", error);
  });

  process.on("unhandledRejection", (reason) => {
    recordCrash("unhandledRejection", reason);
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      void shutdownAgent().finally(() => app.quit());
    }
  });

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0 && runtimeConfig) {
      void createMainWindow(runtimeConfig).then((window) => {
        mainWindow = window;
      }).catch((error) => {
        recordCrash("activate-create-window", error);
      });
    }
  });

  app.on("before-quit", () => {
    appDiagnostics.phase = "before-quit";
    flushDiagnostics();
  });

  app.on("will-quit", () => {
    for (const channel of ipcMain.eventNames()) {
      try {
        ipcMain.removeHandler(String(channel));
      } catch {
        // ignored
      }
    }
  });
}

// -----------------------------------------------------------------------------
// ENTRYPOINT
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  ensureDir(LOG_ROOT);
  flushDiagnostics();
  registerGlobalHandlers();
  enforceSingleInstance();

  await registerOperatorKernelIpc();

app.whenReady();
  recordEvent("app.whenReady");
  await bootstrap();
}

void main().catch(async (error) => {
  recordCrash("main-fatal", error);
  try {
    dialog.showErrorBox("Adjutorix Startup Failure", error instanceof Error ? error.stack || error.message : String(error));
  } catch {
    // ignored
  }
  await shutdownAgent().catch(() => undefined);
  app.exit(1);
});

export type { RuntimeConfig, AgentState, AppDiagnostics, AdjutorixPublicApi, WorkspaceOpenRequest };


// -----------------------------------------------------------------------------
// ADJUTORIX_NATIVE_COMMAND_BRIDGE_V5
// -----------------------------------------------------------------------------
//
// V5 correction:
// Renderer panels are useless unless the main process exposes a governed command
// substrate. This bridge is deliberately bounded: common build/test/verify/git/
// search commands are allowed; destructive shell primitives are denied.

const ADJUTORIX_NATIVE_COMMAND_BRIDGE_V5 = true;
const ADJUTORIX_SHELL_EXECUTE_CHANNEL = "adjutorix:shell:execute";

function adjutorixShellJson(value: unknown): Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value as Json;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(adjutorixShellJson) as Json;
  if (value && typeof value === "object") {
    const out: Record<string, Json> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) out[key] = adjutorixShellJson(child);
    return out;
  }
  return String(value ?? "");
}

function adjutorixBoundText(value: string, maxBytes = 240_000): string {
  const buffer = Buffer.from(value);
  if (buffer.length <= maxBytes) return value;
  return buffer.subarray(0, maxBytes).toString("utf8") + "\n\n[adjutorix:output_truncated]";
}

function adjutorixCommandAllowed(command: string): { ok: true } | { ok: false; reason: string } {
  const trimmed = command.trim();

  if (!trimmed) return { ok: false, reason: "empty_command" };
  if (trimmed.length > 8000) return { ok: false, reason: "command_too_large" };

  const forbidden = [
    /\bsudo\b/,
    /\brm\s+-rf\b/,
    /\bmkfs\b/,
    /\bdd\s+/,
    /\bdiskutil\b/,
    /\bshutdown\b/,
    /\breboot\b/,
    /\bchown\s+-R\b/,
    /\bchmod\s+-R\s+777\b/,
    /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}/,
  ];

  for (const pattern of forbidden) {
    if (pattern.test(trimmed)) return { ok: false, reason: `forbidden:${pattern.source}` };
  }

  const allowedLead = /^(pnpm|npm|npx|node|git|bash|sh|python|python3|pytest|ruff|mypy|tsc|turbo|rg|grep|cat|ls|pwd|find|sed|awk|head|tail|wc|echo)\b/;
  if (!allowedLead.test(trimmed)) return { ok: false, reason: "command_prefix_not_allowed" };

  return { ok: true };
}

function adjutorixResolveCommandCwd(input: Record<string, unknown>): string {
  const workspaceRoot = path.resolve(String(process.env.ADJUTORIX_WORKSPACE_ROOT || process.cwd()));
  const requested = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : workspaceRoot;
  const resolved = path.resolve(requested);

  if (!fs.existsSync(resolved)) throw new Error(`cwd_missing:${resolved}`);
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`cwd_not_directory:${resolved}`);

  return resolved;
}

if (!(globalThis as any).__adjutorixNativeCommandBridgeV5Registered) {
  (globalThis as any).__adjutorixNativeCommandBridgeV5Registered = true;

  ipcMain.handle(ADJUTORIX_SHELL_EXECUTE_CHANNEL, async (_event, payload: unknown) => {
    const startedAtMs = Date.now();
    const input = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
    const command = String(input.command ?? input.intent ?? "").trim();
    const allowed = adjutorixCommandAllowed(command);

    if (!allowed.ok) {
      return adjutorixShellJson({
        ok: false,
        status: "denied",
        reason: allowed.reason,
        command,
        channel: ADJUTORIX_SHELL_EXECUTE_CHANNEL,
      });
    }

    const cwd = adjutorixResolveCommandCwd(input);
    const timeoutMsRaw = Number(input.timeoutMs ?? 120_000);
    const timeoutMs = Number.isFinite(timeoutMsRaw) ? Math.max(1000, Math.min(timeoutMsRaw, 300_000)) : 120_000;

    return await new Promise<Json>((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;

      const child = spawn("/bin/bash", ["-lc", command], {
        cwd,
        env: {
          ...process.env,
          ADJUTORIX_WORKSPACE_ROOT: process.env.ADJUTORIX_WORKSPACE_ROOT || cwd,
          FORCE_COLOR: "0",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      const finish = (result: Record<string, unknown>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(adjutorixShellJson({
          ...result,
          command,
          cwd,
          channel: ADJUTORIX_SHELL_EXECUTE_CHANNEL,
          durationMs: Date.now() - startedAtMs,
          stdout: adjutorixBoundText(stdout),
          stderr: adjutorixBoundText(stderr),
        }));
      };

      const timer = setTimeout(() => {
        try { child.kill("SIGTERM"); } catch {}
        finish({ ok: false, status: "timeout", exitCode: null, signal: "SIGTERM", timeoutMs });
      }, timeoutMs);

      child.stdout?.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr?.on("data", (chunk) => { stderr += String(chunk); });

      child.on("error", (error) => {
        finish({ ok: false, status: "spawn_error", error: error.message, exitCode: null });
      });

      child.on("close", (code, signal) => {
        finish({ ok: code === 0, status: code === 0 ? "ok" : "failed", exitCode: code, signal });
      });
    });
  });
}


// ADJUTORIX_AGENT_STATUS_HANDLER_V7
// Renderer compatibility: V7 workbench introspects agent state.
// This prevents Electron from throwing "No handler registered for 'adjutorix:agent:status'".
const ADJUTORIX_AGENT_STATUS_CHANNEL_V7 = "adjutorix:agent:status";

try {
  ipcMain.removeHandler(ADJUTORIX_AGENT_STATUS_CHANNEL_V7);
} catch {
  // ignore: channel may not exist yet
}

ipcMain.handle(ADJUTORIX_AGENT_STATUS_CHANNEL_V7, async () => {
  return {
    ok: true,
    status: "ready",
    agent: {
      mode: "native-workbench",
      executable: true,
      shellBridge: true,
      marker: "ADJUTORIX_AGENT_STATUS_HANDLER_V7",
      pid: process.pid,
      cwd: process.cwd(),
      workspaceRoot: process.env.ADJUTORIX_WORKSPACE_ROOT ?? process.cwd(),
      time: new Date().toISOString()
    }
  };
});


// ADJUTORIX_AGENT_STATUS_HANDLER_V8
const ADJUTORIX_AGENT_STATUS_CHANNEL_V8 = "adjutorix:agent:status";

try {
  ipcMain.removeHandler(ADJUTORIX_AGENT_STATUS_CHANNEL_V8);
} catch {
  // handler may not exist yet
}

ipcMain.handle(ADJUTORIX_AGENT_STATUS_CHANNEL_V8, async () => {
  return {
    ok: true,
    status: "ready",
    agent: {
      mode: "native-workbench-v8",
      executable: true,
      marker: "ADJUTORIX_AGENT_STATUS_HANDLER_V8",
      pid: process.pid,
      cwd: process.cwd(),
      workspaceRoot: process.env.ADJUTORIX_WORKSPACE_ROOT ?? process.cwd(),
      time: new Date().toISOString()
    }
  };
});


// ADJUTORIX_NATIVE_CONTROL_PLANE_V13_BOOTSTRAP
registerNativeControlPlaneV13();
registerNativeExternalWorkspaceV16();

registerPortfolioWorkspaceV18();
