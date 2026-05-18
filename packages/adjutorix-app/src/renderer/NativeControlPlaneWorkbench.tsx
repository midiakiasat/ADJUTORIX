// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

import "./native-workbench.css";

const MARKER = "ADJUTORIX_NATIVE_PRODUCT_WORKBENCH_V14";

type Any = any;

type FileEntry = {
  path: string;
  isDir?: boolean;
  size?: number;
  score?: number;
};

type BufferState = {
  path: string;
  content: string;
  original: string;
  language: string;
  dirty: boolean;
  openedAt: number;
  savedAt?: number;
};

type Problem = {
  file?: string;
  line?: number;
  column?: number;
  severity: "error" | "warning" | "info";
  message: string;
};

type RunResult = {
  ok?: boolean;
  status?: string;
  exitCode?: number;
  command?: string;
  stdout?: string;
  stderr?: string;
  durationMs?: number;
};

const COMMAND_PATHS = [
  "shell.execute",
  "shell.run",
  "command.run",
  "commands.run",
  "terminal.execute",
  "terminal.run",
  "runtime.runCommand",
];

const READ_PATHS = [
  "workspace.readFile",
  "workspace.file.read",
  "workspace.read",
];

const WRITE_PATHS = [
  "workspace.writeFile",
  "workspace.saveFile",
  "workspace.file.write",
  "workspace.write",
];

const INDEX_PATHS = [
  "workspace.scan",
  "workspace.tree",
  "workspace.status",
  "runtime.snapshot",
  "diagnostics.runtime",
];

const TASKS = [
  ["doctor", "Doctor", "doctor", "echo ADJUTORIX_DOCTOR && pwd && node -v && pnpm -v && git branch --show-current && git rev-parse --short HEAD && git status --short | head -160"],
  ["build", "Build app", "build", "pnpm --filter @adjutorix/app run build"],
  ["typecheck", "Typecheck app", "build", "pnpm --filter @adjutorix/app exec tsc -p tsconfig.json --noEmit --pretty false"],
  ["verify", "Verify repository", "quality", "pnpm run verify"],
  ["test", "Run tests", "quality", "pnpm test"],
  ["debt", "Debt scan", "quality", "rg -n \"TODO|FIXME|HACK|throw new Error|bridge_missing|not implemented|placeholder|mock|stub|toy\" packages configs scripts src 2>/dev/null | head -400"],
  ["status", "SCM status", "scm", "git status --short && echo && git branch --show-current && git rev-parse --short HEAD"],
  ["diff", "SCM diff", "scm", "git diff --stat && echo && git diff --name-only && echo && git diff | head -800"],
  ["timeline", "Timeline", "scm", "git log --oneline --decorate --graph --max-count=120"],
  ["branches", "Branches", "scm", "git branch --all --verbose --no-abbrev | head -160"],
  ["files", "Source inventory", "index", "find . -type f | sed 's#^./##' | grep -Ev '(^|/)(node_modules|.git|dist|build|coverage|__pycache__|.pytest_cache|.mypy_cache|.ruff_cache|.cache|.vite|.turbo)/' | head -2000"],
  ["repo-map", "Write repo map", "index", "python3 - <<'PY'\nfrom pathlib import Path\nroot=Path.cwd()\nout=root/'.adjutorix'/'repo-map.md'\nout.parent.mkdir(parents=True,exist_ok=True)\nskip={'node_modules','.git','dist','build','coverage','__pycache__','.pytest_cache','.mypy_cache','.ruff_cache','.cache','.vite','.turbo'}\nrows=[]\nfor p in sorted(root.rglob('*')):\n    rel=p.relative_to(root)\n    if any(x in skip for x in rel.parts):\n        continue\n    if p.is_file():\n        rows.append(f'- `{rel}`')\nout.write_text('# ADJUTORIX Repository Map\\n\\n'+'\\n'.join(rows[:5000])+'\\n')\nprint(out)\nPY"],
  ["symbol-index", "Symbol index", "index", "rg -n \"^(export default function|export function|function|class|const|def|class ) \" packages src configs scripts 2>/dev/null | head -700"],
  ["health", "Workspace health", "doctor", "find . -maxdepth 4 \\( -name package.json -o -name tsconfig.json -o -name pnpm-workspace.yaml -o -name vite.config.* \\) | sort | head -300"],
];

