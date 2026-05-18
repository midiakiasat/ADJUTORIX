// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

const MARKER = "ADJUTORIX_NATIVE_PORTFOLIO_WORKBENCH_V17";

type Entry = {
  path: string;
  absolutePath?: string;
  isDir?: boolean;
  isDirectory?: boolean;
  size?: number;
  mtimeMs?: number;
};

type BufferState = {
  path: string;
  content: string;
  original: string;
  language: string;
  dirty: boolean;
};

type Tool = {
  id: string;
  label: string;
  lane: string;
  command: string;
  source?: string;
};

type Problem = {
  severity: string;
  file?: string;
  line?: number;
  column?: number;
  message: string;
};

const IGNORE_PARTS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".turbo",
  ".cache",
  ".vite",
  ".venv",
  "venv",
  "site-packages",
  "quarantine",
]);

const BINARY = /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock|pyc)$/i;

const BASE_TOOLS: Tool[] = [
  {
    id: "doctor",
    label: "Doctor",
    lane: "doctor",
    command:
      "echo ADJUTORIX_DOCTOR && pwd && node -v 2>/dev/null || true && pnpm -v 2>/dev/null || true && python3 --version 2>/dev/null || true && git branch --show-current 2>/dev/null || true && git rev-parse --short HEAD 2>/dev/null || true && git status --short 2>/dev/null | head -160",
  },
  { id: "build", label: "Build", lane: "build", command: "pnpm run build || npm run build || make build" },
  { id: "test", label: "Test", lane: "test", command: "pnpm test || npm test || pytest || make test" },
  { id: "verify", label: "Verify", lane: "verify", command: "pnpm run verify || npm run verify || ./scripts/verify.sh || ./configs/ci/verify.sh || make verify" },
  { id: "lint", label: "Lint", lane: "quality", command: "pnpm run lint || npm run lint || ruff check . || make lint" },
  { id: "typecheck", label: "Typecheck", lane: "quality", command: "pnpm run typecheck || pnpm exec tsc --noEmit || npm run typecheck || mypy ." },
  { id: "scm-status", label: "SCM status", lane: "scm", command: "git status --short && git branch --show-current && git rev-parse --short HEAD" },
  { id: "scm-diff", label: "SCM diff", lane: "scm", command: "git diff --stat && echo && git diff --name-only && echo && git diff | head -800" },
  { id: "timeline", label: "Timeline", lane: "scm", command: "git log --oneline --decorate --graph --max-count=120" },
  { id: "branches", label: "Branches", lane: "scm", command: "git branch --all --verbose --no-abbrev | head -160" },
  {
    id: "inventory",
    label: "Source inventory",
    lane: "index",
    command:
      "find . -maxdepth 5 \\( -path './.git' -o -path './node_modules' -o -path './dist' -o -path './build' -o -path './coverage' \\) -prune -o -type f | sort | head -1000",
  },
  {
    id: "symbols",
    label: "Symbol index",
    lane: "index",
    command:
      "rg -n \"^(export default function|export function|function|class|const|def |class )\" . --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!coverage/**' | head -1000",
  },
  {
    id: "debt",
    label: "Debt scan",
    lane: "quality",
    command:
      "rg -n \"TODO|FIXME|XXX|HACK|placeholder|mock|stub|toy|not implemented|bridge_missing|throw new Error\" . --glob '!node_modules/**' --glob '!dist/**' --glob '!build/**' --glob '!coverage/**' | head -1000",
  },
];

function ext() {
  return (window as any).adjutorixExternalWorkspaceV16 ?? null;
}

function api() {
  return (window as any).adjutorix ?? (window as any).adjutorixApi ?? {};
}

