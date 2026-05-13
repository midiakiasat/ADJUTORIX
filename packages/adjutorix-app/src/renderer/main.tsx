// @ts-nocheck
import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createRoot } from "react-dom/client";
import AppShell from "./components/AppShell";
import WelcomeScreen from "./components/WelcomeScreen";
import ProviderStatus from "./components/ProviderStatus";
import FileTreePane from "./components/FileTreePane";
import MonacoEditorPane from "./components/MonacoEditorPane";
import DiffViewerPane from "./components/DiffViewerPane";
import TerminalPanel from "./components/TerminalPanel";
import ChatPanel from "./components/ChatPanel";
import CommandPalette from "./components/CommandPalette";
import { createInitialEditorBuffersState, editorBuffersReducer } from "./state/editor_buffers";
import "./styles/theme.css";
import "./styles/layout.css";
import "./styles/app.css";
import { createInitialInteractionContractState, recordInteraction } from "./lib/interaction_contract";


/**
 * ADJUTORIX APP — RENDERER / main.tsx
 *
 * Canonical renderer bootstrap and composition root.
 *
 * Purpose:
 * - own renderer startup sequencing and deterministic mount behavior
 * - verify preload bridge compatibility before any feature code runs
 * - establish global providers for runtime state, events, notifications, diagnostics,
 *   and command dispatch
 * - wire preload event streams into a stable client-side state machine
 * - provide a hardened failure boundary for early renderer/bootstrap faults
 * - avoid feature components directly bootstrapping themselves or reaching into
 *   ambient globals without normalization
 *
 * This file is intentionally architectural. It is the renderer’s singular entrypoint.
 *
 * Hard invariants:
 * - renderer does not mount until preload/exposed API compatibility is validated
 * - all preload calls are normalized through a single facade boundary
 * - event subscriptions are registered centrally and torn down deterministically
 * - runtime bootstrap state is explicit (booting / ready / degraded / failed)
 * - identical bootstrap inputs yield identical initial client state snapshots
 * - failure UI is renderable without any downstream feature initialization succeeding
 *
 * NO PLACEHOLDERS.
 */

// -----------------------------------------------------------------------------
// GLOBAL TYPE FALLBACKS
// -----------------------------------------------------------------------------

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type Envelope<T extends JsonValue = JsonValue> =
  | {
      ok: true;
      data: T;
      meta: { channel: string; requestHash: string };
    }
  | {
      ok: false;
      error: { code: string; message: string; detail?: JsonObject };
      meta: { channel: string; requestHash: string };
    };

type EventPayload = {
  kind: string;
  snapshot: JsonObject;
  detail: JsonObject;
};

type EventSubscription = {
  active: boolean;
  unsubscribe: () => void;
  channel: string;
  lastPayload: JsonValue | null;
};

type AdjutorixExposedApi = {
  manifest: {
    version: 1;
    name: string;
    bridgeVersion: number;
    bridgeName: string;
    capabilities: string[];
  };
  runtime: {
    snapshot: () => Promise<Envelope<JsonObject>>;
  };
  workspace: {
    open: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    close: () => Promise<Envelope<JsonObject>>;
    reveal: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    health: () => Promise<Envelope<JsonObject>>;
    trust: {
      read: () => Promise<Envelope<JsonObject>>;
      set: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    };
    events: {
      subscribe: (cb: (payload: EventPayload) => void) => EventSubscription;
    };
  };
  patch: {
    preview: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    approve: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    apply: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    clear: () => Promise<Envelope<JsonObject>>;
    events: {
      subscribe: (cb: (payload: EventPayload) => void) => EventSubscription;
    };
  };
  verify: {
    run: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    status: (input?: JsonObject) => Promise<Envelope<JsonObject>>;
    bind: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    events: {
      subscribe: (cb: (payload: EventPayload) => void) => EventSubscription;
    };
  };
  ledger: {
    current: () => Promise<Envelope<JsonObject>>;
    timeline: (input?: JsonObject) => Promise<Envelope<JsonObject>>;
    entry: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    heads: () => Promise<Envelope<JsonObject>>;
    stats: () => Promise<Envelope<JsonObject>>;
  };
  diagnostics: {
    runtime: () => Promise<Envelope<JsonObject>>;
    startup: () => Promise<Envelope<JsonObject>>;
    observability: () => Promise<Envelope<JsonObject>>;
    logTail: (input: JsonObject) => Promise<Envelope<JsonObject>>;
    crashContext: () => Promise<Envelope<JsonObject>>;
    export: (input?: JsonObject) => Promise<Envelope<JsonObject>>;
    events: {
      subscribe: (cb: (payload: EventPayload) => void) => EventSubscription;
    };
  };
  agent: {
    health: () => Promise<Envelope<JsonObject>>;
    status: () => Promise<Envelope<JsonObject>>;
    start: (input?: JsonObject) => Promise<Envelope<JsonObject>>;
    stop: (input?: JsonObject) => Promise<Envelope<JsonObject>>;
    events: {
      subscribe: (cb: (payload: EventPayload) => void) => EventSubscription;
    };
  };
  compatibility: {
    manifest: () => {
      version: 1;
      name: string;
      bridgeVersion: number;
      bridgeName: string;
      capabilities: string[];
    };
    isCompatibleBridgeMeta: (meta: { version: number; bridge: string }) => boolean;
    assertCompatibleBridgeMeta: (meta: { version: number; bridge: string }) => void;
    hasCapability: (capability: string) => boolean;
    listCapabilities: () => string[];
  };
};

declare global {
  interface Window {
    adjutorixApi?: AdjutorixExposedApi;
    adjutorix?: unknown;
  }
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asPrettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function createHashLike(value: unknown): string {
  const text = stableJson(value);
  let acc = 0;
  for (let i = 0; i < text.length; i += 1) {
    acc = (acc * 31 + text.charCodeAt(i)) >>> 0;
  }
  return acc.toString(16).padStart(8, "0");
}


function stableJsonStringify(value: unknown): string {
  const normalize = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") return input;
    if (Array.isArray(input)) return input.map(normalize);

    const output: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      output[key] = normalize((input as Record<string, unknown>)[key]);
    }
    return output;
  };

  return JSON.stringify(normalize(value));
}

