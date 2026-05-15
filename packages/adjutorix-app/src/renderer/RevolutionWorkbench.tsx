// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";

type Any = Record<string, any>;

const MARKER = "ADJUTORIX_REVOLUTION_WORKBENCH_V1";

function api(): Any | null {
  const w = window as Any;
  return w.adjutorixApi ?? w.adjutorix ?? null;
}

function clean(p: unknown): string {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/, "");
}

function base(p: unknown): string {
  const parts = clean(p).split("/").filter(Boolean);
  return parts[parts.length - 1] ?? String(p ?? "");
}

function rel(path: string, root: string | null): string {
  const p = clean(path);
  const r = clean(root);
  if (r && p === r) return ".";
  if (r && p.startsWith(r + "/")) return p.slice(r.length + 1);
  return p;
}

function lang(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".sh")) return "shell";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  return "plaintext";
}

function record(x: unknown): Any {
  return x && typeof x === "object" ? x as Any : {};
}

function unwrap(x: unknown): any {
  const r = record(x);
  if (r.ok === true && "data" in r) return r.data;
  if (r.ok === true && "snapshot" in r) return r.snapshot;
  if (r.ok === true && "result" in r) return r.result;
  return x;
}

function childrenOf(x: Any): Any[] {
  return [
    x.children,
    x.entries,
    x.items,
    x.files,
    x.tree,
    x.workspaceTree,
    x.fileTree,
  ].find(Array.isArray) ?? [];
}

function isDir(x: Any): boolean {
  const k = String(x.kind ?? x.type ?? x.entryType ?? "").toLowerCase();
  return x.isDirectory === true || x.directory === true || k.includes("dir") || k.includes("folder") || childrenOf(x).length > 0;
}

function entryPath(x: Any): string | null {
  const p = x.path ?? x.fullPath ?? x.absolutePath ?? x.relativePath ?? x.workspacePath ?? x.id;
  return typeof p === "string" && p.trim() ? clean(p) : null;
}

function flattenTree(input: unknown): Any[] {
  const out: Any[] = [];
  const seen = new Set<any>();

  const visit = (x: unknown) => {
    const u = unwrap(x);
    if (!u || typeof u !== "object" || seen.has(u)) return;
    seen.add(u);

    if (Array.isArray(u)) {
      u.forEach(visit);
      return;
    }

    const r = record(u);
    const p = entryPath(r);
    if (p) out.push({ ...r, path: p, isDir: isDir(r) });

    for (const c of childrenOf(r)) visit(c);
    for (const key of ["workspace", "data", "snapshot", "runtime", "root", "result"]) visit(r[key]);
  };

  visit(input);

  return out
    .filter((e) => e.path)
    .sort((a, b) => String(a.path).localeCompare(String(b.path)));
}


function isWorkspaceNoisePath(path: unknown): boolean {
  const raw = clean(path);
  const p = `/${raw.toLowerCase()}/`;

  if (!raw.trim()) return true;

  if (
    p.includes("/node_modules/") ||
    p.includes("/.git/") ||
    p.includes("/dist/") ||
    p.includes("/build/") ||
    p.includes("/coverage/") ||
    p.includes("/__pycache__/") ||
    p.includes("/.pytest_cache/") ||
    p.includes("/.mypy_cache/") ||
    p.includes("/.ruff_cache/") ||
    p.includes("/.turbo/") ||
    p.includes("/.cache/") ||
    p.includes("/.vite/") ||
    p.includes("/quarantine/")
  ) {
    return true;
  }

  if (/(^|\/)\.adjutorix-release(\/|$)/i.test(raw)) return true;
  if (/(^|\/)\.adjutorix(\/|$)/i.test(raw)) return true;

  return false;
}

function isBinaryOrAssetPath(path: unknown): boolean {
  const p = clean(path).toLowerCase();
  return /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock)$/i.test(p);
}

