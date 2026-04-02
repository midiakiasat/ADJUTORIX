import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { BrowserWindow, type Rectangle, screen } from "electron";

/**
 * ADJUTORIX APP — MAIN / window_state.ts
 *
 * Authoritative window state persistence, validation, reconciliation, and
 * restoration for the Electron main process.
 *
 * Responsibilities:
 * - persist window bounds + semantic state (normal/maximized/fullscreen)
 * - validate and repair stale/invalid geometry
 * - reconcile saved bounds against current display topology
 * - prevent off-screen restoration after monitor changes
 * - debounce writes while preserving crash-resistant state updates
 * - expose deterministic serialization and hashing for diagnostics/tests
 *
 * Hard invariants:
 * - persisted state is explicit and schema-versioned
 * - only valid, visible bounds are restored
 * - fullscreen/maximized states never corrupt normal bounds
 * - no renderer authority over persisted geometry
 * - state writes are atomic
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// TYPES
// -----------------------------------------------------------------------------

export type WindowMode = "normal" | "maximized" | "fullscreen";

export type WindowBounds = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type PersistedWindowState = {
  schema: 1;
  mode: WindowMode;
  normalBounds: WindowBounds;
  lastKnownDisplayScaleFactor: number;
  lastKnownDisplayId: number | null;
  isVisibleOnAllWorkspaces: boolean;
  hash: string;
};

export type WindowStateOptions = {
  filePath: string;
  defaultWidth: number;
  defaultHeight: number;
  minWidth: number;
  minHeight: number;
  margin?: number;
  debounceMs?: number;
};

export type RestoredWindowState = {
  bounds: WindowBounds;
  mode: WindowMode;
  show: boolean;
};

// -----------------------------------------------------------------------------
// CONSTANTS
// -----------------------------------------------------------------------------

const DEFAULT_MARGIN = 24;
const DEFAULT_DEBOUNCE_MS = 120;

// -----------------------------------------------------------------------------
// HELPERS
// -----------------------------------------------------------------------------

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`main:window_state:${message}`);
  }
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
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

function toBounds(rect: Rectangle): WindowBounds {
  return {
    x: Math.trunc(rect.x),
    y: Math.trunc(rect.y),
    width: Math.trunc(rect.width),
    height: Math.trunc(rect.height),
  };
}

function toRectangle(bounds: WindowBounds): Rectangle {
  return {
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isFiniteInt(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function validateBounds(bounds: WindowBounds, options: WindowStateOptions): void {
  assert(isFiniteInt(bounds.x), "bounds_x_invalid");
  assert(isFiniteInt(bounds.y), "bounds_y_invalid");
  assert(isFiniteInt(bounds.width), "bounds_width_invalid");
  assert(isFiniteInt(bounds.height), "bounds_height_invalid");
  assert(bounds.width >= options.minWidth, "bounds_width_below_min");
  assert(bounds.height >= options.minHeight, "bounds_height_below_min");
}

function defaultBounds(options: WindowStateOptions): WindowBounds {
  const primary = screen.getPrimaryDisplay().workArea;
  const width = clamp(options.defaultWidth, options.minWidth, primary.width);
  const height = clamp(options.defaultHeight, options.minHeight, primary.height);
  const x = Math.trunc(primary.x + (primary.width - width) / 2);
  const y = Math.trunc(primary.y + (primary.height - height) / 2);
  return { x, y, width, height };
}

function rectIntersectionArea(a: Rectangle, b: Rectangle): number {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  const width = Math.max(0, x2 - x1);
  const height = Math.max(0, y2 - y1);
  return width * height;
}

function bestDisplayForBounds(bounds: WindowBounds) {
  const rect = toRectangle(bounds);
  const displays = screen.getAllDisplays();
  let best = displays[0] ?? screen.getPrimaryDisplay();
  let bestArea = -1;

  for (const display of displays) {
    const area = rectIntersectionArea(rect, display.workArea);
    if (area > bestArea) {
      best = display;
      bestArea = area;
    }
  }

  return best;
}

function isReasonablyVisible(bounds: WindowBounds, margin: number): boolean {
  const rect = toRectangle(bounds);
  const displays = screen.getAllDisplays();
  return displays.some((display) => {
    const work = display.workArea;
    const expanded: Rectangle = {
      x: work.x - margin,
      y: work.y - margin,
      width: work.width + margin * 2,
      height: work.height + margin * 2,
    };
    return rectIntersectionArea(rect, expanded) > 0;
  });
}

function fitIntoDisplay(bounds: WindowBounds, options: WindowStateOptions): WindowBounds {
  const margin = options.margin ?? DEFAULT_MARGIN;
  const display = bestDisplayForBounds(bounds);
  const work = display.workArea;

  const width = clamp(bounds.width, options.minWidth, work.width);
  const height = clamp(bounds.height, options.minHeight, work.height);
  const x = clamp(bounds.x, work.x - margin, work.x + work.width - width + margin);
  const y = clamp(bounds.y, work.y - margin, work.y + work.height - height + margin);

  return {
    x: Math.trunc(x),
    y: Math.trunc(y),
    width: Math.trunc(width),
    height: Math.trunc(height),
  };
}

function normalizeState(raw: Omit<PersistedWindowState, "hash">): PersistedWindowState {
  const payload = {
    schema: 1 as const,
    mode: raw.mode,
    normalBounds: raw.normalBounds,
    lastKnownDisplayScaleFactor: raw.lastKnownDisplayScaleFactor,
    lastKnownDisplayId: raw.lastKnownDisplayId,
    isVisibleOnAllWorkspaces: raw.isVisibleOnAllWorkspaces,
  };
  return {
    ...payload,
    hash: sha256(stableJson(payload)),
  };
}

function validatePersistedState(state: PersistedWindowState, options: WindowStateOptions): void {
  assert(state.schema === 1, "schema_invalid");
  assert(state.mode === "normal" || state.mode === "maximized" || state.mode === "fullscreen", "mode_invalid");
  validateBounds(state.normalBounds, options);
  assert(typeof state.lastKnownDisplayScaleFactor === "number" && Number.isFinite(state.lastKnownDisplayScaleFactor), "display_scale_invalid");
  assert(state.lastKnownDisplayId === null || isFiniteInt(state.lastKnownDisplayId), "display_id_invalid");
  assert(typeof state.isVisibleOnAllWorkspaces === "boolean", "visible_on_all_workspaces_invalid");

  const recomputed = normalizeState({
    schema: 1,
    mode: state.mode,
    normalBounds: state.normalBounds,
    lastKnownDisplayScaleFactor: state.lastKnownDisplayScaleFactor,
    lastKnownDisplayId: state.lastKnownDisplayId,
    isVisibleOnAllWorkspaces: state.isVisibleOnAllWorkspaces,
  });
  assert(recomputed.hash === state.hash, "state_hash_drift");
}

function atomicWrite(filePath: string, content: string): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, filePath);
}

// -----------------------------------------------------------------------------
// STORE
// -----------------------------------------------------------------------------

export class WindowStateStore {
  private readonly options: Required<WindowStateOptions>;
  private saveTimer: NodeJS.Timeout | null = null;
  private latestState: PersistedWindowState | null = null;

  constructor(options: WindowStateOptions) {
    this.options = {
      ...options,
      margin: options.margin ?? DEFAULT_MARGIN,
      debounceMs: options.debounceMs ?? DEFAULT_DEBOUNCE_MS,
    };
  }

  load(): PersistedWindowState | null {
    if (!fs.existsSync(this.options.filePath)) {
      return null;
    }

    const raw = JSON.parse(fs.readFileSync(this.options.filePath, "utf8")) as PersistedWindowState;
    validatePersistedState(raw, this.options);
    this.latestState = raw;
    return raw;
  }

  restore(): RestoredWindowState {
    const loaded = this.load();

    if (!loaded) {
      return {
        bounds: defaultBounds(this.options),
        mode: "normal",
        show: true,
      };
    }

    let repaired = fitIntoDisplay(loaded.normalBounds, this.options);
    if (!isReasonablyVisible(repaired, this.options.margin)) {
      repaired = defaultBounds(this.options);
    }

    return {
      bounds: repaired,
      mode: loaded.mode,
      show: true,
    };
  }

  capture(window: BrowserWindow): PersistedWindowState {
    const normalBounds = window.isNormal() ? toBounds(window.getBounds()) : toBounds(window.getNormalBounds());
    validateBounds(normalBounds, this.options);

    const display = bestDisplayForBounds(normalBounds);
    const mode: WindowMode = window.isFullScreen() ? "fullscreen" : window.isMaximized() ? "maximized" : "normal";

    const next = normalizeState({
      schema: 1,
      mode,
      normalBounds,
      lastKnownDisplayScaleFactor: display.scaleFactor,
      lastKnownDisplayId: Number.isFinite(display.id) ? display.id : null,
      isVisibleOnAllWorkspaces: false,
    });

    this.latestState = next;
    return next;
  }

  saveNow(state: PersistedWindowState): void {
    validatePersistedState(state, this.options);
    atomicWrite(this.options.filePath, `${stableJson(state)}\n`);
    this.latestState = state;
  }

  scheduleSave(state: PersistedWindowState): void {
    validatePersistedState(state, this.options);
    this.latestState = state;

    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
    }

    this.saveTimer = setTimeout(() => {
      if (this.latestState) {
        this.saveNow(this.latestState);
      }
      this.saveTimer = null;
    }, this.options.debounceMs);
  }

  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.latestState) {
      this.saveNow(this.latestState);
    }
  }

  clear(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.latestState = null;
    if (fs.existsSync(this.options.filePath)) {
      fs.rmSync(this.options.filePath, { force: true });
    }
  }

  current(): PersistedWindowState | null {
    return this.latestState;
  }
}

// -----------------------------------------------------------------------------
// WINDOW INTEGRATION
// -----------------------------------------------------------------------------

export function attachWindowStatePersistence(window: BrowserWindow, store: WindowStateStore): void {
  const persist = (): void => {
    try {
      const state = store.capture(window);
      store.scheduleSave(state);
    } catch {
      // Fail closed: skip invalid write, preserve prior valid state.
    }
  };

  window.on("resize", persist);
  window.on("move", persist);
  window.on("maximize", persist);
  window.on("unmaximize", persist);
  window.on("enter-full-screen", persist);
  window.on("leave-full-screen", persist);
  window.on("close", () => {
    try {
      store.flush();
    } catch {
      // ignore close-path persistence failure
    }
  });
}

export function applyRestoredWindowState(window: BrowserWindow, restored: RestoredWindowState): void {
  window.setBounds(toRectangle(restored.bounds), false);
  if (restored.mode === "maximized") {
    window.maximize();
  } else if (restored.mode === "fullscreen") {
    window.setFullScreen(true);
  }
}

// -----------------------------------------------------------------------------
// FACTORY HELPERS
// -----------------------------------------------------------------------------

export function createWindowStateStore(options: WindowStateOptions): WindowStateStore {
  return new WindowStateStore(options);
}

export function defaultWindowStateFile(runtimeStateRoot: string): string {
  return path.join(runtimeStateRoot, "window-state.json");
}
