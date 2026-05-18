// @ts-nocheck
import { BrowserWindow, dialog, ipcMain } from "electron";
import { exec as childExec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const OPEN_FOLDER = "adjutorix:v16:dialog:openFolder";
const SCAN = "adjutorix:v16:workspace:scan";
const READ = "adjutorix:v16:file:read";
const WRITE = "adjutorix:v16:file:write";
const EXECUTE = "adjutorix:v16:shell:execute";

const DEFAULT_MAX_ENTRIES = 25000;
const DEFAULT_MAX_READ_BYTES = 4 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 300000;

function defaultRoot(): string {
  return path.resolve(process.env.ADJUTORIX_WORKSPACE_ROOT || process.cwd());
}

function asRoot(input?: any): string {
  const raw = String(input?.root || defaultRoot());
  const root = path.resolve(raw);
  const stat = fs.statSync(root);
  if (!stat.isDirectory()) throw new Error("workspace_root_not_directory");
  return root;
}

function safeJoin(root: string, target: string): string {
  const abs = path.resolve(root, String(target || "."));
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error("workspace_escape_rejected");
  return abs;
}

function rel(root: string, abs: string): string {
  return path.relative(root, abs).replace(/\\/g, "/") || ".";
}

function ignored(relativePath: string, includeGenerated = false): boolean {
  const parts = relativePath.split(/[\\/]+/).filter(Boolean);
  if (parts.includes(".git")) return true;
  if (!includeGenerated) {
    const deny = new Set([
      "node_modules", "dist", "build", "coverage", "__pycache__",
      ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".cache", ".vite",
      ".venv", "venv", "site-packages", "quarantine",
    ]);
    if (parts.some((p) => deny.has(p))) return true;
    if (parts.includes(".adjutorix-release")) return true;
  }
  return false;
}

function binaryPath(p: string): boolean {
  return /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock|pyc)$/i.test(p);
}

function textLooksBinary(buffer: Buffer): boolean {
  const n = Math.min(buffer.length, 4096);
  for (let i = 0; i < n; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function scanRoot(input?: any) {
  const root = asRoot(input);
  const maxEntries = Number(input?.maxEntries || DEFAULT_MAX_ENTRIES);
  const includeGenerated = input?.includeGenerated === true;
  const entries: any[] = [];
  const stack = [root];

  while (stack.length && entries.length < maxEntries) {
    const dir = stack.pop()!;
    let children: string[] = [];
    try {
      children = fs.readdirSync(dir);
    } catch {
      continue;
    }

    children.sort();

    for (const name of children) {
      if (entries.length >= maxEntries) break;
      const abs = path.join(dir, name);
      const relativePath = rel(root, abs);
      if (ignored(relativePath, includeGenerated)) continue;

      let st: fs.Stats;
      try {
        st = fs.statSync(abs);
      } catch {
        continue;
      }

      const isDirectory = st.isDirectory();
      entries.push({
        path: relativePath,
        absolutePath: abs,
        relativePath,
        isDirectory,
        isDir: isDirectory,
        size: st.size,
        mtimeMs: st.mtimeMs,
      });

      if (isDirectory) stack.push(abs);
    }
  }

  return {
    ok: true,
    marker: "ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16",
    root,
    entries,
    truncated: entries.length >= maxEntries,
    maxEntries,
  };
}

function readFile(input?: any) {
  const root = asRoot(input);
  const relativePath = String(input?.path || input?.relativePath || "");
  const abs = safeJoin(root, relativePath);
  const st = fs.statSync(abs);

  if (st.isDirectory()) throw new Error("workspace_file_read_directory_rejected");
  if (st.size > Number(input?.maxBytes || DEFAULT_MAX_READ_BYTES)) throw new Error("workspace_file_read_too_large");
  if (binaryPath(abs)) throw new Error("workspace_file_read_binary_rejected");

  const buffer = fs.readFileSync(abs);
  if (textLooksBinary(buffer)) throw new Error("workspace_file_read_binary_rejected");

  return {
    ok: true,
    root,
    path: rel(root, abs),
    absolutePath: abs,
    content: buffer.toString("utf8"),
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function writeFile(input?: any) {
  const root = asRoot(input);
  const relativePath = String(input?.path || input?.relativePath || "");
  const abs = safeJoin(root, relativePath);
  const content = String(input?.content ?? input?.text ?? input?.value ?? "");

  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);

  const st = fs.statSync(abs);
  return {
    ok: true,
    root,
    path: rel(root, abs),
    absolutePath: abs,
    size: st.size,
    mtimeMs: st.mtimeMs,
  };
}

function execute(input?: any) {
  const root = asRoot(input);
  const command = String(input?.command || input?.intent || "");
  if (!command.trim()) throw new Error("empty_command");

  const timeoutMs = Number(input?.timeoutMs || DEFAULT_TIMEOUT_MS);
  const started = Date.now();

  return new Promise((resolve) => {
    childExec(
      command,
      {
        cwd: root,
        shell: "/bin/bash",
        timeout: timeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: {
          ...process.env,
          ADJUTORIX_WORKSPACE_ROOT: root,
        },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          status: error ? "failed" : "ok",
          exitCode: error && typeof error.code === "number" ? error.code : 0,
          signal: error?.signal ?? null,
          command,
          cwd: root,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          durationMs: Date.now() - started,
        });
      },
    );
  });
}

export function registerNativeExternalWorkspaceV16() {
  const g = globalThis as any;
  if (g.__ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16_REGISTERED__) return;
  g.__ADJUTORIX_NATIVE_EXTERNAL_WORKSPACE_V16_REGISTERED__ = true;

  ipcMain.handle(OPEN_FOLDER, async () => {
    const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
    const result = await dialog.showOpenDialog(win, {
      title: "Open workspace folder",
      properties: ["openDirectory"],
    });

    if (result.canceled || !result.filePaths[0]) return { ok: true, canceled: true };

    const root = path.resolve(result.filePaths[0]);
    return scanRoot({ root });
  });

  ipcMain.handle(SCAN, (_event, input) => scanRoot(input));
  ipcMain.handle(READ, (_event, input) => readFile(input));
  ipcMain.handle(WRITE, (_event, input) => writeFile(input));
  ipcMain.handle(EXECUTE, (_event, input) => execute(input));
}
