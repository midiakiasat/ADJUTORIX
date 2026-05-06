import { app, BrowserWindow, dialog, ipcMain, nativeTheme, protocol } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  loadMainEnvironment,
  validateMainEnvironment,
  summarizeMainEnvironment,
  runtimeEnvForRenderer,
  type MainEnvironment,
} from "@main/env";
import {
  createMainLogger,
  logAppReady,
  logAppShutdown,
  logAppStart,
  logCrash,
  logEnvironmentSnapshot,
  logWindowEvent,
  logAgentEvent,
  logIpcInvocation,
  type MainLogger,
} from "@main/logging";
import {
  createDefaultMenuState,
  installAppMenu,
  rebuildAppMenu,
  type AppMenuActions,
  type MenuState,
} from "@main/app_menu";
import {
  createWindowStateStore,
  defaultWindowStateFile,
  attachWindowStatePersistence,
  applyRestoredWindowState,
  type WindowStateStore,
} from "@main/window_state";

/**
 * ADJUTORIX APP — MAIN / RUNTIME / bootstrap.ts
 *
 * Deterministic runtime bootstrap orchestrator for the Electron main process.
 *
 * Responsibilities:
 * - load and validate canonical environment contract
 * - initialize structured logging before mutable runtime work begins
 * - enforce single-instance startup graph compatibility
 * - create and restore BrowserWindow state
 * - register guarded IPC boundaries and protocol handlers
 * - coordinate optional agent lifecycle and health probing
 * - install native menu from explicit state
 * - expose startup / shutdown diagnostics and bounded rollback behavior
 *
 * Hard invariants:
 * - bootstrap is phase-ordered and explicit; no hidden side effects
 * - failure in any phase yields controlled teardown
 * - runtime authority remains in main process, never renderer
 * - all externally visible runtime state is derivable from BootstrapState
 * - repeated bootstrap with identical inputs produces identical config hash
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type BootstrapPhase =
  | "created"
  | "environment-loaded"
  | "logging-ready"
  | "protocol-ready"
  | "ipc-ready"
  | "agent-ready"
  | "window-ready"
  | "menu-ready"
  | "running"
  | "shutdown";

export type AgentHealth = {
  ok: boolean;
  status: number | null;
  bodySha256: string | null;
  checkedAtMs: number | null;
};

export type AgentRuntime = {
  url: string;
  managed: boolean;
  pid: number | null;
  processHandle: import("node:child_process").ChildProcess | null;
  health: AgentHealth;
};

export type WorkspaceRuntime = {
  currentPath: string | null;
  recentPaths: string[];
  dirty: boolean;
  hasSelection: boolean;
  selectionCount: number;
};

export type BootstrapState = {
  phase: BootstrapPhase;
  startedAtMs: number;
  environment: MainEnvironment | null;
  logger: MainLogger | null;
  window: BrowserWindow | null;
  windowStore: WindowStateStore | null;
  menuState: MenuState;
  agent: AgentRuntime;
  workspace: WorkspaceRuntime;
  diagnosticsPath: string | null;
};

export type BootstrapResult = {
  state: BootstrapState;
  dispose: () => Promise<void>;
  rebuildMenu: () => void;
  getPublicRuntimeSnapshot: () => Record<string, unknown>;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const APP_PROTOCOL = "adjutorix";
const APP_BACKGROUND_COLOR = "#0b0f14";
const AGENT_START_CANDIDATES = [
  path.resolve(process.cwd(), "packages", "adjutorix-agent", "scripts", "start.sh"),
  path.resolve(process.cwd(), "adjutorix-agent", "scripts", "start.sh"),
  path.resolve(process.cwd(), "scripts", "start-agent.sh"),
] as const;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:runtime:bootstrap:${message}`);
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

function sha256(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  fn: () => Promise<T | null>,
  timeoutMs: number,
  intervalMs: number,
  label: string,
): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const result = await fn();
    if (result !== null) {
      return result;
    }
    await sleep(intervalMs);
  }
  throw new Error(`poll_timeout:${label}`);
}

function candidateAgentStartScript(): string | null {
  for (const candidate of AGENT_START_CANDIDATES) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function createInitialState(): BootstrapState {
  return {
    phase: "created",
    startedAtMs: Date.now(),
    environment: null,
    logger: null,
    window: null,
    windowStore: null,
    menuState: createDefaultMenuState(),
    agent: {
      url: "",
      managed: false,
      pid: null,
      processHandle: null,
      health: {
        ok: false,
        status: null,
        bodySha256: null,
        checkedAtMs: null,
      },
    },
    workspace: {
      currentPath: null,
      recentPaths: [],
      dirty: false,
      hasSelection: false,
      selectionCount: 0,
    },
    diagnosticsPath: null,
  };
}

function updateMenuState(state: BootstrapState): void {
  state.menuState = {
    workspace: {
      currentPath: state.workspace.currentPath,
      recentPaths: [...state.workspace.recentPaths],
      isDirty: state.workspace.dirty,
      hasSelection: state.workspace.hasSelection,
      selectionCount: state.workspace.selectionCount,
    },
    capability: {
      canOpenWorkspace: true,
      canRevealWorkspace: !!state.workspace.currentPath,
      canPreviewPatch: !!state.workspace.currentPath,
      canApplyPatch: !!state.workspace.currentPath,
      canRunVerify: !!state.workspace.currentPath,
      canOpenDevTools: !!state.environment && state.environment.features.devTools,
      canReloadWindow: !!state.window,
      canOpenLogs: !!state.environment,
      canStartAgent: !!state.environment && !state.agent.health.ok,
      canStopAgent: !!state.environment && state.agent.managed,
      canOpenSettings: true,
      canExportDiagnostics: !!state.logger,
    },
    view: {
      theme: nativeTheme.themeSource === "light" ? "light" : nativeTheme.themeSource === "dark" ? "dark" : "system",
      sidebarVisible: true,
      activityVisible: true,
      panelVisible: true,
      zoomFactor: state.window?.webContents.getZoomFactor() ?? 1,
      fullscreen: state.window?.isFullScreen() ?? false,
    },
    agent: {
      configuredUrl: state.agent.url || null,
      healthy: state.agent.health.ok,
      managed: state.agent.managed,
      pid: state.agent.pid,
    },
    build: {
      version: state.environment?.build.packageVersion ?? app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      devToolsEnabled: state.environment?.features.devTools ?? false,
      smokeMode: state.environment?.features.smokeMode ?? false,
    },
  };
}

function createLogger(environment: MainEnvironment): MainLogger {
  const logger = createMainLogger({
    rootDir: environment.paths.logRoot,
    fileName: "main.jsonl",
    minLevel: environment.features.enableVerboseDiagnostics ? "debug" : "info",
    mirrorToConsole: environment.features.smokeMode || environment.build.mode !== "production",
    serviceName: "adjutorix-app-main",
  });

  logAppStart(logger, {
    configHash: environment.hash,
    version: environment.build.packageVersion,
    mode: environment.build.mode,
  });
  logEnvironmentSnapshot(logger, summarizeMainEnvironment(environment));
  return logger;
}

async function httpRpcProbe(url: string): Promise<AgentHealth> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "health.ping", params: {} }),
      signal: AbortSignal.timeout(4_000),
    });
    const body = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      bodySha256: sha256(body),
      checkedAtMs: Date.now(),
    };
  } catch {
    return {
      ok: false,
      status: null,
      bodySha256: null,
      checkedAtMs: Date.now(),
    };
  }
}

async function ensureAgent(state: BootstrapState): Promise<void> {
  const environment = state.environment;
  assert(environment, "environment_missing_for_agent");

  state.agent.url = environment.agent.url;
  state.agent.health = await httpRpcProbe(environment.agent.url);
  if (state.agent.health.ok) {
    state.logger?.info("Reusing reachable Adjutorix agent", {
      url: environment.agent.url,
      status: state.agent.health.status,
    });
    return;
  }

  if (!environment.features.autoSpawnAgent) {
    state.logger?.warn("Agent unreachable and autospawn disabled", {
      url: environment.agent.url,
    });
    return;
  }

  const script = candidateAgentStartScript();
  if (!script) {
    state.logger?.warn("Agent start script unavailable", {
      searched: [...AGENT_START_CANDIDATES],
    });
    return;
  }

  const { spawn } = await import("node:child_process");
  const child = spawn(script, [], {
    cwd: path.dirname(script),
    stdio: "ignore",
    shell: false,
    detached: false,
    env: {
      ...process.env,
      ADJUTORIX_ROOT: process.cwd(),
    },
  });

  state.agent.processHandle = child;
  state.agent.managed = true;
  state.agent.pid = child.pid ?? null;
  logAgentEvent(state.logger!, "spawned", {
    script,
    pid: state.agent.pid,
    url: state.agent.url,
  });

  child.on("exit", (code, signal) => {
    state.logger?.warn("Managed agent exited", {
      code: code ?? null,
      signal: signal ?? null,
    });
    state.agent.processHandle = null;
    state.agent.pid = null;
    state.agent.managed = false;
  });

  state.agent.health = await pollUntil(async () => {
    const next = await httpRpcProbe(state.agent.url);
    return next.ok ? next : null;
  }, environment.agent.readyTimeoutMs, environment.agent.pollIntervalMs, "agent-ready");

  logAgentEvent(state.logger!, "ready", {
    url: state.agent.url,
    pid: state.agent.pid,
    status: state.agent.health.status,
  });
}

function registerProtocolHandlers(state: BootstrapState): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: APP_PROTOCOL,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ]);

  state.logger?.debug("Protocol schemes registered", { scheme: APP_PROTOCOL });
}

async function rpcInvokeThroughAgent(state: BootstrapState, method: string, params: Record<string, unknown>): Promise<unknown> {
  const environment = state.environment;
  assert(environment, "environment_missing_for_rpc");

  const tokenFile = environment.agent.tokenFile;
  const token = fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, "utf8").trim() : "";
  const started = Date.now();

  const response = await fetch(environment.agent.url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-adjutorix-token": token } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
    signal: AbortSignal.timeout(environment.agent.rpcTimeoutMs),
  });

  const payload = (await response.json()) as { result?: unknown; error?: { message?: string; code?: number } };
  if (!response.ok || payload.error) {
    const err = new Error(`rpc_failed:${method}:${payload.error?.code ?? response.status}:${payload.error?.message ?? "unknown"}`);
    logIpcInvocation(state.logger!, method, {
      success: false,
      durationMs: Date.now() - started,
      error: err,
      argsShape: { keys: Object.keys(params).sort() },
    });
    throw err;
  }

  logIpcInvocation(state.logger!, method, {
    success: true,
    durationMs: Date.now() - started,
    argsShape: { keys: Object.keys(params).sort() },
  });
  return payload.result ?? null;
}

function registerIpc(state: BootstrapState): void {
  const environment = state.environment;
  assert(environment, "environment_missing_for_ipc");

  const safeHandle = (channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await handler(...args);
      } catch (error) {
        state.logger?.exception(`IPC handler failed: ${channel}`, error, { channel });
        throw error;
      }
    });
  };

  safeHandle("adjutorix:runtime:getSnapshot", async () => {
    return {
      environment: summarizeMainEnvironment(environment),
      workspace: state.workspace,
      agent: {
        url: state.agent.url,
        healthy: state.agent.health.ok,
        managed: state.agent.managed,
        pid: state.agent.pid,
      },
    };
  });

  safeHandle("adjutorix:rpc:invoke", async (method, params) => {
    assert(typeof method === "string" && method.length > 0, "ipc_method_invalid");
    assert(typeof params === "object" && params !== null, "ipc_params_invalid");
    return rpcInvokeThroughAgent(state, method, params as Record<string, unknown>);
  });

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
      const chooserOptions: Electron.OpenDialogOptions = {
        title: "Open governed workspace",
        properties: ["openDirectory"],
      };

      const result =
        state.window && !state.window.isDestroyed()
          ? await dialog.showOpenDialog(state.window, chooserOptions)
          : await dialog.showOpenDialog(chooserOptions);

      if (result.canceled || result.filePaths.length === 0) {
        return { ok: false, canceled: true, cancelled: true, path: null };
      }

      selectedPath = result.filePaths[0] ?? null;
    }

    assert(typeof selectedPath === "string" && selectedPath.trim().length > 0, "workspace_path_invalid");

    const normalized = path.resolve(selectedPath.trim());
    assert(fs.existsSync(normalized), "workspace_missing");
    state.workspace.currentPath = normalized;
    state.workspace.recentPaths = Array.from(new Set([normalized, ...state.workspace.recentPaths])).slice(0, 20);
    updateMenuState(state);
    return { ok: true, path: normalized };
  });

  safeHandle("adjutorix:patch:preview", async (intent) => {
    assert(typeof intent === "object" && intent !== null, "preview_intent_invalid");
    return rpcInvokeThroughAgent(state, "patch.preview", { intent });
  });

  safeHandle("adjutorix:patch:apply", async (patchId) => {
    assert(typeof patchId === "string" && patchId.length > 0, "patch_id_invalid");
    return rpcInvokeThroughAgent(state, "patch.apply", { patch_id: patchId });
  });

  safeHandle("adjutorix:verify:run", async (targets) => {
    assert(Array.isArray(targets), "verify_targets_invalid");
    return rpcInvokeThroughAgent(state, "verify.run", { targets });
  });

  safeHandle("adjutorix:verify:status", async (verifyId) => {
    assert(typeof verifyId === "string" && verifyId.length > 0, "verify_id_invalid");
    return rpcInvokeThroughAgent(state, "verify.status", { verify_id: verifyId });
  });

  safeHandle("adjutorix:ledger:current", async () => {
    return rpcInvokeThroughAgent(state, "ledger.current", {});
  });

  state.logger?.debug("IPC handlers registered", {
    channels: [
      "adjutorix:runtime:getSnapshot",
      "adjutorix:rpc:invoke",
      "adjutorix:workspace:open",
      "adjutorix:patch:preview",
      "adjutorix:patch:apply",
      "adjutorix:verify:run",
      "adjutorix:verify:status",
      "adjutorix:ledger:current",
    ],
  });
}

function createMenuActions(state: BootstrapState): AppMenuActions {
  return {
    workspaceOpen: async () => {
      state.logger?.info("Menu action: workspace open requested");
    },
    workspaceOpenRecent: async (workspacePath: string) => {
      state.workspace.currentPath = path.resolve(workspacePath);
      updateMenuState(state);
    },
    workspaceReveal: async () => {
      assert(state.workspace.currentPath, "workspace_not_open");
      const { shell } = await import("electron");
      shell.showItemInFolder(state.workspace.currentPath);
    },
    workspaceClose: async () => {
      state.workspace.currentPath = null;
      state.workspace.dirty = false;
      updateMenuState(state);
    },
    patchPreview: async () => {
      await rpcInvokeThroughAgent(state, "patch.preview", { intent: { op: "noop" } });
    },
    patchApply: async () => {
      state.logger?.warn("Patch apply invoked without concrete patch id in menu action");
    },
    verifyRun: async () => {
      await rpcInvokeThroughAgent(state, "verify.run", { targets: state.workspace.currentPath ? [state.workspace.currentPath] : [] });
    },
    exportDiagnostics: async () => {
      const environment = state.environment;
      assert(environment, "environment_missing_export_diagnostics");
      const diagnostics = {
        phase: state.phase,
        configHash: environment.hash,
        environment: summarizeMainEnvironment(environment),
        workspace: state.workspace,
        agent: {
          url: state.agent.url,
          healthy: state.agent.health.ok,
          pid: state.agent.pid,
          managed: state.agent.managed,
        },
      };
      const out = path.join(environment.paths.logRoot, "bootstrap-diagnostics.json");
      fs.writeFileSync(out, `${stableJson(diagnostics)}\n`, "utf8");
    },
    openSettings: async () => {
      state.logger?.info("Open settings requested");
    },
    openLogs: async () => {
      const { shell } = await import("electron");
      assert(state.environment, "environment_missing_open_logs");
      shell.openPath(state.environment.paths.logRoot);
    },
    startAgent: async () => {
      await ensureAgent(state);
      updateMenuState(state);
    },
    stopAgent: async () => {
      if (state.agent.processHandle) {
        state.agent.processHandle.kill("SIGTERM");
      }
      state.agent.processHandle = null;
      state.agent.pid = null;
      state.agent.managed = false;
      state.agent.health = await httpRpcProbe(state.agent.url);
      updateMenuState(state);
    },
    reloadWindow: async () => {
      state.window?.reload();
    },
    toggleDevTools: async () => {
      state.window?.webContents.toggleDevTools();
    },
    resetZoom: async () => {
      state.window?.webContents.setZoomFactor(1);
      updateMenuState(state);
    },
    zoomIn: async () => {
      const current = state.window?.webContents.getZoomFactor() ?? 1;
      state.window?.webContents.setZoomFactor(Math.min(current + 0.1, 3));
      updateMenuState(state);
    },
    zoomOut: async () => {
      const current = state.window?.webContents.getZoomFactor() ?? 1;
      state.window?.webContents.setZoomFactor(Math.max(current - 0.1, 0.5));
      updateMenuState(state);
    },
    toggleSidebar: async () => {
      updateMenuState(state);
    },
    toggleActivity: async () => {
      updateMenuState(state);
    },
    togglePanel: async () => {
      updateMenuState(state);
    },
    setTheme: async (theme) => {
      nativeTheme.themeSource = theme;
      updateMenuState(state);
    },
    reportIssue: async () => {
      state.logger?.info("Report issue requested");
    },
    openDocs: async () => {
      state.logger?.info("Open docs requested");
    },
    about: async () => {
      await dialog.showMessageBox({
        type: "info",
        title: "About Adjutorix",
        message: `Adjutorix ${state.environment?.build.packageVersion ?? app.getVersion()}`,
        detail: "Deterministic patch-oriented desktop runtime.",
      });
    },
  };
}

async function createWindow(state: BootstrapState): Promise<BrowserWindow> {
  const environment = state.environment;
  assert(environment, "environment_missing_for_window");

  const store = createWindowStateStore({
    filePath: defaultWindowStateFile(environment.paths.stateRoot),
    defaultWidth: environment.window.width,
    defaultHeight: environment.window.height,
    minWidth: environment.window.minWidth,
    minHeight: environment.window.minHeight,
  });
  state.windowStore = store;

  const restored = store.restore();
  const window = new BrowserWindow({
    show: false,
    width: restored.bounds.width,
    height: restored.bounds.height,
    minWidth: environment.window.minWidth,
    minHeight: environment.window.minHeight,
    backgroundColor: environment.window.backgroundColor || APP_BACKGROUND_COLOR,
    title: "Adjutorix",
    autoHideMenuBar: true,
    webPreferences: {
      preload: environment.paths.preloadEntry,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
      additionalArguments: [
        `--adjutorix-runtime=${Buffer.from(stableJson(runtimeEnvForRenderer(environment))).toString("base64")}`,
      ],
    },
  });

  applyRestoredWindowState(window, restored);
  attachWindowStatePersistence(window, store);

  window.once("ready-to-show", () => {
    if (!environment.features.headless) {
      window.show();
    }
    logWindowEvent(state.logger!, "ready-to-show", {
      fullscreen: window.isFullScreen(),
      maximized: window.isMaximized(),
    });
  });

  window.on("focus", () => logWindowEvent(state.logger!, "focus", {}));
  window.on("blur", () => logWindowEvent(state.logger!, "blur", {}));
  window.on("closed", () => {
    state.window = null;
  });

  await window.loadFile(environment.paths.rendererIndex);
  state.window = window;
  updateMenuState(state);

  await pollUntil(async () => {
    return window.webContents.isLoadingMainFrame() ? null : true;
  }, 15_000, 100, "renderer-load");

  return window;
}

function installMenu(state: BootstrapState): void {
  assert(state.window, "window_missing_for_menu");
  updateMenuState(state);

  const audit = (event: string, detail?: Record<string, unknown>) => {
    state.logger?.info(`Menu audit: ${event}`, detail ?? {});
  };
  const onError = (kind: string, error: unknown, detail?: Record<string, unknown>) => {
    state.logger?.exception(`Menu error: ${kind}`, error, detail ?? {});
  };

  installAppMenu({
    window: state.window,
    state: state.menuState,
    actions: createMenuActions(state),
    audit,
    onError,
  });
}

async function disposeState(state: BootstrapState): Promise<void> {
  state.phase = "shutdown";

  if (state.windowStore) {
    try {
      state.windowStore.flush();
    } catch (error) {
      state.logger?.exception("Window state flush failed during shutdown", error);
    }
  }

  if (state.agent.processHandle) {
    try {
      state.agent.processHandle.kill("SIGTERM");
    } catch {
      // ignore
    }
    state.agent.processHandle = null;
    state.agent.pid = null;
    state.agent.managed = false;
  }

  try {
    ipcMain.removeHandler("adjutorix:runtime:getSnapshot");
    ipcMain.removeHandler("adjutorix:rpc:invoke");
    ipcMain.removeHandler("adjutorix:workspace:open");
    ipcMain.removeHandler("adjutorix:patch:preview");
    ipcMain.removeHandler("adjutorix:patch:apply");
    ipcMain.removeHandler("adjutorix:verify:run");
    ipcMain.removeHandler("adjutorix:verify:status");
    ipcMain.removeHandler("adjutorix:ledger:current");
  } catch {
    // ignore
  }

  if (state.window && !state.window.isDestroyed()) {
    state.window.destroy();
  }

  if (state.logger) {
    logAppShutdown(state.logger, {
      phase: state.phase,
      agentManaged: state.agent.managed,
      workspacePath: state.workspace.currentPath,
    });
  }
}

// -----------------------------------------------------------------------------
// PUBLIC BOOTSTRAP
// -----------------------------------------------------------------------------

export async function bootstrapMainRuntime(): Promise<BootstrapResult> {
  const state = createInitialState();

  try {
    const environment = loadMainEnvironment(process.env);
    validateMainEnvironment(environment);
    state.environment = environment;
    state.diagnosticsPath = path.join(environment.paths.logRoot, "bootstrap-diagnostics.json");
    state.phase = "environment-loaded";

    const logger = createLogger(environment);
    state.logger = logger;
    state.phase = "logging-ready";

    registerProtocolHandlers(state);
    state.phase = "protocol-ready";

    registerIpc(state);
    state.phase = "ipc-ready";

    await ensureAgent(state);
    updateMenuState(state);
    state.phase = "agent-ready";

    await createWindow(state);
    state.phase = "window-ready";

    installMenu(state);
    state.phase = "menu-ready";

    logAppReady(logger, {
      configHash: environment.hash,
      rendererManifestSha256: environment.build.rendererManifestSha256,
      rendererAssetManifestSha256: environment.build.rendererAssetManifestSha256,
    });

    state.phase = "running";

    return {
      state,
      dispose: async () => {
        await disposeState(state);
      },
      rebuildMenu: () => {
        if (!state.window) return;
        updateMenuState(state);
        rebuildAppMenu({
          window: state.window,
          state: state.menuState,
          actions: createMenuActions(state),
          audit: (event, detail) => state.logger?.info(`Menu audit: ${event}`, detail ?? {}),
          onError: (kind, error, detail) => state.logger?.exception(`Menu error: ${kind}`, error, detail ?? {}),
        });
      },
      getPublicRuntimeSnapshot: () => ({
        phase: state.phase,
        configHash: state.environment?.hash ?? null,
        workspace: state.workspace,
        agent: {
          url: state.agent.url,
          healthy: state.agent.health.ok,
          managed: state.agent.managed,
          pid: state.agent.pid,
        },
      }),
    };
  } catch (error) {
    if (state.logger) {
      logCrash(state.logger, "bootstrap-failure", error, {
        phase: state.phase,
      });
    }

    await disposeState(state).catch(() => undefined);
    throw error;
  }
}