const NAV = [
  ["explorer", "EX"],
  ["search", "SE"],
  ["commands", "CM"],
  ["scm", "SC"],
  ["tasks", "TK"],
  ["agent", "AG"],
  ["graph", "GR"],
  ["runtime", "RT"],
];

const RIGHT = ["inspector", "outline", "problems", "patch", "graph", "agent", "runtime"];

function api() {
  const w = window as Any;
  const a = w.adjutorix ?? {};
  const b = w.adjutorixApi ?? {};
  return {
    ...b,
    ...a,
    shell: a.shell ?? b.shell,
    command: a.command ?? b.command,
    commands: a.commands ?? b.commands,
    terminal: a.terminal ?? b.terminal,
    workspace: { ...(b.workspace ?? {}), ...(a.workspace ?? {}) },
    runtime: { ...(b.runtime ?? {}), ...(a.runtime ?? {}) },
    diagnostics: { ...(b.diagnostics ?? {}), ...(a.diagnostics ?? {}) },
    verify: { ...(b.verify ?? {}), ...(a.verify ?? {}) },
    patch: { ...(b.patch ?? {}), ...(a.patch ?? {}) },
    ledger: { ...(b.ledger ?? {}), ...(a.ledger ?? {}) },
    agent: { ...(b.agent ?? {}), ...(a.agent ?? {}) },
  };
}

function pathGet(obj: Any, dot: string) {
  let x = obj;
  for (const part of dot.split(".")) {
    if (!x || typeof x !== "object") return null;
    x = x[part];
  }
  return x;
}

function unwrap(x: Any) {
  if (x && typeof x === "object") {
    if (x.ok === true && "data" in x) return x.data;
    if (x.ok === true && "result" in x) return x.result;
    if (x.ok === true && "snapshot" in x) return x.snapshot;
  }
  return x;
}

async function callAny(paths: string[], payloads: Any[] = [{}]) {
  const bridge = api();
  let found = false;
  let last: Any = null;

  for (const path of paths) {
    const fn = pathGet(bridge, path);
    if (typeof fn !== "function") continue;
    found = true;
    for (const payload of payloads) {
      try {
        return unwrap(await fn(payload));
      } catch (e) {
        last = e;
      }
    }
  }

  throw new Error(found ? String(last?.message ?? last ?? "bridge_call_failed") : `bridge_missing:${paths.join("|")}`);
}

function functionsOf(obj: Any) {
  const out: string[] = [];
  const seen = new Set();
  const walk = (x: Any, prefix: string[], depth: number) => {
    if (!x || typeof x !== "object" || seen.has(x) || depth > 8) return;
    seen.add(x);
    for (const [k, v] of Object.entries(x)) {
      const p = [...prefix, k];
      if (typeof v === "function") out.push(p.join("."));
      else if (v && typeof v === "object") walk(v, p, depth + 1);
    }
  };
  walk(obj, [], 0);
  return out.sort();
}

function norm(p: Any) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
}

function basename(p: string) {
  const parts = norm(p).split("/").filter(Boolean);
  return parts.at(-1) ?? p;
}

function rel(p: string, root?: string) {
  const pp = norm(p);
  const rr = norm(root);
  if (!rr) return pp;
  if (pp === rr) return ".";
  if (pp.startsWith(rr + "/")) return pp.slice(rr.length + 1);
  return pp;
}

function dataPath(x: Any): string | null {
  const y = unwrap(x);
  if (!y || typeof y !== "object") return null;
  const p = y.path ?? y.fullPath ?? y.absolutePath ?? y.relativePath ?? y.workspacePath ?? y.filePath ?? y.id;
  return typeof p === "string" && p.trim() ? norm(p) : null;
}

function childrenOf(x: Any): Any[] {
  return [x?.children, x?.entries, x?.items, x?.files, x?.tree, x?.workspaceTree, x?.fileTree].find(Array.isArray) ?? [];
}

function isDir(x: Any) {
  const y = unwrap(x);
  const kind = String(y?.kind ?? y?.type ?? y?.entryType ?? "").toLowerCase();
  return y?.isDirectory === true || y?.directory === true || kind.includes("dir") || kind.includes("folder") || childrenOf(y).length > 0;
}