function liveFileScore(path: unknown): number {
  const p = clean(path).toLowerCase();
  const name = base(p).toLowerCase();

  let score = 0;

  if (p.endsWith("/packages/adjutorix-app/src/renderer/revolutionworkbench.tsx")) score += 100000;
  if (p.endsWith("/packages/adjutorix-app/src/renderer/main.tsx")) score += 99000;
  if (p.endsWith("/packages/adjutorix-app/src/renderer/app.tsx")) score += 97000;
  if (p.endsWith("/packages/adjutorix-app/src/main/index.ts")) score += 95000;
  if (name === "package.json") score += 90000;
  if (name === "pnpm-workspace.yaml") score += 88000;
  if (name === "readme.md") score += 82000;

  if (p.includes("/src/")) score += 20000;
  if (p.includes("/packages/")) score += 12000;
  if (p.includes("/configs/")) score += 6000;
  if (p.includes("/scripts/")) score += 4000;
  if (p.includes("/tests/")) score += 1000;

  if (p.endsWith(".tsx")) score += 900;
  if (p.endsWith(".ts")) score += 800;
  if (p.endsWith(".json")) score += 500;
  if (p.endsWith(".md")) score += 300;
  if (p.endsWith(".sh")) score += 250;
  if (p.endsWith(".py")) score += 250;

  score -= Math.min(p.length, 500);

  return score;
}

function realFiles(entries: Any[]): Any[] {
  return entries
    .filter((e) => {
      if (e.isDir) return false;
      const p = clean(e.path);
      if (!p) return false;
      if (isWorkspaceNoisePath(p)) return false;
      if (isBinaryOrAssetPath(p)) return false;
      return true;
    })
    .sort((a, b) => {
      const byScore = liveFileScore(b.path) - liveFileScore(a.path);
      if (byScore !== 0) return byScore;
      return String(a.path).localeCompare(String(b.path));
    });
}

function visibleEntryCount(entries: Any[]): number {
  return entries.filter((e) => !isWorkspaceNoisePath(e.path)).length;
}

function chooseRoot(entries: Any[], snapshots: unknown[]): string | null {
  for (const s of snapshots) {
    let found: string | null = null;
    const walk = (x: any) => {
      if (!x || typeof x !== "object" || found) return;
      for (const k of ["rootPath", "workspaceRoot", "workspacePath", "repoPath", "cwd"]) {
        if (typeof x[k] === "string" && x[k].trim()) found = clean(x[k]);
      }
      if (Array.isArray(x)) x.forEach(walk);
      else Object.values(x).forEach(walk);
    };
    walk(unwrap(s));
    if (found) return found;
  }

  const paths = entries.map((e) => clean(e.path));
  for (const marker of ["/packages/", "/configs/", "/scripts/", "/tests/", "/docs/"]) {
    const hit = paths.find((p) => p.includes(marker));
    if (hit) return hit.slice(0, hit.indexOf(marker));
  }
  return null;
}

async function call(fn: any, arg: Any = {}) {
  if (typeof fn !== "function") return null;
  return unwrap(await fn(arg));
}

