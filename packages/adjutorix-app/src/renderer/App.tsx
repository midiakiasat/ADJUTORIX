// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import { OperatorMissionControlPanel } from "./components/OperatorMissionControlPanel";
import { OperatorExecutionRunwayPanel } from "./components/OperatorExecutionRunwayPanel";
import { OperatorSurfaceSpinePanel } from "./components/OperatorSurfaceSpinePanel";

type AnyRecord = Record<string, any>;

type FileRow = {
  path: string;
  label: string;
};

type Toast = {
  id: string;
  kind: "info" | "ok" | "warn" | "error";
  title: string;
  detail: string;
};

const ROOT_FILES = new Set([
  "README.md",
  "FINALITY.md",
  "LICENSE",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.json",
  "tsconfig.base.json",
]);

function asRecord(value: unknown): AnyRecord | null {
  return value && typeof value === "object" ? (value as AnyRecord) : null;
}

function isFn(value: unknown): value is (...args: any[]) => any {
  return typeof value === "function";
}

function unwrap(value: unknown): unknown {
  const record = asRecord(value);
  if (!record) return value;
  if (record.ok === true && "data" in record) return record.data;
  if (record.ok === true && "snapshot" in record) return record.snapshot;
  if (record.ok === true && "result" in record) return record.result;
  return value;
}

function bridge(): AnyRecord {
  const g = globalThis as AnyRecord;
  const runtime = asRecord(g.__adjutorixRendererRuntime) ?? asRecord(g.adjutorixRuntime);
  return asRecord(g.adjutorix) ?? asRecord(runtime?.bridge) ?? asRecord(runtime?.api) ?? {};
}