function norm(value: unknown): string {
  return String(value ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
}

function baseName(p: string): string {
  const parts = norm(p).split("/").filter(Boolean);
  return parts[parts.length - 1] || p;
}

function dirName(p: string): string {
  const n = norm(p);
  const idx = n.lastIndexOf("/");
  return idx <= 0 ? "." : n.slice(0, idx);
}

function shq(value: string): string {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function ignored(path: string, includeGenerated: boolean): boolean {
  const parts = norm(path).split("/").filter(Boolean);
  if (parts.includes(".git")) return true;
  if (!includeGenerated) {
    if (parts.some((p) => IGNORE_PARTS.has(p))) return true;
    if (parts.includes(".adjutorix-release")) return true;
  }
  return false;
}

function isTextSource(path: string, includeGenerated: boolean): boolean {
  const p = norm(path);
  if (!p || ignored(p, includeGenerated) || BINARY.test(p)) return false;
  return /\.(ts|tsx|js|jsx|mjs|cjs|json|md|py|sh|bash|zsh|css|html|yml|yaml|toml|ini|sql|go|rs|java|kt|swift|c|cc|cpp|h|hpp|rb|php|xml|txt|env|example)$/i.test(p);
}

function lang(path: string): string {
  const p = path.toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".json")) return "json";
  if (p.endsWith(".md")) return "markdown";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".zsh")) return "shell";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".toml")) return "toml";
  if (p.endsWith(".sql")) return "sql";
  if (p.endsWith(".go")) return "go";
  if (p.endsWith(".rs")) return "rust";
  return "plaintext";
}

function score(path: string): number {
  const p = path.toLowerCase();
  const name = baseName(p);
  let s = 0;
  if (name === "package.json") s += 9000;
  if (name === "pnpm-workspace.yaml") s += 8500;
  if (name === "pyproject.toml") s += 8300;
  if (name === "makefile") s += 8000;
  if (p.includes("/src/")) s += 4000;
  if (p.includes("/packages/")) s += 3500;
  if (p.includes("/apps/")) s += 3300;
  if (p.includes("/configs/ci/") || p.includes("/.github/workflows/")) s += 3200;
  if (p.includes("/scripts/") || p.includes("/bin/")) s += 3000;
  if (p.endsWith(".tsx")) s += 1200;
  if (p.endsWith(".ts")) s += 1000;
  if (p.endsWith(".py")) s += 950;
  if (p.endsWith(".sh")) s += 900;
  if (p.endsWith(".json")) s += 700;
  if (p.endsWith(".md")) s += 600;
  return s - Math.min(p.length, 1200);
}

function sourceFiles(entries: Entry[], includeGenerated: boolean): Entry[] {
  const seen = new Set<string>();
  return entries
    .filter((e) => !(e.isDir || e.isDirectory))
    .map((e) => ({ ...e, path: norm(e.path) }))
    .filter((e) => {
      if (!isTextSource(e.path, includeGenerated)) return false;
      if (seen.has(e.path)) return false;
      seen.add(e.path);
      return true;
    })
    .sort((a, b) => score(b.path) - score(a.path) || a.path.localeCompare(b.path));
}

function functionsOf(obj: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();

  function walk(node: any, prefix: string[], depth: number) {
    if (!node || typeof node !== "object" || seen.has(node) || depth > 7) return;
    seen.add(node);

    for (const [k, v] of Object.entries(node)) {
      const path = [...prefix, k];
      if (typeof v === "function") out.push(path.join("."));
      else if (v && typeof v === "object") walk(v, path, depth + 1);
    }
  }

  walk(obj, [], 0);
  if (ext()) {
    out.push(
      "externalWorkspaceV16.openFolder",
      "externalWorkspaceV16.scan",
      "externalWorkspaceV16.readFile",
      "externalWorkspaceV16.writeFile",
      "externalWorkspaceV16.execute",
    );
  }

  return Array.from(new Set(out)).sort();
}

function parseProblems(text: string): Problem[] {
  const out: Problem[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (m) {
      out.push({ severity: "error", file: m[1], line: Number(m[2]), column: Number(m[3]), message: `${m[4]} ${m[5]}` });
      continue;
    }

    m = line.match(/^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.+)$/i);
    if (m) {
      out.push({ severity: m[4].toLowerCase(), file: m[1], line: Number(m[2]), column: Number(m[3]), message: m[5] });
      continue;
    }

    if (/error|failed|exception|traceback/i.test(line)) out.push({ severity: "error", message: line });
  }

  return out.slice(0, 500);
}