function flattenFiles(snapshots: Any[]) {
  const map = new Map<string, FileEntry>();
  const walk = (node: Any) => {
    const x = unwrap(node);
    if (!x) return;
    if (Array.isArray(x)) {
      x.forEach(walk);
      return;
    }
    if (typeof x !== "object") return;

    const p = dataPath(x);
    if (p) {
      const entry = { path: p, isDir: isDir(x), size: typeof x.size === "number" ? x.size : undefined };
      map.set(`${entry.isDir ? "d" : "f"}:${entry.path}`, entry);
    }

    childrenOf(x).forEach(walk);
    for (const k of ["workspace", "data", "snapshot", "runtime", "root", "result"]) {
      if (x[k]) walk(x[k]);
    }
  };

  snapshots.forEach(walk);
  return [...map.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function ignored(path: string) {
  const p = `/${norm(path).toLowerCase()}/`;
  return (
    !p.trim() ||
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
    p.includes("/venv/") ||
    p.includes("/.venv/") ||
    p.includes("/site-packages/")
  );
}

function binary(path: string) {
  return /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock)$/i.test(path);
}

function lang(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".sh")) return "shell";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yaml") || p.endsWith(".yml")) return "yaml";
  if (p.endsWith(".sql")) return "sql";
  return "plaintext";
}

function score(path: string) {
  const p = path.toLowerCase();
  const b = basename(p);
  let s = 0;
  if (p.endsWith("/packages/adjutorix-app/src/renderer/nativecontrolplaneworkbench.tsx")) s += 900000;
  if (p.endsWith("/packages/adjutorix-app/src/renderer/commandcenterworkbench.tsx")) s += 860000;
  if (p.endsWith("/packages/adjutorix-app/src/main/index.ts")) s += 820000;
  if (p.endsWith("/packages/adjutorix-app/src/main/native-control-plane-v13.ts")) s += 810000;
  if (p.endsWith("/packages/adjutorix-app/src/preload/preload.ts")) s += 800000;
  if (p.includes("/src/renderer/")) s += 90000;
  if (p.includes("/src/main/")) s += 85000;
  if (p.includes("/src/preload/")) s += 80000;
  if (p.includes("/packages/")) s += 50000;
  if (p.includes("/configs/")) s += 30000;
  if (p.includes("/scripts/")) s += 24000;
  if (p.includes("/tests/")) s += 18000;
  if (b === "package.json") s += 70000;
  if (b === "pnpm-workspace.yaml") s += 65000;
  if (b === "readme.md") s += 35000;
  if (p.endsWith(".tsx")) s += 6000;
  if (p.endsWith(".ts")) s += 5000;
  if (p.endsWith(".py")) s += 3500;
  if (p.endsWith(".json")) s += 2400;
  if (p.endsWith(".md")) s += 1500;
  if (p.endsWith(".sh")) s += 1500;
  return s - Math.min(p.length, 1500);
}

function sourceFiles(entries: FileEntry[]) {
  const seen = new Set();
  const out: FileEntry[] = [];
  for (const f of entries) {
    const p = norm(f.path);
    if (!p || f.isDir || ignored(p) || binary(p) || seen.has(p)) continue;
    seen.add(p);
    out.push({ ...f, path: p, score: score(p) });
  }
  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
}

function findRoot(entries: FileEntry[], snapshots: Any[]) {
  for (const s of snapshots) {
    let out = "";
    const walk = (x: Any) => {
      const y = unwrap(x);
      if (!y || typeof y !== "object" || out) return;
      for (const k of ["rootPath", "workspaceRoot", "workspacePath", "repoPath", "cwd"]) {
        if (typeof y[k] === "string" && y[k].trim()) {
          out = norm(y[k]);
          return;
        }
      }
      if (Array.isArray(y)) y.forEach(walk);
      else Object.values(y).forEach(walk);
    };
    walk(s);
    if (out) return out;
  }

  const paths = entries.map((x) => norm(x.path));
  for (const anchor of ["/packages/", "/configs/", "/scripts/", "/tests/", "/docs/"]) {
    const hit = paths.find((p) => p.includes(anchor));
    if (hit) return hit.slice(0, hit.indexOf(anchor));
  }
  return "";
}

function contentOf(x: Any) {
  if (typeof x === "string") return x;
  const y = unwrap(x);
  return String(y?.content ?? y?.text ?? y?.value ?? y?.body ?? "");
}

function resultOf(x: Any, command: string): RunResult {
  const y = unwrap(x);
  if (y && typeof y === "object" && ("stdout" in y || "stderr" in y || "exitCode" in y || "status" in y)) return y;
  return {
    ok: true,
    status: "ok",
    exitCode: 0,
    command,
    stdout: typeof x === "string" ? x : JSON.stringify(x, null, 2),
    stderr: "",
  };
}

