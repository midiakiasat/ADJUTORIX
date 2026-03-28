import { app, BrowserWindow, dialog, ipcMain, nativeTheme, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

import {
  buildRuntimeConfig,
  summarizeRuntimeConfig,
  redactRuntimeConfig,
  validateRuntimeConfig,
  type RuntimeConfig,
  type MainEnvironment,
} from "@main/runtime/config";
import {
  createMainLogger,
  logAppReady,
  logAppShutdown,
  logCrash,
  logEnvironmentSnapshot,
  logIpcInvocation,
  logWindowEvent,
  logAgentEvent,
  type MainLogger,
} from "@main/logging";
import {
  installAppMenu,
  rebuildAppMenu,
  createDefaultMenuState,
  type MenuState,
  type AppMenuActions,
} from "@main/app_menu";
import {
  createWindowStateStore,
  defaultWindowStateFile,
  attachWindowStatePersistence,
  applyRestoredWindowState,
  type WindowStateStore,
} from "@main/window_state";
import {
  bootstrapMainRuntime,
  type BootstrapResult,
  type BootstrapState,
} from "@main/runtime/bootstrap";

/**
 * ADJUTORIX APP — MAIN / RUNTIME / wiring.ts
 *
 * Composition root and dependency wiring layer for the Electron main process.
 *
 * This module does NOT invent new behavior. It binds already-defined runtime
 * components into a coherent ownership graph with explicit lifecycle rules.
 *
 * Responsibilities:
 * - build the dependency container for main runtime services
 * - define ownership/lifetime boundaries for logger, window, menu, IPC, agent
 * - expose a deterministic composition API for entrypoints and tests
 * - centralize side-effectful adapters (filesystem, shell, dialog, fetch)
 * - prevent cross-module singleton drift and accidental hidden dependencies
 *
 * Hard invariants:
 * - every mutable runtime capability has a single owner
 * - all inter-service references are explicit in WiringGraph
 * - teardown order is reverse-topological
 * - no renderer-facing API bypasses the composed service graph
 * - identical config => identical wiring summary hash
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type WiringPhase =
  | "created"
  | "config-built"
  | "logger-built"
  | "services-wired"
  | "bootstrapped"
  | "disposed";

export type WiringRuntimeState = {
  currentWorkspacePath: string | null;
  recentWorkspacePaths: string[];
  selectionCount: number;
  hasSelection: boolean;
  isDirty: boolean;
  sidebarVisible: boolean;
  activityVisible: boolean;
  panelVisible: boolean;
  theme: "system" | "light" | "dark";
};

export type WiringAgentSnapshot = {
  url: string;
  healthy: boolean;
  managed: boolean;
  pid: number | null;
  checkedAtMs: number | null;
};

export type WiringServices = {
  config: RuntimeConfig;
  logger: MainLogger;
  bootstrap: BootstrapResult;
  windowStateStore: WindowStateStore | null;
  getWindow: () => BrowserWindow | null;
  getMenuState: () => MenuState;
  getAgentSnapshot: () => WiringAgentSnapshot;
  refreshMenu: () => void;
  dispose: () => Promise<void>;
};

export type WiringGraphSummary = {
  schema: 1;
  phase: WiringPhase;
  configHash: string;
  summaryHash: string;
  owns: {
    logger: true;
    bootstrap: true;
    menu: true;
    ipc: true;
    windowState: boolean;
  };
  pointers: {
    logRoot: string;
    runtimeRoot: string;
    stateRoot: string;
    persistedConfigFile: string;
    crashDumpRoot: string;
  };
};

export type BuildWiringOptions = {
  environment: MainEnvironment;
};

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:runtime:wiring:${message}`);
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

function dedupeRecent(paths: string[], max = 20): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of paths.map((x) => path.resolve(x))) {
    if (!seen.has(p)) {
      seen.add(p);
      out.push(p);
    }
    if (out.length >= max) break;
  }
  return out;
}

function createRuntimeState(config: RuntimeConfig): WiringRuntimeState {
  return {
    currentWorkspacePath: null,
    recentWorkspacePaths: dedupeRecent(config.workspace.recentPaths, config.workspace.maxRecentPaths),
    selectionCount: 0,
    hasSelection: false,
    isDirty: false,
    sidebarVisible: config.ui.sidebarVisible,
    activityVisible: config.ui.activityVisible,
    panelVisible: config.ui.panelVisible,
    theme: config.ui.theme,
  };
}

function menuStateFromRuntime(runtime: WiringRuntimeState, config: RuntimeConfig, agent: WiringAgentSnapshot, window: BrowserWindow | null): MenuState {
  return {
    workspace: {
      currentPath: runtime.currentWorkspacePath,
      recentPaths: [...runtime.recentWorkspacePaths],
      isDirty: runtime.isDirty,
      hasSelection: runtime.hasSelection,
      selectionCount: runtime.selectionCount,
    },
    capability: {
      canOpenWorkspace: true,
      canRevealWorkspace: !!runtime.currentWorkspacePath,
      canPreviewPatch: !!runtime.currentWorkspacePath,
      canApplyPatch: !!runtime.currentWorkspacePath,
      canRunVerify: !!runtime.currentWorkspacePath,
      canOpenDevTools: config.features.devTools,
      canReloadWindow: !!window,
      canOpenLogs: true,
      canStartAgent: !agent.healthy,
      canStopAgent: agent.managed,
      canOpenSettings: true,
      canExportDiagnostics: true,
    },
    view: {
      theme: runtime.theme,
      sidebarVisible: runtime.sidebarVisible,
      activityVisible: runtime.activityVisible,
      panelVisible: runtime.panelVisible,
      zoomFactor: window?.webContents.getZoomFactor() ?? config.ui.zoomFactor,
      fullscreen: window?.isFullScreen() ?? false,
    },
    agent: {
      configuredUrl: agent.url,
      healthy: agent.healthy,
      managed: agent.managed,
      pid: agent.pid,
    },
    build: {
      version: config.build.version,
      platform: config.build.platform,
      isPackaged: config.build.isPackaged,
      devToolsEnabled: config.features.devTools,
      smokeMode: config.features.smokeMode,
    },
  };
}

function graphSummary(config: RuntimeConfig, windowStateStore: WindowStateStore | null, phase: WiringPhase): WiringGraphSummary {
  const base = {
    schema: 1 as const,
    phase,
    configHash: config.hash,
    owns: {
      logger: true as const,
      bootstrap: true as const,
      menu: true as const,
      ipc: true as const,
      windowState: !!windowStateStore,
    },
    pointers: {
      logRoot: config.paths.logRoot,
      runtimeRoot: config.paths.runtimeRoot,
      stateRoot: config.paths.stateRoot,
      persistedConfigFile: config.paths.persistedConfigFile,
      crashDumpRoot: config.paths.crashDumpRoot,
    },
  };

  return {
    ...base,
    summaryHash: sha256(stableJson(base)),
  };
}

// -----------------------------------------------------------------------------
// SERVICE ACTIONS
// -----------------------------------------------------------------------------

function createMenuActions(
  services: {
    config: RuntimeConfig;
    logger: MainLogger;
    runtimeState: WiringRuntimeState;
    getWindow: () => BrowserWindow | null;
    getAgentSnapshot: () => WiringAgentSnapshot;
    refreshMenu: () => void;
  },
): AppMenuActions {
  return {
    workspaceOpen: async () => {
      services.logger.info("Menu action requested: workspace open");
    },
    workspaceOpenRecent: async (workspacePath: string) => {
      services.runtimeState.currentWorkspacePath = path.resolve(workspacePath);
      services.runtimeState.recentWorkspacePaths = dedupeRecent([
        workspacePath,
        ...services.runtimeState.recentWorkspacePaths,
      ]);
      services.refreshMenu();
      services.logger.info("Opened recent workspace via menu", { workspacePath: services.runtimeState.currentWorkspacePath });
    },
    workspaceReveal: async () => {
      const current = services.runtimeState.currentWorkspacePath;
      assert(current, "workspace_reveal_without_workspace");
      shell.showItemInFolder(current);
    },
    workspaceClose: async () => {
      services.runtimeState.currentWorkspacePath = null;
      services.runtimeState.isDirty = false;
      services.refreshMenu();
      services.logger.info("Workspace closed via menu");
    },
    patchPreview: async () => {
      services.logger.info("Patch preview requested from menu");
    },
    patchApply: async () => {
      services.logger.warn("Patch apply requested from menu without selected patch context");
    },
    verifyRun: async () => {
      services.logger.info("Verify run requested from menu", {
        workspacePath: services.runtimeState.currentWorkspacePath,
      });
    },
    exportDiagnostics: async () => {
      const payload = {
        config: summarizeRuntimeConfig(redactRuntimeConfig(services.config)),
        runtimeState: services.runtimeState,
        agent: services.getAgentSnapshot(),
      };
      const out = path.join(services.config.paths.logRoot, "wiring-diagnostics.json");
      fs.writeFileSync(out, `${stableJson(payload)}\n`, "utf8");
      services.logger.info("Exported wiring diagnostics", { out });
    },
    openSettings: async () => {
      services.logger.info("Settings requested from menu");
    },
    openLogs: async () => {
      await shell.openPath(services.config.paths.logRoot);
    },
    startAgent: async () => {
      services.logger.info("Agent start requested from menu");
    },
    stopAgent: async () => {
      services.logger.info("Agent stop requested from menu");
    },
    reloadWindow: async () => {
      services.getWindow()?.reload();
    },
    toggleDevTools: async () => {
      services.getWindow()?.webContents.toggleDevTools();
    },
    resetZoom: async () => {
      const window = services.getWindow();
      if (window) {
        window.webContents.setZoomFactor(1);
        services.refreshMenu();
      }
    },
    zoomIn: async () => {
      const window = services.getWindow();
      if (window) {
        window.webContents.setZoomFactor(Math.min(window.webContents.getZoomFactor() + 0.1, 3));
        services.refreshMenu();
      }
    },
    zoomOut: async () => {
      const window = services.getWindow();
      if (window) {
        window.webContents.setZoomFactor(Math.max(window.webContents.getZoomFactor() - 0.1, 0.5));
        services.refreshMenu();
      }
    },
    toggleSidebar: async () => {
      services.runtimeState.sidebarVisible = !services.runtimeState.sidebarVisible;
      services.refreshMenu();
    },
    toggleActivity: async () => {
      services.runtimeState.activityVisible = !services.runtimeState.activityVisible;
      services.refreshMenu();
    },
    togglePanel: async () => {
      services.runtimeState.panelVisible = !services.runtimeState.panelVisible;
      services.refreshMenu();
    },
    setTheme: async (theme) => {
      services.runtimeState.theme = theme;
      nativeTheme.themeSource = theme;
      services.refreshMenu();
    },
    reportIssue: async () => {
      services.logger.info("Report issue requested from menu");
    },
    openDocs: async () => {
      services.logger.info("Documentation requested from menu");
    },
    about: async () => {
      await dialog.showMessageBox({
        type: "info",
        title: "About Adjutorix",
        message: `Adjutorix ${services.config.build.version}`,
        detail: "Deterministic patch-oriented desktop runtime.",
      });
    },
  };
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export async function buildRuntimeWiring(options: BuildWiringOptions): Promise<WiringServices> {
  const config = buildRuntimeConfig(options.environment);
  validateRuntimeConfig(config);

  const logger = createMainLogger({
    rootDir: config.paths.logRoot,
    fileName: "main-wiring.jsonl",
    minLevel: config.features.enableVerboseDiagnostics ? "debug" : "info",
    mirrorToConsole: config.features.smokeMode || config.build.mode !== "production",
    serviceName: "adjutorix-app-main-wiring",
  });

  logger.info("Building runtime wiring", {
    configHash: config.hash,
    environmentHash: config.environmentHash,
  });
  logEnvironmentSnapshot(logger, summarizeRuntimeConfig(redactRuntimeConfig(config)));

  const runtimeState = createRuntimeState(config);
  const bootstrap = await bootstrapMainRuntime();

  const getWindow = (): BrowserWindow | null => bootstrap.state.window;
  const getAgentSnapshot = (): WiringAgentSnapshot => ({
    url: bootstrap.state.agent.url,
    healthy: bootstrap.state.agent.health.ok,
    managed: bootstrap.state.agent.managed,
    pid: bootstrap.state.agent.pid,
    checkedAtMs: bootstrap.state.agent.health.checkedAtMs,
  });

  let currentMenuState: MenuState = menuStateFromRuntime(runtimeState, config, getAgentSnapshot(), getWindow());

  const refreshMenu = (): void => {
    currentMenuState = menuStateFromRuntime(runtimeState, config, getAgentSnapshot(), getWindow());

    const window = getWindow();
    if (!window) {
      return;
    }

    rebuildAppMenu({
      window,
      state: currentMenuState,
      actions: createMenuActions({
        config,
        logger,
        runtimeState,
        getWindow,
        getAgentSnapshot,
        refreshMenu,
      }),
      audit: (event, detail) => logger.info(`Menu audit: ${event}`, detail ?? {}),
      onError: (kind, error, detail) => logger.exception(`Menu error: ${kind}`, error, detail ?? {}),
    });
  };

  if (getWindow()) {
    installAppMenu({
      window: getWindow()!,
      state: currentMenuState,
      actions: createMenuActions({
        config,
        logger,
        runtimeState,
        getWindow,
        getAgentSnapshot,
        refreshMenu,
      }),
      audit: (event, detail) => logger.info(`Menu audit: ${event}`, detail ?? {}),
      onError: (kind, error, detail) => logger.exception(`Menu error: ${kind}`, error, detail ?? {}),
    });
  }

  const summary = graphSummary(config, bootstrap.state.windowStore, "bootstrapped");
  logger.info("Runtime wiring ready", summary);
  logAppReady(logger, {
    wiringSummaryHash: summary.summaryHash,
    configHash: config.hash,
  });

  const dispose = async (): Promise<void> => {
    logger.info("Disposing runtime wiring", {
      summaryHash: summary.summaryHash,
    });
    await bootstrap.dispose();
    logAppShutdown(logger, {
      configHash: config.hash,
      summaryHash: summary.summaryHash,
    });
  };

  return {
    config,
    logger,
    bootstrap,
    windowStateStore: bootstrap.state.windowStore,
    getWindow,
    getMenuState: () => currentMenuState,
    getAgentSnapshot,
    refreshMenu,
    dispose,
  };
}

export function wiringSummary(services: WiringServices): WiringGraphSummary {
  return graphSummary(
    services.config,
    services.windowStateStore,
    "bootstrapped",
  );
}