function outlineOf(text: string) {
  const patterns: [RegExp, string][] = [
    [/^\s*export\s+default\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*export\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*class\s+([A-Za-z0-9_$]+)/, "class"],
    [/^\s*const\s+([A-Za-z0-9_$]+)\s*=/, "const"],
    [/^\s*def\s+([A-Za-z0-9_]+)/, "function"],
    [/^\s*class\s+([A-Za-z0-9_]+)/, "class"],
    [/^\s*#{1,6}\s+(.+)/, "section"],
  ];

  const out: any[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [re, kind] of patterns) {
      const m = line.match(re);
      if (m) {
        out.push({ line: i + 1, kind, name: m[1] });
        break;
      }
    }
  });

  return out.slice(0, 300);
}

function diffText(a: string, b: string): string {
  if (a === b) return "No patch.";
  const left = a.split(/\r?\n/);
  const right = b.split(/\r?\n/);
  const max = Math.max(left.length, right.length);
  const out = ["--- saved", "+++ current"];

  for (let i = 0; i < max; i++) {
    if (left[i] !== right[i]) {
      if (left[i] !== undefined) out.push(`-${String(i + 1).padStart(4, " ")} ${left[i]}`);
      if (right[i] !== undefined) out.push(`+${String(i + 1).padStart(4, " ")} ${right[i]}`);
    }
    if (out.length > 900) {
      out.push("[patch truncated]");
      break;
    }
  }

  return out.join("\n");
}

function terminalText(result: any): string {
  if (!result) return "Pick a workspace, tool, task, script, or source file.";
  return [
    `$ ${result.command ?? ""}`,
    `status=${result.status ?? "unknown"} exit=${result.exitCode ?? ""} duration=${result.durationMs ?? 0}ms`,
    "",
    result.stdout ? String(result.stdout) : "",
    result.stderr ? "\n[stderr]\n" + String(result.stderr) : "",
  ].join("\n");
}

async function readManifestJson(root: string, path: string): Promise<any | null> {
  try {
    const r = await ext()?.readFile?.({ root, path, maxBytes: 512000 });
    return JSON.parse(String(r?.content ?? "{}"));
  } catch {
    return null;
  }
}

async function buildTools(root: string, entries: Entry[], includeGenerated: boolean): Promise<Tool[]> {
  const tools: Tool[] = [...BASE_TOOLS];
  const files = sourceFiles(entries, includeGenerated);

  const packageJsons = files.filter((f) => baseName(f.path) === "package.json").slice(0, 80);
  for (const pkg of packageJsons) {
    const json = await readManifestJson(root, pkg.path);
    const scripts = json?.scripts && typeof json.scripts === "object" ? json.scripts : {};
    const dir = dirName(pkg.path);
    for (const name of Object.keys(scripts).sort()) {
      tools.push({
        id: `npm:${dir}:${name}`,
        label: `${dir === "." ? "root" : dir} › ${name}`,
        lane: ["build", "test", "verify", "lint", "typecheck"].find((x) => name.toLowerCase().includes(x)) ?? "package",
        command: `pnpm --dir ${shq(dir)} run ${shq(name)}`,
        source: pkg.path,
      });
    }
  }

  for (const f of files.filter((x) => /\.sh$/i.test(x.path)).slice(0, 120)) {
    const name = baseName(f.path);
    let lane = "script";
    if (/verify|gate|check/i.test(f.path)) lane = "verify";
    else if (/build|package/i.test(f.path)) lane = "build";
    else if (/test|smoke/i.test(f.path)) lane = "test";
    else if (/release|publish/i.test(f.path)) lane = "release";
    tools.push({
      id: `shell:${f.path}`,
      label: name,
      lane,
      command: `bash ${shq(f.path)}`,
      source: f.path,
    });
  }

  for (const f of files.filter((x) => /^\.github\/workflows\/.+\.ya?ml$/i.test(x.path)).slice(0, 80)) {
    tools.push({
      id: `workflow:${f.path}`,
      label: `workflow › ${baseName(f.path)}`,
      lane: "ci",
      command: `cat ${shq(f.path)}`,
      source: f.path,
    });
  }

  if (files.some((f) => baseName(f.path).toLowerCase() === "pyproject.toml")) {
    tools.push({ id: "py:test", label: "Python pytest", lane: "python", command: "python3 -m pytest" });
    tools.push({ id: "py:ruff", label: "Python ruff", lane: "python", command: "python3 -m ruff check ." });
    tools.push({ id: "py:mypy", label: "Python mypy", lane: "python", command: "python3 -m mypy ." });
  }

  if (files.some((f) => baseName(f.path).toLowerCase() === "makefile")) {
    tools.push({ id: "make:targets", label: "Make targets", lane: "make", command: "make -qp | awk -F: '/^[a-zA-Z0-9][^$#\\/\\t=]*:([^=]|$)/ {print $1}' | sort -u | head -200" });
    tools.push({ id: "make:build", label: "Make build", lane: "make", command: "make build" });
    tools.push({ id: "make:test", label: "Make test", lane: "make", command: "make test" });
  }

  return Array.from(new Map(tools.map((t) => [t.id, t])).values());
}