function terminalText(r: RunResult) {
  return [
    `$ ${r.command ?? ""}`,
    `status=${r.status ?? (r.ok === false ? "failed" : "ok")} exit=${r.exitCode ?? ""} duration=${r.durationMs ?? ""}ms`,
    "",
    r.stdout ?? "",
    r.stderr ? `\n[stderr]\n${r.stderr}` : "",
  ].join("\n").trim();
}

function parseProblems(text: string): Problem[] {
  const out: Problem[] = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    let m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (m) {
      out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), severity: "error", message: `${m[4]} ${m[5]}` });
      continue;
    }
    m = line.match(/^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.+)$/i);
    if (m) {
      out.push({ file: m[1], line: Number(m[2]), column: Number(m[3]), severity: m[4].toLowerCase() === "warning" ? "warning" : "error", message: m[5] });
      continue;
    }
    if (/error|failed|exception|cannot find module|not found/i.test(line)) {
      out.push({ severity: "error", message: line });
    }
  }
  return out.slice(0, 500);
}

function outlineOf(text: string) {
  const rules: [RegExp, string][] = [
    [/^\s*export\s+default\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*export\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*async\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*class\s+([A-Za-z0-9_$]+)/, "class"],
    [/^\s*const\s+([A-Za-z0-9_$]+)\s*=/, "const"],
    [/^\s*def\s+([A-Za-z0-9_]+)/, "function"],
    [/^\s*class\s+([A-Za-z0-9_]+)/, "class"],
    [/^\s*#{1,6}\s+(.+)/, "section"],
  ];

  const out: Any[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [rx, kind] of rules) {
      const m = line.match(rx);
      if (m) {
        out.push({ line: i + 1, kind, name: m[1] });
        break;
      }
    }
  });
  return out.slice(0, 400);
}

