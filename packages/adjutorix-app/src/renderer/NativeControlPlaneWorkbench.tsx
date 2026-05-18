// @ts-nocheck
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Editor from "@monaco-editor/react";

const MARKER = "ADJUTORIX_NATIVE_CONTROL_PLANE_WORKBENCH_V13";

const TASKS = [
  ["doctor", "Doctor", "echo ADJUTORIX_DOCTOR && pwd && node -v && pnpm -v && git branch --show-current && git rev-parse --short HEAD && git status --short | head -160"],
  ["build", "Build app", "pnpm --filter @adjutorix/app run build"],
  ["typecheck", "Typecheck", "pnpm --filter @adjutorix/app exec tsc -p tsconfig.json --noEmit --pretty false"],
  ["verify", "Verify", "pnpm run verify"],
  ["test", "Test", "pnpm test"],
  ["debt", "Debt scan", "rg -n \"TODO|FIXME|bridge unavailable|not implemented|placeholder|mock|stub|toy|launcher\" packages configs scripts src 2>/dev/null | head -400"],
  ["diff", "Diff", "git diff --stat && echo && git diff --name-only && echo && git diff | head -900"],
  ["timeline", "Timeline", "git log --oneline --decorate --graph --max-count=100"],
  ["map", "Repo map", "find packages configs scripts src -maxdepth 5 -type f 2>/dev/null | sort | head -1600"],
];

const BINARY = /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock)$/i;

function native() {
  const w = window as any;
  const api = w.adjutorixNativeV13;
  if (!api) throw new Error("ADJUTORIX_NATIVE_V13_BRIDGE_MISSING");
  return api;
}

function slash(s: string) {
  return String(s || "").replace(/\\/g, "/").replace(/\/+/g, "/").replace(/^\.\//, "");
}

function base(s: string) {
  const p = slash(s).split("/").filter(Boolean);
  return p[p.length - 1] || s;
}

function lang(path: string) {
  const p = path.toLowerCase();
  if (p.endsWith(".tsx") || p.endsWith(".ts")) return "typescript";
  if (p.endsWith(".jsx") || p.endsWith(".js") || p.endsWith(".mjs") || p.endsWith(".cjs")) return "javascript";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".sh") || p.endsWith(".bash") || p.endsWith(".zsh")) return "shell";
  if (p.endsWith(".json") || p.endsWith(".jsonl")) return "json";
  if (p.endsWith(".md") || p.endsWith(".mdx")) return "markdown";
  if (p.endsWith(".yml") || p.endsWith(".yaml")) return "yaml";
  if (p.endsWith(".css")) return "css";
  if (p.endsWith(".html")) return "html";
  if (p.endsWith(".toml")) return "toml";
  return "plaintext";
}

function rank(path: string) {
  const p = slash(path).toLowerCase();
  let s = 0;
  if (p.includes("packages/adjutorix-app/src/renderer/")) s += 900000;
  if (p.includes("packages/adjutorix-app/src/preload/")) s += 850000;
  if (p.includes("packages/adjutorix-app/src/main/")) s += 840000;
  if (p.includes("packages/adjutorix-agent/")) s += 760000;
  if (p.includes("configs/")) s += 300000;
  if (p.includes("scripts/")) s += 250000;
  if (p.includes("tests/")) s += 200000;
  if (p.endsWith(".tsx")) s += 20000;
  if (p.endsWith(".ts")) s += 18000;
  if (p.endsWith(".py")) s += 16000;
  if (p.endsWith(".json")) s += 12000;
  if (p.endsWith(".md")) s += 9000;
  if (p.endsWith(".log")) s -= 250000;
  return s - p.length;
}

