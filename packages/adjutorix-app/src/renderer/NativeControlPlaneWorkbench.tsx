// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";
import "./native-workbench.css";

const MARKER = "ADJUTORIX_NATIVE_ALL_TOOLS_WORKBENCH_V15";

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

const NAV = [
  ["explorer", "EX"],
  ["tools", "TL"],
  ["agent", "AG"],
  ["verify", "VF"],
  ["patch", "PT"],
  ["ledger", "LG"],
  ["transaction", "TX"],
  ["governance", "GV"],
  ["workspace", "WS"],
  ["diagnostics", "DG"],
  ["recovery", "RC"],
  ["performance", "PF"],
  ["ci", "CI"],
  ["surfaces", "UI"],
  ["runtime", "RT"],
];

const RIGHT = ["inspector", "outline", "problems", "patch", "graph", "agent", "runtime", "surfaces"];

const TOOL_SEEDS = [
  ["doctor", "Doctor", "doctor", "echo ADJUTORIX_DOCTOR && pwd && node -v && pnpm -v && git branch --show-current && git rev-parse --short HEAD && git status --short | head -200"],
  ["build-app", "Build app", "build", "pnpm --filter @adjutorix/app run build"],
  ["typecheck-app", "Typecheck app", "build", "pnpm --filter @adjutorix/app exec tsc -p tsconfig.json --noEmit --pretty false"],
  ["verify-root", "Verify root", "verify", "pnpm run verify"],
  ["test-root", "Run root tests", "verify", "pnpm test"],
  ["smoke-root", "Root smoke", "verify", "bash scripts/smoke.sh"],
  ["package-macos", "Package macOS", "release", "bash scripts/package-macos.sh"],

  ["agent-doctor", "Agent doctor", "agent", "bash scripts/agent/doctor.sh"],
  ["agent-status", "Agent status", "agent", "bash scripts/agent/status.sh"],
  ["agent-start", "Agent start", "agent", "bash scripts/agent/start.sh"],
  ["agent-stop", "Agent stop", "agent", "bash scripts/agent/stop.sh"],
  ["agent-restart", "Agent restart", "agent", "bash scripts/agent/restart.sh"],
  ["agent-logs", "Agent logs", "agent", "bash scripts/agent/logs.sh"],

  ["verify-run", "Verify run", "verify", "bash scripts/verify/run.sh"],
  ["verify-status", "Verify status", "verify", "bash scripts/verify/status.sh"],
  ["verify-rerun", "Verify rerun", "verify", "bash scripts/verify/rerun.sh"],
  ["verify-artifacts", "Verify artifacts", "verify", "bash scripts/verify/artifacts.sh"],
  ["verify-summary", "Verify summary", "verify", "bash scripts/verify/summary.sh"],

  ["patch-preview", "Patch preview", "patch", "bash scripts/patch/preview.sh"],
  ["patch-validate", "Patch validate", "patch", "bash scripts/patch/validate.sh"],
  ["patch-apply", "Patch apply", "patch", "bash scripts/patch/apply.sh"],
  ["patch-rebase", "Patch rebase", "patch", "bash scripts/patch/rebase.sh"],
  ["patch-rollback", "Patch rollback", "patch", "bash scripts/patch/rollback.sh"],
  ["patch-reject", "Patch reject", "patch", "bash scripts/patch/reject.sh"],

  ["ledger-current", "Ledger current", "ledger", "bash scripts/ledger/current.sh"],
  ["ledger-graph", "Ledger graph", "ledger", "bash scripts/ledger/graph.sh"],
  ["ledger-inspect", "Ledger inspect", "ledger", "bash scripts/ledger/inspect.sh"],
  ["ledger-range", "Ledger range", "ledger", "bash scripts/ledger/range.sh"],
  ["ledger-replay", "Ledger replay", "ledger", "bash scripts/ledger/replay.sh"],
  ["ledger-at", "Ledger at", "ledger", "bash scripts/ledger/at.sh"],

  ["transaction-status", "Transaction status", "transaction", "bash scripts/transaction/status.sh"],
  ["transaction-submit", "Transaction submit", "transaction", "bash scripts/transaction/submit.sh"],
  ["transaction-cancel", "Transaction cancel", "transaction", "bash scripts/transaction/cancel.sh"],
  ["transaction-inspect", "Transaction inspect", "transaction", "bash scripts/transaction/inspect.sh"],
  ["transaction-graph", "Transaction graph", "transaction", "bash scripts/transaction/graph.sh"],
  ["transaction-logs", "Transaction logs", "transaction", "bash scripts/transaction/logs.sh"],

  ["governance-audit", "Governance audit", "governance", "bash scripts/governance/audit.sh"],
  ["governance-check", "Governance check", "governance", "bash scripts/governance/check.sh"],
  ["governance-explain", "Governance explain", "governance", "bash scripts/governance/explain.sh"],
  ["governance-policies", "Governance policies", "governance", "bash scripts/governance/policies.sh"],
  ["governance-deny-reasons", "Governance denial reasons", "governance", "bash scripts/governance/deny-reasons.sh"],

  ["workspace-open", "Workspace open", "workspace", "bash scripts/workspace/open.sh"],
  ["workspace-scan", "Workspace scan", "workspace", "bash scripts/workspace/scan.sh"],
  ["workspace-health", "Workspace health", "workspace", "bash scripts/workspace/health.sh"],
  ["workspace-reindex", "Workspace reindex", "workspace", "bash scripts/workspace/reindex.sh"],
  ["workspace-trust", "Workspace trust", "workspace", "bash scripts/workspace/trust.sh"],

  ["diagnostics-parse", "Diagnostics parse", "diagnostics", "bash scripts/diagnostics/parse.sh"],
  ["diagnostics-problems", "Diagnostics problems", "diagnostics", "bash scripts/diagnostics/problems.sh"],
  ["diagnostics-link", "Diagnostics link", "diagnostics", "bash scripts/diagnostics/link.sh"],

  ["recovery-cleanup", "Recovery cleanup", "recovery", "bash scripts/recovery/cleanup.sh"],
  ["recovery-resume", "Recovery resume", "recovery", "bash scripts/recovery/resume.sh"],
  ["recovery-rollback", "Recovery rollback", "recovery", "bash scripts/recovery/rollback.sh"],
  ["recovery-ledger", "Repair ledger", "recovery", "bash scripts/recovery/repair-ledger.sh"],
  ["recovery-verify", "Recover verify", "recovery", "bash scripts/recovery/recover-verify.sh"],

  ["performance-benchmark", "Benchmark", "performance", "bash scripts/performance/benchmark.sh"],
  ["performance-profile", "Profile", "performance", "bash scripts/performance/profile.sh"],
  ["performance-compare", "Compare performance", "performance", "bash scripts/performance/compare.sh"],
  ["performance-report", "Performance report", "performance", "bash scripts/performance/report.sh"],

  ["contracts-diff", "Contracts diff", "contracts", "bash scripts/contracts/diff.sh"],
  ["contracts-freeze", "Contracts freeze", "contracts", "bash scripts/contracts/freeze.sh"],
  ["contracts-validate", "Contracts validate", "contracts", "bash scripts/contracts/validate.sh"],

  ["ci-check", "CI check", "ci", "bash configs/ci/check.sh"],
  ["ci-smoke", "CI smoke", "ci", "bash configs/ci/smoke.sh"],
  ["ci-verify", "CI verify", "ci", "bash configs/ci/verify.sh"],
  ["ci-guard-generated", "Guard generated artifacts", "ci", "bash configs/ci/guard_generated_artifacts.sh"],
  ["ci-guard-renderer", "Guard renderer authority", "ci", "bash configs/ci/guard_renderer_authority.sh"],
  ["ci-guard-ipc", "Guard IPC registry", "ci", "bash configs/ci/guard_ipc_channel_registry.sh"],
  ["ci-guard-verify-bypass", "Guard verify bypass", "ci", "bash configs/ci/guard_verify_gate_bypass.sh"],
  ["ci-guard-apply-bypass", "Guard apply bypass", "ci", "bash configs/ci/guard_apply_gate_bypass.sh"],

  ["app-vitest", "App tests", "app", "pnpm --dir packages/adjutorix-app exec vitest run"],
  ["app-smoke", "App smoke", "app", "pnpm --dir packages/adjutorix-app exec vitest run -c vitest.smoke.config.ts"],
  ["agent-tests", "Agent tests", "agent", "cd packages/adjutorix-agent && python -m pytest"],
  ["cli-tests", "CLI tests", "cli", "cd packages/adjutorix-cli && python -m pytest"],
  ["shared-build", "Shared build", "shared", "pnpm --filter @adjutorix/shared run build"],
  ["orchestrator-build", "Orchestrator build", "orchestrator", "pnpm --filter @adjutorix/orchestrator run build"],
];