function importsOf(text: string) {
  return text
    .split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((x) => /^(import|from|const .*require\(|export .* from )/.test(x.text))
    .slice(0, 300);
}

function diffOf(a: string, b: string) {
  if (a === b) return "No patch.";
  const aa = a.split(/\r?\n/);
  const bb = b.split(/\r?\n/);
  const out = ["--- original", "+++ current"];
  const n = Math.max(aa.length, bb.length);
  for (let i = 0; i < n; i++) {
    if (aa[i] === bb[i]) continue;
    if (aa[i] !== undefined) out.push(`-${String(i + 1).padStart(5)} ${aa[i]}`);
    if (bb[i] !== undefined) out.push(`+${String(i + 1).padStart(5)} ${bb[i]}`);
    if (out.length > 1000) {
      out.push("[patch truncated]");
      break;
    }
  }
  return out.join("\n");
}

export default function NativeControlPlaneWorkbench() {
  const editor = useRef<Any>(null);

  const [root, setRoot] = useState("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [bridgeFns, setBridgeFns] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<Any[]>([]);
  const [buffers, setBuffers] = useState<Record<string, BufferState>>({});
  const [selected, setSelected] = useState("");
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [left, setLeft] = useState("explorer");
  const [right, setRight] = useState("inspector");
  const [bottom, setBottom] = useState("terminal");
  const [busy, setBusy] = useState(false);
  const [cmd, setCmd] = useState("pnpm --filter @adjutorix/app run build");
  const [terminal, setTerminal] = useState("Pick a task or run a command.");
  const [lastResult, setLastResult] = useState<RunResult>({ status: "ready", stdout: "Native control-plane workbench ready.", stderr: "" });
  const [problems, setProblems] = useState<Problem[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [palette, setPalette] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [agentText, setAgentText] = useState("Inspect current state. Produce the next concrete patch. Run build and gates.");
  const [grepPattern, setGrepPattern] = useState("");

  const addLog = useCallback((line: string) => {
    setActivity((old) => [`${new Date().toLocaleTimeString()}  ${line}`, ...old].slice(0, 500));
  }, []);

  const visible = useMemo(() => {
    const files = sourceFiles(entries);
    const q = query.trim().toLowerCase();
    const filtered = q
      ? files.filter((f) => f.path.toLowerCase().includes(q) || buffers[f.path]?.content?.toLowerCase?.().includes(q))
      : files;
    return filtered.slice(0, 1000);
  }, [entries, query, buffers]);

  const current = selected ? buffers[selected] : null;
  const dirtyBuffers = Object.values(buffers).filter((b) => b.dirty);
  const outline = useMemo(() => outlineOf(current?.content ?? ""), [current?.content]);
  const imps = useMemo(() => importsOf(current?.content ?? ""), [current?.content]);
  const patch = useMemo(() => current ? diffOf(current.original, current.content) : "No file.", [current]);

  const runCommand = useCallback(async (command: string) => {
    setBusy(true);
    setBottom("terminal");
    setCmd(command);
    setTerminal(`$ ${command}\n\nrunning...`);
    addLog(`RUN ${command}`);

    try {
      const started = Date.now();
      const response = await callAny(COMMAND_PATHS, [
        { schema: 1, actor: "renderer", command, intent: command, cwd: root || undefined, timeoutMs: 240000 },
        { command, cwd: root || undefined, timeoutMs: 240000 },
        command,
      ]);

      const result = { ...resultOf(response, command), durationMs: Date.now() - started };
      setLastResult(result);
      setTerminal(terminalText(result));
      const parsed = parseProblems(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      setProblems(parsed);
      if (parsed.length) setBottom("problems");
      addLog(`DONE ${result.status ?? result.exitCode ?? "ok"}`);
      return result;
    } catch (e) {
      const result: RunResult = { ok: false, status: "bridge_error", exitCode: 1, command, stdout: "", stderr: String(e?.message ?? e) };
      setLastResult(result);
      setTerminal(terminalText(result));
      setProblems(parseProblems(result.stderr ?? ""));
      addLog(`FAIL ${result.stderr}`);
      return result;
    } finally {
      setBusy(false);
    }
  }, [addLog, root]);

  const indexWorkspace = useCallback(async () => {
    setBusy(true);
    addLog("INDEX start");
    const bridge = api();
    const collected: Any[] = [];

    for (const p of INDEX_PATHS) {
      try {
        collected.push(await callAny([p], [{ schema: 1, actor: "renderer", limit: 5000 }]));
      } catch (e) {
        collected.push({ error: String(e), source: p });
      }
    }

    const flat = flattenFiles(collected);
    const nextRoot = findRoot(flat, collected) || root;
    const fns = functionsOf(bridge);

    setSnapshots(collected);
    setEntries(flat);
    setRoot(nextRoot);
    setBridgeFns(fns);

    addLog(`INDEX ${flat.length} entries / ${sourceFiles(flat).length} source files / bridge=${fns.length}`);
    setBusy(false);
  }, [addLog, root]);

  const openFile = useCallback(async (path: string) => {
    const full = norm(path);
    const relative = rel(full, root);
    const known = entries.find((e) => norm(e.path) === full);
    if (known?.isDir || binary(full)) {
      addLog(`SKIP ${relative}`);
      return;
    }

    try {
      const response = await callAny(READ_PATHS, [
        { schema: 1, actor: "renderer", path: relative, targetPath: relative, relativePath: relative, filePath: relative, workspacePath: relative },
        { path: relative },
      ]);

      const content = contentOf(response);
      const actual = norm(response?.path ?? full);
      const buf: BufferState = {
        path: actual,
        content,
        original: content,
        language: lang(actual),
        dirty: false,
        openedAt: Date.now(),
      };

      setBuffers((old) => ({ ...old, [actual]: buf }));
      setOpenFiles((old) => Array.from(new Set([...old, actual])));
      setSelected(actual);
      addLog(`OPEN ${rel(actual, root)}`);
    } catch (e) {
      addLog(`OPEN FAILED ${relative} :: ${String(e?.message ?? e)}`);
      setBottom("output");
    }
  }, [addLog, entries, root]);

  const saveFile = useCallback(async (path: string) => {
    const b = buffers[path];
    if (!b) return;

    const r = rel(path, root);
    try {
      await callAny(WRITE_PATHS, [
        { schema: 1, actor: "renderer", path: r, targetPath: r, relativePath: r, filePath: r, workspacePath: r, content: b.content, text: b.content, value: b.content },
        { path: r, content: b.content },
      ]);

      setBuffers((old) => ({ ...old, [path]: { ...b, original: b.content, dirty: false, savedAt: Date.now() } }));
      addLog(`SAVE ${r}`);
    } catch (e) {
      addLog(`SAVE BRIDGE FAILED ${r} :: ${String(e?.message ?? e)}`);
      const safe = JSON.stringify(b.content);
      const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path(${JSON.stringify(r)})\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text(${safe})\nprint(p)\nPY`;
      await runCommand(command);
      setBuffers((old) => ({ ...old, [path]: { ...b, original: b.content, dirty: false, savedAt: Date.now() } }));
    }
  }, [addLog, buffers, root, runCommand]);

  const saveAll = useCallback(async () => {
    for (const b of dirtyBuffers) await saveFile(b.path);
  }, [dirtyBuffers, saveFile]);

  const writeAgentContext = useCallback(async () => {
    const body = [
      "# ADJUTORIX Agent Context",
      "",
      `marker=${MARKER}`,
      `root=${root}`,
      `current=${current ? rel(current.path, root) : "none"}`,
      `dirty=${dirtyBuffers.map((b) => rel(b.path, root)).join(",") || "none"}`,
      "",
      "## Intent",
      "",
      agentText,
      "",
      "## Bridge Functions",
      "",
      bridgeFns.join("\n"),
      "",
      "## Current File",
      "",
      "```",
      (current?.content ?? "").slice(0, 60000),
      "```",
      "",
      "## Patch",
      "",
      "```diff",
      patch.slice(0, 60000),
      "```",
      "",
      "## Problems",
      "",
      problems.map((p) => `${p.severity} ${p.file ?? ""}:${p.line ?? ""} ${p.message}`).join("\n"),
      "",
      "## Activity",
      "",
      activity.slice(0, 200).join("\n"),
      "",
    ].join("\n");

    const target = ".adjutorix/native-agent-context.md";
    try {
      await callAny(WRITE_PATHS, [
        { schema: 1, actor: "renderer", path: target, targetPath: target, relativePath: target, filePath: target, workspacePath: target, content: body, text: body, value: body },
        { path: target, content: body },
      ]);
      addLog(`AGENT CONTEXT WRITTEN ${target}`);
      return;
    } catch (e) {
      addLog(`AGENT WRITE FALLBACK ${String(e?.message ?? e)}`);
    }

    const command = `python3 - <<'PY'\nfrom pathlib import Path\nbody = ${JSON.stringify(body)}\np = Path(".adjutorix/native-agent-context.md")\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text(body)\nprint(p)\nPY`;
    await runCommand(command);
  }, [activity, addLog, agentText, bridgeFns, current, dirtyBuffers, patch, problems, root, runCommand]);

  const runGrep = useCallback(async () => {
    const q = grepPattern.trim() || query.trim();
    if (!q) return;
    const command = `rg -n ${JSON.stringify(q)} packages configs scripts src tests 2>/dev/null | head -500`;
    await runCommand(command);
    setBottom("terminal");
  }, [grepPattern, query, runCommand]);

  useEffect(() => {
    indexWorkspace();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      if ((e.metaKey || e.ctrlKey) && k === "p") {
        e.preventDefault();
        setPalette(true);
      }
      if ((e.metaKey || e.ctrlKey) && k === "s") {
        e.preventDefault();
        if (e.shiftKey) saveAll();
        else if (selected) saveFile(selected);
      }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAll, saveFile, selected]);

  const paletteItems = useMemo(() => {
    const taskItems = TASKS.map(([id, label, group, command]) => ({
      label,
      kind: group,
      run: () => runCommand(command),
    }));

    const fileItems = visible.slice(0, 250).map((f) => ({
      label: rel(f.path, root),
      kind: "file",
      run: () => openFile(f.path),
    }));

    const all = [...taskItems, ...fileItems];
    const q = paletteQ.trim().toLowerCase();
    return q ? all.filter((x) => x.label.toLowerCase().includes(q) || x.kind.toLowerCase().includes(q)) : all;
  }, [openFile, paletteQ, root, runCommand, visible]);

  const leftPane = () => {
    if (left === "commands" || left === "tasks") {
      return (
        <div className="v14-stack">
          {TASKS.filter((t) => left !== "tasks" || ["doctor", "build", "quality"].includes(t[2])).map(([id, label, group, command]) => (
            <button key={id} className="v14-task" onClick={() => runCommand(command)}>
              <strong>{label}</strong>
              <span>{group}</span>
              <code>{command}</code>
            </button>
          ))}
        </div>
      );
    }

    if (left === "scm") {
      return (
        <div className="v14-stack">
          {TASKS.filter((t) => t[2] === "scm").map(([id, label, group, command]) => (
            <button key={id} className="v14-task" onClick={() => runCommand(command)}>
              <strong>{label}</strong>
              <span>{group}</span>
              <code>{command}</code>
            </button>
          ))}
        </div>
      );
    }

    if (left === "search") {
      return (
        <div className="v14-stack">
          <input className="v14-input" value={grepPattern} onChange={(e) => setGrepPattern(e.target.value)} placeholder="repo grep pattern" />
          <button className="v14-primary" onClick={runGrep}>Run repository grep</button>
          <div className="v14-hint">Search uses filenames, loaded buffers, and native rg command output.</div>
          {visible.map((f) => (
            <button key={f.path} className="v14-file" onClick={() => openFile(f.path)}>
              <span>·</span>{rel(f.path, root)}
            </button>
          ))}
        </div>
      );
    }

    if (left === "agent") {
      return (
        <div className="v14-agent">
          <textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} />
          <button className="v14-primary big" onClick={writeAgentContext}>Write full agent context pack</button>
          <div className="v14-hint">Includes current file, patch, dirty set, problems, bridge functions, and recent activity.</div>
        </div>
      );
    }

    if (left === "graph") {
      return (
        <div className="v14-stack">
          <div className="v14-card"><b>Current imports</b><pre>{imps.map((x) => `${x.line}: ${x.text}`).join("\n") || "No imports."}</pre></div>
          <div className="v14-card"><b>Current symbols</b><pre>{outline.map((x) => `${x.line}: ${x.kind} ${x.name}`).join("\n") || "No symbols."}</pre></div>
          <div className="v14-card"><b>Hot files</b><pre>{visible.slice(0, 80).map((x) => rel(x.path, root)).join("\n")}</pre></div>
        </div>
      );
    }

    if (left === "runtime") {
      return (
        <div className="v14-stack mono">
          {bridgeFns.map((f) => <button key={f} className="v14-runtime">{f}</button>)}
        </div>
      );
    }

    return (
      <div className="v14-stack">
        {visible.map((f) => (
          <button key={f.path} className={selected === f.path ? "v14-file active" : "v14-file"} onClick={() => openFile(f.path)}>
            <span>{buffers[f.path]?.dirty ? "●" : "·"}</span>{rel(f.path, root)}
          </button>
        ))}
      </div>
    );
  };

  const rightPane = () => {
    if (right === "outline") {
      return <div className="v14-cards">{outline.map((s) => <button key={`${s.line}-${s.name}`} onClick={() => editor.current?.revealLineInCenter?.(s.line)}><b>{s.kind}</b><span>{s.name}</span><em>line {s.line}</em></button>)}</div>;
    }

    if (right === "problems") {
      return <div className="v14-cards">{problems.length ? problems.map((p, i) => <button key={i} onClick={() => p.file && openFile(p.file)}><b className="bad">{p.severity}</b><span>{p.file ?? ""}:{p.line ?? ""}</span><em>{p.message}</em></button>) : <p>No parsed problems.</p>}</div>;
    }

    if (right === "patch") return <pre className="v14-pre">{patch}</pre>;

    if (right === "graph") {
      const graph = ["IMPORTS", ...imps.map((x) => `${x.line}: ${x.text}`), "", "SYMBOLS", ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`)].join("\n");
      return <pre className="v14-pre">{graph}</pre>;
    }

    if (right === "agent") {
      return <div className="v14-agent"><textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} /><button className="v14-primary" onClick={writeAgentContext}>Write context pack</button><pre>{activity.join("\n")}</pre></div>;
    }

    if (right === "runtime") {
      return <div className="v14-stack mono">{bridgeFns.map((f) => <button key={f} className="v14-runtime">{f}</button>)}</div>;
    }

    return (
      <div className="v14-inspector">
        <div className="v14-root"><span>root</span><b>{root || "unknown"}</b></div>
        <section>
          <article><span>files</span><b>{sourceFiles(entries).length}</b></article>
          <article><span>indexed</span><b>{entries.length}</b></article>
          <article><span>open</span><b>{openFiles.length}</b></article>
          <article><span>dirty</span><b>{dirtyBuffers.length}</b></article>
          <article><span>bridge</span><b>{bridgeFns.length}</b></article>
          <article><span>status</span><b>{busy ? "busy" : "live"}</b></article>
        </section>
        <div className="v14-root"><span>current</span><b>{current?.path ? rel(current.path, root) : "none"}</b></div>
        <div className="v14-card"><b>Capabilities</b><p>Editor, Explorer, Search, SCM, Tasks, Problems, Patch, Graph, Agent, Runtime, Terminal.</p></div>
      </div>
    );
  };

  return (
    <div className="v14-shell">
      <header className="v14-top">
        <div className="v14-brand">{MARKER}</div>
        <button className="v14-palette-btn" onClick={() => setPalette(true)}>⌘P</button>
        <div className="v14-rootline">{root || "workspace root unknown"}</div>
        <div className="v14-spacer" />
        <span className={busy ? "v14-live busy" : "v14-live"}>{busy ? "BUSY" : "LIVE"}</span>
        <button onClick={indexWorkspace}>Index</button>
        <button disabled={!current?.dirty} onClick={() => current && saveFile(current.path)}>Save</button>
        <button disabled={!dirtyBuffers.length} onClick={saveAll}>Save all</button>
      </header>

      <main className="v14-main">
        <nav className="v14-nav">
          {NAV.map(([id, label]) => <button key={id} className={left === id ? "active" : ""} onClick={() => setLeft(id)}>{label}</button>)}
        </nav>

        <aside className="v14-left">
          <div className="v14-left-head">
            <span>{left}</span>
            <b>{visible.length}/{sourceFiles(entries).length}</b>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search files and buffers" />
          </div>
          <div className="v14-left-body">{leftPane()}</div>
        </aside>

        <section className="v14-center">
          <div className="v14-tabs">
            {openFiles.length ? openFiles.map((p) => (
              <button key={p} className={selected === p ? "active" : ""} onClick={() => setSelected(p)}>
                {buffers[p]?.dirty ? "● " : ""}{basename(p)}
              </button>
            )) : <span>Open a source file.</span>}
          </div>

          <div className="v14-editor">
            {current ? (
              <Editor
                height="100%"
                theme="vs-dark"
                path={current.path}
                language={current.language}
                value={current.content}
                onMount={(ed) => { editor.current = ed; }}
                options={{
                  automaticLayout: true,
                  fontSize: 14,
                  minimap: { enabled: true },
                  scrollBeyondLastLine: false,
                  renderWhitespace: "selection",
                  wordWrap: "off",
                }}
                onChange={(value) => {
                  const content = value ?? "";
                  setBuffers((old) => {
                    const b = old[current.path];
                    if (!b) return old;
                    return { ...old, [current.path]: { ...b, content, dirty: content !== b.original } };
                  });
                }}
              />
            ) : (
              <div className="v14-empty">No file selected.</div>
            )}
          </div>

          <div className="v14-bottom">
            <div className="v14-bottom-tabs">
              {["terminal", "output", "problems", "patch", "graph", "raw"].map((x) => <button key={x} className={bottom === x ? "active" : ""} onClick={() => setBottom(x)}>{x}</button>)}
            </div>

            {bottom === "terminal" && (
              <div className="v14-terminal">
                <div className="v14-runbar">
                  <input value={cmd} onChange={(e) => setCmd(e.target.value)} />
                  <button onClick={() => runCommand(cmd)}>Run</button>
                </div>
                <pre>{terminal}</pre>
              </div>
            )}

            {bottom === "output" && <pre className="v14-pre">{activity.join("\n")}</pre>}
            {bottom === "problems" && <pre className="v14-pre">{problems.map((p) => `${p.severity} ${p.file ?? ""}:${p.line ?? ""}:${p.column ?? ""} ${p.message}`).join("\n") || "No parsed problems."}</pre>}
            {bottom === "patch" && <pre className="v14-pre">{patch}</pre>}
            {bottom === "graph" && <pre className="v14-pre">{["IMPORTS", ...imps.map((x) => `${x.line}: ${x.text}`), "", "SYMBOLS", ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`)].join("\n")}</pre>}
            {bottom === "raw" && <pre className="v14-pre">{JSON.stringify({ lastResult, snapshots }, null, 2)}</pre>}
          </div>
        </section>

        <aside className="v14-right">
          <div className="v14-right-tabs">
            {RIGHT.map((x) => <button key={x} className={right === x ? "active" : ""} onClick={() => setRight(x)}>{x}</button>)}
          </div>
          <div className="v14-right-body">{rightPane()}</div>
        </aside>
      </main>

      {palette && (
        <div className="v14-overlay" onClick={() => setPalette(false)}>
          <div className="v14-palette" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={paletteQ} onChange={(e) => setPaletteQ(e.target.value)} placeholder="command, task, file..." />
            <div>
              {paletteItems.slice(0, 80).map((item, i) => (
                <button key={`${item.kind}-${item.label}-${i}`} onClick={() => { item.run(); setPalette(false); setPaletteQ(""); }}>
                  <span>{item.label}</span><em>{item.kind}</em>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
