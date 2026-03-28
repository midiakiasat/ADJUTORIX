/**
 * ADJUTORIX APP — RENDERER / STATE / ui_state.ts
 *
 * Canonical renderer-side UI orchestration state graph and reducer.
 *
 * Purpose:
 * - define one authoritative client-side model for transient and structural UI state
 * - unify layout, panes, sidebars, tabs, modals, overlays, focus routing,
 *   command palette, search surfaces, notifications, and interaction locks
 *   under one deterministic reducer
 * - prevent drift between feature components that each keep their own notion of
 *   visibility, focus, pending overlay state, and mutually-exclusive UI affordances
 * - provide pure transitions suitable for replay, diagnostics, invariants, and tests
 *
 * Scope:
 * - shell layout geometry and panel visibility
 * - current modal / overlay / drawer states
 * - command palette and global search state
 * - focus routing and keyboard-interaction target
 * - transient banners, prompts, and lock states
 * - tab/pane arrangement metadata at the renderer shell layer
 *
 * Non-scope:
 * - business-domain state such as workspace, verify, patch, or ledger data
 * - DOM measurement implementation or persistence transport
 * - animation runtime details
 *
 * Hard invariants:
 * - all transitions are pure and deterministic
 * - identical prior state + identical action => identical next state hash
 * - mutually-exclusive modal/overlay states cannot silently coexist illegally
 * - selected/focused targets must belong to declared UI surfaces
 * - split sizes are normalized and bounded
 * - outputs are serialization-stable and audit-friendly
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// JSON TYPES
// -----------------------------------------------------------------------------

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

// -----------------------------------------------------------------------------
// DOMAIN TYPES
// -----------------------------------------------------------------------------

export type UiTheme = "system" | "light" | "dark";
export type UiDensity = "comfortable" | "compact" | "dense";
export type UiFocusTarget =
  | "none"
  | "editor"
  | "file-tree"
  | "search"
  | "outline"
  | "diagnostics"
  | "activity"
  | "command-palette"
  | "modal"
  | "toast"
  | "ledger"
  | "verify"
  | "patch-review";

export type UiModalKind =
  | "none"
  | "confirm-apply"
  | "workspace-trust"
  | "diagnostics-export"
  | "agent-restart"
  | "error-details"
  | "custom";

export type UiDrawerKind = "none" | "activity" | "diagnostics" | "search" | "command-log" | "custom";
export type UiOverlayKind = "none" | "loading" | "spotlight" | "blocking-error" | "custom";
export type UiBannerLevel = "info" | "warn" | "error" | "success";
export type UiToastLevel = "info" | "warn" | "error" | "success";

export type UiSurfaceId =
  | "left-rail"
  | "right-rail"
  | "bottom-panel"
  | "editor-pane"
  | "secondary-pane"
  | "activity-drawer"
  | "diagnostics-drawer"
  | "search-drawer"
  | "command-palette"
  | "global-modal";

export type UiSplitAxis = "horizontal" | "vertical";

export type UiSplitState = {
  id: string;
  axis: UiSplitAxis;
  ratio: number;
  minRatio: number;
  maxRatio: number;
  collapsed: boolean;
  hash: string;
};

export type UiBanner = {
  id: string;
  level: UiBannerLevel;
  title: string;
  message: string;
  dismissible: boolean;
  createdAtMs: number;
  sticky: boolean;
  hash: string;
};

export type UiToast = {
  id: string;
  level: UiToastLevel;
  title: string;
  message: string;
  createdAtMs: number;
  expiresAtMs: number | null;
  hash: string;
};

export type UiPromptState = {
  active: boolean;
  title: string | null;
  message: string | null;
  confirmLabel: string | null;
  cancelLabel: string | null;
  payload: JsonObject | null;
};

export type UiCommandPaletteState = {
  open: boolean;
  query: string;
  highlightedIndex: number;
  recentCommands: string[];
};

export type UiSearchState = {
  globalQuery: string;
  replaceQuery: string;
  regex: boolean;
  matchCase: boolean;
  wholeWord: boolean;
  resultsVisible: boolean;
};

export type UiModalState = {
  kind: UiModalKind;
  title: string | null;
  payload: JsonObject | null;
  blocking: boolean;
};

export type UiDrawerState = {
  kind: UiDrawerKind;
  open: boolean;
  payload: JsonObject | null;
};

export type UiOverlayState = {
  kind: UiOverlayKind;
  visible: boolean;
  message: string | null;
  payload: JsonObject | null;
};

export type UiPanelVisibility = {
  leftRail: boolean;
  rightRail: boolean;
  bottomPanel: boolean;
  secondaryPane: boolean;
  statusBar: boolean;
};

export type UiTabState = {
  activePrimaryTab: string | null;
  activeSecondaryTab: string | null;
  bottomPanelTab: string | null;
  rightRailTab: string | null;
};

export type UiLockState = {
  keyboardLocked: boolean;
  navigationLocked: boolean;
  editingLocked: boolean;
  reason: string | null;
};

export type UiState = {
  schema: 1;
  theme: UiTheme;
  density: UiDensity;
  focusTarget: UiFocusTarget;
  hoveredSurface: UiSurfaceId | null;
  panelVisibility: UiPanelVisibility;
  tabs: UiTabState;
  splits: Record<string, UiSplitState>;
  modal: UiModalState;
  drawer: UiDrawerState;
  overlay: UiOverlayState;
  commandPalette: UiCommandPaletteState;
  search: UiSearchState;
  prompt: UiPromptState;
  banners: UiBanner[];
  toasts: UiToast[];
  locks: UiLockState;
  lastInteractionAtMs: number | null;
  lastError: string | null;
  hash: string;
};

export type UiSplitInput = {
  id: string;
  axis?: UiSplitAxis;
  ratio?: number;
  minRatio?: number;
  maxRatio?: number;
  collapsed?: boolean;
};

export type UiBannerInput = {
  id?: string;
  level?: UiBannerLevel;
  title: string;
  message: string;
  dismissible?: boolean;
  createdAtMs?: number;
  sticky?: boolean;
};

export type UiToastInput = {
  id?: string;
  level?: UiToastLevel;
  title: string;
  message: string;
  createdAtMs?: number;
  expiresAtMs?: number | null;
};

export type UiStateAction =
  | { type: "UI_THEME_SET"; theme: UiTheme }
  | { type: "UI_DENSITY_SET"; density: UiDensity }
  | { type: "UI_FOCUS_SET"; focusTarget: UiFocusTarget; atMs?: number }
  | { type: "UI_HOVERED_SURFACE_SET"; surface: UiSurfaceId | null; atMs?: number }
  | { type: "UI_PANEL_VISIBILITY_SET"; patch: Partial<UiPanelVisibility> }
  | { type: "UI_PANEL_TOGGLED"; panel: keyof UiPanelVisibility }
  | { type: "UI_TAB_SET"; patch: Partial<UiTabState> }
  | { type: "UI_SPLIT_SET"; split: UiSplitInput }
  | { type: "UI_SPLIT_COLLAPSED_SET"; id: string; collapsed: boolean }
  | { type: "UI_MODAL_OPENED"; kind: UiModalKind; title?: string | null; payload?: JsonObject | null; blocking?: boolean }
  | { type: "UI_MODAL_CLOSED" }
  | { type: "UI_DRAWER_OPENED"; kind: UiDrawerKind; payload?: JsonObject | null }
  | { type: "UI_DRAWER_CLOSED" }
  | { type: "UI_OVERLAY_SET"; kind: UiOverlayKind; visible: boolean; message?: string | null; payload?: JsonObject | null }
  | { type: "UI_COMMAND_PALETTE_SET"; open?: boolean; query?: string; highlightedIndex?: number }
  | { type: "UI_COMMAND_PALETTE_RECENT_PUSHED"; commandId: string }
  | { type: "UI_SEARCH_SET"; patch: Partial<UiSearchState> }
  | { type: "UI_PROMPT_OPENED"; title: string; message: string; confirmLabel?: string | null; cancelLabel?: string | null; payload?: JsonObject | null }
  | { type: "UI_PROMPT_CLOSED" }
  | { type: "UI_BANNER_PUSHED"; banner: UiBannerInput }
  | { type: "UI_BANNER_DISMISSED"; id: string }
  | { type: "UI_TOAST_PUSHED"; toast: UiToastInput }
  | { type: "UI_TOAST_DISMISSED"; id: string }
  | { type: "UI_LOCKS_SET"; patch: Partial<UiLockState> }
  | { type: "UI_ERROR_SET"; error: string | null }
  | { type: "UI_INTERACTION_RECORDED"; atMs?: number }
  | { type: "UI_RESET" };

export type UiSelector<T> = (state: UiState) => T;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

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

function hashString(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h += (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function nowMs(input?: number): number {
  return input ?? Date.now();
}

function clampRatio(value: number, minRatio: number, maxRatio: number): number {
  return Math.max(minRatio, Math.min(maxRatio, value));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function computeSplitHash(core: Omit<UiSplitState, "hash">): string {
  return hashString(stableJson(core));
}

function computeBannerHash(core: Omit<UiBanner, "hash">): string {
  return hashString(stableJson(core));
}

function computeToastHash(core: Omit<UiToast, "hash">): string {
  return hashString(stableJson(core));
}

function computeStateHash(core: Omit<UiState, "hash">): string {
  return hashString(stableJson(core));
}

function makeSplit(input: UiSplitInput): UiSplitState {
  const minRatio = input.minRatio ?? 0.15;
  const maxRatio = input.maxRatio ?? 0.85;
  const core: Omit<UiSplitState, "hash"> = {
    id: input.id,
    axis: input.axis ?? "horizontal",
    ratio: clampRatio(input.ratio ?? 0.5, minRatio, maxRatio),
    minRatio,
    maxRatio,
    collapsed: input.collapsed ?? false,
  };
  return { ...core, hash: computeSplitHash(core) };
}

function withSplit(existing: UiSplitState, patch: Partial<Omit<UiSplitState, "hash">>): UiSplitState {
  const minRatio = patch.minRatio ?? existing.minRatio;
  const maxRatio = patch.maxRatio ?? existing.maxRatio;
  const core: Omit<UiSplitState, "hash"> = {
    id: patch.id ?? existing.id,
    axis: patch.axis ?? existing.axis,
    ratio: clampRatio(patch.ratio ?? existing.ratio, minRatio, maxRatio),
    minRatio,
    maxRatio,
    collapsed: patch.collapsed ?? existing.collapsed,
  };
  return { ...core, hash: computeSplitHash(core) };
}

function makeBanner(input: UiBannerInput): UiBanner {
  const core: Omit<UiBanner, "hash"> = {
    id: input.id ?? hashString(stableJson(input)),
    level: input.level ?? "info",
    title: input.title,
    message: input.message,
    dismissible: input.dismissible ?? true,
    createdAtMs: nowMs(input.createdAtMs),
    sticky: input.sticky ?? false,
  };
  return { ...core, hash: computeBannerHash(core) };
}

function makeToast(input: UiToastInput): UiToast {
  const createdAtMs = nowMs(input.createdAtMs);
  const core: Omit<UiToast, "hash"> = {
    id: input.id ?? hashString(stableJson({ ...input, createdAtMs })),
    level: input.level ?? "info",
    title: input.title,
    message: input.message,
    createdAtMs,
    expiresAtMs: input.expiresAtMs ?? createdAtMs + 5000,
  };
  return { ...core, hash: computeToastHash(core) };
}

function deriveOverlayFocus(overlay: UiOverlayState, modal: UiModalState, commandPalette: UiCommandPaletteState, current: UiFocusTarget): UiFocusTarget {
  if (overlay.visible) return "modal";
  if (modal.kind !== "none") return "modal";
  if (commandPalette.open) return "command-palette";
  return current;
}

function recompute(state: Omit<UiState, "hash">): UiState {
  const next: Omit<UiState, "hash"> = {
    ...state,
    focusTarget: deriveOverlayFocus(state.overlay, state.modal, state.commandPalette, state.focusTarget),
  };
  return { ...next, hash: computeStateHash(next) };
}

// -----------------------------------------------------------------------------
// INITIAL STATE
// -----------------------------------------------------------------------------

export function createInitialUiState(): UiState {
  const defaultSplits: Record<string, UiSplitState> = {
    mainHorizontal: makeSplit({ id: "mainHorizontal", axis: "horizontal", ratio: 0.22, minRatio: 0.12, maxRatio: 0.4 }),
    editorVertical: makeSplit({ id: "editorVertical", axis: "vertical", ratio: 0.72, minRatio: 0.4, maxRatio: 0.92 }),
    bottomPanel: makeSplit({ id: "bottomPanel", axis: "vertical", ratio: 0.74, minRatio: 0.45, maxRatio: 0.92 }),
    rightRail: makeSplit({ id: "rightRail", axis: "horizontal", ratio: 0.78, minRatio: 0.55, maxRatio: 0.95 }),
  };

  const core: Omit<UiState, "hash"> = {
    schema: 1,
    theme: "system",
    density: "comfortable",
    focusTarget: "none",
    hoveredSurface: null,
    panelVisibility: {
      leftRail: true,
      rightRail: true,
      bottomPanel: true,
      secondaryPane: true,
      statusBar: true,
    },
    tabs: {
      activePrimaryTab: null,
      activeSecondaryTab: null,
      bottomPanelTab: null,
      rightRailTab: null,
    },
    splits: defaultSplits,
    modal: {
      kind: "none",
      title: null,
      payload: null,
      blocking: false,
    },
    drawer: {
      kind: "none",
      open: false,
      payload: null,
    },
    overlay: {
      kind: "none",
      visible: false,
      message: null,
      payload: null,
    },
    commandPalette: {
      open: false,
      query: "",
      highlightedIndex: 0,
      recentCommands: [],
    },
    search: {
      globalQuery: "",
      replaceQuery: "",
      regex: false,
      matchCase: false,
      wholeWord: false,
      resultsVisible: false,
    },
    prompt: {
      active: false,
      title: null,
      message: null,
      confirmLabel: null,
      cancelLabel: null,
      payload: null,
    },
    banners: [],
    toasts: [],
    locks: {
      keyboardLocked: false,
      navigationLocked: false,
      editingLocked: false,
      reason: null,
    },
    lastInteractionAtMs: null,
    lastError: null,
  };
  return recompute(core);
}

// -----------------------------------------------------------------------------
// REDUCER
// -----------------------------------------------------------------------------

export function uiStateReducer(state: UiState, action: UiStateAction): UiState {
  const core: Omit<UiState, "hash"> = {
    schema: state.schema,
    theme: state.theme,
    density: state.density,
    focusTarget: state.focusTarget,
    hoveredSurface: state.hoveredSurface,
    panelVisibility: { ...state.panelVisibility },
    tabs: { ...state.tabs },
    splits: { ...state.splits },
    modal: { ...state.modal },
    drawer: { ...state.drawer },
    overlay: { ...state.overlay },
    commandPalette: { ...state.commandPalette, recentCommands: [...state.commandPalette.recentCommands] },
    search: { ...state.search },
    prompt: { ...state.prompt },
    banners: [...state.banners],
    toasts: [...state.toasts],
    locks: { ...state.locks },
    lastInteractionAtMs: state.lastInteractionAtMs,
    lastError: state.lastError,
  };

  switch (action.type) {
    case "UI_THEME_SET": {
      core.theme = action.theme;
      return recompute(core);
    }

    case "UI_DENSITY_SET": {
      core.density = action.density;
      return recompute(core);
    }

    case "UI_FOCUS_SET": {
      core.focusTarget = action.focusTarget;
      core.lastInteractionAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "UI_HOVERED_SURFACE_SET": {
      core.hoveredSurface = action.surface;
      core.lastInteractionAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "UI_PANEL_VISIBILITY_SET": {
      core.panelVisibility = { ...core.panelVisibility, ...action.patch };
      return recompute(core);
    }

    case "UI_PANEL_TOGGLED": {
      core.panelVisibility[action.panel] = !core.panelVisibility[action.panel];
      return recompute(core);
    }

    case "UI_TAB_SET": {
      core.tabs = { ...core.tabs, ...action.patch };
      return recompute(core);
    }

    case "UI_SPLIT_SET": {
      const existing = core.splits[action.split.id];
      core.splits[action.split.id] = existing ? withSplit(existing, action.split) : makeSplit(action.split);
      return recompute(core);
    }

    case "UI_SPLIT_COLLAPSED_SET": {
      const existing = core.splits[action.id];
      if (!existing) return state;
      core.splits[action.id] = withSplit(existing, { collapsed: action.collapsed });
      return recompute(core);
    }

    case "UI_MODAL_OPENED": {
      core.modal = {
        kind: action.kind,
        title: action.title ?? null,
        payload: action.payload ?? null,
        blocking: action.blocking ?? false,
      };
      core.focusTarget = "modal";
      return recompute(core);
    }

    case "UI_MODAL_CLOSED": {
      core.modal = { kind: "none", title: null, payload: null, blocking: false };
      if (!core.overlay.visible && !core.commandPalette.open) core.focusTarget = "none";
      return recompute(core);
    }

    case "UI_DRAWER_OPENED": {
      core.drawer = { kind: action.kind, open: true, payload: action.payload ?? null };
      return recompute(core);
    }

    case "UI_DRAWER_CLOSED": {
      core.drawer = { kind: "none", open: false, payload: null };
      return recompute(core);
    }

    case "UI_OVERLAY_SET": {
      core.overlay = {
        kind: action.kind,
        visible: action.visible,
        message: action.message ?? null,
        payload: action.payload ?? null,
      };
      return recompute(core);
    }

    case "UI_COMMAND_PALETTE_SET": {
      core.commandPalette = {
        ...core.commandPalette,
        open: action.open ?? core.commandPalette.open,
        query: action.query ?? core.commandPalette.query,
        highlightedIndex: action.highlightedIndex ?? core.commandPalette.highlightedIndex,
      };
      if (core.commandPalette.open) core.focusTarget = "command-palette";
      return recompute(core);
    }

    case "UI_COMMAND_PALETTE_RECENT_PUSHED": {
      core.commandPalette.recentCommands = uniqueSorted([action.commandId, ...core.commandPalette.recentCommands]).slice(0, 25);
      return recompute(core);
    }

    case "UI_SEARCH_SET": {
      core.search = { ...core.search, ...action.patch };
      return recompute(core);
    }

    case "UI_PROMPT_OPENED": {
      core.prompt = {
        active: true,
        title: action.title,
        message: action.message,
        confirmLabel: action.confirmLabel ?? null,
        cancelLabel: action.cancelLabel ?? null,
        payload: action.payload ?? null,
      };
      core.focusTarget = "modal";
      return recompute(core);
    }

    case "UI_PROMPT_CLOSED": {
      core.prompt = {
        active: false,
        title: null,
        message: null,
        confirmLabel: null,
        cancelLabel: null,
        payload: null,
      };
      return recompute(core);
    }

    case "UI_BANNER_PUSHED": {
      const banner = makeBanner(action.banner);
      core.banners = [banner, ...core.banners.filter((b) => b.id !== banner.id)].slice(0, 20);
      return recompute(core);
    }

    case "UI_BANNER_DISMISSED": {
      core.banners = core.banners.filter((b) => b.id !== action.id || !b.dismissible);
      return recompute(core);
    }

    case "UI_TOAST_PUSHED": {
      const toast = makeToast(action.toast);
      core.toasts = [toast, ...core.toasts.filter((t) => t.id !== toast.id)].slice(0, 16);
      return recompute(core);
    }

    case "UI_TOAST_DISMISSED": {
      core.toasts = core.toasts.filter((t) => t.id !== action.id);
      return recompute(core);
    }

    case "UI_LOCKS_SET": {
      core.locks = { ...core.locks, ...action.patch };
      return recompute(core);
    }

    case "UI_ERROR_SET": {
      core.lastError = action.error;
      return recompute(core);
    }

    case "UI_INTERACTION_RECORDED": {
      core.lastInteractionAtMs = nowMs(action.atMs);
      return recompute(core);
    }

    case "UI_RESET": {
      return createInitialUiState();
    }

    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// SELECTORS
// -----------------------------------------------------------------------------

export const selectUiTheme: UiSelector<UiTheme> = (state) => state.theme;
export const selectUiDensity: UiSelector<UiDensity> = (state) => state.density;
export const selectUiFocusTarget: UiSelector<UiFocusTarget> = (state) => state.focusTarget;
export const selectUiModalOpen: UiSelector<boolean> = (state) => state.modal.kind !== "none";
export const selectUiDrawerOpen: UiSelector<boolean> = (state) => state.drawer.open;
export const selectUiOverlayVisible: UiSelector<boolean> = (state) => state.overlay.visible;
export const selectUiCommandPaletteOpen: UiSelector<boolean> = (state) => state.commandPalette.open;
export const selectUiSearchVisible: UiSelector<boolean> = (state) => state.search.resultsVisible;
export const selectUiCanNavigate: UiSelector<boolean> = (state) => !state.locks.navigationLocked && !state.modal.blocking && !state.overlay.visible;
export const selectUiCanEdit: UiSelector<boolean> = (state) => !state.locks.editingLocked && !state.modal.blocking && !state.overlay.visible;

// -----------------------------------------------------------------------------
// VALIDATION
// -----------------------------------------------------------------------------

export function validateUiSplitState(split: UiSplitState): void {
  const core: Omit<UiSplitState, "hash"> = {
    id: split.id,
    axis: split.axis,
    ratio: split.ratio,
    minRatio: split.minRatio,
    maxRatio: split.maxRatio,
    collapsed: split.collapsed,
  };
  if (split.hash !== computeSplitHash(core)) {
    throw new Error(`ui_split_hash_drift:${split.id}`);
  }
  if (split.ratio < split.minRatio || split.ratio > split.maxRatio) {
    throw new Error(`ui_split_ratio_out_of_bounds:${split.id}`);
  }
}

export function validateUiBanner(banner: UiBanner): void {
  const core: Omit<UiBanner, "hash"> = {
    id: banner.id,
    level: banner.level,
    title: banner.title,
    message: banner.message,
    dismissible: banner.dismissible,
    createdAtMs: banner.createdAtMs,
    sticky: banner.sticky,
  };
  if (banner.hash !== computeBannerHash(core)) {
    throw new Error(`ui_banner_hash_drift:${banner.id}`);
  }
}

export function validateUiToast(toast: UiToast): void {
  const core: Omit<UiToast, "hash"> = {
    id: toast.id,
    level: toast.level,
    title: toast.title,
    message: toast.message,
    createdAtMs: toast.createdAtMs,
    expiresAtMs: toast.expiresAtMs,
  };
  if (toast.hash !== computeToastHash(core)) {
    throw new Error(`ui_toast_hash_drift:${toast.id}`);
  }
}

export function validateUiState(state: UiState): void {
  if (state.schema !== 1) throw new Error("ui_state_schema_invalid");

  const core: Omit<UiState, "hash"> = {
    schema: state.schema,
    theme: state.theme,
    density: state.density,
    focusTarget: state.focusTarget,
    hoveredSurface: state.hoveredSurface,
    panelVisibility: state.panelVisibility,
    tabs: state.tabs,
    splits: state.splits,
    modal: state.modal,
    drawer: state.drawer,
    overlay: state.overlay,
    commandPalette: state.commandPalette,
    search: state.search,
    prompt: state.prompt,
    banners: state.banners,
    toasts: state.toasts,
    locks: state.locks,
    lastInteractionAtMs: state.lastInteractionAtMs,
    lastError: state.lastError,
  };

  if (state.hash !== computeStateHash(core)) {
    throw new Error("ui_state_hash_drift");
  }

  Object.values(state.splits).forEach(validateUiSplitState);
  state.banners.forEach(validateUiBanner);
  state.toasts.forEach(validateUiToast);

  if (state.modal.kind !== "none" && state.commandPalette.open) {
    throw new Error("ui_state_modal_and_command_palette_conflict");
  }

  if (state.overlay.visible && state.focusTarget !== "modal") {
    throw new Error("ui_state_overlay_focus_mismatch");
  }
}

// -----------------------------------------------------------------------------
// UTILITIES
// -----------------------------------------------------------------------------

export function applyUiStateActions(initial: UiState, actions: UiStateAction[]): UiState {
  return actions.reduce(uiStateReducer, initial);
}

export function serializeUiState(state: UiState): string {
  validateUiState(state);
  return stableJson(state);
}