export default function RevolutionWorkbench() {
  const [root, setRoot] = useState<string | null>(null);
  const [entries, setEntries] = useState<Any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [tabs, setTabs] = useState<string[]>([]);
  const [buffers, setBuffers] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [bottom, setBottom] = useState<"log" | "raw" | "closed">("log");
  const [raw, setRaw] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const addLog = useCallback((line: string) => {
    setLog((l) => [`${new Date().toLocaleTimeString()}  ${line}`, ...l].slice(0, 200));
  }, []);

  const refresh = useCallback(async () => {
    setBusy(true);
    const a = api();
    if (!a) {
      addLog("BLOCKED: preload bridge missing");
      setBusy(false);
      return;
    }

    const snapshots = [];
    try { snapshots.push(await call(a.runtime?.snapshot)); } catch (e) { snapshots.push({ runtimeError: String(e) }); }
    try { snapshots.push(await call(a.workspace?.status)); } catch (e) { snapshots.push({ workspaceStatusError: String(e) }); }
    try { snapshots.push(await call(a.workspace?.tree)); } catch (e) { snapshots.push({ workspaceTreeError: String(e) }); }
    try { snapshots.push(await call(a.workspace?.scan)); } catch (e) { snapshots.push({ workspaceScanError: String(e) }); }
    try { snapshots.push(await call(a.diagnostics?.runtime)); } catch (e) { snapshots.push({ diagnosticsError: String(e) }); }

    const flat = flattenTree(snapshots);
    const r = chooseRoot(flat, snapshots);

    setRaw(snapshots);
    setRoot(r);
    setEntries(flat);

    const files = realFiles(flat);
    const preferred = files[0];
    const selectedInvalid = selected ? isWorkspaceNoisePath(selected) : false;

    if (selectedInvalid) {
      setSelected(null);
      setTabs([]);
      setBuffers({});
      setDirty({});
      addLog(`DROP JUNK BUFFER: ${selected}`);
    }

    if (preferred && (!selected || selectedInvalid)) {
      await openFile(preferred.path, r);
    }

    addLog(`REFRESH: ${flat.length} entries, ${files.length} files`);
    setBusy(false);
  }, [addLog, selected]);

  const openWorkspace = useCallback(async () => {
    const a = api();
    if (!a?.workspace?.open) {
      addLog("BLOCKED: workspace.open unavailable");
      return;
    }
    try {
      await call(a.workspace.open, { schema: 1, actor: "renderer", source: "ipc" });
      addLog("workspace.open completed");
      await refresh();
    } catch (e) {
      addLog(`workspace.open failed: ${String(e)}`);
    }
  }, [addLog, refresh]);

  const openFile = useCallback(async (path: string, rootOverride?: string | null) => {
    const a = api();
    const p = clean(path);
    const r = rootOverride ?? root;
    const relative = rel(p, r);

    const entry = entries.find((e) => clean(e.path) === p);
    if (entry?.isDir) {
      addLog(`SKIP DIRECTORY: ${relative}`);
      return;
    }

    if (!a?.workspace?.readFile) {
      addLog("BLOCKED: workspace.readFile unavailable");
      return;
    }

    try {
      const out = await call(a.workspace.readFile, {
        schema: 1,
        actor: "renderer",
        path: relative,
        targetPath: relative,
        relativePath: relative,
        filePath: relative,
        workspacePath: relative,
      });

      const text = String(out?.content ?? out?.text ?? out?.value ?? "");
      const realPath = clean(out?.path ?? p);

      setSelected(realPath);
      setTabs((t) => Array.from(new Set([...t, realPath])));
      setBuffers((b) => ({ ...b, [realPath]: text }));
      setDirty((d) => ({ ...d, [realPath]: false }));
      addLog(`OPEN: ${rel(realPath, r)}`);
    } catch (e) {
      addLog(`OPEN FAILED: ${relative} :: ${String(e)}`);
    }
  }, [addLog, entries, root]);

  const save = useCallback(async () => {
    if (!selected) return;
    const a = api();
    if (!a?.workspace?.writeFile && !a?.workspace?.saveFile) {
      addLog("BLOCKED: write/save bridge unavailable");
      return;
    }

    const relative = rel(selected, root);
    const content = buffers[selected] ?? "";

    try {
      const fn = a.workspace.writeFile ?? a.workspace.saveFile;
      await call(fn, {
        schema: 1,
        actor: "renderer",
        path: relative,
        targetPath: relative,
        relativePath: relative,
        filePath: relative,
        content,
        text: content,
        value: content,
      });
      setDirty((d) => ({ ...d, [selected]: false }));
      addLog(`SAVE: ${relative}`);
    } catch (e) {
      addLog(`SAVE FAILED: ${relative} :: ${String(e)}`);
    }
  }, [addLog, buffers, root, selected]);

  useEffect(() => { void refresh(); }, []);

  const files = useMemo(() => {
    const f = realFiles(entries);
    const q = query.trim().toLowerCase();
    if (!q) return f;
    return f.filter((e) => rel(e.path, root).toLowerCase().includes(q) || String(buffers[e.path] ?? "").toLowerCase().includes(q));
  }, [buffers, entries, query, root]);

  return (
    <div className="h-screen w-screen overflow-hidden bg-black text-zinc-100">
      <div className="grid h-full grid-rows-[44px_minmax(0,1fr)]">
        <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 px-3">
          <div className="flex min-w-0 items-center gap-3">
            <div className="rounded-md border border-emerald-700 bg-emerald-950/40 px-2 py-1 text-[11px] font-bold tracking-wide text-emerald-200">
              {MARKER}
            </div>
            <div className="truncate text-xs text-zinc-500">{root ?? "no workspace root"}</div>
          </div>
          <div className="flex items-center gap-2">
            <button onClick={openWorkspace} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">Open workspace</button>
            <button onClick={refresh} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">{busy ? "Refreshing..." : "Refresh"}</button>
            <button onClick={save} disabled={!selected || !dirty[selected]} className="rounded-md bg-emerald-900 px-3 py-1.5 text-xs enabled:hover:bg-emerald-800 disabled:opacity-40">Save</button>
            <button onClick={() => setBottom(bottom === "closed" ? "log" : "closed")} className="rounded-md bg-zinc-800 px-3 py-1.5 text-xs hover:bg-zinc-700">Bottom</button>
          </div>
        </header>

        <main className="grid min-h-0 grid-cols-[320px_minmax(0,1fr)]">
          <aside className="grid min-h-0 grid-rows-[88px_minmax(0,1fr)] border-r border-zinc-800 bg-zinc-950">
            <div className="border-b border-zinc-800 p-3">
              <div className="mb-2 flex items-center justify-between text-xs">
                <span className="font-semibold uppercase tracking-[0.18em] text-zinc-500">Files</span>
                <span className="text-zinc-500">{files.length}/{visibleEntryCount(entries)}</span>
              </div>
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="search files + loaded buffers"
                className="w-full rounded-md border border-zinc-800 bg-black px-3 py-2 text-xs outline-none focus:border-emerald-700"
              />
            </div>
            <div className="overflow-auto p-2">
              {files.map((f) => (
                <button
                  key={f.path}
                  onClick={() => void openFile(f.path)}
                  title={f.path}
                  className={[
                    "block w-full truncate rounded-md px-2 py-1.5 text-left text-xs",
                    selected === f.path ? "bg-emerald-950 text-emerald-100" : "text-zinc-300 hover:bg-zinc-900"
                  ].join(" ")}
                >
                  <span className="mr-2 text-zinc-600">{dirty[f.path] ? "●" : "·"}</span>
                  {rel(f.path, root)}
                </button>
              ))}
            </div>
          </aside>

          <section className="grid min-h-0 grid-rows-[38px_minmax(0,1fr)_auto]">
            <div className="flex min-w-0 items-center gap-1 overflow-x-auto border-b border-zinc-800 bg-zinc-950 px-2">
              {tabs.length === 0 ? <span className="text-xs text-zinc-600">No open files</span> : tabs.map((t) => (
                <button
                  key={t}
                  onClick={() => setSelected(t)}
                  className={[
                    "h-7 max-w-64 truncate rounded-md px-3 text-xs",
                    selected === t ? "bg-zinc-800 text-zinc-100" : "bg-black text-zinc-400"
                  ].join(" ")}
                  title={t}
                >
                  {dirty[t] ? "● " : ""}{base(t)}
                </button>
              ))}
            </div>

            <div className="min-h-0">
              {selected ? (
                <Editor
                  height="100%"
                  theme="vs-dark"
                  path={selected}
                  language={lang(selected)}
                  value={buffers[selected] ?? ""}
                  options={{
                    automaticLayout: true,
                    fontSize: 13,
                    minimap: { enabled: true },
                    scrollBeyondLastLine: false,
                    wordWrap: "off",
                    renderWhitespace: "selection",
                  }}
                  onChange={(v) => {
                    setBuffers((b) => ({ ...b, [selected]: v ?? "" }));
                    setDirty((d) => ({ ...d, [selected]: true }));
                  }}
                />
              ) : (
                <div className="grid h-full place-items-center text-sm text-zinc-600">Open a real file.</div>
              )}
            </div>

            {bottom !== "closed" && (
              <div className="h-56 border-t border-zinc-800 bg-zinc-950">
                <div className="flex h-8 items-center justify-between border-b border-zinc-800 px-3 text-xs">
                  <div className="flex gap-3">
                    <button onClick={() => setBottom("log")} className={bottom === "log" ? "text-emerald-300" : "text-zinc-500"}>Log</button>
                    <button onClick={() => setBottom("raw")} className={bottom === "raw" ? "text-emerald-300" : "text-zinc-500"}>Raw</button>
                  </div>
                  <button onClick={() => setBottom("closed")} className="text-zinc-500">Close</button>
                </div>
                <pre className="h-[calc(100%-32px)] overflow-auto p-3 text-xs leading-5 text-zinc-300">
                  {bottom === "raw" ? JSON.stringify(raw, null, 2) : log.join("\n")}
                </pre>
              </div>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