function symbols(text: string) {
  const out: any[] = [];
  const rules = [
    [/^\s*export\s+default\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*export\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*async\s+function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*function\s+([A-Za-z0-9_$]+)/, "function"],
    [/^\s*class\s+([A-Za-z0-9_$]+)/, "class"],
    [/^\s*const\s+([A-Za-z0-9_$]+)\s*=/, "const"],
    [/^\s*def\s+([A-Za-z0-9_]+)/, "function"],
    [/^\s*#{1,6}\s+(.+)/, "section"],
  ];
  text.split(/\r?\n/).forEach((line, idx) => {
    for (const [re, kind] of rules) {
      const m = line.match(re);
      if (m) {
        out.push({ kind, name: m[1], line: idx + 1 });
        break;
      }
    }
  });
  return out.slice(0, 300);
}

function imports(text: string) {
  return text.split(/\r?\n/)
    .map((line, i) => ({ line: i + 1, text: line.trim() }))
    .filter((x) => /^(import|from\s+\S+\s+import|const\s+\S+\s*=\s*require\()/.test(x.text))
    .slice(0, 200);
}

function parseProblems(text: string) {
  const out: any[] = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    let m = line.match(/^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/);
    if (m) {
      out.push({ severity: "error", file: slash(m[1]), line: Number(m[2]), message: `${m[4]} ${m[5]}` });
      continue;
    }
    m = line.match(/^(.+?):(\d+):(\d+):\s+(error|warning):\s+(.+)$/i);
    if (m) out.push({ severity: m[4].toLowerCase(), file: slash(m[1]), line: Number(m[2]), message: m[5] });
  }
  return out.slice(0, 500);
}

function patchOf(a: string, b: string) {
  if (a === b) return "No patch.";
  const aa = a.split(/\r?\n/);
  const bb = b.split(/\r?\n/);
  const out = ["--- original", "+++ current"];
  for (let i = 0; i < Math.max(aa.length, bb.length); i++) {
    if (aa[i] !== bb[i]) {
      if (aa[i] !== undefined) out.push(`-${String(i + 1).padStart(4, " ")} ${aa[i]}`);
      if (bb[i] !== undefined) out.push(`+${String(i + 1).padStart(4, " ")} ${bb[i]}`);
      if (out.length > 900) {
        out.push("[patch truncated]");
        break;
      }
    }
  }
  return out.join("\n");
}

export default function NativeControlPlaneWorkbench() {
  const [root, setRoot] = useState("");
  const [files, setFiles] = useState<any[]>([]);
  const [buffers, setBuffers] = useState<Record<string, any>>({});
  const [open, setOpen] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [left, setLeft] = useState("explorer");
  const [right, setRight] = useState("inspector");
  const [bottom, setBottom] = useState("terminal");
  const [query, setQuery] = useState("");
  const [cmd, setCmd] = useState(TASKS[1][2]);
  const [run, setRun] = useState<any>(null);
  const [history, setHistory] = useState<any[]>([]);
  const [problems, setProblems] = useState<any[]>([]);
  const [activity, setActivity] = useState<string[]>([]);
  const [palette, setPalette] = useState(false);
  const [paletteQ, setPaletteQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [agentText, setAgentText] = useState("Inspect current state. Produce the next concrete patch. Run build and gates.");
  const editor = useRef<any>(null);

  const current = selected ? buffers[selected] : null;
  const dirty = Object.values(buffers).filter((b: any) => b.dirty).length;

  const log = useCallback((msg: string) => {
    setActivity((p) => [`${new Date().toLocaleTimeString()}  ${msg}`, ...p].slice(0, 500));
  }, []);

  const indexed = useMemo(() => {
    return files
      .filter((f) => !f.isDir && !f.binary && !BINARY.test(f.path))
      .sort((a, b) => rank(b.path) - rank(a.path));
  }, [files]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return indexed.slice(0, 1000);
    return indexed.filter((f) => {
      const p = f.path.toLowerCase();
      const body = String(buffers[f.path]?.content || "").toLowerCase();
      return p.includes(q) || body.includes(q);
    }).slice(0, 1000);
  }, [indexed, query, buffers]);

  const outline = useMemo(() => symbols(current?.content || ""), [current?.content]);
  const imps = useMemo(() => imports(current?.content || ""), [current?.content]);
  const diff = useMemo(() => current ? patchOf(current.original, current.content) : "No file.", [current]);

  const index = useCallback(async () => {
    setBusy(true);
    try {
      const snap = await native().snapshot();
      const tree = await native().listWorkspace();
      setRoot(snap.root || tree.root || "");
      setFiles((tree.entries || []).map((e: any) => ({ ...e, path: slash(e.path) })));
      log(`INDEX files=${tree.files} dirs=${tree.directories} root=${snap.root}`);
    } catch (e) {
      log(`INDEX FAILED ${String(e)}`);
      setRun({ status: "bridge_error", stderr: String(e), stdout: "", command: "index", durationMs: 0 });
    } finally {
      setBusy(false);
    }
  }, [log]);

  const runCommand = useCallback(async (command: string) => {
    const c = command.trim();
    if (!c) return;
    setBusy(true);
    setBottom("terminal");
    const start = { command: c, status: "running", stdout: "", stderr: "", durationMs: 0 };
    setRun(start);
    log(`RUN ${c}`);
    try {
      const result = await native().runCommand({ command: c, cwd: ".", timeoutMs: 600000 });
      setRun(result);
      setHistory((h) => [result, ...h].slice(0, 100));
      const parsed = parseProblems(`${result.stderr || ""}\n${result.stdout || ""}`);
      setProblems(parsed);
      if (parsed.length) setRight("problems");
      log(`DONE status=${result.status} exit=${result.exitCode} duration=${result.durationMs}ms`);
    } catch (e) {
      const fail = { command: c, status: "bridge_error", stdout: "", stderr: String(e), durationMs: 0, ok: false };
      setRun(fail);
      setHistory((h) => [fail, ...h].slice(0, 100));
      log(`FAIL ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }, [log]);

  const openFile = useCallback(async (path: string) => {
    const p = slash(path);
    try {
      const payload = await native().readFile({ path: p });
      const buf = {
        path: slash(payload.path),
        content: payload.content || "",
        original: payload.content || "",
        language: lang(payload.path),
        dirty: false,
      };
      setBuffers((b) => ({ ...b, [buf.path]: buf }));
      setOpen((o) => Array.from(new Set([...o, buf.path])));
      setSelected(buf.path);
      log(`OPEN ${buf.path}`);
    } catch (e) {
      log(`OPEN FAILED ${p} ${String(e)}`);
      setRun({ command: `open ${p}`, status: "open_failed", stdout: "", stderr: String(e), durationMs: 0 });
      setBottom("terminal");
    }
  }, [log]);

  const saveFile = useCallback(async (path: string) => {
    const b = buffers[path];
    if (!b) return;
    try {
      const result = await native().writeFile({ path, content: b.content });
      setBuffers((prev) => ({ ...prev, [path]: { ...b, original: b.content, dirty: false } }));
      log(`SAVE ${result.path} bytes=${result.bytes}`);
    } catch (e) {
      log(`SAVE FAILED ${path} ${String(e)}`);
    }
  }, [buffers, log]);

  const saveAll = useCallback(async () => {
    for (const b of Object.values(buffers).filter((x: any) => x.dirty)) await saveFile((b as any).path);
  }, [buffers, saveFile]);

  const writeAgent = useCallback(async () => {
    const content = [
      "# ADJUTORIX V13 Agent Context",
      "",
      `marker=${MARKER}`,
      `root=${root}`,
      `current=${current?.path || "none"}`,
      `dirty=${Object.values(buffers).filter((b: any) => b.dirty).map((b: any) => b.path).join(",") || "none"}`,
      `intent=${agentText}`,
      "",
      "## Patch",
      "```diff",
      diff.slice(0, 40000),
      "```",
      "",
      "## Problems",
      ...problems.map((p) => `- ${p.severity} ${p.file || ""}:${p.line || ""} ${p.message}`),
      "",
      "## Current file",
      "```",
      String(current?.content || "").slice(0, 50000),
      "```",
      "",
      "## Activity",
      ...activity.slice(0, 200),
    ].join("\n");

    try {
      await native().writeFile({ path: ".adjutorix/native-agent-context.md", content });
      log("AGENT CONTEXT WRITTEN .adjutorix/native-agent-context.md");
      setRight("agent");
    } catch (e) {
      log(`AGENT CONTEXT FAILED ${String(e)}`);
    }
  }, [activity, agentText, buffers, current, diff, log, problems, root]);

  useEffect(() => {
    index().then(() => runCommand(TASKS[0][2]));
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        e.preventDefault();
        setPalette(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.shiftKey ? saveAll() : selected && saveFile(selected);
      }
      if (e.key === "Escape") setPalette(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [saveAll, saveFile, selected]);

  const paletteItems = useMemo(() => {
    const taskItems = TASKS.map(([id, label, command]) => ({ label, kind: id, run: () => { setCmd(command); runCommand(command); } }));
    const fileItems = visible.slice(0, 160).map((f) => ({ label: f.path, kind: "file", run: () => openFile(f.path) }));
    const all = [...taskItems, ...fileItems];
    const q = paletteQ.toLowerCase().trim();
    return q ? all.filter((x) => x.label.toLowerCase().includes(q) || x.kind.toLowerCase().includes(q)) : all;
  }, [visible, paletteQ, openFile, runCommand]);

  const leftPane = () => {
    if (left === "commands" || left === "tasks" || left === "run") {
      return <div className="v13-list">{TASKS.map(([id, label, command]) => (
        <button key={id} className="v13-task" onClick={() => { setCmd(command); runCommand(command); }}>
          <b>{label}</b><em>{id}</em><code>{command}</code>
        </button>
      ))}</div>;
    }
    if (left === "scm") {
      return <div className="v13-list">{TASKS.filter(([id]) => ["diff", "timeline"].includes(id)).map(([id, label, command]) => (
        <button key={id} className="v13-task" onClick={() => { setCmd(command); runCommand(command); }}>
          <b>{label}</b><code>{command}</code>
        </button>
      ))}</div>;
    }
    if (left === "agent") {
      return <div className="v13-agent"><textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} /><button onClick={writeAgent}>Write agent context</button></div>;
    }
    return <div className="v13-list">{visible.map((f) => (
      <button key={f.path} className={selected === f.path ? "v13-file active" : "v13-file"} onClick={() => openFile(f.path)}>
        <span>{buffers[f.path]?.dirty ? "●" : "·"}</span>{f.path}
      </button>
    ))}</div>;
  };

  const rightPane = () => {
    if (right === "outline") return <div className="v13-cards">{outline.map((s) => <button key={`${s.line}-${s.name}`} onClick={() => editor.current?.revealLineInCenter?.(s.line)}><b>{s.kind}</b><span>{s.name}</span><em>line {s.line}</em></button>)}</div>;
    if (right === "problems") return <div className="v13-cards">{problems.length ? problems.map((p, i) => <button key={i} onClick={() => p.file && openFile(p.file)}><b className="bad">{p.severity}</b><span>{p.file}:{p.line}</span><em>{p.message}</em></button>) : <p>No parsed problems.</p>}</div>;
    if (right === "patch") return <pre className="v13-pre">{diff}</pre>;
    if (right === "graph") {
      const graphText = [
        "IMPORTS",
        ...imps.map((x) => `${x.line}: ${x.text}`),
        "",
        "SYMBOLS",
        ...outline.map((x) => `${x.line}: ${x.kind} ${x.name}`),
      ].join("\\n");
      return <pre className="v13-pre">{graphText}</pre>;
    }
    if (right === "agent") return <div className="v13-agent"><textarea value={agentText} onChange={(e) => setAgentText(e.target.value)} /><button onClick={writeAgent}>Write agent context</button><pre>{activity.join("\n")}</pre></div>;
    return <div className="v13-inspector">
      <div><span>root</span><b>{root}</b></div>
      <section><article><span>files</span><b>{indexed.length}</b></article><article><span>open</span><b>{open.length}</b></article><article><span>dirty</span><b>{dirty}</b></article><article><span>status</span><b>{busy ? "busy" : "live"}</b></article></section>
      <div><span>current</span><b>{current?.path || "none"}</b></div>
    </div>;
  };

  const terminal = run || { command: "", status: "booting", stdout: "V13 native control plane boots by running Doctor automatically.", stderr: "", durationMs: 0 };

  return <div className="v13-root">
    <header className="v13-top">
      <b>{MARKER}</b>
      <button onClick={() => setPalette(true)}>⌘P</button>
      <span>{root || "booting native control plane..."}</span>
      <i>{busy ? "BUSY" : "LIVE"}</i>
      <button onClick={index}>Index</button>
      <button disabled={!current?.dirty} onClick={() => current && saveFile(current.path)}>Save</button>
      <button disabled={!dirty} onClick={saveAll}>Save all</button>
    </header>

    <main className="v13-main">
      <nav>{[["explorer","EX"],["search","SE"],["commands","CM"],["scm","SC"],["tasks","TK"],["agent","AG"]].map(([id,l]) => <button key={id} className={left===id?"active":""} onClick={() => setLeft(id)}>{l}</button>)}</nav>

      <aside className="v13-left">
        <div className="v13-search">
          <strong>{left}</strong><em>{visible.length}/{indexed.length}</em>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="search files and buffers" />
          {left === "search" && <button onClick={() => runCommand(`rg -n "${query.replace(/"/g, '\\"')}" packages configs scripts src 2>/dev/null | head -400`)}>Run grep</button>}
        </div>
        {leftPane()}
      </aside>

      <section className="v13-work">
        <div className="v13-tabs">{open.length ? open.map((p) => <button key={p} className={selected===p?"active":""} onClick={() => setSelected(p)}>{buffers[p]?.dirty ? "● " : ""}{base(p)}</button>) : <span>Open a source file.</span>}</div>
        <div className="v13-editor">{current ? <Editor height="100%" theme="vs-dark" path={current.path} language={current.language} value={current.content} onMount={(ed) => { editor.current = ed; }} options={{ automaticLayout: true, fontSize: 14, minimap: { enabled: true }, scrollBeyondLastLine: false }} onChange={(value) => {
          const next = value || "";
          setBuffers((prev) => ({ ...prev, [current.path]: { ...prev[current.path], content: next, dirty: next !== prev[current.path].original } }));
        }} /> : <div className="v13-empty">No file selected.</div>}</div>

        <div className="v13-bottom">
          <div>{["terminal","output","problems","patch","graph"].map((id) => <button key={id} className={bottom===id?"active":""} onClick={() => setBottom(id)}>{id}</button>)}</div>
          {bottom === "terminal" && <section className="v13-terminal"><form onSubmit={(e) => { e.preventDefault(); runCommand(cmd); }}><input value={cmd} onChange={(e) => setCmd(e.target.value)} /><button>Run</button></form><pre>{`$ ${terminal.command}\nstatus=${terminal.status} exit=${terminal.exitCode ?? ""} duration=${terminal.durationMs || 0}ms\n\n${terminal.stdout || ""}${terminal.stderr ? `\n\n[stderr]\n${terminal.stderr}` : ""}`}</pre></section>}
          {bottom === "output" && <pre className="v13-pre">{activity.join("\n")}</pre>}
          {bottom === "problems" && <div className="v13-cards">{problems.map((p, i) => <button key={i} onClick={() => p.file && openFile(p.file)}><b className="bad">{p.severity}</b><span>{p.file}:{p.line}</span><em>{p.message}</em></button>)}</div>}
          {bottom === "patch" && <pre className="v13-pre">{diff}</pre>}
          {bottom === "graph" && <pre className="v13-pre">{JSON.stringify({ imports: imps, symbols: outline, history: history.slice(0, 10) }, null, 2)}</pre>}
        </div>
      </section>

      <aside className="v13-right">
        <div>{["inspector","outline","problems","patch","graph","agent"].map((id) => <button key={id} className={right===id?"active":""} onClick={() => setRight(id)}>{id}</button>)}</div>
        {rightPane()}
      </aside>
    </main>

    {palette && <div className="v13-modal" onMouseDown={() => setPalette(false)}><section onMouseDown={(e) => e.stopPropagation()}><input autoFocus value={paletteQ} onChange={(e) => setPaletteQ(e.target.value)} placeholder="command or file..." onKeyDown={(e) => { if (e.key === "Enter" && paletteItems[0]) { paletteItems[0].run(); setPalette(false); } }} />{paletteItems.slice(0, 100).map((x, i) => <button key={i} onClick={() => { x.run(); setPalette(false); }}><span>{x.label}</span><em>{x.kind}</em></button>)}</section></div>}
  </div>;
}