function api() {
  const w = window as any;
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
    compatibility: { ...(b.compatibility ?? {}), ...(a.compatibility ?? {}) },
  };
}

function pathGet(obj: any, path: string) {
  let x = obj;
  for (const p of path.split(".")) {
    if (!x || typeof x !== "object") return null;
    x = x[p];
  }
  return x;
}

function unwrap(x: any) {
  if (x && typeof x === "object") {
    if (x.ok === true && "data" in x) return x.data;
    if (x.ok === true && "result" in x) return x.result;
    if (x.ok === true && "snapshot" in x) return x.snapshot;
  }
  return x;
}

async function callAny(paths: string[], payloads: any[] = [{}]) {
  const bridge = api();
  let found = false;
  let last: any = null;

  for (const p of paths) {
    const fn = pathGet(bridge, p);
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

function functionsOf(obj: any) {
  const out: string[] = [];
  const seen = new Set();

  const walk = (x: any, prefix: string[], depth: number) => {
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

function norm(p: any) {
  return String(p ?? "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/\/$/g, "");
}

function base(p: string) {
  return norm(p).split("/").filter(Boolean).at(-1) ?? p;
}

function relative(p: string, root?: string) {
  const pp = norm(p);
  const rr = norm(root);
  if (!rr) return pp;
  if (pp === rr) return ".";
  if (pp.startsWith(rr + "/")) return pp.slice(rr.length + 1);
  return pp;
}

function childrenOf(x: any) {
  return [x?.children, x?.entries, x?.items, x?.files, x?.tree, x?.workspaceTree, x?.fileTree].find(Array.isArray) ?? [];
}

function dataPath(x: any) {
  const y = unwrap(x);
  if (!y || typeof y !== "object") return null;
  const p = y.path ?? y.fullPath ?? y.absolutePath ?? y.relativePath ?? y.workspacePath ?? y.filePath ?? y.id;
  return typeof p === "string" && p.trim() ? norm(p) : null;
}

function isDir(x: any) {
  const y = unwrap(x);
  const kind = String(y?.kind ?? y?.type ?? y?.entryType ?? "").toLowerCase();
  return y?.isDirectory === true || y?.directory === true || kind.includes("dir") || kind.includes("folder") || childrenOf(y).length > 0;
}

function flattenFiles(snapshots: any[]) {
  const map = new Map();

  const walk = (node: any) => {
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

function findRoot(entries: any[], snapshots: any[]) {
  for (const s of snapshots) {
    let out = "";

    const walk = (x: any) => {
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

function generated(path: string) {
  const p = `/${norm(path).toLowerCase()}/`;
  return (
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
    p.includes("/.adjutorix-release/") ||
    p.includes("/quarantine/") ||
    p.includes("/venv/") ||
    p.includes("/.venv/")
  );
}

function binary(path: string) {
  return /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock|pyc)$/i.test(path);
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

function sourceScore(path: string) {
  const p = norm(path).toLowerCase();
  const b = base(p);
  let s = 0;

  if (p.endsWith("/packages/adjutorix-app/src/renderer/nativecontrolplaneworkbench.tsx")) s += 950000;
  if (p.includes("/packages/adjutorix-app/src/renderer/components/")) s += 910000;
  if (p.includes("/packages/adjutorix-app/src/renderer/hooks/")) s += 900000;
  if (p.includes("/packages/adjutorix-app/src/renderer/state/")) s += 890000;
  if (p.includes("/packages/adjutorix-app/src/renderer/lib/")) s += 880000;
  if (p.includes("/packages/adjutorix-app/src/main/ipc/")) s += 860000;
  if (p.includes("/packages/adjutorix-app/src/main/")) s += 840000;
  if (p.includes("/packages/adjutorix-app/src/preload/")) s += 830000;
  if (p.includes("/packages/adjutorix-agent/adjutorix_agent/")) s += 810000;
  if (p.includes("/packages/shared/src/")) s += 790000;
  if (p.includes("/packages/orchestrator/src/")) s += 760000;
  if (p.includes("/packages/adjutorix-cli/adjutorix_cli/")) s += 750000;
  if (p.startsWith("scripts/")) s += 730000;
  if (p.startsWith("configs/")) s += 600000;
  if (p.startsWith("tests/")) s += 500000;

  if (b === "package.json") s += 70000;
  if (b === "pnpm-workspace.yaml") s += 65000;
  if (b === "readme.md") s += 30000;

  if (p.endsWith(".tsx")) s += 7000;
  if (p.endsWith(".ts")) s += 6000;
  if (p.endsWith(".py")) s += 5000;
  if (p.endsWith(".sh")) s += 4500;
  if (p.endsWith(".json")) s += 3000;
  if (p.endsWith(".yaml") || p.endsWith(".yml")) s += 2500;
  if (p.endsWith(".md")) s += 1800;

  return s - Math.min(p.length, 2000);
}

function classify(path: string) {
  const p = norm(path);

  if (/^scripts\/agent\//.test(p) || /adjutorix_agent\//.test(p)) return "agent";
  if (/^scripts\/verify\//.test(p) || /verify/i.test(p)) return "verify";
  if (/^scripts\/patch\//.test(p) || /patch/i.test(p)) return "patch";
  if (/^scripts\/ledger\//.test(p) || /ledger/i.test(p)) return "ledger";
  if (/^scripts\/transaction\//.test(p) || /transaction/i.test(p)) return "transaction";
  if (/^scripts\/governance\//.test(p) || /governance|policy|constitution|guard/i.test(p)) return "governance";
  if (/^scripts\/workspace\//.test(p) || /workspace/i.test(p)) return "workspace";
  if (/^scripts\/diagnostics\//.test(p) || /diagnostics|observability|metrics|tracing|logging|errors/i.test(p)) return "diagnostics";
  if (/^scripts\/recovery\//.test(p) || /recovery|rollback|resume|repair/i.test(p)) return "recovery";
  if (/^scripts\/performance\//.test(p) || /performance|benchmark|profile|latency/i.test(p)) return "performance";
  if (/^configs\/ci\//.test(p) || /\.github\/workflows/.test(p)) return "ci";
  if (/contracts/.test(p)) return "contracts";
  if (/renderer\/components|renderer\/hooks|renderer\/state|renderer\/lib/.test(p)) return "surfaces";
  if (/packages\/shared/.test(p)) return "shared";
  if (/packages\/orchestrator/.test(p)) return "orchestrator";
  if (/packages\/adjutorix-cli/.test(p)) return "cli";
  if (/tests\//.test(p)) return "tests";
  return "source";
}

function scriptTool(path: string) {
  const p = norm(path);
  const id = p.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
  const name = p.replace(/^scripts\//, "").replace(/^configs\/ci\//, "ci/").replace(/^packages\//, "pkg/").replace(/\.(sh|mjs|js|py|ts)$/i, "");
  const group = classify(p);
  const runner = p.endsWith(".sh") ? `bash ${JSON.stringify(p)}` :
    p.endsWith(".mjs") || p.endsWith(".js") ? `node ${JSON.stringify(p)}` :
    p.endsWith(".py") ? `python3 ${JSON.stringify(p)}` :
    `cat ${JSON.stringify(p)}`;
  return { id, label: name, group, command: runner, source: "discovered-script" };
}

function contentOf(x: any) {
  if (typeof x === "string") return x;
  const y = unwrap(x);
  return String(y?.content ?? y?.text ?? y?.value ?? y?.body ?? "");
}

function resultOf(x: any, command: string) {
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

function terminalText(r: any) {
  return [
    `$ ${r.command ?? ""}`,
    `status=${r.status ?? (r.ok === false ? "failed" : "ok")} exit=${r.exitCode ?? ""} duration=${r.durationMs ?? ""}ms`,
    "",
    r.stdout ?? "",
    r.stderr ? `\n[stderr]\n${r.stderr}` : "",
  ].join("\n").trim();
}

function parseProblems(text: string) {
  const out: any[] = [];

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

    if (/error|failed|exception|cannot find module|module_not_found|traceback|denied|reject/i.test(line)) {
      out.push({ severity: "error", message: line });
    }
  }

  return out.slice(0, 700);
}

function outlineOf(text: string) {
  const rules = [
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

  const out: any[] = [];
  text.split(/\r?\n/).forEach((line, i) => {
    for (const [rx, kind] of rules) {
      const m = line.match(rx);
      if (m) {
        out.push({ line: i + 1, kind, name: m[1] });
        break;
      }
    }
  });

  return out.slice(0, 500);
}

function importsOf(text: string) {
  return text
    .split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((x) => /^(import|from|const .*require\(|export .* from )/.test(x.text))
    .slice(0, 400);
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
    if (out.length > 1200) {
      out.push("[patch truncated]");
      break;
    }
  }

  return out.join("\n");
}

function uniqTools(tools: any[]) {
  const m = new Map();
  for (const t of tools) m.set(t.id || t.command, t);
  return [...m.values()];
}

function sourceFiles(entries: any[], includeGenerated: boolean) {
  const seen = new Set();
  const out: any[] = [];

  for (const e of entries) {
    const p = norm(e.path);
    if (!p || e.isDir || binary(p) || seen.has(p)) continue;
    if (!includeGenerated && generated(p)) continue;
    seen.add(p);
    out.push({ ...e, path: p, score: sourceScore(p), group: classify(p) });
  }

  return out.sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || a.path.localeCompare(b.path));
}

export default function NativeControlPlaneWorkbench() {
  const editor = useRef<any>(null);

  const [root, setRoot] = useState("");
  const [entries, setEntries] = useState<any[]>([]);
  const [bridgeFns, setBridgeFns] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<any[]>([]);
  const [buffers, setBuffers] = useState<Record<string, any>>({});
  const [selected, setSelected] = useState("");
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [includeGenerated, setIncludeGenerated] = useState(false);
  const [left, setLeft] = useState("tools");
  const [right, setRight] = useState("inspector");
  const [bottom, setBottom] = useState("terminal");
  const [busy, setBusy] = useState(false);
  const [cmd, setCmd] = useState("pnpm --filter @adjutorix/app run build");
  const [terminal, setTerminal] = useState("Pick a tool, task, script, product surface, or source file.");
  const [lastResult, setLastResult] = useState<any>({ status: "ready", stdout: "All-tools workbench ready.", stderr: "" });
  const [problems, setProblems] = useState<any[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [palette, setPalette] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [agentText, setAgentText] = useState("Inspect the full ADJUTORIX system. Use all tools. Produce the next concrete patch. Run build, verify, and gates.");

  const current = selected ? buffers[selected] : null;
  const dirtyBuffers = Object.values(buffers).filter((b: any) => b.dirty);

  const addLog = useCallback((line: string) => {
    setActivity((old) => [`${new Date().toLocaleTimeString()}  ${line}`, ...old].slice(0, 800));
  }, []);

  const files = useMemo(() => sourceFiles(entries, includeGenerated), [entries, includeGenerated]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? files.filter((f) => f.path.toLowerCase().includes(q) || buffers[f.path]?.content?.toLowerCase?.().includes(q))
      : files;
    return filtered.slice(0, 1500);
  }, [buffers, files, query]);

  const discoveredTools = useMemo(() => {
    const scriptLike = files.filter((f) =>
      /^scripts\/.+\.(sh|mjs|js|py)$/i.test(relative(f.path, root)) ||
      /^configs\/ci\/.+\.sh$/i.test(relative(f.path, root)) ||
      /^packages\/[^/]+\/scripts\/.+\.(sh|mjs|js|py)$/i.test(relative(f.path, root))
    );
    return scriptLike.map((f) => scriptTool(relative(f.path, root)));
  }, [files, root]);

  const allTools = useMemo(() => {
    const seeded = TOOL_SEEDS.map(([id, label, group, command]) => ({ id, label, group, command, source: "seed" }));
    return uniqTools([...seeded, ...discoveredTools]).sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  }, [discoveredTools]);

  const surfaceFiles = useMemo(() => files.filter((f) =>
    /packages\/adjutorix-app\/src\/renderer\/(components|hooks|state|lib)\//.test(relative(f.path, root)) ||
    /packages\/adjutorix-app\/src\/main\//.test(relative(f.path, root)) ||
    /packages\/adjutorix-app\/src\/preload\//.test(relative(f.path, root)) ||
    /packages\/adjutorix-agent\/adjutorix_agent\//.test(relative(f.path, root)) ||
    /packages\/adjutorix-cli\/adjutorix_cli\//.test(relative(f.path, root)) ||
    /packages\/orchestrator\/src\//.test(relative(f.path, root)) ||
    /packages\/shared\/src\//.test(relative(f.path, root))
  ), [files, root]);

  const outline = useMemo(() => outlineOf(current?.content ?? ""), [current?.content]);
  const imports = useMemo(() => importsOf(current?.content ?? ""), [current?.content]);
  const patch = useMemo(() => current ? diffOf(current.original, current.content) : "No file.", [current]);

  const domainCounts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of files) out[f.group] = (out[f.group] ?? 0) + 1;
    for (const t of allTools) out[`tool:${t.group}`] = (out[`tool:${t.group}`] ?? 0) + 1;
    return out;
  }, [allTools, files]);

  const runCommand = useCallback(async (command: string) => {
    setBusy(true);
    setBottom("terminal");
    setCmd(command);
    setTerminal(`$ ${command}\n\nrunning...`);
    addLog(`RUN ${command}`);

    try {
      const started = Date.now();
      const response = await callAny(COMMAND_PATHS, [
        { schema: 1, actor: "renderer", command, intent: command, cwd: root || undefined, timeoutMs: 300000 },
        { command, cwd: root || undefined, timeoutMs: 300000 },
        command,
      ]);

      const result = { ...resultOf(response, command), durationMs: Date.now() - started, command };
      setLastResult(result);
      setTerminal(terminalText(result));

      const parsed = parseProblems(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
      setProblems(parsed);
      if (parsed.length) setBottom("problems");

      addLog(`DONE ${result.status ?? result.exitCode ?? "ok"}`);
      return result;
    } catch (e) {
      const result = { ok: false, status: "bridge_error", exitCode: 1, command, stdout: "", stderr: String(e?.message ?? e) };
      setLastResult(result);
      setTerminal(terminalText(result));
      setProblems(parseProblems(result.stderr ?? ""));
      setBottom("problems");
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
    const collected: any[] = [];

    for (const path of INDEX_PATHS) {
      try {
        collected.push(await callAny([path], [{ schema: 1, actor: "renderer", limit: 12000 }]));
      } catch (e) {
        collected.push({ error: String(e), source: path });
      }
    }

    const flat = flattenFiles(collected);
    const nextRoot = findRoot(flat, collected) || root;
    const fns = functionsOf(bridge);

    setSnapshots(collected);
    setEntries(flat);
    setRoot(nextRoot);
    setBridgeFns(fns);

    addLog(`INDEX ${flat.length} entries / ${sourceFiles(flat, false).length} product files / bridge=${fns.length}`);
    setBusy(false);
  }, [addLog, root]);

  const openFile = useCallback(async (path: string) => {
    const full = norm(path);
    const r = relative(full, root);
    const known = entries.find((e) => norm(e.path) === full || relative(e.path, root) === r);

    if (known?.isDir || binary(full)) {
      addLog(`SKIP ${r}`);
      return;
    }

    try {
      const response = await callAny(READ_PATHS, [
        { schema: 1, actor: "renderer", path: r, targetPath: r, relativePath: r, filePath: r, workspacePath: r },
        { path: r },
      ]);

      const content = contentOf(response);
      const actual = norm(response?.path ?? full);
      const buf = {
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
      addLog(`OPEN ${relative(actual, root)}`);
    } catch (e) {
      addLog(`OPEN FAILED ${r} :: ${String(e?.message ?? e)}`);
      setBottom("output");
    }
  }, [addLog, entries, root]);

  const saveFile = useCallback(async (path: string) => {
    const b = buffers[path];
    if (!b) return;

    const r = relative(path, root);

    try {
      await callAny(WRITE_PATHS, [
        { schema: 1, actor: "renderer", path: r, targetPath: r, relativePath: r, filePath: r, workspacePath: r, content: b.content, text: b.content, value: b.content },
        { path: r, content: b.content },
      ]);

      setBuffers((old) => ({ ...old, [path]: { ...b, original: b.content, dirty: false, savedAt: Date.now() } }));
      addLog(`SAVE ${r}`);
    } catch (e) {
      addLog(`SAVE FALLBACK ${r} :: ${String(e?.message ?? e)}`);
      const command = `python3 - <<'PY'\nfrom pathlib import Path\np=Path(${JSON.stringify(r)})\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text(${JSON.stringify(b.content)})\nprint(p)\nPY`;
      await runCommand(command);
      setBuffers((old) => ({ ...old, [path]: { ...b, original: b.content, dirty: false, savedAt: Date.now() } }));
    }
  }, [addLog, buffers, root, runCommand]);

  const saveAll = useCallback(async () => {
    for (const b of dirtyBuffers) await saveFile(b.path);
  }, [dirtyBuffers, saveFile]);

  const openCoreSurfaces = useCallback(async () => {
    const wanted = [
      "packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx",
      "packages/adjutorix-app/src/main/index.ts",
      "packages/adjutorix-app/src/preload/preload.ts",
      "packages/adjutorix-app/src/renderer/components/AppShell.tsx",
      "packages/adjutorix-app/src/renderer/components/CommandPalette.tsx",
      "packages/adjutorix-app/src/renderer/components/FileTreePane.tsx",
      "packages/adjutorix-app/src/renderer/components/TerminalPanel.tsx",
      "packages/adjutorix-app/src/renderer/components/PatchReviewPanel.tsx",
      "packages/adjutorix-app/src/renderer/components/VerifyPanel.tsx",
      "packages/adjutorix-app/src/renderer/components/LedgerPanel.tsx",
      "packages/adjutorix-app/src/renderer/components/TransactionGraphPanel.tsx",
      "packages/adjutorix-agent/adjutorix_agent/core/patch_pipeline.py",
      "packages/adjutorix-agent/adjutorix_agent/core/verify_pipeline.py",
      "packages/shared/src/patch/patch_artifact.ts",
      "packages/orchestrator/src/system_bootstrap.ts",
    ];

    for (const p of wanted) {
      const hit = files.find((f) => relative(f.path, root) === p || f.path === p);
      if (hit) await openFile(hit.path);
    }
  }, [files, openFile, root]);

  const writeAgentContext = useCallback(async () => {
    const body = [
      "# ADJUTORIX Agent Context",
      "",
      `marker=${MARKER}`,
      `root=${root}`,
      `current=${current ? relative(current.path, root) : "none"}`,
      `dirty=${dirtyBuffers.map((b: any) => relative(b.path, root)).join(",") || "none"}`,
      "",
      "## Intent",
      "",
      agentText,
      "",
      "## All Tools",
      "",
      allTools.map((t) => `- [${t.group}] ${t.label}: \`${t.command}\``).join("\n"),
      "",
      "## Product Surfaces",
      "",
      surfaceFiles.slice(0, 800).map((f) => `- ${relative(f.path, root)}`).join("\n"),
      "",
      "## Bridge Functions",
      "",
      bridgeFns.join("\n"),
      "",
      "## Current File",
      "",
      "```",
      (current?.content ?? "").slice(0, 80000),
      "```",
      "",
      "## Patch",
      "",
      "```diff",
      patch.slice(0, 80000),
      "```",
      "",
      "## Problems",
      "",
      problems.map((p) => `${p.severity} ${p.file ?? ""}:${p.line ?? ""} ${p.message}`).join("\n"),
      "",
      "## Activity",
      "",
      activity.slice(0, 240).join("\n"),
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

    await runCommand(`python3 - <<'PY'\nfrom pathlib import Path\nbody=${JSON.stringify(body)}\np=Path(".adjutorix/native-agent-context.md")\np.parent.mkdir(parents=True, exist_ok=True)\np.write_text(body)\nprint(p)\nPY`);
  }, [activity, addLog, agentText, allTools, bridgeFns, current, dirtyBuffers, patch, problems, root, runCommand, surfaceFiles]);

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
    const toolItems = allTools.map((t) => ({ label: t.label, detail: t.command, kind: t.group, run: () => runCommand(t.command) }));
    const fileItems = visible.slice(0, 500).map((f) => ({ label: relative(f.path, root), detail: f.group, kind: "file", run: () => openFile(f.path) }));
    const items = [...toolItems, ...fileItems];
    const q = paletteQ.trim().toLowerCase();
    return q ? items.filter((x) => `${x.label} ${x.detail} ${x.kind}`.toLowerCase().includes(q)) : items;
  }, [allTools, openFile, paletteQ, root, runCommand, visible]);

  const toolGrid = (group?: string) => {
    const list = group ? allTools.filter((t) => t.group === group) : allTools;

    return (
      <div className="v15-toolgrid">
        {list.map((t) => (
          <button key={`${t.id}-${t.command}`} className="v15-tool" onClick={() => runCommand(t.command)}>
            <strong>{t.label}</strong>
            <span>{t.group}</span>
            <code>{t.command}</code>
            <em>{t.source}</em>
          </button>
        ))}
      </div>
    );
  };

  const fileList = (list: any[]) => (
    <div className="v15-list">
      {list.map((f) => (
        <button key={f.path} className={selected === f.path ? "v15-file active" : "v15-file"} onClick={() => openFile(f.path)}>
          <span>{buffers[f.path]?.dirty ? "●" : "·"}</span>
          <b>{relative(f.path, root)}</b>
          <em>{f.group}</em>
        </button>
      ))}
    </div>
  );

  const leftPane = () => {
    if (left === "tools") {
      const groups = Array.from(new Set(allTools.map((t) => t.group))).sort();

      return (
        <div className="v15-stack">
          <button className="v15-primary" onClick={openCoreSurfaces}>Open core product surfaces</button>
          <button className="v15-primary" onClick={writeAgentContext}>Write full agent context pack</button>
          <div className="v15-domain-grid">
            {groups.map((g) => (
              <button key={g} onClick={() => setLeft(g)}>
                <span>{g}</span>
                <b>{allTools.filter((t) => t.group === g).length}</b>
              </button>
            ))}
          </div>
          {toolGrid()}
        </div>
      );
    }

    if (["agent", "verify", "patch", "ledger", "transaction", "governance", "workspace", "diagnostics", "recovery", "performance", "ci"].includes(left)) {
      return toolGrid(left);
    }

    if (left === "surfaces") {
      return (
        <div className="v15-stack">
          <div className="v15-domain-grid">
            {["surfaces", "agent", "shared", "orchestrator", "cli", "tests", "contracts"].map((g) => (
              <button key={g} onClick={() => setQuery(g === "surfaces" ? "packages/adjutorix-app/src/renderer" : g)}>
                <span>{g}</span>
                <b>{files.filter((f) => f.group === g || relative(f.path, root).includes(g)).length}</b>
              </button>
            ))}
          </div>
          {fileList(surfaceFiles.slice(0, 1000))}
        </div>
      );
    }

    if (left === "runtime") {
      return <div className="v15-runtime">{bridgeFns.map((f) => <button key={f}>{f}</button>)}</div>;
    }

    return fileList(visible);
  };

  const rightPane = () => {
    if (right === "outline") {
      return <div className="v15-cards">{outline.map((s) => <button key={`${s.line}-${s.name}`} onClick={() => editor.current?.revealLineInCenter?.(s.line)}><b>{s.kind}</b><span>{s.name}</span><em>line {s.line}</em></button>)}</div>;
    }

    if (right === "problems") {
      return <div className="v15-cards">{problems.length ? problems.map((p, i) => <button key={i} onClick={() => p.file && openFile(p.file)}><b className="bad">{p.severity}</b><span>{p.file ?? ""}:{p.line ?? ""}</span><em>{p.message}</em></button>) : <p>No parsed problems.</p>}</div>;
    }

    if (right === "patch") return <pre className="v15-pre">{patch}</pre>;

    if (right === "graph") {
      return <pre className="v15-pre">{[
        "IMPORTS",
        ...imports.map((x) => `${x.line}: ${x.text}`),
        "",
        "SYMBOLS",
        ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`),
        "",
        "DOMAIN COUNTS",
        ...Object.entries(domainCounts).sort().map(([k, v]) => `${k}: ${v}`),
      ].join("\n")}</pre>;
    }

    if (right === "agent") {
      return <div className="v15-agent"><textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} /><button className="v15-primary big" onClick={writeAgentContext}>Write context pack</button><pre>{activity.join("\n")}</pre></div>;
    }

    if (right === "runtime") return <div className="v15-runtime">{bridgeFns.map((f) => <button key={f}>{f}</button>)}</div>;

    if (right === "surfaces") return fileList(surfaceFiles.slice(0, 700));

    return (
      <div className="v15-inspector">
        <div className="v15-card root"><span>root</span><b>{root || "unknown"}</b></div>
        <section>
          <article><span>product files</span><b>{files.length}</b></article>
          <article><span>indexed</span><b>{entries.length}</b></article>
          <article><span>tools</span><b>{allTools.length}</b></article>
          <article><span>surfaces</span><b>{surfaceFiles.length}</b></article>
          <article><span>open</span><b>{openFiles.length}</b></article>
          <article><span>dirty</span><b>{dirtyBuffers.length}</b></article>
          <article><span>bridge</span><b>{bridgeFns.length}</b></article>
          <article><span>status</span><b>{busy ? "busy" : "live"}</b></article>
        </section>
        <div className="v15-card"><span>current</span><b>{current ? relative(current.path, root) : "none"}</b></div>
        <div className="v15-card">
          <span>active lanes</span>
          <p>Agent, Verify, Patch, Ledger, Transaction, Governance, Workspace, Diagnostics, Recovery, Performance, CI, Contracts, Renderer, Main, Preload, Shared, Orchestrator, CLI, Tests.</p>
        </div>
      </div>
    );
  };

  return (
    <div className="v15-shell">
      <header className="v15-top">
        <div className="v15-brand">{MARKER}</div>
        <button className="v15-palette-btn" onClick={() => setPalette(true)}>⌘P</button>
        <div className="v15-rootline">{root || "workspace root unknown"}</div>
        <div className="v15-spacer" />
        <label className="v15-check"><input type="checkbox" checked={includeGenerated} onChange={(e) => setIncludeGenerated(e.target.checked)} /> generated</label>
        <span className={busy ? "v15-live busy" : "v15-live"}>{busy ? "BUSY" : "LIVE"}</span>
        <button onClick={indexWorkspace}>Index</button>
        <button onClick={openCoreSurfaces}>Core</button>
        <button disabled={!current?.dirty} onClick={() => current && saveFile(current.path)}>Save</button>
        <button disabled={!dirtyBuffers.length} onClick={saveAll}>Save all</button>
      </header>

      <main className="v15-main">
        <nav className="v15-nav">
          {NAV.map(([id, label]) => <button key={id} className={left === id ? "active" : ""} onClick={() => setLeft(id)}>{label}</button>)}
        </nav>

        <aside className="v15-left">
          <div className="v15-left-head">
            <span>{left}</span>
            <b>{visible.length}/{files.length}</b>
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search tools, files, modules, buffers" />
          </div>
          <div className="v15-left-body">{leftPane()}</div>
        </aside>

        <section className="v15-center">
          <div className="v15-tabs">
            {openFiles.length ? openFiles.map((p) => (
              <button key={p} className={selected === p ? "active" : ""} onClick={() => setSelected(p)}>
                {buffers[p]?.dirty ? "● " : ""}{base(p)}
              </button>
            )) : <span>Open a source file.</span>}
          </div>

          <div className="v15-editor">
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
              <div className="v15-empty">No file selected.</div>
            )}
          </div>

          <div className="v15-bottom">
            <div className="v15-bottom-tabs">
              {["terminal", "output", "problems", "patch", "graph", "raw"].map((x) => <button key={x} className={bottom === x ? "active" : ""} onClick={() => setBottom(x)}>{x}</button>)}
            </div>

            {bottom === "terminal" && (
              <div className="v15-terminal">
                <div className="v15-runbar">
                  <input value={cmd} onChange={(e) => setCmd(e.target.value)} />
                  <button onClick={() => runCommand(cmd)}>Run</button>
                </div>
                <pre>{terminal}</pre>
              </div>
            )}

            {bottom === "output" && <pre className="v15-pre">{activity.join("\n")}</pre>}
            {bottom === "problems" && <pre className="v15-pre">{problems.map((p) => `${p.severity} ${p.file ?? ""}:${p.line ?? ""}:${p.column ?? ""} ${p.message}`).join("\n") || "No parsed problems."}</pre>}
            {bottom === "patch" && <pre className="v15-pre">{patch}</pre>}
            {bottom === "graph" && <pre className="v15-pre">{["IMPORTS", ...imports.map((x) => `${x.line}: ${x.text}`), "", "SYMBOLS", ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`)].join("\n")}</pre>}
            {bottom === "raw" && <pre className="v15-pre">{JSON.stringify({ lastResult, domainCounts, snapshots }, null, 2)}</pre>}
          </div>
        </section>

        <aside className="v15-right">
          <div className="v15-right-tabs">
            {RIGHT.map((x) => <button key={x} className={right === x ? "active" : ""} onClick={() => setRight(x)}>{x}</button>)}
          </div>
          <div className="v15-right-body">{rightPane()}</div>
        </aside>
      </main>

      {palette && (
        <div className="v15-overlay" onClick={() => setPalette(false)}>
          <div className="v15-palette" onClick={(e) => e.stopPropagation()}>
            <input autoFocus value={paletteQ} onChange={(e) => setPaletteQ(e.target.value)} placeholder="command, tool, script, file, module..." />
            <div>
              {paletteItems.slice(0, 120).map((item, i) => (
                <button key={`${item.kind}-${item.label}-${i}`} onClick={() => { item.run(); setPalette(false); setPaletteQ(""); }}>
                  <span>{item.label}</span>
                  <em>{item.kind}</em>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
