// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import AppShell from "./components/AppShell";
import CommandPalette from "./components/CommandPalette";
import FileTreePane from "./components/FileTreePane";
import MonacoEditorPane from "./components/MonacoEditorPane";
import TerminalPanel from "./components/TerminalPanel";

type AnyRecord = Record<string, any>;
type ActivityItem = {
  id: string;
  title: string;
  message: string;
  level: "info" | "success" | "warn" | "error";
  atMs: number;
};

const ROOT_FILE_NAMES = new Set([
  "README.md",
  "LICENSE",
  "FINALITY.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
]);

function asRecord(value: unknown): AnyRecord | null {
  return value !== null && typeof value === "object" ? (value as AnyRecord) : null;
}

function isFn(value: unknown): value is (...args: any[]) => any {
  return typeof value === "function";
}

function unwrapEnvelope(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (record.ok === true && "data" in record) return record.data;
  if (record.ok === true && "snapshot" in record) return record.snapshot;
  return value;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function cleanPath(path: string): string {
  return String(path ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function basename(path: string | null | undefined): string {
  const value = cleanPath(String(path ?? ""));
  const parts = value.split("/").filter(Boolean);
  return parts[parts.length - 1] || value || "Untitled";
}

function relativeToRoot(path: string | null | undefined, rootPath: string | null | undefined): string {
  const pathValue = cleanPath(String(path ?? ""));
  const rootValue = cleanPath(String(rootPath ?? ""));
  if (!pathValue) return "";
  if (rootValue && pathValue === rootValue) return ".";
  if (rootValue && pathValue.startsWith(`${rootValue}/`)) return pathValue.slice(rootValue.length + 1);
  return pathValue;
}

function looksLikeFilePath(value: string): boolean {
  const path = cleanPath(value);
  if (!path || /^https?:\/\//i.test(path) || /\s/.test(path)) return false;
  const leaf = basename(path);
  if (ROOT_FILE_NAMES.has(leaf)) return true;
  if (!path.includes("/") && !path.includes("\\")) return false;
  return /\.[A-Za-z0-9]{1,16}$/.test(leaf);
}

function looksLikeDirectoryPath(value: string): boolean {
  const path = cleanPath(value);
  if (!path || looksLikeFilePath(path)) return false;
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("/");
}

function inferRootFromFile(path: string): string | null {
  const value = cleanPath(path);
  const markers = [
    "/packages/",
    "/configs/",
    "/scripts/",
    "/tests/",
    "/docs/",
    "/src/",
    "/dist/",
    "/node_modules/",
    "/.github/",
  ];
  for (const marker of markers) {
    const index = value.indexOf(marker);
    if (index > 0) return value.slice(0, index);
  }
  return null;
}

function uniq(values: string[]): string[] {
  return Array.from(new Set(values.map(cleanPath).filter(Boolean)));
}

function currentBridge(): AnyRecord {
  const g = globalThis as AnyRecord;
  const runtime = asRecord(g.__adjutorixRendererRuntime) ?? asRecord(g.adjutorixRuntime);
  return asRecord(g.adjutorix) ?? asRecord(runtime?.bridge) ?? asRecord(runtime?.api) ?? {};
}

function visitUnknown(value: unknown, visit: (value: unknown, key?: string) => void, key?: string, seen = new WeakSet<object>()) {
  visit(value, key);

  const unwrapped = unwrapEnvelope(value);
  if (unwrapped !== value) visitUnknown(unwrapped, visit, key, seen);

  if (!unwrapped || typeof unwrapped !== "object") return;
  if (seen.has(unwrapped as object)) return;
  seen.add(unwrapped as object);

  if (Array.isArray(unwrapped)) {
    for (const item of unwrapped) visitUnknown(item, visit, key, seen);
    return;
  }

  for (const [childKey, child] of Object.entries(unwrapped as AnyRecord)) {
    visitUnknown(child, visit, childKey, seen);
  }
}

function collectFilePaths(...inputs: unknown[]): string[] {
  const found: string[] = [];

  for (const input of inputs) {
    visitUnknown(input, (value) => {
      if (typeof value === "string" && looksLikeFilePath(value)) found.push(value);
    });
  }

  return uniq(found);
}

function collectRootPath(...inputs: unknown[]): string | null {
  const preferredKeys = new Set([
    "rootPath",
    "workspaceRoot",
    "workspacePath",
    "currentPath",
    "repoPath",
    "directory",
    "folderPath",
    "path",
  ]);

  const candidates: string[] = [];

  for (const input of inputs) {
    visitUnknown(input, (value, key) => {
      if (typeof value !== "string" || !value.trim()) return;
      if (key && !preferredKeys.has(key)) return;

      const clean = cleanPath(value);
      if (looksLikeDirectoryPath(clean)) candidates.push(clean);

      if (looksLikeFilePath(clean)) {
        const inferred = inferRootFromFile(clean);
        if (inferred) candidates.push(inferred);
      }
    });
  }

  return uniq(candidates)[0] ?? null;
}

function collectSelectedPath(...inputs: unknown[]): string | null {
  const keys = new Set(["selectedPath", "activePath", "currentPath", "filePath", "targetPath", "previewPath", "path"]);
  const candidates: string[] = [];

  for (const input of inputs) {
    visitUnknown(input, (value, key) => {
      if (typeof value === "string" && (!key || keys.has(key)) && looksLikeFilePath(value)) candidates.push(value);
    });
  }

  return uniq(candidates)[0] ?? null;
}

function collectStatus(...inputs: unknown[]): { health: string; trust: string; phase: string } {
  let health: string | null = null;
  let trust: string | null = null;
  let phase: string | null = null;

  for (const input of inputs) {
    visitUnknown(input, (value, key) => {
      if (typeof value !== "string") return;
      const lowered = value.toLowerCase();
      if (!health && key && /health|status|level/.test(key) && /healthy|degraded|unhealthy|ready|unknown|failed/.test(lowered)) health = value;
      if (!trust && key && /trust/.test(key) && /trusted|restricted|untrusted|unknown/.test(lowered)) trust = value;
      if (!phase && key && /phase/.test(key)) phase = value;
    });
  }

  return {
    health: health ?? "unknown",
    trust: trust ?? "unknown",
    phase: phase ?? "ready",
  };
}

function toWorkspaceEntries(rootPath: string | null, paths: string[]) {
  const entries: AnyRecord[] = [];

  if (rootPath) {
    entries.push({
      path: rootPath,
      name: basename(rootPath),
      type: "directory",
    });
  }

  for (const path of paths) {
    const absolute = rootPath && !cleanPath(path).startsWith("/") ? cleanPath(`${rootPath}/${path}`) : cleanPath(path);
    entries.push({
      path: absolute,
      relativePath: relativeToRoot(absolute, rootPath),
      name: basename(absolute),
      type: looksLikeFilePath(absolute) ? "file" : "directory",
    });
  }

  return entries;
}

function extractReadableContent(value: unknown): string | null {
  const priorityKeys = [
    "content",
    "contents",
    "text",
    "source",
    "buffer",
    "preview",
    "previewText",
    "body",
    "snippet",
    "value",
  ];

  const root = unwrapEnvelope(value);
  if (typeof root === "string") return root;

  const scan = (input: unknown, seen = new WeakSet<object>()): string | null => {
    const unwrapped = unwrapEnvelope(input);
    if (typeof unwrapped === "string") return unwrapped;
    if (!unwrapped || typeof unwrapped !== "object") return null;
    if (seen.has(unwrapped as object)) return null;
    seen.add(unwrapped as object);

    if (Array.isArray(unwrapped)) {
      for (const item of unwrapped) {
        const found = scan(item, seen);
        if (found !== null) return found;
      }
      return null;
    }

    const record = unwrapped as AnyRecord;
    for (const key of priorityKeys) {
      const valueAtKey = record[key];
      if (typeof valueAtKey === "string") return valueAtKey;
      const nested = scan(valueAtKey, seen);
      if (nested !== null) return nested;
    }

    return null;
  };

  return scan(root);
}

function languageFromPath(path: string | null): string {
  const p = cleanPath(String(path ?? "")).toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".sql")) return "sql";
  if (p.endsWith(".sh")) return "shell";
  return "plaintext";
}

function summarizeResult(value: unknown): string {
  const record = asRecord(value);
  if (record?.ok === false) {
    return firstString(record.error?.message, record.error?.code, "blocked") ?? "blocked";
  }

  const data = unwrapEnvelope(value);
  const dataRecord = asRecord(data);
  const status = firstString(dataRecord?.status, dataRecord?.state, dataRecord?.phase, dataRecord?.health);
  if (status) return status;

  if (Array.isArray(data)) return `${data.length} items`;
  if (dataRecord) return `${Object.keys(dataRecord).length} fields`;
  return "completed";
}

function WorkbenchCard(props: { title: string; eyebrow?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-[2rem] border border-zinc-800 bg-zinc-900/70 p-5 shadow-xl">
      {props.eyebrow ? <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">{props.eyebrow}</div> : null}
      <h2 className="mt-1 text-xl font-semibold text-zinc-50">{props.title}</h2>
      <div className="mt-5">{props.children}</div>
    </section>
  );
}

export default function App(): React.JSX.Element {
  const [currentView, setCurrentView] = useState("workspace");
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [paths, setPaths] = useState<string[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [openedPaths, setOpenedPaths] = useState<string[]>([]);
  const [fileContents, setFileContents] = useState<Record<string, string>>({});
  const [health, setHealth] = useState("unknown");
  const [trust, setTrust] = useState("unknown");
  const [phase, setPhase] = useState("ready");
  const [treeQuery, setTreeQuery] = useState("");
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [actionStatus, setActionStatus] = useState("No governed action has run yet.");
  const [terminalInput, setTerminalInput] = useState("");
  const [lastError, setLastError] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const appendActivity = useCallback((title: string, message: string, level: ActivityItem["level"] = "info") => {
    setActivity((items) => [
      { id: `${Date.now()}-${Math.random()}`, title, message, level, atMs: Date.now() },
      ...items,
    ].slice(0, 80));
  }, []);

  const mergeWorkspaceState = useCallback((...inputs: unknown[]) => {
    const nextRoot = collectRootPath(...inputs);
    const nextPaths = collectFilePaths(...inputs);
    const nextSelected = collectSelectedPath(...inputs);
    const status = collectStatus(...inputs);

    setRootPath((existing) => nextRoot ?? existing);
    setPaths((existing) => uniq([...existing, ...nextPaths]));
    setSelectedPath((existing) => nextSelected ?? existing ?? nextPaths[0] ?? null);
    setHealth(status.health);
    setTrust(status.trust);
    setPhase(status.phase);
  }, []);

  const refreshWorkspace = useCallback(async () => {
    const bridge = currentBridge();
    const snapshots: unknown[] = [];

    try {
      if (isFn(bridge.runtime?.snapshot)) snapshots.push(await bridge.runtime.snapshot());
      if (isFn(bridge.workspace?.health)) snapshots.push(await bridge.workspace.health());
      mergeWorkspaceState(...snapshots);
      appendActivity("Workspace refreshed", "Runtime and workspace posture updated.", "success");
      setLastError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      appendActivity("Workspace refresh failed", message, "error");
    }
  }, [appendActivity, mergeWorkspaceState]);

  const openWorkspace = useCallback(async () => {
    const bridge = currentBridge();
    if (!isFn(bridge.workspace?.open)) {
      appendActivity("Open workspace unavailable", "The preload bridge does not expose workspace.open.", "warn");
      return;
    }

    const candidateRoot = rootPath;
    if (!candidateRoot) {
      appendActivity("Workspace path required", "Open a root from startup/env first, then the renderer can bind it through the governed bridge.", "warn");
      return;
    }

    try {
      const opened = await bridge.workspace.open({
        schema: 1,
        actor: "renderer",
        source: "ipc",
        rootPath: candidateRoot,
        workspacePath: candidateRoot,
      });
      mergeWorkspaceState(opened);
      await refreshWorkspace();
      appendActivity("Workspace opened", candidateRoot, "success");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setLastError(message);
      appendActivity("Workspace open failed", message, "error");
    }
  }, [appendActivity, mergeWorkspaceState, refreshWorkspace, rootPath]);

  const openFile = useCallback(async (path: string) => {
    if (!path) return;
    const clean = cleanPath(path);
    setSelectedPath(clean);
    setOpenedPaths((existing) => uniq([...existing, clean]));
    appendActivity("File opened", relativeToRoot(clean, rootPath), "success");

    const bridge = currentBridge();
    const workspaceApi = asRecord(bridge.workspace);

    if (isFn(workspaceApi?.readFile)) {
      try {
        const read = await workspaceApi.readFile({ schema: 1, actor: "renderer", path: clean });
        const text = extractReadableContent(read);
        setFileContents((existing) => ({
          ...existing,
          [clean]: text ?? "Preview unavailable: workspace.readFile returned no renderer-readable text payload.",
        }));
        setLastError(null);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setFileContents((existing) => ({ ...existing, [clean]: `Read failed: ${message}` }));
        setLastError(message);
      }
      return;
    }

    setFileContents((existing) => ({
      ...existing,
      [clean]: "Preview unavailable: this bridge has no workspace.readFile capability.",
    }));
  }, [appendActivity, rootPath]);

  const revealSelected = useCallback(async () => {
    if (!selectedPath) return;
    const bridge = currentBridge();
    if (!isFn(bridge.workspace?.reveal)) {
      appendActivity("Reveal unavailable", "The preload bridge does not expose workspace.reveal.", "warn");
      return;
    }

    try {
      await bridge.workspace.reveal({ schema: 1, actor: "renderer", targetPath: selectedPath });
      appendActivity("Revealed in Finder", relativeToRoot(selectedPath, rootPath), "success");
    } catch (error) {
      appendActivity("Reveal failed", error instanceof Error ? error.message : String(error), "error");
    }
  }, [appendActivity, rootPath, selectedPath]);

  const runGovernedAction = useCallback(async (label: string, action: () => Promise<unknown>) => {
    setActionStatus(`${label}: running`);
    appendActivity(label, "Started governed bridge action.", "info");

    try {
      const result = await action();
      const summary = summarizeResult(result);
      setActionStatus(`${label}: ${summary}`);
      appendActivity(label, summary, asRecord(result)?.ok === false ? "warn" : "success");
      await refreshWorkspace();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setActionStatus(`${label}: ${message}`);
      appendActivity(label, message, "error");
    }
  }, [appendActivity, refreshWorkspace]);

  useEffect(() => {
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    const bridge = currentBridge();
    const subscriptions: Array<() => void> = [];

    const bind = (api: any, title: string) => {
      const subscribe = api?.events?.subscribe ?? api?.subscribe;
      if (!isFn(subscribe)) return;

      const subscription = subscribe((payload: unknown) => {
        mergeWorkspaceState(payload);
        appendActivity(title, "Renderer event received and folded into the workbench.", "info");
      });

      if (isFn(subscription)) subscriptions.push(subscription);
      else if (isFn(subscription?.unsubscribe)) subscriptions.push(() => subscription.unsubscribe());
    };

    bind(bridge.workspace, "Workspace event");
    bind(bridge.patch, "Patch event");
    bind(bridge.verify, "Verify event");
    bind(bridge.agent, "Agent event");
    bind(bridge.diagnostics, "Diagnostics event");

    return () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }, [appendActivity, mergeWorkspaceState]);

  const filteredPaths = useMemo(() => {
    const query = treeQuery.trim().toLowerCase();
    if (!query) return paths;
    return paths.filter((path) => relativeToRoot(path, rootPath).toLowerCase().includes(query));
  }, [paths, rootPath, treeQuery]);

  const workspaceEntries = useMemo(() => toWorkspaceEntries(rootPath, filteredPaths), [filteredPaths, rootPath]);
  const activeContent = selectedPath ? fileContents[selectedPath] ?? "Select a file to load its governed preview." : "No file selected.";
  const capabilities = useMemo(() => {
    const bridge = currentBridge();
    const listed = isFn(bridge.compatibility?.listCapabilities)
      ? bridge.compatibility.listCapabilities()
      : Array.isArray(bridge.manifest?.capabilities)
        ? bridge.manifest.capabilities
        : [];
    return Array.isArray(listed) ? listed : [];
  }, [activity.length, phase]);

  const shellAvailable = capabilities.some((capability: string) => /shell|terminal|command/.test(capability));

  const commands = useMemo(() => [
    {
      id: "open-workspace",
      title: "Open governed workspace",
      subtitle: rootPath ? relativeToRoot(rootPath, rootPath) || rootPath : "No root path currently bound",
      category: "workspace",
      scope: "workspace",
      risk: "safe",
      enabled: Boolean(rootPath),
      enabledReason: rootPath ? "Root path available" : "No root path",
      icon: "folder",
      keywords: ["open", "workspace"],
    },
    {
      id: "refresh-workspace",
      title: "Refresh workspace",
      subtitle: "Reload runtime and workspace posture",
      category: "workspace",
      scope: "workspace",
      risk: "safe",
      enabled: true,
      icon: "system",
      keywords: ["refresh", "workspace"],
    },
    {
      id: "focus-search",
      title: "Focus workspace search",
      subtitle: "Filter file tree and open visible results",
      category: "navigation",
      scope: "workspace",
      risk: "safe",
      enabled: true,
      icon: "search",
      keywords: ["search", "file"],
    },
    {
      id: "reveal-selected",
      title: "Reveal selected file",
      subtitle: selectedPath ? relativeToRoot(selectedPath, rootPath) : "No selected file",
      category: "workspace",
      scope: "selection",
      risk: "safe",
      enabled: Boolean(selectedPath),
      icon: "file",
      keywords: ["reveal", "finder"],
    },
    {
      id: "run-verify",
      title: "Run verify on selected target",
      subtitle: selectedPath ? relativeToRoot(selectedPath, rootPath) : "Workspace-level verification",
      category: "verify",
      scope: "verify",
      risk: "guarded",
      enabled: isFn(currentBridge().verify?.run),
      icon: "verify",
      keywords: ["verify", "test"],
    },
    {
      id: "terminal-unavailable",
      title: shellAvailable ? "Open terminal" : "Terminal unavailable",
      subtitle: shellAvailable ? "Shell capability detected" : "No shell command bridge is exposed; no fake terminal is mounted",
      category: "terminal",
      scope: "job",
      risk: "guarded",
      enabled: shellAvailable,
      icon: "terminal",
      keywords: ["terminal", "shell", "command"],
    },
  ], [rootPath, selectedPath, shellAvailable]);

  const runCommand = useCallback((command: any) => {
    setCommandPaletteOpen(false);

    if (command.id === "open-workspace") void openWorkspace();
    if (command.id === "refresh-workspace") void refreshWorkspace();
    if (command.id === "focus-search") searchRef.current?.focus();
    if (command.id === "reveal-selected") void revealSelected();
    if (command.id === "run-verify") {
      const bridge = currentBridge();
      void runGovernedAction("Verify run", () => bridge.verify.run({
        schema: 1,
        actor: "renderer",
        targets: selectedPath ? [selectedPath] : [],
      }));
    }
    if (command.id === "terminal-unavailable") {
      appendActivity("Terminal unavailable", "No shell command capability is exposed by the bridge, so this surface remains disabled instead of fake.", "warn");
    }
  }, [appendActivity, openWorkspace, refreshWorkspace, revealSelected, runGovernedAction, selectedPath]);

  const workspaceContent = (
    <div className="grid h-full min-h-[42rem] grid-cols-[minmax(18rem,24rem)_minmax(0,1fr)] gap-5">
      <FileTreePane
        rootPath={rootPath}
        entries={workspaceEntries}
        selectedPath={selectedPath}
        openedPaths={openedPaths}
        filterQuery={treeQuery}
        health={health}
        showHidden
        showIgnored={false}
        onFilterQueryChange={setTreeQuery}
        onRefreshRequested={refreshWorkspace}
        onPathSelected={(path: string) => setSelectedPath(cleanPath(path))}
        onOpenPath={(path: string) => void openFile(path)}
        onRevealPathRequested={(path: string) => {
          setSelectedPath(cleanPath(path));
          void revealSelected();
        }}
      />

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 rounded-[1.5rem] border border-zinc-800 bg-zinc-900/70 px-4 py-3">
          <input
            ref={searchRef}
            aria-label="Workspace search"
            className="min-w-[18rem] flex-1 rounded-2xl border border-zinc-800 bg-zinc-950 px-4 py-2 text-sm text-zinc-100 outline-none focus:border-emerald-600"
            placeholder="Search workspace files"
            value={treeQuery}
            onChange={(event) => setTreeQuery(event.currentTarget.value)}
          />
          <button
            type="button"
            className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-900"
            onClick={() => {
              const first = filteredPaths[0];
              if (first) void openFile(first);
            }}
          >
            Open first result
          </button>
          <button
            type="button"
            className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-100 hover:bg-zinc-900"
            onClick={revealSelected}
            disabled={!selectedPath}
          >
            Reveal selected
          </button>
        </div>

        <MonacoEditorPane
          path={selectedPath}
          title={selectedPath ? basename(selectedPath) : "No file selected"}
          language={languageFromPath(selectedPath)}
          baselineContent={activeContent}
          workingContent={activeContent}
          currentValue={activeContent}
          value={activeContent}
          readOnly
          modified={false}
          trustLevel={trust}
          reviewState="none"
          contentSource="working"
          showMinimap
          wordWrap="off"
          fontSize={13}
          diagnostics={[]}
          onSearchRequested={() => searchRef.current?.focus()}
        />
      </div>
    </div>
  );

  const rightRail = (
    <div className="space-y-4 p-5">
      <WorkbenchCard title="Operator context" eyebrow="Selected">
        <div className="space-y-3 text-sm text-zinc-300">
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Workspace</div>
            <div className="mt-1 break-words text-zinc-100">{rootPath ?? "No workspace root bound"}</div>
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">File</div>
            <div className="mt-1 break-words text-zinc-100">{selectedPath ? relativeToRoot(selectedPath, rootPath) : "No file selected"}</div>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Files</div>
              <div className="mt-1 text-lg font-semibold text-zinc-50">{paths.length}</div>
            </div>
            <div className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
              <div className="text-xs uppercase tracking-[0.18em] text-zinc-500">Opened</div>
              <div className="mt-1 text-lg font-semibold text-zinc-50">{openedPaths.length}</div>
            </div>
          </div>
        </div>
      </WorkbenchCard>

      <WorkbenchCard title="Action state" eyebrow="Live">
        <p className="text-sm leading-7 text-zinc-300">{actionStatus}</p>
        {lastError ? <p className="mt-3 rounded-2xl border border-rose-800 bg-rose-500/10 p-3 text-sm text-rose-200">{lastError}</p> : null}
      </WorkbenchCard>

      <WorkbenchCard title="Recent activity" eyebrow="Stream">
        <div className="max-h-72 space-y-2 overflow-auto">
          {activity.length === 0 ? (
            <p className="text-sm text-zinc-400">No activity yet.</p>
          ) : (
            activity.slice(0, 8).map((item) => (
              <div key={item.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-3">
                <div className="text-sm font-semibold text-zinc-100">{item.title}</div>
                <div className="mt-1 text-xs leading-5 text-zinc-400">{item.message}</div>
              </div>
            ))
          )}
        </div>
      </WorkbenchCard>
    </div>
  );

  const actionWorkflow = (view: string) => {
    const bridge = currentBridge();

    if (view === "patch") {
      return (
        <WorkbenchCard title="Patch workflow" eyebrow="Action surface">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-zinc-400">Patch preview is explicit. Approval and apply remain blocked until a real preview hash is returned.</p>
            <button
              type="button"
              className="rounded-2xl border border-emerald-700/50 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200"
              disabled={!selectedPath || !isFn(bridge.patch?.preview)}
              onClick={() => runGovernedAction("Patch preview", () => bridge.patch.preview({
                schema: 1,
                actor: "renderer",
                prompt: "Review selected file and propose a governed patch.",
                targetPaths: selectedPath ? [selectedPath] : [],
              }))}
            >
              Preview patch for selected file
            </button>
          </div>
        </WorkbenchCard>
      );
    }

    if (view === "verify") {
      return (
        <WorkbenchCard title="Verification workflow" eyebrow="Action surface">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-zinc-400">Run verification through the governed bridge. Evidence is summarized, not dumped as raw payload.</p>
            <button
              type="button"
              className="rounded-2xl border border-emerald-700/50 bg-emerald-500/10 px-4 py-2 text-sm font-medium text-emerald-200"
              disabled={!isFn(bridge.verify?.run)}
              onClick={() => runGovernedAction("Verify run", () => bridge.verify.run({
                schema: 1,
                actor: "renderer",
                targets: selectedPath ? [selectedPath] : [],
              }))}
            >
              Run verify
            </button>
          </div>
        </WorkbenchCard>
      );
    }

    if (view === "ledger") {
      return (
        <WorkbenchCard title="Ledger workflow" eyebrow="Action surface">
          <div className="space-y-4">
            <p className="text-sm leading-7 text-zinc-400">Ledger is a navigable history surface. Raw event payloads stay out of the default UI.</p>
            <button
              type="button"
              className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm font-medium text-zinc-100"
              disabled={!isFn(bridge.ledger?.timeline)}
              onClick={() => runGovernedAction("Ledger timeline", () => bridge.ledger.timeline({ limit: 50, reverse: true }))}
            >
              Refresh timeline
            </button>
          </div>
        </WorkbenchCard>
      );
    }

    if (view === "agent") {
      return (
        <WorkbenchCard title="Agent control" eyebrow="Action surface">
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Agent health", () => bridge.agent.health())}>Health</button>
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Agent start", () => bridge.agent.start({ schema: 1, actor: "renderer", reason: "operator requested start" }))}>Start</button>
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Agent stop", () => bridge.agent.stop({ schema: 1, actor: "renderer", reason: "operator requested stop" }))}>Stop</button>
          </div>
        </WorkbenchCard>
      );
    }

    if (view === "diagnostics") {
      return (
        <WorkbenchCard title="Diagnostics workflow" eyebrow="Action surface">
          <div className="flex flex-wrap gap-3">
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Diagnostics runtime", () => bridge.diagnostics.runtime())}>Runtime</button>
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Diagnostics startup", () => bridge.diagnostics.startup())}>Startup</button>
            <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => runGovernedAction("Diagnostics log tail", () => bridge.diagnostics.logTail({ target: "main", lines: 80 }))}>Tail logs</button>
          </div>
        </WorkbenchCard>
      );
    }

    if (view === "activity") {
      return (
        <WorkbenchCard title="Activity stream" eyebrow="Events">
          <div className="space-y-3">
            {activity.length === 0 ? <p className="text-sm text-zinc-400">No activity has been recorded.</p> : activity.map((item) => (
              <div key={item.id} className="rounded-2xl border border-zinc-800 bg-zinc-950/60 p-4">
                <div className="text-sm font-semibold text-zinc-100">{item.title}</div>
                <div className="mt-1 text-sm text-zinc-400">{item.message}</div>
              </div>
            ))}
          </div>
        </WorkbenchCard>
      );
    }

    return workspaceContent;
  };

  return (
    <AppShell
      appTitle="Adjutorix Workbench"
      subtitle="Live governed workspace"
      health={/healthy|ready/i.test(health) ? "healthy" : /degraded|restricted|warning/i.test(health) ? "degraded" : /failed|error|unhealthy/i.test(health) ? "unhealthy" : "unknown"}
      currentView={currentView}
      commandPaletteOpen={commandPaletteOpen}
      leftRailCollapsed={false}
      rightRailCollapsed={false}
      bottomPanelVisible={currentView === "workspace"}
      statusChips={[
        { label: "Phase", value: phase, tone: /ready/i.test(phase) ? "good" : "neutral" },
        { label: "Workspace", value: rootPath ? basename(rootPath) : "none", tone: rootPath ? "good" : "warn" },
        { label: "Files", value: String(paths.length), tone: paths.length > 0 ? "good" : "warn" },
        { label: "Trust", value: trust, tone: /trusted/i.test(trust) ? "good" : /restricted|unknown/i.test(trust) ? "warn" : "bad" },
      ]}
      navItems={[
        { key: "workspace", label: "Workspace" },
        { key: "patch", label: "Patch" },
        { key: "verify", label: "Verify" },
        { key: "ledger", label: "Ledger" },
        { key: "agent", label: "Agent" },
        { key: "diagnostics", label: "Diagnostics" },
        { key: "activity", label: "Activity", badge: activity.length || null },
      ]}
      onSelectView={(view) => setCurrentView(view)}
      onToggleCommandPalette={() => setCommandPaletteOpen((open) => !open)}
      headerActions={
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={openWorkspace}>Open workspace</button>
          <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={refreshWorkspace}>Refresh</button>
          <button type="button" className="rounded-2xl border border-zinc-700 bg-zinc-950 px-4 py-2 text-sm text-zinc-100" onClick={() => setCommandPaletteOpen(true)}>Commands</button>
        </div>
      }
      primaryContent={currentView === "workspace" ? workspaceContent : actionWorkflow(currentView)}
      rightRail={rightRail}
      bottomPanel={
        <div className="h-full p-4">
          <TerminalPanel
            title="Terminal"
            subtitle={shellAvailable ? "Governed shell bridge detected" : "No shell bridge exposed; disabled rather than fake"}
            health={shellAvailable ? "healthy" : "degraded"}
            trustLevel={trust}
            shellStatus={shellAvailable ? "ready" : "unavailable"}
            runState="idle"
            cwd={rootPath}
            commandInput={terminalInput}
            onCommandInputChange={setTerminalInput}
            canRun={false}
            canCancel={false}
            canClear
            onClearRequested={() => setTerminalInput("")}
            history={[
              {
                id: "terminal-boundary",
                kind: "system",
                text: shellAvailable
                  ? "Shell capability detected. Bind command runner before enabling execution."
                  : "Terminal execution is unavailable because the exposed bridge has no shell/terminal/command capability.",
                atMs: Date.now(),
                severity: shellAvailable ? "info" : "warn",
              },
            ]}
          />
        </div>
      }
      overlayLayer={
        <CommandPalette
          isOpen={commandPaletteOpen}
          query={commandQuery}
          commands={commands}
          health="healthy"
          trustLevel={trust}
          metrics={[
            { id: "files", label: "Files", value: String(paths.length), tone: paths.length > 0 ? "good" : "warn" },
            { id: "opened", label: "Opened", value: String(openedPaths.length), tone: openedPaths.length > 0 ? "good" : "neutral" },
          ]}
          onQueryChange={setCommandQuery}
          onClose={() => setCommandPaletteOpen(false)}
          onRunCommand={runCommand}
          onSelectCommand={runCommand}
        />
      }
      footer={
        <div className="flex flex-wrap gap-4 text-xs text-zinc-500">
          <span>workspace-first</span>
          <span>raw-json-hidden</span>
          <span>file-click-opens-editor</span>
          <span>{shellAvailable ? "terminal-capability-detected" : "terminal-disabled-no-fake"}</span>
        </div>
      }
    />
  );
}