export default function NativeControlPlaneWorkbench() {
  const editorRef = useRef<any>(null);

  const [root, setRoot] = useState("");
  const [entries, setEntries] = useState<Entry[]>([]);
  const [includeGenerated, setIncludeGenerated] = useState(false);
  const [tools, setTools] = useState<Tool[]>(BASE_TOOLS);
  const [bridgeFns, setBridgeFns] = useState<string[]>([]);
  const [knownRoots, setKnownRoots] = useState<string[]>([]);
  const [left, setLeft] = useState("workspaces");
  const [right, setRight] = useState("inspector");
  const [bottom, setBottom] = useState("terminal");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState("");
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [buffers, setBuffers] = useState<Record<string, BufferState>>({});
  const [command, setCommand] = useState("pnpm run build || npm run build || make build");
  const [lastResult, setLastResult] = useState<any>(null);
  const [problems, setProblems] = useState<Problem[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [agentText, setAgentText] = useState("Inspect this workspace. Use its own tools, manifests, scripts, CI, tests, build commands, and source graph. Produce the next concrete patch.");

  const addLog = useCallback((line: string) => {
    const stamp = new Date().toLocaleTimeString();
    setActivity((old) => [`${stamp}  ${line}`, ...old].slice(0, 300));
  }, []);

  const files = useMemo(() => sourceFiles(entries, includeGenerated), [entries, includeGenerated]);
  const current = selected ? buffers[selected] : null;
  const dirty = Object.values(buffers).filter((b) => b.dirty).length;
  const outline = useMemo(() => outlineOf(current?.content ?? ""), [current?.content]);
  const patch = useMemo(() => (current ? diffText(current.original, current.content) : "No file."), [current]);
  const terminal = useMemo(() => terminalText(lastResult), [lastResult]);

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return files.slice(0, 1200);
    return files.filter((f) => f.path.toLowerCase().includes(q) || (buffers[f.path]?.content ?? "").toLowerCase().includes(q)).slice(0, 1200);
  }, [files, query, buffers]);

  const visibleTools = useMemo(() => {
    const q = query.trim().toLowerCase();
    return tools.filter((t) => !q || t.label.toLowerCase().includes(q) || t.command.toLowerCase().includes(q) || t.lane.toLowerCase().includes(q));
  }, [tools, query]);

  const lanes = useMemo(() => {
    const map = new Map<string, number>();
    for (const t of tools) map.set(t.lane, (map.get(t.lane) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [tools]);

  const applyScan = useCallback(async (scan: any) => {
    const nextRoot = norm(scan?.root || root);
    const nextEntries = Array.isArray(scan?.entries)
      ? scan.entries.map((e: any) => ({
          path: norm(e.path ?? e.relativePath ?? e.absolutePath),
          absolutePath: e.absolutePath,
          isDir: e.isDir === true || e.isDirectory === true,
          size: e.size,
          mtimeMs: e.mtimeMs,
        }))
      : [];

    setRoot(nextRoot);
    setEntries(nextEntries);
    setBridgeFns(functionsOf(api()));
    setTools(await buildTools(nextRoot, nextEntries, includeGenerated));
    addLog(`INDEX ${nextEntries.length} entries / ${sourceFiles(nextEntries, includeGenerated).length} files / tools rebuilt`);
  }, [root, includeGenerated, addLog]);

  const indexWorkspace = useCallback(async () => {
    const e = ext();
    if (!e?.scan) {
      addLog("INDEX FAILED external workspace bridge missing");
      return;
    }

    setBusy(true);
    try {
      const scan = await e.scan({ root: root || undefined, maxEntries: 50000, includeGenerated });
      await applyScan(scan);
    } catch (err) {
      addLog(`INDEX FAILED ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [root, includeGenerated, applyScan, addLog]);

  const openFolder = useCallback(async () => {
    const e = ext();
    if (!e?.openFolder) {
      addLog("OPEN FOLDER FAILED bridge missing");
      return;
    }

    setBusy(true);
    try {
      const scan = await e.openFolder();
      if (scan?.canceled) {
        addLog("OPEN FOLDER canceled");
        return;
      }
      setBuffers({});
      setOpenFiles([]);
      setSelected("");
      await applyScan(scan);
      setLeft("explorer");
    } catch (err) {
      addLog(`OPEN FOLDER FAILED ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyScan, addLog]);

  const openKnownRoot = useCallback(async (nextRoot: string) => {
    const e = ext();
    if (!e?.scan) return;

    setBusy(true);
    try {
      const scan = await e.scan({ root: nextRoot, maxEntries: 50000, includeGenerated });
      setBuffers({});
      setOpenFiles([]);
      setSelected("");
      await applyScan(scan);
      setLeft("explorer");
    } catch (err) {
      addLog(`OPEN WORKSPACE FAILED ${nextRoot} :: ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [applyScan, includeGenerated, addLog]);

  const discoverWorkspaces = useCallback(async () => {
    const e = ext();
    if (!e?.execute) return;

    const script = `python3 - <<'PY'
from pathlib import Path
home = Path.home()
cwd = Path.cwd().resolve()
bases = []
for p in [cwd, *cwd.parents[:5], home / "Downloads" / "Apps", home / "Downloads", home]:
    if p.exists() and p.is_dir() and p not in bases:
        bases.append(p)

seen = set()
deny = {"node_modules", ".git", "dist", "build", "coverage", ".adjutorix-release", ".cache", ".venv", "venv"}
for base in bases:
    try:
        for marker in [".git", "package.json", "pnpm-workspace.yaml", "pyproject.toml", "Cargo.toml", "go.mod"]:
            for item in base.rglob(marker):
                parts = set(item.parts)
                if parts & deny:
                    continue
                root = item.parent if item.name != ".git" else item.parent
                s = str(root.resolve())
                if s not in seen:
                    seen.add(s)
                    print(s)
                if len(seen) >= 200:
                    raise SystemExit
    except Exception:
        pass
PY`;

    setBusy(true);
    try {
      const result = await e.execute({ root: root || undefined, command: script, timeoutMs: 120000 });
      const roots = String(result?.stdout ?? "")
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
      setKnownRoots(Array.from(new Set([root, ...roots].filter(Boolean))).slice(0, 200));
      setLastResult(result);
      addLog(`DISCOVER ${roots.length} workspaces`);
    } catch (err) {
      addLog(`DISCOVER FAILED ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [root, addLog]);

  const openFile = useCallback(async (path: string) => {
    const e = ext();
    if (!e?.readFile) return;

    const p = norm(path);
    setBusy(true);
    try {
      const r = await e.readFile({ root, path: p, maxBytes: 4 * 1024 * 1024 });
      const actual = norm(r?.path ?? p);
      const content = String(r?.content ?? "");
      setBuffers((old) => ({
        ...old,
        [actual]: { path: actual, content, original: content, language: lang(actual), dirty: false },
      }));
      setOpenFiles((old) => Array.from(new Set([...old, actual])));
      setSelected(actual);
      addLog(`OPEN ${actual}`);
    } catch (err) {
      addLog(`OPEN FAILED ${p} :: ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [root, addLog]);

  const saveFile = useCallback(async (path: string) => {
    const e = ext();
    const b = buffers[path];
    if (!e?.writeFile || !b) return;

    setBusy(true);
    try {
      await e.writeFile({ root, path, content: b.content });
      setBuffers((old) => ({ ...old, [path]: { ...b, original: b.content, dirty: false } }));
      addLog(`SAVE ${path}`);
    } catch (err) {
      addLog(`SAVE FAILED ${path} :: ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [root, buffers, addLog]);

  const saveAll = useCallback(async () => {
    for (const b of Object.values(buffers).filter((x) => x.dirty)) await saveFile(b.path);
  }, [buffers, saveFile]);

  const runCommand = useCallback(async (cmd = command) => {
    const e = ext();
    if (!e?.execute) {
      addLog("RUN FAILED bridge missing");
      return;
    }

    setCommand(cmd);
    setBusy(true);
    try {
      const result = await e.execute({ root, command: cmd, timeoutMs: 300000 });
      setLastResult(result);
      const parsed = parseProblems(`${result?.stdout ?? ""}\n${result?.stderr ?? ""}`);
      setProblems(parsed);
      if (parsed.length) setBottom("problems");
      addLog(`RUN ${result?.status ?? "unknown"} ${cmd}`);
    } catch (err) {
      addLog(`RUN FAILED ${String((err as any)?.message ?? err)}`);
    } finally {
      setBusy(false);
    }
  }, [root, command, addLog]);

  const writeContext = useCallback(async () => {
    const e = ext();
    if (!e?.writeFile) return;

    const body = [
      "# Workspace Context",
      "",
      `marker=${MARKER}`,
      `root=${root}`,
      `current=${selected || "none"}`,
      `dirty=${Object.values(buffers).filter((b) => b.dirty).map((b) => b.path).join(",") || "none"}`,
      "",
      "## Intent",
      agentText,
      "",
      "## Available Workspaces",
      ...knownRoots.map((r) => `- ${r}`),
      "",
      "## Tools",
      ...tools.map((t) => `- [${t.lane}] ${t.label}: ${t.command}`),
      "",
      "## Bridge",
      ...bridgeFns.map((f) => `- ${f}`),
      "",
      "## Current File",
      selected,
      "",
      "```",
      current?.content?.slice(0, 50000) ?? "",
      "```",
      "",
      "## Activity",
      ...activity.slice(0, 120),
    ].join("\n");

    try {
      await e.writeFile({ root, path: ".adjutorix/workspace-context.md", content: body });
      addLog("CONTEXT WRITTEN .adjutorix/workspace-context.md");
    } catch (err) {
      addLog(`CONTEXT FAILED ${String((err as any)?.message ?? err)}`);
    }
  }, [root, selected, buffers, agentText, knownRoots, tools, bridgeFns, current, activity, addLog]);

  const paletteItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    const toolItems = tools.map((t) => ({ kind: t.lane, label: t.label, detail: t.command, run: () => runCommand(t.command) }));
    const fileItems = files.slice(0, 800).map((f) => ({ kind: "file", label: f.path, detail: f.path, run: () => openFile(f.path) }));
    const rootItems = knownRoots.map((r) => ({ kind: "workspace", label: r, detail: r, run: () => openKnownRoot(r) }));
    const all = [...toolItems, ...rootItems, ...fileItems];
    return q ? all.filter((x) => `${x.kind} ${x.label} ${x.detail}`.toLowerCase().includes(q)) : all;
  }, [query, tools, files, knownRoots, runCommand, openFile, openKnownRoot]);

  useEffect(() => {
    indexWorkspace();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setLeft("palette");
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (selected) saveFile(selected);
      }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        saveAll();
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selected, saveFile, saveAll]);

  const leftContent = () => {
    if (left === "palette") {
      return <div className="v17-list">{paletteItems.slice(0, 500).map((item, i) => (
        <button key={`${item.kind}-${item.label}-${i}`} className="v17-row" onClick={item.run}>
          <b>{item.label}</b><em>{item.kind}</em><code>{item.detail}</code>
        </button>
      ))}</div>;
    }

    if (left === "workspaces") {
      return <div className="v17-list">
        <button className="v17-big" onClick={openFolder}>Open any folder</button>
        <button className="v17-big" onClick={discoverWorkspaces}>Discover workspaces</button>
        {knownRoots.map((r) => (
          <button key={r} className={norm(r) === norm(root) ? "v17-row active" : "v17-row"} onClick={() => openKnownRoot(r)}>
            <b>{baseName(r)}</b><em>workspace</em><code>{r}</code>
          </button>
        ))}
      </div>;
    }

    if (left === "tools" || left === "tasks") {
      return <div className="v17-list">
        {lanes.map(([lane, count]) => <button key={lane} className="v17-lane" onClick={() => setQuery(lane)}><b>{lane}</b><strong>{count}</strong></button>)}
        {visibleTools.slice(0, 400).map((t) => (
          <button key={t.id} className="v17-row" onClick={() => runCommand(t.command)}>
            <b>{t.label}</b><em>{t.lane}</em><code>{t.command}</code>
          </button>
        ))}
      </div>;
    }

    if (left === "scm") {
      return <div className="v17-list">{tools.filter((t) => t.lane === "scm").map((t) => (
        <button key={t.id} className="v17-row" onClick={() => runCommand(t.command)}>
          <b>{t.label}</b><code>{t.command}</code>
        </button>
      ))}</div>;
    }

    if (left === "agent") {
      return <div className="v17-agent">
        <textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} />
        <button className="v17-big" onClick={writeContext}>Write full workspace context</button>
        <p>Context includes active workspace, discovered workspaces, tools, bridge functions, current buffer, dirty files, and recent activity.</p>
      </div>;
    }

    if (left === "runtime") {
      return <div className="v17-list">{bridgeFns.map((f) => <button key={f} className="v17-row"><b>{f}</b><em>bridge</em></button>)}</div>;
    }

    return <div className="v17-list">{visibleFiles.map((f) => (
      <button key={f.path} className={selected === f.path ? "v17-file active" : "v17-file"} onClick={() => openFile(f.path)}>
        <span>{buffers[f.path]?.dirty ? "●" : "·"}</span>
        <b>{f.path}</b>
      </button>
    ))}</div>;
  };

  const rightContent = () => {
    if (right === "outline") return <div className="v17-cards">{outline.map((s) => (
      <button key={`${s.line}-${s.name}`} onClick={() => editorRef.current?.revealLineInCenter?.(s.line)}>
        <b>{s.kind}</b><span>{s.name}</span><em>line {s.line}</em>
      </button>
    ))}</div>;

    if (right === "problems") return <div className="v17-cards">{problems.length ? problems.map((p, i) => (
      <button key={i} onClick={() => p.file && openFile(p.file)}>
        <b className={p.severity === "warning" ? "warn" : "bad"}>{p.severity}</b>
        <span>{p.file || "command"}{p.line ? `:${p.line}` : ""}</span>
        <em>{p.message}</em>
      </button>
    )) : <p>No parsed problems.</p>}</div>;

    if (right === "patch") return <pre className="v17-pre">{patch}</pre>;
    if (right === "graph") return <pre className="v17-pre">{[
      "WORKSPACE",
      root,
      "",
      "OPEN FILES",
      ...openFiles,
      "",
      "OUTLINE",
      ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`),
      "",
      "TOOLS",
      ...tools.map((t) => `[${t.lane}] ${t.label} -> ${t.command}`),
    ].join("\n")}</pre>;

    if (right === "agent") return <div className="v17-agent"><textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} /><button className="v17-big" onClick={writeContext}>Write context</button><pre>{activity.join("\n")}</pre></div>;
    if (right === "runtime") return <div className="v17-list">{bridgeFns.map((f) => <button key={f} className="v17-row"><b>{f}</b></button>)}</div>;

    return <div className="v17-inspector">
      <div className="v17-card wide"><span>root</span><b>{root || "unknown"}</b></div>
      <div className="v17-card"><span>files</span><b>{files.length}</b></div>
      <div className="v17-card"><span>indexed</span><b>{entries.length}</b></div>
      <div className="v17-card"><span>tools</span><b>{tools.length}</b></div>
      <div className="v17-card"><span>workspaces</span><b>{knownRoots.length}</b></div>
      <div className="v17-card"><span>open</span><b>{openFiles.length}</b></div>
      <div className="v17-card"><span>dirty</span><b>{dirty}</b></div>
      <div className="v17-card"><span>bridge</span><b>{bridgeFns.length}</b></div>
      <div className="v17-card"><span>status</span><b>{busy ? "busy" : "live"}</b></div>
      <div className="v17-card wide"><span>current</span><b>{selected || "none"}</b></div>
      <div className="v17-card wide"><span>lanes</span><p>{lanes.map(([lane]) => lane).join(", ")}</p></div>
    </div>;
  };

  return <div className="v17-shell">
    <header className="v17-top">
      <button className="v17-marker" onClick={() => setLeft("palette")}>{MARKER}</button>
      <button onClick={() => setLeft("palette")} className="v17-command">⌘P</button>
      <strong className="v17-root">{root}</strong>
      <label className="v17-check"><input type="checkbox" checked={includeGenerated} onChange={(e) => setIncludeGenerated(e.target.checked)} /> generated</label>
      <button className="v17-live">{busy ? "BUSY" : "LIVE"}</button>
      <button onClick={openFolder}>Open folder</button>
      <button onClick={discoverWorkspaces}>Discover</button>
      <button onClick={indexWorkspace}>Index</button>
      <button disabled={!selected || !current?.dirty} onClick={() => selected && saveFile(selected)}>Save</button>
      <button disabled={!dirty} onClick={saveAll}>Save all</button>
    </header>

    <main className="v17-main">
      <nav className="v17-rail">
        {[
          ["workspaces", "WS"],
          ["explorer", "EX"],
          ["tools", "TL"],
          ["tasks", "TK"],
          ["scm", "SC"],
          ["agent", "AG"],
          ["runtime", "RT"],
        ].map(([id, label]) => <button key={id} className={left === id ? "active" : ""} onClick={() => setLeft(id)}>{label}</button>)}
      </nav>

      <aside className="v17-left">
        <div className="v17-panel-head">
          <b>{left}</b>
          <span>{visibleFiles.length}/{files.length}</span>
        </div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="workspace, tool, file, module, buffer" />
        {leftContent()}
      </aside>

      <section className="v17-center">
        <div className="v17-tabs">
          {openFiles.length ? openFiles.map((p) => (
            <button key={p} className={selected === p ? "active" : ""} onClick={() => setSelected(p)}>
              {buffers[p]?.dirty ? "● " : ""}{baseName(p)}
              <span onClick={(e) => { e.stopPropagation(); setOpenFiles((old) => old.filter((x) => x !== p)); if (selected === p) setSelected(""); }}>×</span>
            </button>
          )) : <span>Open a source file.</span>}
        </div>

        <div className="v17-editor">
          {current ? <Editor
            height="100%"
            theme="vs-dark"
            language={current.language}
            path={current.path}
            value={current.content}
            onMount={(editor) => { editorRef.current = editor; }}
            options={{
              automaticLayout: true,
              fontSize: 13,
              minimap: { enabled: true },
              scrollBeyondLastLine: false,
              renderWhitespace: "selection",
            }}
            onChange={(value) => {
              const next = value ?? "";
              setBuffers((old) => {
                const b = old[current.path];
                if (!b) return old;
                return { ...old, [current.path]: { ...b, content: next, dirty: next !== b.original } };
              });
            }}
          /> : <div className="v17-empty">No file selected.</div>}
        </div>

        <div className="v17-bottom">
          <div className="v17-bottom-tabs">
            {["terminal", "output", "problems", "patch", "graph", "raw"].map((id) => (
              <button key={id} className={bottom === id ? "active" : ""} onClick={() => setBottom(id)}>{id}</button>
            ))}
          </div>
          {bottom === "terminal" && <div className="v17-terminal">
            <div className="v17-runline"><input value={command} onChange={(e) => setCommand(e.target.value)} /><button onClick={() => runCommand(command)}>Run</button></div>
            <pre>{terminal}</pre>
          </div>}
          {bottom === "output" && <pre className="v17-pre">{activity.join("\n")}</pre>}
          {bottom === "problems" && <pre className="v17-pre">{problems.map((p) => `${p.severity} ${p.file ?? ""}:${p.line ?? ""} ${p.message}`).join("\n") || "No parsed problems."}</pre>}
          {bottom === "patch" && <pre className="v17-pre">{patch}</pre>}
          {bottom === "graph" && <pre className="v17-pre">{rightContent() as any}</pre>}
          {bottom === "raw" && <pre className="v17-pre">{JSON.stringify({ marker: MARKER, root, entries: entries.length, files: files.length, tools: tools.length, knownRoots, lastResult }, null, 2)}</pre>}
        </div>
      </section>

      <aside className="v17-right">
        <div className="v17-right-tabs">
          {["inspector", "outline", "problems", "patch", "graph", "agent", "runtime"].map((id) => (
            <button key={id} className={right === id ? "active" : ""} onClick={() => setRight(id)}>{id}</button>
          ))}
        </div>
        {rightContent()}
      </aside>
    </main>
  </div>;
}