function cleanPath(input: unknown): string {
  return String(input ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function basename(path: unknown): string {
  const clean = cleanPath(path);
  return clean.split("/").filter(Boolean).pop() || clean || "Untitled";
}

function dirname(path: string): string {
  const clean = cleanPath(path);
  const parts = clean.split("/").filter(Boolean);
  parts.pop();
  return clean.startsWith("/") ? `/${parts.join("/")}` : parts.join("/");
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function looksLikeFilePath(input: unknown): boolean {
  const path = cleanPath(input);
  if (!path || /^https?:\/\//i.test(path) || /\s/.test(path)) return false;

  const leaf = basename(path);

  if (ROOT_FILES.has(leaf)) return true;

  // Hidden directories like .adjutorix and .github are NOT files.
  if (/^\.[A-Za-z0-9_-]+$/.test(leaf)) return false;

  return path.includes("/") && /\.[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(leaf);
}

function rel(path: string, root: string | null): string {
  const p = cleanPath(path);
  const r = cleanPath(root);
  if (r && p === r) return ".";
  if (r && p.startsWith(`${r}/`)) return p.slice(r.length + 1);
  return p;
}

function languageFor(path: string | null): string {
  const p = cleanPath(path).toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".sh")) return "shell";
  if (p.endsWith(".sql")) return "sql";
  return "plaintext";
}

function walk(value: unknown, fn: (value: unknown, key?: string) => void, key?: string, seen = new WeakSet<object>()): void {
  fn(value, key);

  const unwrapped = unwrap(value);
  if (unwrapped !== value) walk(unwrapped, fn, key, seen);

  if (!unwrapped || typeof unwrapped !== "object") return;
  if (seen.has(unwrapped as object)) return;
  seen.add(unwrapped as object);

  if (Array.isArray(unwrapped)) {
    for (const item of unwrapped) walk(item, fn, key, seen);
    return;
  }

  for (const [childKey, child] of Object.entries(unwrapped as AnyRecord)) {
    walk(child, fn, childKey, seen);
  }
}

function collectFiles(...inputs: unknown[]): FileRow[] {
  const paths = new Set<string>();

  for (const input of inputs) {
    walk(input, (value) => {
      if (typeof value === "string" && looksLikeFilePath(value)) {
        paths.add(cleanPath(value));
      }

      const record = asRecord(unwrap(value)) ?? asRecord(value);
      if (!record) return;

      const explicitType = String(record.type ?? record.kind ?? "").toLowerCase();
      const directory =
        explicitType.includes("dir") ||
        record.isDirectory === true ||
        record.directory === true ||
        record.children != null;

      if (directory) return;

      const path = firstString(
        record.path,
        record.filePath,
        record.fullPath,
        record.absolutePath,
        record.selectedPath,
      );

      if (path && looksLikeFilePath(path)) paths.add(cleanPath(path));
    });
  }

  return Array.from(paths)
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({ path, label: basename(path) }));
}

function inferRoot(files: FileRow[], ...inputs: unknown[]): string | null {
  const keys = new Set([
    "rootPath",
    "workspaceRoot",
    "workspacePath",
    "repoPath",
    "directory",
    "folderPath",
    "cwd",
  ]);

  for (const input of inputs) {
    let found: string | null = null;
    walk(input, (value, key) => {
      if (found || !key || !keys.has(key)) return;
      if (typeof value === "string" && value.trim()) found = cleanPath(value);
    });
    if (found) return found;
  }

  const paths = files.map((file) => file.path);
  for (const marker of ["/packages/", "/configs/", "/scripts/", "/tests/", "/docs/", "/src/"]) {
    for (const path of paths) {
      const index = path.indexOf(marker);
      if (index > 0) return path.slice(0, index);
    }
  }

  return paths.length ? dirname(paths[0]) : null;
}

function extractText(path: string, ...inputs: unknown[]): string | null {
  const target = cleanPath(path);
  let exact: string | null = null;

  const textKeys = new Set([
    "content",
    "contents",
    "text",
    "value",
    "body",
    "source",
    "preview",
    "previewText",
    "workingContent",
    "currentValue",
  ]);

  for (const input of inputs) {
    walk(input, (value) => {
      if (exact != null) return;

      if (typeof value === "string" && value.length > 0 && !looksLikeFilePath(value)) {
        return;
      }

      const record = asRecord(unwrap(value)) ?? asRecord(value);
      if (!record) return;

      const recordPath = cleanPath(firstString(
        record.path,
        record.filePath,
        record.fullPath,
        record.absolutePath,
        record.selectedPath,
      ));

      if (!recordPath) return;

      const matches =
        recordPath === target ||
        target.endsWith(`/${recordPath}`) ||
        recordPath.endsWith(`/${basename(target)}`);

      if (!matches) return;

      for (const [key, candidate] of Object.entries(record)) {
        if (textKeys.has(key) && typeof candidate === "string") {
          exact = candidate;
          return;
        }
      }
    });
  }

  return exact;
}

async function callMethod(api: AnyRecord | null, names: string[], arg: AnyRecord = {}): Promise<unknown> {
  if (!api) return null;

  let lastError: unknown = null;

  for (const name of names) {
    if (!isFn(api[name])) continue;
    try {
      return await api[name](arg);
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) throw lastError;
  return null;
}

function nowId(): string {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function App(): React.JSX.Element {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [bottom, setBottom] = useState<"closed" | "terminal" | "problems" | "activity">("closed");
  const [terminalInput, setTerminalInput] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([]);
  const [activity, setActivity] = useState<Toast[]>([]);
  const [raw, setRaw] = useState<unknown>(null);
  const [showRaw, setShowRaw] = useState(false);
  const [loading, setLoading] = useState(false);
  const [operatorIntent, setOperatorIntent] = useState("");
  const [operatorKernelReceipt, setOperatorKernelReceipt] = useState<AnyRecord | null>(null);
  const [operatorKernelPreviousHash, setOperatorKernelPreviousHash] = useState<string | null>(null);
  const [operatorKernelPatchId, setOperatorKernelPatchId] = useState("");
  const [operatorKernelPreviewHash, setOperatorKernelPreviewHash] = useState("");
  const [operatorKernelRequestHash, setOperatorKernelRequestHash] = useState("");
  const [operatorKernelBusy, setOperatorKernelBusy] = useState(false);

  const push = useCallback((kind: Toast["kind"], title: string, detail: string) => {
    setActivity((items) => [{ id: nowId(), kind, title, detail }, ...items].slice(0, 50));
  }, []);

  const shellApi = useMemo(() => {
    const b = bridge();
    return asRecord(b.shell) ?? asRecord(b.terminal);
  }, []);

  const shellReady = Boolean(shellApi && (isFn(shellApi.run) || isFn(shellApi.execute) || isFn(shellApi.start)));

  const operatorKernelApi = useMemo(() => {
    const g = globalThis as AnyRecord;
    return asRecord(g.adjutorixOperatorKernel) ?? asRecord(bridge().operatorKernel);
  }, []);

  const operatorKernelReady = Boolean(operatorKernelApi && isFn(operatorKernelApi.createReceipt));
  const operatorKernelReceiptId = firstString(
    operatorKernelReceipt?.receiptId,
    operatorKernelReceipt?.id,
    operatorKernelReceipt?.receipt_id,
  ) ?? "";
  const operatorKernelReceiptHash = firstString(
    operatorKernelReceipt?.receiptHash,
    operatorKernelReceipt?.kernelHash,
    operatorKernelReceipt?.hash,
    operatorKernelReceipt?.previousKernelHash,
  ) ?? "";
  const operatorKernelApplyReady = Boolean(
    operatorKernelReceiptHash &&
    operatorKernelPatchId.trim() &&
    operatorKernelPreviewHash.trim() &&
    operatorKernelRequestHash.trim(),
  );

  const createOperatorKernelReceipt = useCallback(async () => {
    if (!operatorKernelReady || !operatorKernelApi) {
      push("error", "Operator kernel unavailable", "adjutorixOperatorKernel bridge is not exposed.");
      return;
    }

    const workspaceRoot = rootPath ?? dirname(selectedPath ?? "");
    if (!workspaceRoot || workspaceRoot === ".") {
      push("warn", "Workspace root required", "Open or index a workspace before creating the kernel receipt.");
      return;
    }

    const intent =
      operatorIntent.trim() ||
      `Governed operation for ${selectedPath ? rel(selectedPath, rootPath) : workspaceRoot}`;

    setOperatorKernelBusy(true);
    try {
      const lastOutput = await callMethod(operatorKernelApi, ["lastHash"], { workspaceRoot });
      const lastRecord = asRecord(unwrap(lastOutput)) ?? {};
      const previousKernelHash = firstString(
        lastRecord.previousKernelHash,
        lastRecord.kernelHash,
        lastRecord.hash,
      );

      const output = await callMethod(operatorKernelApi, ["createReceipt"], {
        workspaceRoot,
        selectedPath,
        operatorIntent: intent,
        planId: "adjutorix-live-operator-surface-v0.4.0",
        commands: terminalInput.trim() ? [terminalInput.trim()] : [],
        previousKernelHash,
      });

      const receipt = asRecord(unwrap(output)) ?? asRecord(output) ?? {};
      setOperatorKernelReceipt(receipt);
      setOperatorKernelPreviousHash(previousKernelHash ?? firstString(receipt.previousKernelHash, receipt.kernelHash));
      push("ok", "Operator kernel receipt created", firstString(receipt.receiptHash, receipt.kernelHash, receipt.hash, receipt.id) ?? "receipt-ready");
    } catch (error) {
      push("error", "Operator kernel receipt failed", error instanceof Error ? error.message : String(error));
    } finally {
      setOperatorKernelBusy(false);
    }
  }, [operatorIntent, operatorKernelApi, operatorKernelReady, push, rootPath, selectedPath, terminalInput]);

  const applyKernelGatedPatch = useCallback(async () => {
    const patchApi = asRecord(bridge().patch);

    if (!patchApi || !isFn(patchApi.apply)) {
      push("error", "Patch apply unavailable", "adjutorix.patch.apply is not exposed.");
      return;
    }

    if (!operatorKernelApplyReady) {
      push("warn", "Kernel-gated apply blocked", "Create a receipt and provide patchId, previewHash, and requestHash.");
      return;
    }

    setOperatorKernelBusy(true);
    try {
      const output = await patchApi.apply({
        schema: 1,
        actor: "renderer",
        patchId: operatorKernelPatchId.trim(),
        previewHash: operatorKernelPreviewHash.trim(),
        requestHash: operatorKernelRequestHash.trim(),
        operatorKernelReceiptId: operatorKernelReceiptId || operatorKernelReceiptHash,
        operatorKernelHash: operatorKernelReceiptHash,
        operatorKernel: operatorKernelReceipt ?? {
          receiptHash: operatorKernelReceiptHash,
          previousKernelHash: operatorKernelPreviousHash,
        },
      });

      setRaw(output ?? raw);
      push("ok", "Kernel-gated apply submitted", operatorKernelPatchId.trim());
    } catch (error) {
      push("error", "Kernel-gated apply failed", error instanceof Error ? error.message : String(error));
    } finally {
      setOperatorKernelBusy(false);
    }
  }, [
    operatorKernelApplyReady,
    operatorKernelPatchId,
    operatorKernelPreviewHash,
    operatorKernelReceipt,
    operatorKernelReceiptHash,
    operatorKernelReceiptId,
    operatorKernelRequestHash,
    operatorKernelPreviousHash,
    push,
    raw,
  ]);

  const refresh = useCallback(async () => {
    setLoading(true);

    const b = bridge();
    const workspace = asRecord(b.workspace);
    const runtime = asRecord(b.runtime);
    const diagnostics = asRecord(b.diagnostics);

    const outputs: unknown[] = [];

    for (const [api, methods] of [
      [runtime, ["snapshot", "status", "load"]],
      [workspace, ["load", "tree", "list", "scan", "current", "status"]],
      [diagnostics, ["load", "runtime", "status"]],
    ] as Array<[AnyRecord | null, string[]]>) {
      try {
        const output = await callMethod(api, methods, {});
        if (output) outputs.push(output);
      } catch (error) {
        outputs.push({ error: error instanceof Error ? error.message : String(error) });
      }
    }

    const nextFiles = collectFiles(...outputs);
    const nextRoot = inferRoot(nextFiles, ...outputs);

    setRaw(outputs);
    setFiles(nextFiles);
    setRootPath(nextRoot);

    const preferred =
      nextFiles.find((file) => /packages\/adjutorix-app\/src\/renderer\/App\.tsx$/i.test(file.path)) ??
      nextFiles.find((file) => /configs\/runtime\/limits\.json$/i.test(file.path)) ??
      nextFiles.find((file) => /package\.json$/i.test(file.path)) ??
      nextFiles[0];

    if (preferred) {
      setSelectedPath(preferred.path);
      setTabs((current) => Array.from(new Set([...current, preferred.path])));
    }

    push("ok", "Workspace indexed", `${nextFiles.length} files`);
    setLoading(false);
  }, [push]);

  const openFile = useCallback(async (path: string) => {
    const clean = cleanPath(path);

    if (!looksLikeFilePath(clean)) {
      push("warn", "Directory ignored", rel(clean, rootPath));
      return;
    }

    const b = bridge();
    const workspace = asRecord(b.workspace);
    const fileApi = asRecord(workspace?.file);

    const arg = { path: clean, filePath: clean, selectedPath: clean };
    const outputs: unknown[] = [];

    try {
      const output =
        (await callMethod(fileApi, ["read", "load", "open", "preview"], arg)) ??
        (await callMethod(workspace, ["readFile", "read", "fileRead", "openFile", "previewFile", "preview"], arg));

      if (output) outputs.push(output);

      const text = extractText(clean, ...outputs) ?? (typeof output === "string" ? output : "");

      setSelectedPath(clean);
      setTabs((current) => Array.from(new Set([...current, clean])));
      setBuffers((current) => ({ ...current, [clean]: text }));
      setDirty((current) => ({ ...current, [clean]: false }));
      push("ok", "File opened", rel(clean, rootPath));
    } catch (error) {
      push("error", "File open failed", error instanceof Error ? error.message : String(error));
    }
  }, [push, rootPath]);

  const saveFile = useCallback(async () => {
    if (!selectedPath) return;

    const b = bridge();
    const workspace = asRecord(b.workspace);
    const fileApi = asRecord(workspace?.file);
    const content = buffers[selectedPath] ?? "";

    const arg = {
      path: selectedPath,
      filePath: selectedPath,
      selectedPath,
      content,
      text: content,
      value: content,
    };

    try {
      const output =
        (await callMethod(fileApi, ["write", "save", "update"], arg)) ??
        (await callMethod(workspace, ["writeFile", "saveFile", "save", "updateFile", "write"], arg));

      setDirty((current) => ({ ...current, [selectedPath]: false }));
      setRaw(output ?? raw);
      push("ok", "Saved", rel(selectedPath, rootPath));
    } catch (error) {
      push("error", "Save failed", error instanceof Error ? error.message : String(error));
    }
  }, [buffers, push, raw, rootPath, selectedPath]);

  const runTerminal = useCallback(async () => {
    const command = terminalInput.trim();
    if (!command) return;

    if (!shellReady || !shellApi) {
      setTerminalLines((lines) => [...lines, "$ " + command, "Terminal bridge unavailable."]);
      setTerminalInput("");
      return;
    }

    setTerminalLines((lines) => [...lines, "$ " + command]);

    try {
      const output = await callMethod(shellApi, ["run", "execute", "start"], {
        command,
        cwd: rootPath,
      });

      const text =
        typeof output === "string"
          ? output
          : JSON.stringify(output ?? {}, null, 2);

      setTerminalLines((lines) => [...lines, text]);
      setTerminalInput("");
    } catch (error) {
      setTerminalLines((lines) => [
        ...lines,
        error instanceof Error ? error.message : String(error),
      ]);
    }
  }, [rootPath, shellApi, shellReady, terminalInput]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files;
    return files.filter((file) => {
      const label = rel(file.path, rootPath).toLowerCase();
      const content = (buffers[file.path] ?? "").toLowerCase();
      return label.includes(q) || content.includes(q);
    });
  }, [buffers, files, query, rootPath]);

  const selectedValue = selectedPath ? buffers[selectedPath] ?? "" : "";

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#09090b] text-zinc-100">
      <header className="flex h-12 items-center justify-between border-b border-zinc-800 bg-black px-3">
        <div className="flex min-w-0 items-center gap-3">
          <div className="rounded-md border border-emerald-800/60 px-2 py-1 text-xs font-semibold text-emerald-300">
            ADJUTORIX REAL WORKBENCH CUT
          </div>
          <div className="truncate text-xs text-zinc-500">
            {rootPath ?? "No workspace root"}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button onClick={refresh} className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800">
            Refresh
          </button>
          <button
            onClick={saveFile}
            disabled={!selectedPath || !dirty[selectedPath]}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs enabled:hover:bg-zinc-800 disabled:opacity-40"
          >
            Save
          </button>
          <button
            onClick={() => setShowRaw((value) => !value)}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs hover:bg-zinc-800"
          >
            Inspect raw
          </button>
        </div>
      </header>

      <main className="grid h-[calc(100vh-48px)] grid-cols-[52px_340px_minmax(0,1fr)]">
        <aside className="flex flex-col items-center gap-2 border-r border-zinc-800 bg-black py-3">
          <button title="Explorer" className="h-9 w-9 rounded-lg bg-zinc-800 text-sm">F</button>
          <button title="Search" onClick={() => document.getElementById("global-file-search")?.focus()} className="h-9 w-9 rounded-lg bg-zinc-950 text-sm text-zinc-400">S</button>
          <button title="Problems" onClick={() => setBottom("problems")} className="h-9 w-9 rounded-lg bg-zinc-950 text-sm text-zinc-400">P</button>
          <button title="Terminal" onClick={() => setBottom(bottom === "terminal" ? "closed" : "terminal")} className="h-9 w-9 rounded-lg bg-zinc-950 text-sm text-zinc-400">T</button>
        </aside>

        <aside className="min-h-0 overflow-hidden border-r border-zinc-800 bg-[#111113]">
          <div className="border-b border-zinc-800 p-3">
            <div className="mb-3 flex items-center justify-between">
              <div>
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Explorer</div>
                <div className="mt-1 text-sm font-semibold">{files.length} files</div>
              </div>
              <div className={`rounded-md px-2 py-1 text-xs ${loading ? "bg-amber-950 text-amber-200" : "bg-emerald-950 text-emerald-300"}`}>
                {loading ? "indexing" : "ready"}
              </div>
            </div>

            <input
              id="global-file-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find file or text"
              className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-sm outline-none focus:border-emerald-700"
            />
          </div>

          <div className="h-[calc(100%-94px)] overflow-auto p-2">
            {visibleFiles.map((file) => {
              const active = file.path === selectedPath;
              const changed = dirty[file.path] === true;

              return (
                <button
                  key={file.path}
                  onClick={() => void openFile(file.path)}
                  className={`mb-1 block w-full truncate rounded-md px-2 py-1.5 text-left text-xs ${
                    active ? "bg-emerald-950/70 text-emerald-200" : "text-zinc-300 hover:bg-zinc-900"
                  }`}
                  title={file.path}
                >
                  <span className="mr-2 text-zinc-600">{changed ? "●" : "·"}</span>
                  {rel(file.path, rootPath)}
                </button>
              );
            })}
          </div>
        </aside>

        <section className="grid min-h-0 grid-rows-[42px_auto_minmax(0,1fr)_auto] bg-[#0b0b0d]">
          <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-[#111113] px-2">
            {tabs.length === 0 ? (
              <div className="text-xs text-zinc-500">No open files</div>
            ) : (
              tabs.map((path) => (
                <button
                  key={path}
                  onClick={() => setSelectedPath(path)}
                  className={`h-8 max-w-64 truncate rounded-md px-3 text-xs ${
                    path === selectedPath ? "bg-zinc-800 text-zinc-100" : "bg-zinc-950 text-zinc-400"
                  }`}
                  title={path}
                >
                  {dirty[path] ? "● " : ""}
                  {basename(path)}
                </button>
              ))
            )}
          </div>

          <OperatorSurfaceSpinePanel
            missionControl={<OperatorMissionControlPanel />}
            liveKernelCockpit={
              <div
                          data-testid="operator-kernel-live-surface"
                          className="border-b border-emerald-900/60 bg-emerald-950/10 px-3 py-2"
                        >
                          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-xs font-semibold uppercase tracking-[0.22em] text-emerald-300">
                                Operator Kernel Live Cockpit
                              </div>
                              <div className="mt-1 text-xs text-zinc-500">
                                User-visible receipt creation and kernel-gated apply evidence. No invisible mutation.
                              </div>
                            </div>
                            <div className={`rounded-md px-2 py-1 text-xs ${operatorKernelReady ? "bg-emerald-950 text-emerald-300" : "bg-red-950 text-red-300"}`}>
                              {operatorKernelReady ? "kernel bridge ready" : "kernel bridge missing"}
                            </div>
                          </div>

                          <div className="grid gap-2 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
                            <div className="grid gap-2">
                              <input
                                value={operatorIntent}
                                onChange={(event) => setOperatorIntent(event.target.value)}
                                placeholder="Operator intent required before governed apply"
                                className="w-full rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs outline-none focus:border-emerald-700"
                              />
                              <div className="grid gap-2 sm:grid-cols-3">
                                <input
                                  value={operatorKernelPatchId}
                                  onChange={(event) => setOperatorKernelPatchId(event.target.value)}
                                  placeholder="patchId"
                                  className="rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs outline-none focus:border-emerald-700"
                                />
                                <input
                                  value={operatorKernelPreviewHash}
                                  onChange={(event) => setOperatorKernelPreviewHash(event.target.value)}
                                  placeholder="previewHash"
                                  className="rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs outline-none focus:border-emerald-700"
                                />
                                <input
                                  value={operatorKernelRequestHash}
                                  onChange={(event) => setOperatorKernelRequestHash(event.target.value)}
                                  placeholder="requestHash"
                                  className="rounded-lg border border-zinc-800 bg-black px-3 py-2 text-xs outline-none focus:border-emerald-700"
                                />
                              </div>
                            </div>

                            <div className="grid gap-2">
                              <div className="grid grid-cols-2 gap-2 text-[11px] text-zinc-500">
                                <div className="truncate rounded-md border border-zinc-800 bg-black px-2 py-1">
                                  root: {rootPath ?? "none"}
                                </div>
                                <div className="truncate rounded-md border border-zinc-800 bg-black px-2 py-1">
                                  selected: {selectedPath ? rel(selectedPath, rootPath) : "none"}
                                </div>
                                <div className="truncate rounded-md border border-zinc-800 bg-black px-2 py-1">
                                  previousKernelHash: {operatorKernelPreviousHash ?? "none"}
                                </div>
                                <div className="truncate rounded-md border border-zinc-800 bg-black px-2 py-1">
                                  receiptHash: {operatorKernelReceiptHash || "none"}
                                </div>
                              </div>

                              <div className="flex flex-wrap gap-2">
                                <button
                                  onClick={() => void createOperatorKernelReceipt()}
                                  disabled={!operatorKernelReady || operatorKernelBusy}
                                  className="rounded-lg bg-emerald-900 px-3 py-2 text-xs font-semibold text-emerald-100 enabled:hover:bg-emerald-800 disabled:opacity-40"
                                >
                                  Create kernel receipt
                                </button>
                                <button
                                  onClick={() => void applyKernelGatedPatch()}
                                  disabled={!operatorKernelApplyReady || operatorKernelBusy}
                                  className="rounded-lg bg-zinc-100 px-3 py-2 text-xs font-semibold text-black enabled:hover:bg-white disabled:opacity-30"
                                >
                                  Kernel-gated apply
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
            }
            executionRunway={<OperatorExecutionRunwayPanel />}
          />

          <div className="min-h-0">
            {selectedPath ? (
              <Editor
                height="100%"
                theme="vs-dark"
                language={languageFor(selectedPath)}
                path={selectedPath}
                value={selectedValue}
                options={{
                  minimap: { enabled: true },
                  fontSize: 13,
                  lineNumbers: "on",
                  wordWrap: "off",
                  automaticLayout: true,
                  scrollBeyondLastLine: false,
                  renderWhitespace: "selection",
                }}
                onChange={(value) => {
                  if (!selectedPath) return;
                  setBuffers((current) => ({ ...current, [selectedPath]: value ?? "" }));
                  setDirty((current) => ({ ...current, [selectedPath]: true }));
                }}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                Select a file.
              </div>
            )}
          </div>

          {bottom !== "closed" && (
            <div className="h-56 border-t border-zinc-800 bg-[#111113]">
              <div className="flex h-9 items-center justify-between border-b border-zinc-800 px-3">
                <div className="flex items-center gap-2 text-xs">
                  <button onClick={() => setBottom("terminal")} className={bottom === "terminal" ? "text-emerald-300" : "text-zinc-500"}>Terminal</button>
                  <button onClick={() => setBottom("problems")} className={bottom === "problems" ? "text-emerald-300" : "text-zinc-500"}>Problems</button>
                  <button onClick={() => setBottom("activity")} className={bottom === "activity" ? "text-emerald-300" : "text-zinc-500"}>Activity</button>
                </div>
                <button onClick={() => setBottom("closed")} className="text-xs text-zinc-500">Close</button>
              </div>

              {bottom === "terminal" && (
                <div className="grid h-[calc(100%-36px)] grid-rows-[1fr_42px]">
                  <pre className="overflow-auto p-3 font-mono text-xs leading-5 text-zinc-300">
                    {terminalLines.join("\n")}
                  </pre>
                  <div className="flex items-center gap-2 border-t border-zinc-800 p-2">
                    <span className="text-xs text-zinc-500">$</span>
                    <input
                      value={terminalInput}
                      onChange={(event) => setTerminalInput(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") void runTerminal();
                      }}
                      placeholder={shellReady ? "Run command through real bridge" : "Terminal bridge unavailable"}
                      className="flex-1 rounded-md border border-zinc-800 bg-black px-3 py-1.5 font-mono text-xs outline-none focus:border-emerald-700"
                    />
                    <button onClick={runTerminal} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs">Run</button>
                  </div>
                </div>
              )}

              {bottom === "problems" && (
                <div className="p-3 text-xs text-zinc-400">
                  {selectedPath ? "No renderer problem surfaced for selected file." : "No file selected."}
                </div>
              )}

              {bottom === "activity" && (
                <div className="h-full overflow-auto p-3">
                  {activity.map((item) => (
                    <div key={item.id} className="mb-2 rounded-md border border-zinc-800 bg-black p-2 text-xs">
                      <div className="font-semibold text-zinc-100">{item.title}</div>
                      <div className="mt-1 text-zinc-500">{item.detail}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {showRaw && (
            <div className="absolute bottom-4 right-4 top-16 z-50 w-[520px] overflow-auto rounded-xl border border-zinc-700 bg-black p-4 shadow-2xl">
              <div className="mb-3 flex items-center justify-between">
                <div className="text-xs uppercase tracking-[0.22em] text-zinc-500">Raw bridge payload</div>
                <button onClick={() => setShowRaw(false)} className="text-xs text-zinc-500">Close</button>
              </div>
              <pre className="whitespace-pre-wrap break-words text-xs leading-5 text-zinc-300">
                {JSON.stringify(raw ?? {}, null, 2)}
              </pre>
            </div>
          )}
        </section>
      </main>
    </div>
  );
}