function stableHash(value: unknown): string {
  const text = stableJsonStringify(value);
  let hash = 0;

  for (let index = 0; index < text.length; index += 1) {
    hash = (Math.imul(hash, 31) + text.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16).padStart(8, "0");
}

function isEnvelope(value: unknown): value is Envelope<JsonValue> {
  return isObject(value) && typeof value.ok === "boolean" && isObject(value.meta);
}

function ok<T extends JsonValue>(data: T, channel: string, requestHash: string): Envelope<T> {
  return { ok: true, data, meta: { channel, requestHash } };
}

function err(code: string, message: string, channel: string, requestHash: string, detail?: JsonObject): Envelope<JsonValue> {
  return {
    ok: false,
    error: { code, message, ...(detail ? { detail } : {}) },
    meta: { channel, requestHash },
  };
}


function adaptLegacyBridge(legacy: any): AdjutorixExposedApi {
  const meta = legacy?.meta ?? { version: 1, bridge: "adjutorix-legacy" };
  const manifest = {
    version: 1 as const,
    name: "adjutorixApi",
    bridgeVersion: typeof meta.version === "number" ? meta.version : 1,
    bridgeName: typeof meta.bridge === "string" ? meta.bridge : "adjutorix-legacy",
    capabilities: [
      "runtime",
      "workspace",
      "patch",
      "verify",
      "ledger",
      "diagnostics",
      "agent",
    ].filter((key) => typeof legacy?.[key] === "object"),
  };

  return {
    manifest,
    runtime: legacy.runtime,
    workspace: legacy.workspace,
    patch: legacy.patch,
    verify: legacy.verify,
    ledger: legacy.ledger,
    diagnostics: legacy.diagnostics,
    agent: legacy.agent,
    compatibility: {
      manifest: () => manifest,
      isCompatibleBridgeMeta: (input: { version: number; bridge: string }) =>
        Boolean(input) &&
        typeof input.version === "number" &&
        typeof input.bridge === "string",
      assertCompatibleBridgeMeta: (input: { version: number; bridge: string }) => {
        if (!input || typeof input.version !== "number" || typeof input.bridge !== "string") {
          throw new Error("renderer_bootstrap_incompatible_bridge_meta");
        }
      },
      hasCapability: (capability: string) => manifest.capabilities.includes(capability),
      listCapabilities: () => [...manifest.capabilities],
    },
  };
}

function requireApi(): AdjutorixExposedApi {
  const api = window.adjutorixApi;
  if (api) {
    return api;
  }

  const legacy = window.adjutorix;
  if (legacy && typeof legacy === "object") {
    return adaptLegacyBridge(legacy as any);
  }

  throw new Error("renderer_bootstrap_missing_exposed_api");
}

function validateApiShape(api: AdjutorixExposedApi): void {
  if (!api || typeof api !== "object") throw new Error("renderer_bootstrap_invalid_api_object");
  if (!api.manifest || api.manifest.version !== 1) throw new Error("renderer_bootstrap_manifest_invalid");
  if (typeof api.runtime?.snapshot !== "function") throw new Error("renderer_bootstrap_runtime_missing");
  if (typeof api.workspace?.open !== "function") throw new Error("renderer_bootstrap_workspace_missing");
  if (typeof api.patch?.preview !== "function") throw new Error("renderer_bootstrap_patch_missing");
  if (typeof api.verify?.run !== "function") throw new Error("renderer_bootstrap_verify_missing");
  if (typeof api.ledger?.current !== "function") throw new Error("renderer_bootstrap_ledger_missing");
  if (typeof api.diagnostics?.runtime !== "function") throw new Error("renderer_bootstrap_diagnostics_missing");
  if (typeof api.agent?.health !== "function") throw new Error("renderer_bootstrap_agent_missing");
}

function normalizeEnvelope<T extends JsonValue>(value: unknown, fallbackChannel: string): Envelope<T> {
  if (isEnvelope(value)) return value as Envelope<T>;
  return err(
    "INVALID_ENVELOPE",
    "Renderer received a malformed envelope.",
    fallbackChannel,
    createHashLike(value),
    { receivedType: typeof value },
  ) as Envelope<T>;
}

// -----------------------------------------------------------------------------
// BOOTSTRAP / APP STATE MODEL
// -----------------------------------------------------------------------------

type BootPhase = "booting" | "ready" | "degraded" | "failed";

type NotificationLevel = "info" | "warn" | "error";

type NotificationItem = {
  id: string;
  level: NotificationLevel;
  title: string;
  message: string;
  atMs: number;
};

type EventLogItem = {
  id: string;
  source: "workspace" | "agent" | "diagnostics" | "patch" | "verify";
  payload: EventPayload;
  atMs: number;
};

type BootstrapSnapshot = {
  manifest: AdjutorixExposedApi["manifest"] | null;
  runtimeSnapshot: JsonObject | null;
  workspaceHealth: JsonObject | null;
  agentHealth: JsonObject | null;
  diagnosticsRuntime: JsonObject | null;
  bootstrapHash: string;
};

type AppState = {
  phase: BootPhase;
  startedAtMs: number;
  readyAtMs: number | null;
  failedAtMs: number | null;
  degradedReason: string | null;
  fatalError: string | null;
  manifest: AdjutorixExposedApi["manifest"] | null;
  runtimeSnapshot: JsonObject | null;
  workspaceHealth: JsonObject | null;
  agentHealth: JsonObject | null;
  diagnosticsRuntime: JsonObject | null;
  notifications: NotificationItem[];
  eventLog: EventLogItem[];
  bootstrapHash: string;
};

type AppAction =
  | { type: "BOOTSTRAP_STARTED"; startedAtMs: number }
  | {
      type: "BOOTSTRAP_SUCCEEDED";
      readyAtMs: number;
      manifest: AdjutorixExposedApi["manifest"];
      runtimeSnapshot: JsonObject | null;
      workspaceHealth: JsonObject | null;
      agentHealth: JsonObject | null;
      diagnosticsRuntime: JsonObject | null;
    }
  | { type: "BOOTSTRAP_DEGRADED"; reason: string }
  | { type: "BOOTSTRAP_FAILED"; failedAtMs: number; error: string }
  | { type: "NOTIFY"; item: NotificationItem }
  | { type: "DISMISS_NOTIFICATION"; id: string }
  | { type: "EVENT_RECEIVED"; item: EventLogItem }
  | { type: "RUNTIME_SNAPSHOT_UPDATED"; runtimeSnapshot: JsonObject }
  | { type: "WORKSPACE_HEALTH_UPDATED"; workspaceHealth: JsonObject }
  | { type: "AGENT_HEALTH_UPDATED"; agentHealth: JsonObject }
  | { type: "DIAGNOSTICS_RUNTIME_UPDATED"; diagnosticsRuntime: JsonObject };

function initialState(): AppState {
  const startedAtMs = Date.now();
  const bootstrapHash = createHashLike({ phase: "booting", startedAtMs });
  return {
    phase: "booting",
    startedAtMs,
    readyAtMs: null,
    failedAtMs: null,
    degradedReason: null,
    fatalError: null,
    manifest: null,
    runtimeSnapshot: null,
    workspaceHealth: null,
    agentHealth: null,
    diagnosticsRuntime: null,
    notifications: [],
    eventLog: [],
    bootstrapHash,
  };
}


type OperationalGate = {
  ok: boolean;
  label: "HEALTHY" | "NOT OPERATIONAL";
  workspaceRoot: string | null;
  treeEntries: number;
  selectedPath: string | null;
  bufferMounted: boolean;
  fileReadOk: boolean;
  writableKnown: boolean;
  failures: string[];
};

function deriveOperationalGate(input: {
  workspaceRoot: string | null;
  workspaceEntries: unknown[];
  selectedPath: string | null;
  activeEditorBuffer: any | null;
  workspaceHealth: any | null;
}): OperationalGate {
  const failures: string[] = [];

  const workspaceRoot = input.workspaceRoot ?? null;
  const treeEntries = Array.isArray(input.workspaceEntries) ? input.workspaceEntries.length : 0;
  const selectedPath = input.selectedPath ?? null;

  const bufferContent = input.activeEditorBuffer?.content;
  const hasBufferContent =
    typeof bufferContent?.workingContent === "string" ||
    typeof bufferContent?.baselineContent === "string";

  const bufferMounted =
    !!input.activeEditorBuffer &&
    typeof input.activeEditorBuffer.path === "string" &&
    input.activeEditorBuffer.path.length > 0 &&
    hasBufferContent;

  const fileReadOk =
    bufferMounted &&
    input.activeEditorBuffer.readOnly === true;

  const writableKnown =
    typeof input.workspaceHealth?.writable === "boolean" ||
    input.activeEditorBuffer?.readOnly === true;

  if (!workspaceRoot) failures.push("workspace_root_missing");
  if (treeEntries <= 0) failures.push("workspace_tree_empty");
  if (!selectedPath) failures.push("file_selection_missing");
  if (!bufferMounted) failures.push("editor_buffer_not_mounted");
  if (!fileReadOk) failures.push("governed_file_read_not_proven");
  if (!writableKnown) failures.push("write_posture_unknown");

  const ok = failures.length === 0;

  return {
    ok,
    label: ok ? "HEALTHY" : "NOT OPERATIONAL",
    workspaceRoot,
    treeEntries,
    selectedPath,
    bufferMounted,
    fileReadOk,
    writableKnown,
    failures,
  };
}


type WorkspaceTreeEntryLike = {
  path?: unknown;
  workspacePath?: unknown;
  fullPath?: unknown;
  absolutePath?: unknown;
  relativePath?: unknown;
  id?: unknown;
  kind?: unknown;
  type?: unknown;
  entryType?: unknown;
  nodeType?: unknown;
  isFile?: unknown;
  file?: unknown;
  isDirectory?: unknown;
  directory?: unknown;
  hidden?: unknown;
  ignored?: unknown;
  children?: unknown;
  entries?: unknown;
  items?: unknown;
};

function flattenWorkspaceTreeEntries(entries: unknown[]): WorkspaceTreeEntryLike[] {
  const out: WorkspaceTreeEntryLike[] = [];

  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return;

    const entry = value as WorkspaceTreeEntryLike;
    out.push(entry);

    const children =
      Array.isArray(entry.children) ? entry.children :
      Array.isArray(entry.entries) ? entry.entries :
      Array.isArray(entry.items) ? entry.items :
      [];

    for (const child of children) visit(child);
  };

  for (const entry of entries) visit(entry);
  return out;
}

function workspaceTreeEntryPath(entry: WorkspaceTreeEntryLike): string | null {
  for (const key of ["path", "workspacePath", "fullPath", "absolutePath", "relativePath", "id"] as const) {
    const value = entry[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function workspaceTreeEntryKind(entry: WorkspaceTreeEntryLike): string {
  return String(entry.kind ?? entry.type ?? entry.entryType ?? entry.nodeType ?? "").toLowerCase();
}

function isWorkspaceTreeDirectory(entry: WorkspaceTreeEntryLike): boolean {
  const kind = workspaceTreeEntryKind(entry);

  if (entry.isDirectory === true || entry.directory === true) return true;
  if (kind.includes("directory") || kind.includes("folder") || kind === "root") return true;

  const children =
    Array.isArray(entry.children) ? entry.children :
    Array.isArray(entry.entries) ? entry.entries :
    Array.isArray(entry.items) ? entry.items :
    [];

  return children.length > 0 && entry.isFile !== true && entry.file !== true && !kind.includes("file");
}

function isAutoOpenEligibleWorkspacePath(path: string): boolean {
  const lower = path.replace(/\\/g, "/").toLowerCase();

  if (
    lower.includes("/node_modules/") ||
    lower.includes("/.git/") ||
    lower.includes("/dist/") ||
    lower.includes("/build/") ||
    lower.includes("/coverage/") ||
    lower.includes("/.next/") ||
    lower.includes("/.turbo/")
  ) {
    return false;
  }

  if (/\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav)$/i.test(lower)) {
    return false;
  }

  return true;
}

function scoreAutoOpenWorkspacePath(path: string, entry: WorkspaceTreeEntryLike): number {
  const normalized = path.replace(/\\/g, "/");
  const lower = normalized.toLowerCase();
  const parts = lower.split("/").filter(Boolean);
  const base = parts.length ? parts[parts.length - 1] : lower;

  let score = 0;

  if (base === "readme.md") score += 2000;
  if (base === "package.json") score += 1800;
  if (base === "pnpm-workspace.yaml") score += 1600;
  if (base === "tsconfig.json") score += 1500;
  if (base.endsWith(".md")) score += 500;
  if (base.endsWith(".json")) score += 450;
  if (base.endsWith(".ts") || base.endsWith(".tsx")) score += 400;
  if (lower.includes("/packages/")) score += 250;
  if (lower.includes("/src/")) score += 200;

  const pathSegments = lower.split("/").filter(Boolean);
  const hiddenPath =
    entry.hidden === true ||
    pathSegments.some((segment) => segment.startsWith("."));

  if (hiddenPath) score -= 5000;
  if (entry.ignored === true) score -= 1000;
  if (lower.includes("/logs/")) score -= 500;

  score -= Math.min(normalized.length, 400) / 1000;

  return score;
}


function workspacePathForReadRequest(pathValue: string, workspaceRoot: string | null): string {
  const normalized = pathValue.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  const root = workspaceRoot?.trim().replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "") ?? "";

  if (root && normalized === root) return "";
  if (root && normalized.startsWith(root + "/")) return normalized.slice(root.length + 1);

  return normalized.replace(/^\.\//, "");
}


function pickFirstOperationalWorkspacePath(entries: unknown[]): string | null {
  const candidates = flattenWorkspaceTreeEntries(entries)
    .map((entry) => ({ entry, path: workspaceTreeEntryPath(entry) }))
    .filter((candidate): candidate is { entry: WorkspaceTreeEntryLike; path: string } => {
      if (!candidate.path) return false;
      if (isWorkspaceTreeDirectory(candidate.entry)) return false;
      return isAutoOpenEligibleWorkspacePath(candidate.path);
    })
    .sort((a, b) => scoreAutoOpenWorkspacePath(b.path, b.entry) - scoreAutoOpenWorkspacePath(a.path, a.entry));

  return candidates[0]?.path ?? null;
}


function deriveBootstrapHash(state: Pick<AppState, "manifest" | "runtimeSnapshot" | "workspaceHealth" | "agentHealth" | "diagnosticsRuntime" | "phase">): string {
  return createHashLike({
    phase: state.phase,
    manifest: state.manifest,
    runtimeSnapshot: state.runtimeSnapshot,
    workspaceHealth: state.workspaceHealth,
    agentHealth: state.agentHealth,
    diagnosticsRuntime: state.diagnosticsRuntime,
  });
}

function reducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "BOOTSTRAP_STARTED": {
      return {
        ...state,
        phase: "booting",
        startedAtMs: action.startedAtMs,
        failedAtMs: null,
        fatalError: null,
        degradedReason: null,
        bootstrapHash: createHashLike({ phase: "booting", startedAtMs: action.startedAtMs }),
      };
    }
    case "BOOTSTRAP_SUCCEEDED": {
      const next: AppState = {
        ...state,
        phase: "ready",
        readyAtMs: action.readyAtMs,
        failedAtMs: null,
        fatalError: null,
        degradedReason: null,
        manifest: action.manifest,
        runtimeSnapshot: action.runtimeSnapshot,
        workspaceHealth: action.workspaceHealth,
        agentHealth: action.agentHealth,
        diagnosticsRuntime: action.diagnosticsRuntime,
        bootstrapHash: "",
      };
      next.bootstrapHash = deriveBootstrapHash(next);
      return next;
    }
    case "BOOTSTRAP_DEGRADED": {
      const next = { ...state, phase: "degraded" as const, degradedReason: action.reason };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    case "BOOTSTRAP_FAILED": {
      const next = {
        ...state,
        phase: "failed" as const,
        failedAtMs: action.failedAtMs,
        fatalError: action.error,
      };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    case "NOTIFY": {
      return {
        ...state,
        notifications: [action.item, ...state.notifications].slice(0, 25),
      };
    }
    case "DISMISS_NOTIFICATION": {
      return {
        ...state,
        notifications: state.notifications.filter((n) => n.id !== action.id),
      };
    }
    case "EVENT_RECEIVED": {
      return {
        ...state,
        eventLog: [action.item, ...state.eventLog].slice(0, 200),
      };
    }
    case "RUNTIME_SNAPSHOT_UPDATED": {
      const next = { ...state, runtimeSnapshot: action.runtimeSnapshot };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    case "WORKSPACE_HEALTH_UPDATED": {
      const next = { ...state, workspaceHealth: action.workspaceHealth };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    case "AGENT_HEALTH_UPDATED": {
      const next = { ...state, agentHealth: action.agentHealth };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    case "DIAGNOSTICS_RUNTIME_UPDATED": {
      const next = { ...state, diagnosticsRuntime: action.diagnosticsRuntime };
      return { ...next, bootstrapHash: deriveBootstrapHash(next) };
    }
    default:
      return state;
  }
}

// -----------------------------------------------------------------------------
// CONTEXTS
// -----------------------------------------------------------------------------

type AppContextValue = {
  state: AppState;
  api: AdjutorixExposedApi;
  notify: (level: NotificationLevel, title: string, message: string) => void;
  recordEvent: (source: string, payload: { kind: string; detail?: unknown }) => void;
  refreshRuntime: () => Promise<void>;
  refreshWorkspaceHealth: () => Promise<void>;
  refreshAgentHealth: () => Promise<void>;
  refreshDiagnosticsRuntime: () => Promise<void>;
};

const AppContext = createContext<AppContextValue | null>(null);

function useAppContext(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("renderer_app_context_missing");
  return ctx;
}

// -----------------------------------------------------------------------------
// ERROR BOUNDARY
// -----------------------------------------------------------------------------

type BoundaryState = {
  hasError: boolean;
  error: string | null;
};

class RootErrorBoundary extends React.Component<React.PropsWithChildren, BoundaryState> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { hasError: true, error: error.message };
  }

  override componentDidCatch(error: Error, info: React.ErrorInfo): void {
    console.error("Adjutorix renderer boundary fault", error, info);
  }

  override render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <FatalScreen
          title="Renderer crashed"
          message={this.state.error ?? "Unknown renderer error."}
          diagnostics={{ boundary: "RootErrorBoundary" }}
        />
      );
    }
    return this.props.children;
  }
}

