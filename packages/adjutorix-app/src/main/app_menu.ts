import { app, BrowserWindow, Menu, MenuItemConstructorOptions, dialog, nativeTheme, shell } from "electron";
import path from "node:path";
import fs from "node:fs";

/**
 * ADJUTORIX APP — MAIN / app_menu.ts
 *
 * Authoritative native application menu for Adjutorix desktop.
 *
 * Responsibilities:
 * - construct deterministic, role-aware native menu templates
 * - route menu actions to explicit main-process handlers only
 * - guard destructive commands behind confirmation / capability checks
 * - expose workspace-aware command enablement / visibility
 * - centralize keyboard accelerator policy
 * - keep renderer out of direct menu authority
 *
 * Hard invariants:
 * - menu is a projection of explicit application state, not implicit renderer state
 * - destructive actions never execute without a guarded main-process path
 * - accelerators are stable and platform-normalized
 * - no menu item mutates state without a named action and audit event
 * - menu rebuilds are deterministic for identical state inputs
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type AppMenuTheme = "system" | "light" | "dark";

export type MenuAuditFn = (event: string, detail?: Record<string, unknown>) => void;
export type MenuErrorFn = (kind: string, error: unknown, detail?: Record<string, unknown>) => void;

export type MenuWorkspaceState = {
  currentPath: string | null;
  recentPaths: string[];
  isDirty: boolean;
  hasSelection: boolean;
  selectionCount: number;
};

export type MenuCapabilityState = {
  canOpenWorkspace: boolean;
  canRevealWorkspace: boolean;
  canPreviewPatch: boolean;
  canApplyPatch: boolean;
  canRunVerify: boolean;
  canOpenDevTools: boolean;
  canReloadWindow: boolean;
  canOpenLogs: boolean;
  canStartAgent: boolean;
  canStopAgent: boolean;
  canOpenSettings: boolean;
  canExportDiagnostics: boolean;
};

export type MenuViewState = {
  theme: AppMenuTheme;
  sidebarVisible: boolean;
  activityVisible: boolean;
  panelVisible: boolean;
  zoomFactor: number;
  fullscreen: boolean;
};

export type MenuAgentState = {
  configuredUrl: string | null;
  healthy: boolean;
  managed: boolean;
  pid: number | null;
};

export type MenuBuildState = {
  version: string;
  platform: NodeJS.Platform;
  isPackaged: boolean;
  devToolsEnabled: boolean;
  smokeMode: boolean;
};

export type MenuState = {
  workspace: MenuWorkspaceState;
  capability: MenuCapabilityState;
  view: MenuViewState;
  agent: MenuAgentState;
  build: MenuBuildState;
};

export type AppMenuActions = {
  workspaceOpen: () => Promise<void> | void;
  workspaceOpenRecent: (workspacePath: string) => Promise<void> | void;
  workspaceReveal: () => Promise<void> | void;
  workspaceClose: () => Promise<void> | void;
  patchPreview: () => Promise<void> | void;
  patchApply: () => Promise<void> | void;
  verifyRun: () => Promise<void> | void;
  exportDiagnostics: () => Promise<void> | void;
  openSettings: () => Promise<void> | void;
  openLogs: () => Promise<void> | void;
  startAgent: () => Promise<void> | void;
  stopAgent: () => Promise<void> | void;
  reloadWindow: () => Promise<void> | void;
  toggleDevTools: () => Promise<void> | void;
  resetZoom: () => Promise<void> | void;
  zoomIn: () => Promise<void> | void;
  zoomOut: () => Promise<void> | void;
  toggleSidebar: () => Promise<void> | void;
  toggleActivity: () => Promise<void> | void;
  togglePanel: () => Promise<void> | void;
  setTheme: (theme: AppMenuTheme) => Promise<void> | void;
  reportIssue: () => Promise<void> | void;
  openDocs: () => Promise<void> | void;
  about: () => Promise<void> | void;
};

export type BuildMenuOptions = {
  window: BrowserWindow;
  state: MenuState;
  actions: AppMenuActions;
  audit: MenuAuditFn;
  onError: MenuErrorFn;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const IS_MAC = process.platform === "darwin";

const DOCS_URL = "https://example.invalid/adjutorix/docs";
const ISSUE_URL = "https://example.invalid/adjutorix/issues";

// -----------------------------------------------------------------------------
// INTERNAL HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:app_menu:${message}`);
  }
}

function normalizeRecentPaths(paths: string[]): string[] {
  return [...new Set(paths.map((p) => path.resolve(p)).filter((p) => p.length > 0))].sort((a, b) => a.localeCompare(b));
}

function truncateLabel(input: string, max = 60): string {
  return input.length <= max ? input : `${input.slice(0, max - 1)}…`;
}

function roleOr(label: string, fallback: MenuItemConstructorOptions): MenuItemConstructorOptions {
  // Convenience wrapper to reduce platform branching noise if ever extended.
  return { label, ...fallback };
}

async function guardedInvoke(
  label: string,
  fn: () => Promise<void> | void,
  audit: MenuAuditFn,
  onError: MenuErrorFn,
  detail?: Record<string, unknown>,
): Promise<void> {
  audit("menu.invoke.begin", { label, ...(detail || {}) });
  try {
    await fn();
    audit("menu.invoke.success", { label, ...(detail || {}) });
  } catch (error) {
    onError("menu.invoke", error, { label, ...(detail || {}) });
    dialog.showErrorBox("Adjutorix Menu Action Failed", error instanceof Error ? error.message : String(error));
  }
}

async function confirmDestructive(
  window: BrowserWindow,
  title: string,
  message: string,
  detail?: string,
): Promise<boolean> {
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    buttons: ["Cancel", "Continue"],
    defaultId: 0,
    cancelId: 0,
    title,
    message,
    detail,
    normalizeAccessKeys: true,
    noLink: true,
  });
  return result.response === 1;
}

function themeChecked(theme: AppMenuTheme, current: AppMenuTheme): boolean {
  return theme === current;
}

function visibleWorkspacePath(state: MenuState): string {
  return state.workspace.currentPath ? truncateLabel(state.workspace.currentPath, 80) : "No Workspace Open";
}

function updateNativeTheme(theme: AppMenuTheme): void {
  nativeTheme.themeSource = theme;
}

// -----------------------------------------------------------------------------
// TEMPLATE BUILDERS
// -----------------------------------------------------------------------------

function buildAppMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError, window } = options;

  return {
    label: app.name,
    submenu: [
      {
        label: `About ${app.name}`,
        click: () => {
          void guardedInvoke("about", actions.about, audit, onError);
        },
      },
      { type: "separator" },
      {
        label: "Settings…",
        accelerator: IS_MAC ? "Cmd+," : "Ctrl+,",
        enabled: state.capability.canOpenSettings,
        click: () => {
          void guardedInvoke("open-settings", actions.openSettings, audit, onError);
        },
      },
      { type: "separator" },
      ...(IS_MAC
        ? ([
            { role: "services" as const },
            { type: "separator" as const },
            { role: "hide" as const },
            { role: "hideOthers" as const },
            { role: "unhide" as const },
            { type: "separator" as const },
          ] satisfies MenuItemConstructorOptions[])
        : []),
      { role: "quit" },
    ],
  };
}

function buildFileMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError, window } = options;
  const recent = normalizeRecentPaths(state.workspace.recentPaths);

  const recentMenu: MenuItemConstructorOptions[] = recent.length > 0
    ? recent.map((workspacePath) => ({
        label: truncateLabel(workspacePath, 90),
        click: () => {
          void guardedInvoke(
            "workspace-open-recent",
            () => actions.workspaceOpenRecent(workspacePath),
            audit,
            onError,
            { workspacePath },
          );
        },
      }))
    : [{ label: "No Recent Workspaces", enabled: false }];

  return {
    label: "File",
    submenu: [
      {
        label: "Open Workspace…",
        accelerator: IS_MAC ? "Cmd+O" : "Ctrl+O",
        enabled: state.capability.canOpenWorkspace,
        click: () => {
          void guardedInvoke("workspace-open", actions.workspaceOpen, audit, onError);
        },
      },
      {
        label: "Open Recent",
        submenu: recentMenu,
      },
      {
        label: "Reveal Workspace in File Manager",
        enabled: state.capability.canRevealWorkspace && !!state.workspace.currentPath,
        click: () => {
          void guardedInvoke("workspace-reveal", actions.workspaceReveal, audit, onError, {
            workspacePath: state.workspace.currentPath,
          });
        },
      },
      { type: "separator" },
      {
        label: "Close Workspace",
        enabled: !!state.workspace.currentPath,
        click: async () => {
          const proceed = state.workspace.isDirty
            ? await confirmDestructive(
                window,
                "Close Workspace",
                "The current workspace has unapplied or unsaved state.",
                "Closing now may interrupt review flow or leave diagnostics context behind.",
              )
            : true;

          if (!proceed) {
            audit("menu.invoke.cancelled", { label: "workspace-close" });
            return;
          }

          await guardedInvoke("workspace-close", actions.workspaceClose, audit, onError, {
            workspacePath: state.workspace.currentPath,
          });
        },
      },
      { type: "separator" },
      {
        label: "Export Diagnostics…",
        enabled: state.capability.canExportDiagnostics,
        click: () => {
          void guardedInvoke("export-diagnostics", actions.exportDiagnostics, audit, onError);
        },
      },
      { type: "separator" },
      IS_MAC ? { role: "close" } : { role: "quit" },
    ],
  };
}

function buildEditMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state } = options;

  return {
    label: "Edit",
    submenu: [
      { role: "undo" },
      { role: "redo" },
      { type: "separator" },
      { role: "cut" },
      { role: "copy" },
      { role: "paste" },
      { role: "selectAll" },
      { type: "separator" },
      {
        label: `Selection: ${state.workspace.selectionCount}`,
        enabled: false,
      },
    ],
  };
}

function buildActionsMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError, window } = options;

  return {
    label: "Actions",
    submenu: [
      {
        label: "Preview Patch",
        accelerator: IS_MAC ? "Cmd+Shift+P" : "Ctrl+Shift+P",
        enabled: state.capability.canPreviewPatch,
        click: () => {
          void guardedInvoke("patch-preview", actions.patchPreview, audit, onError, {
            workspacePath: state.workspace.currentPath,
          });
        },
      },
      {
        label: "Apply Patch",
        accelerator: IS_MAC ? "Cmd+Enter" : "Ctrl+Enter",
        enabled: state.capability.canApplyPatch,
        click: async () => {
          const proceed = await confirmDestructive(
            window,
            "Apply Patch",
            "Applying a patch mutates governed state.",
            "This action should only proceed when preview and verification evidence are satisfactory.",
          );
          if (!proceed) {
            audit("menu.invoke.cancelled", { label: "patch-apply" });
            return;
          }
          await guardedInvoke("patch-apply", actions.patchApply, audit, onError);
        },
      },
      { type: "separator" },
      {
        label: "Run Verify",
        accelerator: IS_MAC ? "Cmd+Shift+V" : "Ctrl+Shift+V",
        enabled: state.capability.canRunVerify,
        click: () => {
          void guardedInvoke("verify-run", actions.verifyRun, audit, onError, {
            workspacePath: state.workspace.currentPath,
          });
        },
      },
    ],
  };
}

function buildViewMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError } = options;

  return {
    label: "View",
    submenu: [
      {
        label: "Toggle Sidebar",
        accelerator: IS_MAC ? "Cmd+B" : "Ctrl+B",
        type: "checkbox",
        checked: state.view.sidebarVisible,
        click: () => {
          void guardedInvoke("toggle-sidebar", actions.toggleSidebar, audit, onError, {
            checked: !state.view.sidebarVisible,
          });
        },
      },
      {
        label: "Toggle Activity",
        accelerator: IS_MAC ? "Cmd+Shift+A" : "Ctrl+Shift+A",
        type: "checkbox",
        checked: state.view.activityVisible,
        click: () => {
          void guardedInvoke("toggle-activity", actions.toggleActivity, audit, onError, {
            checked: !state.view.activityVisible,
          });
        },
      },
      {
        label: "Toggle Panel",
        accelerator: IS_MAC ? "Cmd+J" : "Ctrl+J",
        type: "checkbox",
        checked: state.view.panelVisible,
        click: () => {
          void guardedInvoke("toggle-panel", actions.togglePanel, audit, onError, {
            checked: !state.view.panelVisible,
          });
        },
      },
      { type: "separator" },
      {
        label: "Reset Zoom",
        accelerator: IS_MAC ? "Cmd+0" : "Ctrl+0",
        click: () => {
          void guardedInvoke("zoom-reset", actions.resetZoom, audit, onError);
        },
      },
      {
        label: "Zoom In",
        accelerator: IS_MAC ? "Cmd+Plus" : "Ctrl+Plus",
        click: () => {
          void guardedInvoke("zoom-in", actions.zoomIn, audit, onError);
        },
      },
      {
        label: "Zoom Out",
        accelerator: IS_MAC ? "Cmd+-" : "Ctrl+-",
        click: () => {
          void guardedInvoke("zoom-out", actions.zoomOut, audit, onError);
        },
      },
      { type: "separator" },
      {
        label: "Theme",
        submenu: [
          {
            label: "System",
            type: "radio",
            checked: themeChecked("system", state.view.theme),
            click: () => {
              updateNativeTheme("system");
              void guardedInvoke("theme-system", () => actions.setTheme("system"), audit, onError);
            },
          },
          {
            label: "Light",
            type: "radio",
            checked: themeChecked("light", state.view.theme),
            click: () => {
              updateNativeTheme("light");
              void guardedInvoke("theme-light", () => actions.setTheme("light"), audit, onError);
            },
          },
          {
            label: "Dark",
            type: "radio",
            checked: themeChecked("dark", state.view.theme),
            click: () => {
              updateNativeTheme("dark");
              void guardedInvoke("theme-dark", () => actions.setTheme("dark"), audit, onError);
            },
          },
        ],
      },
      { type: "separator" },
      { role: "togglefullscreen", checked: state.view.fullscreen },
    ],
  };
}

function buildWindowMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError } = options;

  return {
    label: "Window",
    submenu: [
      { role: "minimize" },
      { role: "zoom" },
      ...(IS_MAC ? ([{ type: "separator" as const }, { role: "front" as const }] satisfies MenuItemConstructorOptions[]) : []),
      { type: "separator" },
      {
        label: `Workspace: ${visibleWorkspacePath(state)}`,
        enabled: false,
      },
    ],
  };
}

function buildAgentMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError } = options;

  return {
    label: "Agent",
    submenu: [
      {
        label: state.agent.healthy ? "Agent Healthy" : "Agent Unreachable",
        enabled: false,
      },
      {
        label: state.agent.configuredUrl ? truncateLabel(state.agent.configuredUrl, 80) : "No Agent URL Configured",
        enabled: false,
      },
      {
        label: state.agent.pid ? `PID ${state.agent.pid}` : "No Managed PID",
        enabled: false,
      },
      { type: "separator" },
      {
        label: "Start Agent",
        enabled: state.capability.canStartAgent,
        click: () => {
          void guardedInvoke("agent-start", actions.startAgent, audit, onError, {
            configuredUrl: state.agent.configuredUrl,
          });
        },
      },
      {
        label: "Stop Agent",
        enabled: state.capability.canStopAgent,
        click: async () => {
          const proceed = state.agent.managed
            ? true
            : false;
          if (!proceed) {
            audit("menu.invoke.cancelled", { label: "agent-stop", reason: "not-managed" });
            return;
          }
          await guardedInvoke("agent-stop", actions.stopAgent, audit, onError, {
            pid: state.agent.pid,
          });
        },
      },
      {
        label: "Open Logs Folder",
        enabled: state.capability.canOpenLogs,
        click: () => {
          void guardedInvoke("open-logs", actions.openLogs, audit, onError);
        },
      },
    ],
  };
}

function buildDeveloperMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { state, actions, audit, onError } = options;

  return {
    label: "Developer",
    submenu: [
      {
        label: "Reload Window",
        accelerator: IS_MAC ? "Cmd+R" : "Ctrl+R",
        enabled: state.capability.canReloadWindow,
        click: () => {
          void guardedInvoke("reload-window", actions.reloadWindow, audit, onError);
        },
      },
      {
        label: "Toggle DevTools",
        accelerator: IS_MAC ? "Alt+Cmd+I" : "Ctrl+Shift+I",
        enabled: state.capability.canOpenDevTools,
        click: () => {
          void guardedInvoke("toggle-devtools", actions.toggleDevTools, audit, onError);
        },
      },
      { type: "separator" },
      {
        label: `Version ${state.build.version}`,
        enabled: false,
      },
      {
        label: state.build.isPackaged ? "Packaged Build" : "Unpackaged Build",
        enabled: false,
      },
      {
        label: state.build.smokeMode ? "Smoke Mode" : "Normal Mode",
        enabled: false,
      },
    ],
  };
}

function buildHelpMenu(options: BuildMenuOptions): MenuItemConstructorOptions {
  const { actions, audit, onError } = options;

  return {
    label: "Help",
    submenu: [
      {
        label: "Documentation",
        click: () => {
          void guardedInvoke("open-docs", async () => {
            await actions.openDocs();
            await shell.openExternal(DOCS_URL);
          }, audit, onError);
        },
      },
      {
        label: "Report Issue",
        click: () => {
          void guardedInvoke("report-issue", async () => {
            await actions.reportIssue();
            await shell.openExternal(ISSUE_URL);
          }, audit, onError);
        },
      },
      { type: "separator" },
      {
        label: `About ${app.name}`,
        click: () => {
          void guardedInvoke("about-help", actions.about, audit, onError);
        },
      },
    ],
  };
}

// -----------------------------------------------------------------------------
// PUBLIC API
// -----------------------------------------------------------------------------

export function buildAppMenuTemplate(options: BuildMenuOptions): MenuItemConstructorOptions[] {
  const template: MenuItemConstructorOptions[] = [
    buildAppMenu(options),
    buildFileMenu(options),
    buildEditMenu(options),
    buildActionsMenu(options),
    buildViewMenu(options),
    buildWindowMenu(options),
    buildAgentMenu(options),
    buildDeveloperMenu(options),
    buildHelpMenu(options),
  ];

  return template;
}

export function installAppMenu(options: BuildMenuOptions): Menu {
  const template = buildAppMenuTemplate(options);
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
  options.audit("menu.installed", {
    items: template.length,
    workspacePath: options.state.workspace.currentPath,
    agentHealthy: options.state.agent.healthy,
  });
  return menu;
}

export function rebuildAppMenu(options: BuildMenuOptions): Menu {
  options.audit("menu.rebuild", {
    workspacePath: options.state.workspace.currentPath,
    recentCount: options.state.workspace.recentPaths.length,
    selectionCount: options.state.workspace.selectionCount,
    theme: options.state.view.theme,
  });
  return installAppMenu(options);
}

export function createDefaultMenuState(): MenuState {
  return {
    workspace: {
      currentPath: null,
      recentPaths: [],
      isDirty: false,
      hasSelection: false,
      selectionCount: 0,
    },
    capability: {
      canOpenWorkspace: true,
      canRevealWorkspace: false,
      canPreviewPatch: false,
      canApplyPatch: false,
      canRunVerify: false,
      canOpenDevTools: !app.isPackaged,
      canReloadWindow: true,
      canOpenLogs: true,
      canStartAgent: true,
      canStopAgent: false,
      canOpenSettings: true,
      canExportDiagnostics: true,
    },
    view: {
      theme: "system",
      sidebarVisible: true,
      activityVisible: true,
      panelVisible: true,
      zoomFactor: 1,
      fullscreen: false,
    },
    agent: {
      configuredUrl: null,
      healthy: false,
      managed: false,
      pid: null,
    },
    build: {
      version: app.getVersion(),
      platform: process.platform,
      isPackaged: app.isPackaged,
      devToolsEnabled: !app.isPackaged,
      smokeMode: process.env.ADJUTORIX_SMOKE_MODE === "1",
    },
  };
}