// -----------------------------------------------------------------------------
// VIEW COMPONENTS
// -----------------------------------------------------------------------------

function FatalScreen(props: { title: string; message: string; diagnostics?: JsonObject }): JSX.Element {
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 p-8">
      <div className="mx-auto max-w-5xl rounded-3xl border border-red-900/40 bg-zinc-900 shadow-2xl">
        <div className="border-b border-zinc-800 px-8 py-6">
          <h1 className="text-3xl font-semibold tracking-tight">{props.title}</h1>
          <p className="mt-2 text-sm text-zinc-400">Adjutorix renderer bootstrap could not proceed.</p>
        </div>
        <div className="grid gap-6 p-8 lg:grid-cols-[1.2fr_0.8fr]">
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
            <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-400">Failure</h2>
            <p className="mt-4 whitespace-pre-wrap text-base text-zinc-200">{props.message}</p>
          </section>
          <section className="rounded-2xl border border-zinc-800 bg-zinc-950/50 p-6">
            <h2 className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-400">Diagnostics</h2>
            <pre className="mt-4 overflow-auto text-xs leading-6 text-zinc-300">{asPrettyJson(props.diagnostics ?? {})}</pre>
          </section>
        </div>
      </div>
    </div>
  );
}

function NotificationCenter(): JSX.Element {
  const { state } = useAppContext();

  const [interactionContract, setInteractionContract] = React.useState(createInitialInteractionContractState());
  const selectInteractionView = React.useCallback((id: string, detail: string) => {
    setInteractionContract((state) => recordInteraction(state, id, detail));
  }, []);
  return (
    <div className="fixed right-4 top-4 z-50 flex max-w-md flex-col gap-3">
      {state.notifications.map((n) => (
        <div
          key={n.id}
          className="rounded-2xl border border-zinc-800 bg-zinc-950/90 p-4 shadow-xl backdrop-blur"
        >
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{n.level}</div>
              <div className="mt-1 text-sm font-semibold text-zinc-100">{n.title}</div>
              <div className="mt-1 text-sm text-zinc-400">{n.message}</div>
            </div>
            <div className="text-[10px] text-zinc-600">{new Date(n.atMs).toLocaleTimeString()}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

function StatusPill(props: { label: string; value: string }): JSX.Element {
  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 shadow-sm">
      <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500">{props.label}</div>
      <div className="mt-1 text-sm font-medium text-zinc-100">{props.value}</div>
    </div>
  );
}

function SnapshotCard(props: { title: string; value: JsonValue | null }): JSX.Element {
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/50 p-6 shadow-lg">
      <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">{props.title}</h3>
      <pre className="mt-4 max-h-[28rem] overflow-auto rounded-2xl border border-zinc-800 bg-black/20 p-4 text-xs leading-6 text-zinc-200">
        {asPrettyJson(props.value)}
      </pre>
    </section>
  );
}

function EventStreamCard(): JSX.Element {
  const { state } = useAppContext();
  return (
    <section className="rounded-3xl border border-zinc-800 bg-zinc-950/50 p-6 shadow-lg">
      <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">Event stream</h3>
      <div className="mt-4 space-y-3">
        {state.eventLog.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">No events observed yet.</div>
        ) : (
          state.eventLog.map((entry) => (
            <div key={entry.id} className="rounded-2xl border border-zinc-800 bg-black/20 p-4">
              <div className="flex items-center justify-between gap-4">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{entry.source}</div>
                <div className="text-[10px] text-zinc-600">{new Date(entry.atMs).toLocaleTimeString()}</div>
              </div>
              <div className="mt-2 text-sm font-medium text-zinc-100">{entry.payload.kind}</div>
              <pre className="mt-3 overflow-auto text-xs leading-6 text-zinc-300">{asPrettyJson(entry.payload.detail)}</pre>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function CommandBar(): JSX.Element {
  const { refreshAgentHealth, refreshDiagnosticsRuntime, refreshRuntime, refreshWorkspaceHealth } = useAppContext();
  return (
    <div className="flex flex-wrap gap-3">
      {[
        { label: "Refresh runtime", onClick: refreshRuntime },
        { label: "Refresh workspace", onClick: refreshWorkspaceHealth },
        { label: "Refresh agent", onClick: refreshAgentHealth },
        { label: "Refresh diagnostics", onClick: refreshDiagnosticsRuntime },
      ].map((item) => (
        <button
          key={item.label}
          onClick={() => void item.onClick()}
          className="rounded-2xl border border-zinc-700 bg-zinc-900 px-4 py-2 text-sm font-medium text-zinc-100 shadow hover:bg-zinc-800"
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function ShellApp(): JSX.Element {
  const { state, recordEvent, notify, api, refreshAgentHealth, refreshDiagnosticsRuntime, refreshRuntime, refreshWorkspaceHealth } = useAppContext();

  const shellHealth =
    state.phase === "failed"
      ? "unhealthy"
      : state.phase === "degraded"
        ? "degraded"
        : state.phase === "ready"
          ? "healthy"
          : "unknown";

  const workspaceRoot =
    (state.workspaceHealth as any)?.rootPath ??
    (state.workspaceHealth as any)?.workspacePath ??
    (state.runtimeSnapshot as any)?.workspace?.rootPath ??
    null;

  const workspaceOpen = Boolean(workspaceRoot);
  const workspaceName = workspaceRoot
    ? String(workspaceRoot).split("/").filter(Boolean).pop() ?? String(workspaceRoot)
    : "No workspace";

  const capabilities = state.manifest?.capabilities ?? [];

  const classifyHealth = (value: any): "healthy" | "degraded" | "unhealthy" | "unknown" => {
    const level = value?.level ?? value?.health?.level ?? null;
    if (level === "healthy" || level === "degraded" || level === "unhealthy" || level === "unknown") {
      return level;
    }
    if (value?.ok === true) return "healthy";
    if (value?.ok === false) return "unhealthy";
    return "unknown";
  };

  const providers = [
    {
      id: "bridge",
      label: "Renderer bridge",
      subtitle: state.manifest ? `${state.manifest.name} · ${state.manifest.bridgeName}` : "Bridge manifest unavailable",
      kind: "shell",
      health: shellHealth,
      connectivity: state.manifest ? "connected" : "unknown",
      available: Boolean(state.manifest),
      version: state.manifest ? `v${state.manifest.bridgeVersion}` : null,
      endpointLabel: state.manifest ? `${capabilities.length} capabilities` : null,
      detail: state.manifest ?? null,
    },
    {
      id: "workspace",
      label: "Workspace",
      subtitle: workspaceRoot ? String(workspaceRoot) : "No governed workspace open",
      kind: "workspace",
      health: classifyHealth(state.workspaceHealth),
      connectivity: workspaceOpen ? "connected" : "unknown",
      available: workspaceOpen,
      trustLevel: ((state.workspaceHealth as any)?.trustLevel ?? (state.runtimeSnapshot as any)?.workspace?.trustLevel ?? "unknown") as any,
      attentionMessage: state.phase === "degraded" && !workspaceOpen ? "Workspace posture has not been hydrated yet." : null,
      detail: state.workspaceHealth ?? null,
    },
    {
      id: "agent",
      label: "Agent",
      subtitle: (state.agentHealth as any)?.url ?? "Local agent endpoint",
      kind: "agent",
      health: classifyHealth(state.agentHealth),
      connectivity: (state.agentHealth as any)?.ok ? "connected" : "disconnected",
      available: Boolean(state.agentHealth),
      endpointLabel: (state.agentHealth as any)?.url ?? null,
      detail: state.agentHealth ?? null,
    },
    {
      id: "diagnostics",
      label: "Diagnostics",
      subtitle: state.diagnosticsRuntime ? "Runtime diagnostics snapshot loaded" : "Diagnostics not loaded",
      kind: "diagnostics",
      health: classifyHealth(state.diagnosticsRuntime),
      connectivity: state.diagnosticsRuntime ? "connected" : "unknown",
      available: Boolean(state.diagnosticsRuntime),
      detail: state.diagnosticsRuntime ?? null,
    },
    {
      id: "ledger",
      label: "Ledger",
      subtitle: state.runtimeSnapshot ? "Ledger surface reachable" : "Ledger not hydrated",
      kind: "ledger",
      health: "unknown",
      connectivity: "unknown",
      available: Boolean(state.runtimeSnapshot),
      detail: null,
    },
  ];

  const toasts = state.notifications.map((item) => ({
    id: item.id,
    level: item.level,
    title: item.title,
    message: item.message,
    createdAtMs: item.atMs,
  }));

  const banners = [
    ...(state.degradedReason
      ? [
          {
            id: "bootstrap-degraded",
            level: "warn" as const,
            title: "Bootstrap degraded",
            message: state.degradedReason,
            sticky: true,
          },
        ]
      : []),
    ...(state.fatalError
      ? [
          {
            id: "bootstrap-failed",
            level: "error" as const,
            title: "Bootstrap failure",
            message: state.fatalError,
            sticky: true,
          },
        ]
      : []),
  ];

  


const statusChips = [
    { label: "Phase", value: state.phase, tone: shellHealth === "healthy" ? "good" : shellHealth === "degraded" ? "warn" : shellHealth === "unhealthy" ? "bad" : "neutral" },
    { label: "Bridge", value: state.manifest ? `${state.manifest.name} v${state.manifest.version}` : "Unavailable", tone: state.manifest ? "good" : "warn" },
    { label: "Capabilities", value: String(capabilities.length), tone: capabilities.length > 0 ? "good" : "warn" },
    { label: "Events", value: String(state.eventLog.length), tone: state.eventLog.length > 0 ? "good" : "neutral" },
    { label: "Bootstrap hash", value: state.bootstrapHash, tone: "neutral" },
  ];

  type InteractionView =
    | "overview"
    | "workspace"
    | "patch"
    | "verify"
    | "ledger"
    | "agent"
    | "diagnostics"
    | "activity";

  const [interactionView, setInteractionView] = React.useState<InteractionView>(
    workspaceOpen ? "workspace" : "overview",
  );

  React.useEffect(() => {
    if (workspaceOpen && interactionView === "overview") {
      setInteractionView("workspace");
    }
  }, [workspaceOpen, interactionView]);

  const selectInteractionView = React.useCallback((id: string, detail: string) => {
    const allowed: InteractionView[] = [
      "overview",
      "workspace",
      "patch",
      "verify",
      "ledger",
      "agent",
      "diagnostics",
      "activity",
    ];
    const next = allowed.includes(id as InteractionView) ? (id as InteractionView) : "overview";
    setInteractionView(next);
    const navigationEvent = { id: next, detail };
    console.info("[adjutorix.navigation]", JSON.stringify(navigationEvent));
    recordEvent("renderer.navigation", { kind: "navigation.selected", detail: navigationEvent });
  }, [recordEvent]);


  type SurfaceFact = {
    label: string;
    value: string;
    tone?: "good" | "warn" | "bad" | "neutral";
  };

  type SurfaceAction = {
    id: string;
    label: string;
    description: string;
    disabled?: boolean;
    onClick?: () => unknown;
  };

  const surfaceWorkspaceRoot =
    (((state.workspaceHealth as any)?.rootPath ??
      (state.workspaceHealth as any)?.workspacePath ??
      (state.runtimeSnapshot as any)?.workspace?.rootPath ??
      null) as string | null);

  const surfaceWorkspaceBound = Boolean(surfaceWorkspaceRoot);
  const surfaceCapabilities = state.manifest?.capabilities ?? [];
  const hasSurfaceCapability = React.useCallback(
    (name: string) =>
      surfaceCapabilities.some((capability) => {
        const value = String(capability);
        return (
          value === name ||
          value.startsWith(`${name}.`) ||
          value.startsWith(`events.${name}`) ||
          value.includes(`.${name}.`)
        );
      }),
    [surfaceCapabilities],
  );

  const openWorkspace = React.useCallback(async () => {
    try {
      const envelope = normalizeEnvelope(
        await api.workspace.open({ schema: 1, actor: "renderer", source: "ipc" }),
        "workspace.open",
      );

      const operationOk =
        envelope.ok &&
        isObject(envelope.data) &&
        envelope.data.ok !== false &&
        typeof envelope.data.path === "string" &&
        envelope.data.path.length > 0;

      if (operationOk) {
        await Promise.allSettled([refreshWorkspaceHealth(), refreshRuntime()]);
        notify("success", "Workspace opened", "Workspace posture refreshed.");
        recordEvent("workspace.open", { kind: "workspace.opened", detail: envelope.data ?? null });
      } else if (envelope.ok) {
        recordEvent("workspace.open", { kind: "workspace.open.cancelled", detail: envelope.data ?? null });
      } else {
        notify("error", "Workspace open failed", envelope.error.message);
        recordEvent("workspace.open", { kind: "workspace.open.failed", detail: envelope.error });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      notify("error", "Workspace open failed", message);
      recordEvent("workspace.open", { kind: "workspace.open.threw", detail: { message } });
    }
  }, [api.workspace, notify, recordEvent, refreshRuntime, refreshWorkspaceHealth]);

  const [commandPaletteOpen, setCommandPaletteOpen] = React.useState(false);

  const [workspaceTreeQuery, setWorkspaceTreeQuery] = React.useState("");
  const [selectedWorkspacePath, setSelectedWorkspacePath] = React.useState<string | null>(null);
  const [selectedDiffHunkId, setSelectedDiffHunkId] = useState<string | null>(null);
  const [openedWorkspacePaths, setOpenedWorkspacePaths] = React.useState<string[]>([]);
  const [editorBuffers, dispatchEditorBuffers] = React.useReducer(editorBuffersReducer, undefined, createInitialEditorBuffersState);
  const activeEditorBuffer = editorBuffers.activePath ? editorBuffers.byPath[editorBuffers.activePath] ?? null : null;
  const autoOpenWorkspacePathRef = React.useRef<string | null>(null);
  const workspaceEntries = React.useMemo(() => {
    const health = (state.workspaceHealth ?? {}) as any;
    const runtimeWorkspace = ((state.runtimeSnapshot as any)?.workspace ?? {}) as any;
    const diagnosticsRuntime =
      ((state.diagnosticsRuntime as any)?.snapshot?.runtime ??
        (state.diagnosticsRuntime as any)?.runtime ??
        {}) as any;
    const diagnosticsWorkspace =
      ((state.diagnosticsRuntime as any)?.snapshot?.workspace ??
        (state.diagnosticsRuntime as any)?.workspace ??
        {}) as any;

    const candidates = [
      health.entries,
      health.fileTree,
      health.tree,
      health.workspaceTree,
      runtimeWorkspace.entries,
      runtimeWorkspace.fileTree,
      runtimeWorkspace.tree,
      runtimeWorkspace.workspaceTree,
      diagnosticsWorkspace.entries,
      diagnosticsWorkspace.fileTree,
      diagnosticsWorkspace.tree,
      diagnosticsWorkspace.workspaceTree,
      diagnosticsRuntime.entries,
      diagnosticsRuntime.fileTree,
      diagnosticsRuntime.tree,
      diagnosticsRuntime.workspaceTree,
    ];

    let emptyCandidate: any[] | null = null;

    for (const candidate of candidates) {
      if (Array.isArray(candidate)) {
        if (candidate.length > 0) return candidate;
        if (!emptyCandidate) emptyCandidate = candidate;
        continue;
      }

      if (candidate && typeof candidate === "object" && Array.isArray((candidate as any).entries)) {
        const entries = (candidate as any).entries as any[];
        if (entries.length > 0) return entries;
        if (!emptyCandidate) emptyCandidate = entries;
      }

      if (candidate && typeof candidate === "object" && Array.isArray((candidate as any).children)) {
        const children = (candidate as any).children as any[];
        if (children.length > 0) return children;
        if (!emptyCandidate) emptyCandidate = children;
      }
    }

    return emptyCandidate ?? [];
  }, [state.runtimeSnapshot, state.workspaceHealth, state.diagnosticsRuntime]);

  const operationalGate = React.useMemo(
    () =>
      deriveOperationalGate({
        workspaceRoot: surfaceWorkspaceRoot ?? workspaceRoot ?? null,
        workspaceEntries,
        selectedPath: selectedWorkspacePath,
        activeEditorBuffer,
        workspaceHealth: state.workspaceHealth,
      }),
    [surfaceWorkspaceRoot, workspaceRoot, workspaceEntries, selectedWorkspacePath, activeEditorBuffer, state.workspaceHealth],
  );

  React.useEffect(() => {
    autoOpenWorkspacePathRef.current = null;
    setSelectedWorkspacePath(null);
    setOpenedWorkspacePaths([]);
  }, [surfaceWorkspaceRoot]);

  const selectWorkspacePath = React.useCallback((pathValue: unknown) => {
    const raw =
      typeof pathValue === "string"
        ? pathValue
        : pathValue && typeof pathValue === "object"
          ? String((pathValue as any).path ?? (pathValue as any).fullPath ?? (pathValue as any).relativePath ?? "")
          : "";

    const next = raw.trim() || null;
    setSelectedWorkspacePath(next);

    if (next) {
      setOpenedWorkspacePaths((current) => Array.from(new Set([next, ...current])).slice(0, 24));
      recordEvent("workspace.selection", { kind: "workspace.path.selected", detail: { path: next } });
    }
  }, [recordEvent]);

  const openWorkspacePath = React.useCallback(async (pathValue: unknown) => {
    const raw =
      typeof pathValue === "string"
        ? pathValue
        : pathValue && typeof pathValue === "object"
          ? String((pathValue as any).path ?? (pathValue as any).fullPath ?? (pathValue as any).relativePath ?? "")
          : "";
    const next = raw.trim();

    if (!next) return;
    selectWorkspacePath(next);

    const entry = workspaceEntries.find((candidate: any) => {
      const candidatePath = String(candidate?.path ?? candidate?.fullPath ?? candidate?.relativePath ?? "");
      return candidatePath === next;
    }) as any;

    const entryKind = String(entry?.kind ?? entry?.type ?? "").toLowerCase();
    if (entryKind === "directory" || entryKind === "dir") {
      recordEvent("workspace.open", { kind: "workspace.path.directory-selected", detail: { path: next } });
      return;
    }

    dispatchEditorBuffers({ type: "BUFFER_OPEN_REQUESTED", payload: { path: next, readOnly: true, atMs: Date.now() } });

    try {
      const readPath = workspacePathForReadRequest(next, surfaceWorkspaceRoot ?? workspaceRoot ?? null) || next;
      if (!readPath.trim()) throw new Error("workspace_file_open_path_empty");

      const envelope = await (api.workspace as any).readFile({
        schema: 1,
        actor: "renderer",
        path: readPath,
        targetPath: readPath,
        relativePath: readPath,
        relative_path: readPath,
        workspacePath: readPath,
        workspace_path: readPath,
        filePath: readPath,
        file_path: readPath,
      });
      if (!envelope?.ok) {
        const message = envelope?.error?.message ?? "Workspace file read failed.";
        dispatchEditorBuffers({ type: "BUFFER_OPEN_FAILED", path: next, error: message, atMs: Date.now() });
        notify("error", "File open failed", message);
        recordEvent("workspace.open", { kind: "workspace.file.open.failed", detail: { path: next, message } });
        return;
      }

      const data = envelope.data ?? {};
      dispatchEditorBuffers({
        type: "BUFFER_OPEN_SUCCEEDED",
        payload: {
          path: String(data.path ?? next),
          title: String(data.name ?? next.split("/").pop() ?? next),
          content: String(data.content ?? ""),
          source: "disk",
          language: typeof data.language === "string" ? data.language : null,
          encoding: "utf8",
          lineEnding: typeof data.lineEnding === "string" ? data.lineEnding : "unknown",
          readOnly: true,
          atMs: Date.now(),
        },
      });
      setOpenedWorkspacePaths((current) => Array.from(new Set([String(data.path ?? next), ...current])).slice(0, 24));
      notify("success", "File opened", String(data.relativePath ?? data.path ?? next));
      recordEvent("workspace.open", { kind: "workspace.file.opened", detail: { path: String(data.path ?? next), sizeBytes: data.sizeBytes ?? null, sha256: data.sha256 ?? null } });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      dispatchEditorBuffers({ type: "BUFFER_OPEN_FAILED", path: next, error: message, atMs: Date.now() });
      notify("error", "File open failed", message);
      recordEvent("workspace.open", { kind: "workspace.file.open.threw", detail: { path: next, message } });
    }
  }, [api.workspace, notify, recordEvent, selectWorkspacePath, surfaceWorkspaceRoot, workspaceRoot, workspaceEntries]);

  React.useEffect(() => {
    if (!surfaceWorkspaceBound) return;
    if (activeEditorBuffer || selectedWorkspacePath) return;

    const nextPath = pickFirstOperationalWorkspacePath(workspaceEntries);
    if (!nextPath || autoOpenWorkspacePathRef.current === nextPath) return;

    autoOpenWorkspacePathRef.current = nextPath;
    void openWorkspacePath(nextPath);
  }, [surfaceWorkspaceBound, workspaceEntries, activeEditorBuffer, selectedWorkspacePath, openWorkspacePath]);




  const toSurfaceJson = (value: unknown) => (value ?? null) as JsonValue | null;

  const factToneClass = (tone: SurfaceFact["tone"] = "neutral") => {
    switch (tone) {
      case "good":
        return "border-emerald-700/30 bg-emerald-500/10 text-emerald-200";
      case "warn":
        return "border-amber-700/30 bg-amber-500/10 text-amber-200";
      case "bad":
        return "border-rose-700/30 bg-rose-500/10 text-rose-200";
      default:
        return "border-zinc-800 bg-zinc-950/60 text-zinc-200";
    }
  };

  const SurfaceActions = ({ actions }: { actions: SurfaceAction[] }) => (
    <div className="flex flex-wrap gap-3">
      {actions.map((action) => (
        <button
          key={action.id}
          disabled={action.disabled || !action.onClick}
          onClick={() => void action.onClick?.()}
          className={[
            "rounded-2xl border px-4 py-2 text-sm font-semibold transition",
            action.disabled || !action.onClick
              ? "cursor-not-allowed border-zinc-800 bg-zinc-900/50 text-zinc-600"
              : "border-zinc-700 bg-zinc-900 text-zinc-100 hover:bg-zinc-800",
          ].join(" ")}
          title={action.description}
        >
          {action.label}
        </button>
      ))}
    </div>
  );

  const FactGrid = ({ facts }: { facts: SurfaceFact[] }) => (
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
      {facts.map((fact) => (
        <div key={fact.label} className={["rounded-2xl border p-4", factToneClass(fact.tone)].join(" ")}>
          <div className="text-[10px] uppercase tracking-[0.22em] opacity-70">{fact.label}</div>
          <div className="mt-2 break-words text-sm font-semibold">{fact.value}</div>
        </div>
      ))}
    </div>
  );

  const SurfaceFrame = ({
    eyebrow,
    title,
    description,
    facts,
    actions,
    children,
  }: {
    eyebrow: string;
    title: string;
    description: string;
    facts: SurfaceFact[];
    actions: SurfaceAction[];
    children: React.ReactNode;
  }) => (
    <div className="grid gap-6">
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/50 p-6 shadow-lg">
        <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">{eyebrow}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight text-zinc-50">{title}</h2>
        <p className="mt-3 max-w-4xl text-sm leading-7 text-zinc-400">{description}</p>
        <div className="mt-5">
          <SurfaceActions actions={actions} />
        </div>
        <div className="mt-5">
          <FactGrid facts={facts} />
        </div>
      </section>
      {children}
    </div>
  );

  const OverviewSurface = () => (
    <SurfaceFrame
      eyebrow="Overview"
      title={surfaceWorkspaceBound ? "Governed workspace posture" : "Open a governed workspace"}
      description={
        surfaceWorkspaceBound
          ? "Workspace posture is hydrated. Continue into Patch, Verify, Ledger, Agent, Diagnostics, or Activity from the routed surfaces."
          : "No workspace is attached yet. The shell can inspect runtime, agent, and diagnostics posture, but workspace-bound mutation remains blocked."
      }
      actions={[
        { id: "open-workspace", label: "Open workspace", description: "Open a governed workspace through the bridge.", onClick: openWorkspace },
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime bootstrap state.", onClick: refreshRuntime },
        { id: "refresh-workspace", label: "Refresh workspace", description: "Reload workspace posture.", onClick: refreshWorkspaceHealth },
        { id: "refresh-agent", label: "Refresh agent", description: "Reload agent posture.", onClick: refreshAgentHealth },
        {
          id: "refresh-diagnostics",
          label: "Refresh diagnostics",
          description: "Reload diagnostics runtime.",
          onClick: refreshDiagnosticsRuntime,
        },
      ]}
      facts={[
        { label: "Phase", value: state.phase, tone: shellHealth === "healthy" ? "good" : shellHealth === "degraded" ? "warn" : "neutral" },
        { label: "Workspace", value: surfaceWorkspaceRoot ?? "none", tone: surfaceWorkspaceBound ? "good" : "warn" },
        { label: "Bridge", value: state.manifest ? `${state.manifest.name} v${state.manifest.version}` : "unavailable", tone: state.manifest ? "good" : "bad" },
        { label: "Capabilities", value: String(surfaceCapabilities.length), tone: surfaceCapabilities.length > 0 ? "good" : "warn" },
      ]}
    >
      <div className="grid gap-6 2xl:grid-cols-2">
        <SnapshotCard title="Runtime snapshot" value={toSurfaceJson(state.runtimeSnapshot)} />
        <SnapshotCard title="Workspace posture" value={toSurfaceJson(state.workspaceHealth)} />
      </div>
    </SurfaceFrame>
  );

  const WorkspaceSurface = () => (
    <SurfaceFrame
      eyebrow="Workspace"
      title={surfaceWorkspaceBound ? "Workspace attached" : "Workspace not attached"}
      description="Workspace is the root authority boundary. File tree, trust posture, writable state, and large-file guard evidence must be visible before patch preview or apply."
      actions={[
        { id: "open-workspace", label: "Open workspace", description: "Open a governed workspace through the bridge.", onClick: openWorkspace },
        { id: "refresh-workspace", label: "Refresh workspace posture", description: "Reload workspace health.", onClick: refreshWorkspaceHealth },
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime snapshot.", onClick: refreshRuntime },
        {
          id: "go-patch",
          label: "Go to Patch",
          description: "Open patch review surface.",
          disabled: !operationalGate.ok,
          onClick: () => selectInteractionView("patch", "Workspace posture accepted for patch review."),
        },
      ]}
      facts={[
        { label: "Root", value: surfaceWorkspaceRoot ?? "none", tone: surfaceWorkspaceBound ? "good" : "warn" },
        { label: "Trust", value: String((state.workspaceHealth as any)?.trustLevel ?? "unknown"), tone: (state.workspaceHealth as any)?.trustLevel === "trusted" ? "good" : "neutral" },
        { label: "Writable", value: String((state.workspaceHealth as any)?.writable ?? "unknown"), tone: (state.workspaceHealth as any)?.writable === true ? "good" : "neutral" },
        { label: "Issues", value: String(((state.workspaceHealth as any)?.issues ?? []).length ?? 0), tone: ((state.workspaceHealth as any)?.issues ?? []).length ? "warn" : "good" },
      ]}
    >
      {!operationalGate.ok ? (
        <div className="rounded-2xl border border-red-500/40 bg-red-950/30 p-4 text-sm text-red-100">
          <div className="text-xs font-semibold uppercase tracking-[0.24em] text-red-300">Not operational</div>
          <div className="mt-2 font-medium">Workspace is attached, but governed action has not been proven.</div>
          <div className="mt-2 text-red-200/80">
            Missing: {operationalGate.failures.join(", ")}
          </div>
        </div>
      ) : null}
      <div className="grid gap-6 2xl:grid-cols-[minmax(22rem,0.9fr)_minmax(0,1.1fr)]">
        <FileTreePane
          rootPath={surfaceWorkspaceRoot ?? undefined}
          workspaceRoot={surfaceWorkspaceRoot ?? undefined}
          workspaceName={workspaceName}
          entries={workspaceEntries}
          selectedPath={selectedWorkspacePath ?? undefined}
          openedPaths={openedWorkspacePaths}
          filterQuery={workspaceTreeQuery}
          health={surfaceWorkspaceBound ? "healthy" : "unknown"}
          onFilterQueryChange={setWorkspaceTreeQuery}
          onSearchQueryChange={setWorkspaceTreeQuery}
          onPathSelected={openWorkspacePath}
          onOpenPath={openWorkspacePath}
          onOpenPathRequested={openWorkspacePath}
          onRefreshRequested={refreshWorkspaceHealth}
        />
        <div className="grid gap-6">
          <div className="min-h-[36rem]">
            <MonacoEditorPane
              path={activeEditorBuffer?.path ?? null}
              title={activeEditorBuffer?.title ?? null}
              language={activeEditorBuffer?.language ?? null}
              baselineContent={activeEditorBuffer?.content.baselineContent ?? ""}
              workingContent={activeEditorBuffer?.content.workingContent ?? ""}
              readOnly={activeEditorBuffer?.readOnly ?? true}
              modified={activeEditorBuffer ? activeEditorBuffer.content.workingHash !== activeEditorBuffer.content.baselineHash : false}
              loading={activeEditorBuffer?.lifecycle === "opening"}
              trustLevel={String((state.workspaceHealth as any)?.trustLevel ?? "unknown") as any}
              reviewState="none"
              onChangeWorkingContent={(next) => {
                if (!activeEditorBuffer) return;
                dispatchEditorBuffers({ type: "BUFFER_WORKING_CONTENT_SET", payload: { path: activeEditorBuffer.path, content: next, atMs: Date.now() } });
              }}
              onResetToBaselineRequested={() => {
                if (!activeEditorBuffer) return;
                dispatchEditorBuffers({ type: "BUFFER_RESET_WORKING_TO_BASELINE", path: activeEditorBuffer.path });
              }}
            />
          </div>
          <SnapshotCard
            title="Active workspace path"
            value={toSurfaceJson({
              rootPath: surfaceWorkspaceRoot,
              selectedPath: selectedWorkspacePath,
              openedPaths: openedWorkspacePaths,
              activeBufferPath: activeEditorBuffer?.path ?? null,
              openBufferCount: editorBuffers.tabOrder.length,
              entryCount: workspaceEntries.length,
            })}
          />
          <SnapshotCard title="Workspace health" value={toSurfaceJson(state.workspaceHealth)} />
          <SnapshotCard title="Runtime workspace context" value={toSurfaceJson((state.runtimeSnapshot as any)?.workspace ?? null)} />
        </div>
      </div>
    </SurfaceFrame>
  );


  const patchReviewFiles = React.useMemo(() => {
    const buffer = activeEditorBuffer;
    const path = String(buffer?.path ?? selectedWorkspacePath ?? "No active buffer");
    const baseline = String(buffer?.content?.baselineContent ?? "");
    const working = String(buffer?.content?.workingContent ?? baseline);
    const baselineLines = baseline.split(/\r?\n/);
    const workingLines = working.split(/\r?\n/);
    const maxLines = Math.max(baselineLines.length, workingLines.length, 1);
    const changedLineCount = Array.from({ length: maxLines }).filter((_, index) => baselineLines[index] !== workingLines[index]).length;
    const addedLines = working === baseline ? 0 : Math.max(1, workingLines.length - baselineLines.length, changedLineCount);
    const removedLines = working === baseline ? 0 : Math.max(0, baselineLines.length - workingLines.length, changedLineCount);

    return [
      {
        id: path,
        path,
        status: buffer ? (working === baseline ? "unchanged" : "preview") : "empty",
        original: baseline,
        modified: working,
        addedLines,
        removedLines,
        diagnosticsCount: 0,
        diagnosticsSeverity: "none",
        reviewStatus: buffer ? "reviewable" : "no-buffer",
        verifyStatus: operationalGate.ok ? "ready" : "blocked",
        applyStatus: operationalGate.ok ? "guarded" : "blocked",
        healthStatus: operationalGate.ok ? "operational" : "not-operational",
        hunks: [
          {
            id: `${path}:synthetic-hunk`,
            header: `@@ active-buffer ${path} @@`,
            summary: buffer ? "Baseline versus working copy for the active editor buffer." : "Select a workspace file to hydrate diff review.",
            decision: working === baseline ? "accepted" : "needs-attention",
            diagnosticsCount: 0,
            diagnosticsSeverity: "none",
            lines: Array.from({ length: Math.min(maxLines, 160) }).map((_, index) => {
              const oldLine = baselineLines[index];
              const newLine = workingLines[index];
              const same = oldLine === newLine;
              return {
                id: `${path}:line:${index + 1}`,
                kind: same ? "context" : "modified",
                content: newLine ?? oldLine ?? "",
                oldLineNumber: oldLine === undefined ? undefined : index + 1,
                newLineNumber: newLine === undefined ? undefined : index + 1,
              };
            }),
          },
        ],
      },
    ];
  }, [activeEditorBuffer, operationalGate.ok, selectedWorkspacePath]);

  React.useEffect(() => {
    setSelectedDiffHunkId(null);
  }, [activeEditorBuffer?.path]);

  const PatchSurface = () => (
    <SurfaceFrame
      eyebrow="Patch"
      title="Patch review gate"
      description="Patch work is review-first. This surface now exposes the workspace gate, bridge capabilities, runtime evidence, and verification handoff instead of an inert placeholder."
      actions={[
        {
          id: "refresh-workspace",
          label: "Refresh workspace",
          description: "Patch preview depends on current workspace posture.",
          onClick: refreshWorkspaceHealth,
        },
        {
          id: "refresh-runtime",
          label: "Refresh runtime",
          description: "Reload runtime evidence before patch review.",
          onClick: refreshRuntime,
        },
        {
          id: "open-verify",
          label: "Bind verification",
          description: "Move to verification surface.",
          disabled: !operationalGate.ok,
          onClick: () => selectInteractionView("verify", "Patch surface requested verification binding."),
        },
      ]}
      facts={[
        { label: "Workspace gate", value: surfaceWorkspaceBound ? "open" : "blocked", tone: surfaceWorkspaceBound ? "good" : "warn" },
        { label: "Preview mode", value: "review-first", tone: "good" },
        { label: "Apply mode", value: "blocked until verified", tone: "warn" },
        { label: "Patch capability", value: hasSurfaceCapability("patch") ? "declared" : "not declared", tone: hasSurfaceCapability("patch") ? "good" : "bad" },
      ]}
    >
      <div className="grid gap-6">
        <div className="min-h-[34rem]">
          <DiffViewerPane
            title="Active buffer diff review"
            subtitle="Governed baseline versus working-copy comparison for the selected workspace file."
            files={patchReviewFiles as any}
            selectedFileId={patchReviewFiles[0]?.id}
            selectedHunkId={selectedDiffHunkId ?? patchReviewFiles[0]?.hunks?.[0]?.id}
            splitView={true}
            showWhitespace={false}
            canOpenFile={Boolean(activeEditorBuffer?.path)}
            canRevealFile={Boolean(activeEditorBuffer?.path)}
            canNavigateToFile={Boolean(activeEditorBuffer?.path)}
            onOpenFile={(file) => {
              if (file?.path && file.path !== "No active buffer") void openWorkspacePath(file.path);
            }}
            onRevealFile={(file) => {
              if (!file?.path || file.path === "No active buffer") return;
              selectWorkspacePath(file.path);
              recordEvent("workspace.diff", { kind: "diff.file.revealed", detail: { path: file.path } });
            }}
            onNavigateToFile={(file) => {
              if (!file?.path || file.path === "No active buffer") return;
              selectWorkspacePath(file.path);
              selectInteractionView("workspace", "Diff viewer navigated to workspace editor.");
            }}
            onSelectFile={(file) => {
              setSelectedDiffHunkId(file.hunks?.[0]?.id ?? null);
              recordEvent("workspace.diff", { kind: "diff.file.selected", detail: { path: file.path, status: file.status } });
            }}
            onSelectHunk={(file, hunk) => {
              setSelectedDiffHunkId(hunk.id);
              recordEvent("workspace.diff", { kind: "diff.hunk.selected", detail: { path: file.path, hunkId: hunk.id } });
            }}
            onRefresh={refreshWorkspaceHealth}
          />
        </div>
        <div className="grid gap-6 2xl:grid-cols-3">
          <SnapshotCard title="Patch gate evidence" value={toSurfaceJson({ workspaceRoot: surfaceWorkspaceRoot, workspaceBound: surfaceWorkspaceBound, bridgeCapabilities: surfaceCapabilities.filter((c) => String(c).includes("patch")) })} />
          <SnapshotCard title="Workspace posture" value={toSurfaceJson(state.workspaceHealth)} />
          <SnapshotCard title="Runtime snapshot" value={toSurfaceJson(state.runtimeSnapshot)} />
        </div>
      </div>
    </SurfaceFrame>
  );

  const VerifySurface = () => (
    <SurfaceFrame
      eyebrow="Verify"
      title="Verification evidence gate"
      description="Verification binds runtime, workspace, diagnostics, and patch lineage before any apply step. The surface is wired to refresh current evidence and expose degraded posture."
      actions={[
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime state.", onClick: refreshRuntime },
        { id: "refresh-diagnostics", label: "Refresh diagnostics", description: "Reload diagnostics evidence.", onClick: refreshDiagnosticsRuntime },
        {
          id: "open-ledger",
          label: "Open ledger",
          description: "Review history and evidence trail.",
          onClick: () => selectInteractionView("ledger", "Verification evidence routed to ledger review."),
        },
      ]}
      facts={[
        { label: "Runtime", value: state.runtimeSnapshot ? "loaded" : "missing", tone: state.runtimeSnapshot ? "good" : "warn" },
        { label: "Diagnostics", value: state.diagnosticsRuntime ? "loaded" : "missing", tone: state.diagnosticsRuntime ? "good" : "warn" },
        { label: "Workspace", value: surfaceWorkspaceBound ? "bound" : "unbound", tone: surfaceWorkspaceBound ? "good" : "warn" },
        { label: "Verify capability", value: hasSurfaceCapability("verify") ? "declared" : "not declared", tone: hasSurfaceCapability("verify") ? "good" : "bad" },
      ]}
    >
      <div className="grid gap-6 2xl:grid-cols-2">
        <SnapshotCard title="Runtime evidence" value={toSurfaceJson(state.runtimeSnapshot)} />
        <SnapshotCard title="Diagnostics evidence" value={toSurfaceJson(state.diagnosticsRuntime)} />
      </div>
    </SurfaceFrame>
  );

  const LedgerSurface = () => (
    <SurfaceFrame
      eyebrow="Ledger"
      title="Ledger-backed history"
      description="Ledger state must make history, event lineage, bootstrap hash, and replay anchors visible. This surface now exposes current evidence and event count."
      actions={[
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime state.", onClick: refreshRuntime },
        {
          id: "open-activity",
          label: "Open activity",
          description: "Inspect live event stream.",
          onClick: () => selectInteractionView("activity", "Ledger requested activity stream."),
        },
      ]}
      facts={[
        { label: "Bootstrap hash", value: state.bootstrapHash, tone: "neutral" },
        { label: "Events", value: String(state.eventLog.length), tone: state.eventLog.length ? "good" : "neutral" },
        { label: "Ledger capability", value: hasSurfaceCapability("ledger") ? "declared" : "not declared", tone: hasSurfaceCapability("ledger") ? "good" : "bad" },
        { label: "Phase", value: state.phase, tone: state.phase === "ready" ? "good" : "warn" },
      ]}
    >
      <div className="grid gap-6 2xl:grid-cols-2">
        <SnapshotCard title="Ledger context" value={toSurfaceJson({ bootstrapHash: state.bootstrapHash, phase: state.phase, readyAtMs: state.readyAtMs, eventCount: state.eventLog.length })} />
        <SnapshotCard title="Recent event log" value={toSurfaceJson(state.eventLog.slice(0, 20))} />
      </div>
    </SurfaceFrame>
  );

  const AgentSurface = () => (
    <SurfaceFrame
      eyebrow="Agent"
      title="Agent readiness"
      description="Agent state is not inferred from a green chip. This surface exposes endpoint, auth, reconnect posture, failures, and pending request state."
      actions={[
        { id: "refresh-agent", label: "Refresh agent", description: "Reload agent health.", onClick: refreshAgentHealth },
        { id: "refresh-diagnostics", label: "Refresh diagnostics", description: "Reload diagnostics runtime.", onClick: refreshDiagnosticsRuntime },
      ]}
      facts={[
        { label: "Agent", value: state.agentHealth ? "loaded" : "missing", tone: state.agentHealth ? "good" : "warn" },
        { label: "Endpoint", value: String((state.agentHealth as any)?.url ?? (state.agentHealth as any)?.endpoint ?? "unknown"), tone: state.agentHealth ? "good" : "neutral" },
        { label: "Agent capability", value: hasSurfaceCapability("agent") ? "declared" : "not declared", tone: hasSurfaceCapability("agent") ? "good" : "bad" },
        { label: "Failure", value: String((state.agentHealth as any)?.error ?? (state.agentHealth as any)?.failure ?? "none"), tone: (state.agentHealth as any)?.error ? "bad" : "good" },
      ]}
    >
      <div className="grid gap-6 2xl:grid-cols-2">
        <SnapshotCard title="Agent health" value={toSurfaceJson(state.agentHealth)} />
        <SnapshotCard title="Diagnostics runtime" value={toSurfaceJson(state.diagnosticsRuntime)} />
      </div>
    </SurfaceFrame>
  );

  const DiagnosticsSurface = () => (
    <SurfaceFrame
      eyebrow="Diagnostics"
      title="Diagnostics cockpit"
      description="Diagnostics are the inspectability boundary for startup, runtime, provider state, crash context, and degraded operation."
      actions={[
        { id: "refresh-diagnostics", label: "Refresh diagnostics", description: "Reload diagnostics runtime.", onClick: refreshDiagnosticsRuntime },
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime snapshot.", onClick: refreshRuntime },
        { id: "refresh-agent", label: "Refresh agent", description: "Reload provider/agent status.", onClick: refreshAgentHealth },
      ]}
      facts={[
        { label: "Diagnostics", value: state.diagnosticsRuntime ? "loaded" : "missing", tone: state.diagnosticsRuntime ? "good" : "warn" },
        { label: "Runtime", value: state.runtimeSnapshot ? "loaded" : "missing", tone: state.runtimeSnapshot ? "good" : "warn" },
        { label: "Fatal", value: state.fatalError ?? "none", tone: state.fatalError ? "bad" : "good" },
        { label: "Degraded", value: state.degradedReason ?? "none", tone: state.degradedReason ? "warn" : "good" },
      ]}
    >
      <div className="grid gap-6 2xl:grid-cols-2">
        <SnapshotCard title="Diagnostics runtime" value={toSurfaceJson(state.diagnosticsRuntime)} />
        <SnapshotCard title="Bootstrap diagnostics" value={toSurfaceJson({ phase: state.phase, degradedReason: state.degradedReason, fatalError: state.fatalError, bootstrapHash: state.bootstrapHash })} />
      </div>
    </SurfaceFrame>
  );

  const ActivitySurface = () => (
    <SurfaceFrame
      eyebrow="Activity"
      title="Activity stream"
      description="Activity records renderer-observed workspace, agent, diagnostics, patch, and verify events. An empty stream is now an explicit state, not a blank panel."
      actions={[
        { id: "refresh-runtime", label: "Refresh runtime", description: "Reload runtime state.", onClick: refreshRuntime },
        {
          id: "open-diagnostics",
          label: "Open diagnostics",
          description: "Inspect diagnostics posture.",
          onClick: () => selectInteractionView("diagnostics", "Activity stream requested diagnostics."),
        },
      ]}
      facts={[
        { label: "Events", value: String(state.eventLog.length), tone: state.eventLog.length ? "good" : "neutral" },
        { label: "Notifications", value: String(state.notifications.length), tone: state.notifications.length ? "warn" : "good" },
        { label: "Phase", value: state.phase, tone: state.phase === "ready" ? "good" : "warn" },
        { label: "Hash", value: state.bootstrapHash, tone: "neutral" },
      ]}
    >
      <section className="rounded-3xl border border-zinc-800 bg-zinc-950/50 p-6 shadow-lg">
        <h3 className="text-sm font-semibold uppercase tracking-[0.2em] text-zinc-400">Event stream</h3>
        <div className="mt-4 space-y-3">
          {state.eventLog.length === 0 ? (
            <div className="rounded-2xl border border-dashed border-zinc-800 p-4 text-sm text-zinc-500">
              Event bus is wired. No events observed yet.
            </div>
          ) : (
            state.eventLog.map((event) => {
              const payload = ((event as any).payload ?? {}) as any;
              return (
                <div key={(event as any).id} className="rounded-2xl border border-zinc-800 bg-black/20 p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">{String((event as any).source ?? "unknown")}</div>
                    <div className="text-[10px] text-zinc-600">{new Date((event as any).atMs ?? Date.now()).toLocaleTimeString()}</div>
                  </div>
                  <div className="mt-2 text-sm font-medium text-zinc-100">{String(payload.kind ?? "event")}</div>
                  <pre className="mt-3 max-h-48 overflow-auto text-xs leading-6 text-zinc-300">
                    {JSON.stringify(payload.detail ?? payload, null, 2)}
                  </pre>
                </div>
              );
            })
          )}
        </div>
      </section>
    </SurfaceFrame>
  );

  const renderPrimaryContent = () => {
    switch (interactionView) {
      case "workspace":
        return <WorkspaceSurface />;
      case "patch":
        return <PatchSurface />;
      case "verify":
        return <VerifySurface />;
      case "ledger":
        return <LedgerSurface />;
      case "agent":
        return <AgentSurface />;
      case "diagnostics":
        return <DiagnosticsSurface />;
      case "activity":
        return <ActivitySurface />;
      case "overview":
      default:
        return <OverviewSurface />;
    }
  };

  const commandPaletteCommands = React.useMemo(
    () => [
      { id: "nav:overview", title: "Open Overview", subtitle: "Show workbench overview.", category: "navigation", scope: "global", risk: "safe", enabled: true, shortcutLabel: "G O", icon: "system" },
      { id: "nav:workspace", title: "Open Workspace", subtitle: "Show file tree and editor surface.", category: "navigation", scope: "workspace", risk: "safe", enabled: true, shortcutLabel: "G W", icon: "folder" },
      { id: "nav:patch", title: "Open Patch", subtitle: "Show patch review gate.", category: "navigation", scope: "patch", risk: "guarded", enabled: operationalGate.ok, enabledReason: operationalGate.ok ? "Workspace gate is operational." : operationalGate.failures.join(", "), shortcutLabel: "G P", icon: "patch" },
      { id: "nav:verify", title: "Open Verify", subtitle: "Show verification evidence gate.", category: "navigation", scope: "verify", risk: "safe", enabled: true, shortcutLabel: "G V", icon: "verify" },
      { id: "nav:ledger", title: "Open Ledger", subtitle: "Show ledger-backed history.", category: "navigation", scope: "global", risk: "safe", enabled: true, shortcutLabel: "G L", icon: "ledger" },
      { id: "nav:agent", title: "Open Agent", subtitle: "Show agent readiness posture.", category: "navigation", scope: "global", risk: "safe", enabled: true, shortcutLabel: "G A", icon: "bot" },
      { id: "nav:diagnostics", title: "Open Diagnostics", subtitle: "Show diagnostics cockpit.", category: "navigation", scope: "global", risk: "safe", enabled: true, shortcutLabel: "G D", icon: "diagnostics" },
      { id: "nav:activity", title: "Open Activity", subtitle: "Show renderer activity stream.", category: "navigation", scope: "global", risk: "safe", enabled: true, shortcutLabel: "G E", icon: "system" },

      { id: "workspace:open", title: "Open governed workspace", subtitle: "Attach a workspace through the preload bridge.", category: "workspace", scope: "workspace", risk: "guarded", enabled: true, authorityLabel: "workspace.open", icon: "folder" },
      { id: "workspace:refresh", title: "Refresh workspace posture", subtitle: "Reload workspace health and trust evidence.", category: "workspace", scope: "workspace", risk: "safe", enabled: true, authorityLabel: "workspace.health", icon: "folder" },
      { id: "runtime:refresh", title: "Refresh runtime", subtitle: "Reload renderer runtime snapshot.", category: "system", scope: "global", risk: "safe", enabled: true, authorityLabel: "runtime.snapshot", icon: "system" },
      { id: "agent:refresh", title: "Refresh agent", subtitle: "Reload provider and agent health.", category: "diagnostics", scope: "global", risk: "safe", enabled: true, authorityLabel: "agent.health", icon: "bot" },
      { id: "diagnostics:refresh", title: "Refresh diagnostics", subtitle: "Reload diagnostics runtime evidence.", category: "diagnostics", scope: "global", risk: "safe", enabled: true, authorityLabel: "diagnostics.runtime", icon: "diagnostics" },

      { id: "terminal:focus", title: "Focus terminal panel", subtitle: "Route operator to bottom transcript surface.", category: "terminal", scope: "global", risk: "safe", enabled: true, icon: "terminal" },
      { id: "chat:focus", title: "Focus chat rail", subtitle: "Route operator to workbench chat surface.", category: "chat", scope: "chat", risk: "safe", enabled: true, icon: "chat" },
    ],
    [operationalGate.failures, operationalGate.ok],
  );

  const runCommandPaletteCommand = React.useCallback(
    (command: any) => {
      recordEvent("renderer.command", {
        kind: "command.palette.run",
        detail: { id: command?.id ?? "unknown", title: command?.title ?? "unknown" },
      });

      const id = String(command?.id ?? "");

      if (id.startsWith("nav:")) {
        selectInteractionView(id.slice(4), `Command palette selected ${id}.`);
        setCommandPaletteOpen(false);
        return;
      }

      switch (id) {
        case "workspace:open":
          void openWorkspace();
          break;
        case "workspace:refresh":
          void refreshWorkspaceHealth();
          break;
        case "runtime:refresh":
          void refreshRuntime();
          break;
        case "agent:refresh":
          void refreshAgentHealth();
          break;
        case "diagnostics:refresh":
          void refreshDiagnosticsRuntime();
          break;
        case "terminal:focus":
          selectInteractionView("activity", "Command palette focused terminal-backed activity.");
          break;
        case "chat:focus":
          selectInteractionView("agent", "Command palette focused chat-adjacent agent posture.");
          break;
        default:
          notify("warn", "Command unavailable", id || "Unknown command.");
          break;
      }

      setCommandPaletteOpen(false);
    },
    [
      notify,
      openWorkspace,
      recordEvent,
      refreshAgentHealth,
      refreshDiagnosticsRuntime,
      refreshRuntime,
      refreshWorkspaceHealth,
      selectInteractionView,
    ],
  );


  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100">
      <AppShell
        appTitle="Adjutorix"
        subtitle={workspaceOpen ? `Governed workspace · ${workspaceName}` : "Governed execution surface"}
        health={shellHealth as any}
        currentView={interactionView}
        loading={state.phase === "booting"}
        commandPaletteOpen={commandPaletteOpen}
        onToggleCommandPalette={() => {
          const nextOpen = !commandPaletteOpen;
          setCommandPaletteOpen(nextOpen);
          recordEvent("renderer.command", { kind: "command.palette.toggled", detail: { nextOpen } });
        }}
        bottomPanelVisible={true}
        statusChips={statusChips as any}
        banners={banners as any}
        toasts={toasts as any}
        onSelectView={(view) => selectInteractionView(view, `Navigation selected: ${view}`)}
      headerActions={<CommandBar />}
        leftRail={
          <div className="space-y-6">
            <FileTreePane
              rootPath={workspaceRoot ?? undefined}
              workspaceRoot={workspaceRoot ?? undefined}
              workspaceName={workspaceName}
              entries={workspaceEntries}
              selectedPath={selectedWorkspacePath ?? undefined}
              openedPaths={openedWorkspacePaths}
              filterQuery={workspaceTreeQuery}
              health={workspaceOpen ? "healthy" : "unknown"}
              onFilterQueryChange={setWorkspaceTreeQuery}
              onSearchQueryChange={setWorkspaceTreeQuery}
              onPathSelected={openWorkspacePath}
              onOpenPath={openWorkspacePath}
              onOpenPathRequested={openWorkspacePath}
              onRefreshRequested={refreshWorkspaceHealth}
            />
            <SnapshotCard title="Manifest" value={state.manifest as JsonValue | null} />
            <SnapshotCard
              title="Workspace posture"
              value={{
                rootPath: workspaceRoot,
                phase: state.phase,
                workspaceHealth: state.workspaceHealth,
              }}
            />
          </div>
        }
        primaryContent={renderPrimaryContent()}
        rightRail={
          <div className="space-y-6 p-4">
            <ProviderStatus
              title="Provider posture"
              subtitle="Live renderer-side provider and bridge visibility"
              health={shellHealth as any}
              providers={providers as any}
              onRefreshRequested={() => {
                void Promise.allSettled([
                  refreshRuntime(),
                  refreshWorkspaceHealth(),
                  refreshAgentHealth(),
                  refreshDiagnosticsRuntime(),
                ]);
              }}
              onReconnectRequested={(provider) => {
                if (!provider || provider.id === "agent") {
                  void refreshAgentHealth();
                }
              }}
            />
            <ChatPanel
              title="Workbench chat"
              subtitle="Governed assistant interaction surface bound to current workspace posture."
              health={shellHealth}
              trustLevel={String((state.workspaceHealth as any)?.trustLevel ?? "unknown")}
              workspaceRoot={workspaceRoot ?? null}
              messages={state.eventLog.slice(0, 12).map((entry) => ({
                id: entry.id,
                role: "system",
                author: entry.source,
                content: `${entry.payload.kind}\n${JSON.stringify(entry.payload.detail ?? {}, null, 2)}`,
                createdAtMs: entry.atMs,
              }))}
              onSendMessage={(value: unknown) => {
                const content =
                  typeof value === "string"
                    ? value
                    : value && typeof value === "object"
                      ? String((value as any).content ?? (value as any).message ?? "")
                      : "";
                recordEvent("renderer.chat", {
                  kind: "chat.message.submitted",
                  detail: { content, workspaceRoot: workspaceRoot ?? null },
                });
              }}
              onClearRequested={() => {
                recordEvent("renderer.chat", {
                  kind: "chat.clear.requested",
                  detail: { source: "right-rail" },
                });
              }}
            />
          </div>
        }
        bottomPanel={
          <TerminalPanel
            title="Workbench terminal"
            subtitle="Renderer-observed command and system transcript surface."
            executionState={state.phase === "ready" ? "idle" : state.phase === "failed" ? "failed" : "degraded"}
            trustLevel={String((state.workspaceHealth as any)?.trustLevel ?? "unknown") as any}
            shellPath="governed renderer event bus"
            cwd={workspaceRoot ?? undefined}
            outputEntries={state.eventLog.slice().reverse().map((entry, index) => ({
              seq: index + 1,
              kind: "system",
              text: `[${entry.source}] ${entry.payload.kind}\n${JSON.stringify(entry.payload.detail ?? {}, null, 2)}`,
              atMs: entry.atMs,
              severity: "info",
            }))}
            commandHistory={[]}
            currentCommand={null}
            showStdout={true}
            showStderr={true}
            showSystem={true}
            showCommands={true}
            autoScroll={true}
            onClearRequested={() => recordEvent("renderer.terminal", { kind: "terminal.clear.requested", detail: { source: "bottom-panel" } })}
            onCopyTranscriptRequested={() => {
              const text = state.eventLog
                .slice()
                .reverse()
                .map((entry) => `[${new Date(entry.atMs).toISOString()}] [${entry.source}] ${entry.payload.kind}\n${JSON.stringify(entry.payload.detail ?? {}, null, 2)}`)
                .join("\n\n");
              void navigator.clipboard?.writeText(text);
              notify("info", "Transcript copied", "Workbench terminal transcript copied to clipboard.");
            }}
          />
        }
        modalLayer={
          <CommandPalette
            isOpen={commandPaletteOpen}
            title="Governed command palette"
            subtitle="Command routing with explicit scope, risk, readiness, and authority posture."
            health={shellHealth as any}
            trustLevel={String((state.workspaceHealth as any)?.trustLevel ?? "unknown") as any}
            commands={commandPaletteCommands as any}
            selectedCommandId={null}
            onClose={() => {
              setCommandPaletteOpen(false);
              recordEvent("renderer.command", {
                kind: "command.palette.closed",
                detail: { source: "command-palette" },
              });
            }}
            onSelectCommand={(command) => {
              recordEvent("renderer.command", {
                kind: "command.palette.selected",
                detail: { id: command.id, title: command.title },
              });
            }}
            onRunCommand={runCommandPaletteCommand}
          />
        }
        footer={
          <div className="px-4 py-3 text-xs text-zinc-500">
            bootstrap={state.phase} · workspace={workspaceOpen ? String(workspaceRoot) : "none"} · hash={state.bootstrapHash}
          </div>
        }
      />
    </div>
  );
}

// -----------------------------------------------------------------------------
// PROVIDER / BOOTSTRAP LOGIC
// -----------------------------------------------------------------------------

function AppProvider(props: { api: AdjutorixExposedApi; children: React.ReactNode }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, undefined, initialState);
  const subscriptionsRef = useRef<Array<() => void>>([]);

  const notify = useCallback((level: NotificationLevel, title: string, message: string) => {
    dispatch({
      type: "NOTIFY",
      item: {
        id: createHashLike({ level, title, message, atMs: Date.now() }),
        level,
        title,
        message,
        atMs: Date.now(),
      },
    });
  }, []);
  const recordEvent = React.useCallback((source: string, payload: { kind: string; detail?: unknown }) => {
    const atMs = Date.now();
    dispatch({
      type: "EVENT_RECEIVED",
      item: {
        id: stableHash({ source, payload, atMs }),
        source,
        payload,
        atMs,
      },
    });
  }, []);


  const refreshRuntime = useCallback(async () => {
    const envelope = normalizeEnvelope<JsonObject>(await props.api.runtime.snapshot(), "runtime.snapshot");
    if (envelope.ok) dispatch({ type: "RUNTIME_SNAPSHOT_UPDATED", runtimeSnapshot: envelope.data });
    else notify("error", "Runtime refresh failed", envelope.error.message);
  }, [notify, props.api]);

  const refreshWorkspaceHealth = useCallback(async () => {
    const envelope = normalizeEnvelope<JsonObject>(await props.api.workspace.health(), "workspace.health");
    if (envelope.ok) dispatch({ type: "WORKSPACE_HEALTH_UPDATED", workspaceHealth: envelope.data });
    else notify("error", "Workspace refresh failed", envelope.error.message);
  }, [notify, props.api]);

  const refreshAgentHealth = useCallback(async () => {
    const envelope = normalizeEnvelope<JsonObject>(await props.api.agent.health(), "agent.health");
    if (envelope.ok) dispatch({ type: "AGENT_HEALTH_UPDATED", agentHealth: envelope.data });
    else notify("error", "Agent refresh failed", envelope.error.message);
  }, [notify, props.api]);

  const refreshDiagnosticsRuntime = useCallback(async () => {
    const envelope = normalizeEnvelope<JsonObject>(await props.api.diagnostics.runtime(), "diagnostics.runtime");
    if (envelope.ok) dispatch({ type: "DIAGNOSTICS_RUNTIME_UPDATED", diagnosticsRuntime: envelope.data });
    else notify("error", "Diagnostics refresh failed", envelope.error.message);
  }, [notify, props.api]);

  useEffect(() => {
    let disposed = false;

    const bootstrap = async () => {
      dispatch({ type: "BOOTSTRAP_STARTED", startedAtMs: Date.now() });

      try {
        const manifest = props.api.compatibility.manifest();

        const [runtimeEnv, workspaceEnv, agentEnv, diagnosticsEnv] = await Promise.all([
          props.api.runtime.snapshot(),
          props.api.workspace.health(),
          props.api.agent.health(),
          props.api.diagnostics.runtime(),
        ]);

        if (disposed) return;

        const runtimeSnapshot = normalizeEnvelope<JsonObject>(runtimeEnv, "runtime.snapshot");
        const workspaceHealth = normalizeEnvelope<JsonObject>(workspaceEnv, "workspace.health");
        const agentHealth = normalizeEnvelope<JsonObject>(agentEnv, "agent.health");
        const diagnosticsRuntime = normalizeEnvelope<JsonObject>(diagnosticsEnv, "diagnostics.runtime");

        const runtimeOk = runtimeSnapshot.ok ? runtimeSnapshot.data : null;
        const workspaceOk = workspaceHealth.ok ? workspaceHealth.data : null;
        const agentOk = agentHealth.ok ? agentHealth.data : null;
        const diagnosticsOk = diagnosticsRuntime.ok ? diagnosticsRuntime.data : null;

        dispatch({
          type: "BOOTSTRAP_SUCCEEDED",
          readyAtMs: Date.now(),
          manifest,
          runtimeSnapshot: runtimeOk,
          workspaceHealth: workspaceOk,
          agentHealth: agentOk,
          diagnosticsRuntime: diagnosticsOk,
        });

        if (!runtimeSnapshot.ok || !workspaceHealth.ok || !agentHealth.ok || !diagnosticsRuntime.ok) {
          const errors = [runtimeSnapshot, workspaceHealth, agentHealth, diagnosticsRuntime]
            .filter((x): x is Extract<typeof x, { ok: false }> => !x.ok)
            .map((x) => `${x.meta.channel}: ${x.error.message}`)
            .join(" | ");
          dispatch({ type: "BOOTSTRAP_DEGRADED", reason: errors || "Bootstrap degraded." });
          notify("warn", "Bootstrap degraded", errors || "Some startup snapshots failed.");
        }

        const mkHandler =
          (source: EventLogItem["source"]) =>
          (payload: EventPayload): void => {
            dispatch({
              type: "EVENT_RECEIVED",
              item: {
                id: createHashLike({ source, payload, atMs: Date.now() }),
                source,
                payload,
                atMs: Date.now(),
              },
            });
          };

        subscriptionsRef.current = [
          props.api.workspace.events.subscribe(mkHandler("workspace")).unsubscribe,
          props.api.agent.events.subscribe(mkHandler("agent")).unsubscribe,
          props.api.diagnostics.events.subscribe(mkHandler("diagnostics")).unsubscribe,
          props.api.patch.events.subscribe(mkHandler("patch")).unsubscribe,
          props.api.verify.events.subscribe(mkHandler("verify")).unsubscribe,
        ];
      } catch (error) {
        if (disposed) return;
        const message = error instanceof Error ? error.message : String(error);
        dispatch({ type: "BOOTSTRAP_FAILED", failedAtMs: Date.now(), error: message });
      }
    };

    void bootstrap();

    return () => {
      disposed = true;
      for (const unsubscribe of subscriptionsRef.current) unsubscribe();
      subscriptionsRef.current = [];
    };
  }, [notify, props.api]);

  const ctxValue = useMemo<AppContextValue>(
    () => ({
      state,
      api: props.api,
      notify,
    recordEvent,
      refreshRuntime,
      refreshWorkspaceHealth,
      refreshAgentHealth,
      refreshDiagnosticsRuntime,
    }),
    [state, props.api, notify, recordEvent, refreshRuntime, refreshWorkspaceHealth, refreshAgentHealth, refreshDiagnosticsRuntime],
  );

  if (state.phase === "failed") {
    return (
      <FatalScreen
        title="Bootstrap failed"
        message={state.fatalError ?? "Unknown bootstrap failure."}
        diagnostics={{
          phase: state.phase,
          failedAtMs: state.failedAtMs,
          bootstrapHash: state.bootstrapHash,
          manifest: state.manifest,
        }}
      />
    );
  }

  return <AppContext.Provider value={ctxValue}>{props.children}</AppContext.Provider>;
}

// -----------------------------------------------------------------------------
// ROOT BOOTSTRAP
// -----------------------------------------------------------------------------

async function bootstrapRenderer(): Promise<JSX.Element> {
  const api = requireApi();
  validateApiShape(api);
  api.compatibility.assertCompatibleBridgeMeta({ version: api.manifest.bridgeVersion, bridge: api.manifest.bridgeName });

  return (
    <React.StrictMode>
      <RootErrorBoundary>
        <AppProvider api={api}>
          <ShellApp />
        </AppProvider>
      </RootErrorBoundary>
    </React.StrictMode>
  );
}

async function mount(): Promise<void> {
  const container = document.getElementById("root");
  if (!container) {
    throw new Error("renderer_root_container_missing");
  }
  const root = createRoot(container);

  try {
    const app = await bootstrapRenderer();
    root.render(app);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    root.render(
      <React.StrictMode>
        <FatalScreen
          title="Renderer could not mount"
          message={message}
          diagnostics={{
            hasAdjutorixApi: !!window.adjutorixApi,
            hasLegacyAdjutorix: !!window.adjutorix,
          }}
        />
      </React.StrictMode>,
    );
  }
}

void mount();
