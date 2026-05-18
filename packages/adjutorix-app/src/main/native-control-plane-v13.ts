// @ts-nocheck
import { ipcMain } from "electron";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as path from "node:path";

const MARKER = "ADJUTORIX_NATIVE_CONTROL_PLANE_V13";
const MAX_FILE_BYTES = 1_500_000;
const MAX_COMMAND_BYTES = 8_000_000;

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", "__pycache__",
  ".pytest_cache", ".mypy_cache", ".ruff_cache", ".turbo", ".cache",
  ".vite", ".venv", "venv", "site-packages", "quarantine",
]);

const BINARY_RE = /\.(png|jpg|jpeg|gif|webp|icns|ico|woff|woff2|ttf|otf|zip|gz|tgz|pdf|mp4|mov|mp3|wav|sqlite|db|lock)$/i;

function workspaceRoot() {
  return path.resolve(process.env.ADJUTORIX_WORKSPACE_ROOT || process.cwd());
}

function insideRoot(inputPath: string) {
  const root = workspaceRoot();
  const resolved = path.resolve(root, String(inputPath || "."));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`path_outside_workspace:${inputPath}`);
  }
  return { root, resolved, relative: path.relative(root, resolved).replace(/\\/g, "/") || "." };
}

function safeTextBuffer(buf: Buffer, filePath: string) {
  if (BINARY_RE.test(filePath)) throw new Error(`binary_file_rejected:${filePath}`);
  const sample = buf.subarray(0, Math.min(buf.length, 8192));
  if (sample.includes(0)) throw new Error(`binary_file_rejected:${filePath}`);
  return buf.toString("utf8");
}

async function listFiles(root: string) {
  const out: any[] = [];
  async function walk(dir: string, depth: number) {
    if (out.length >= 5000 || depth > 9) return;
    let entries: any[] = [];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const ent of entries) {
      if (out.length >= 5000) break;
      if (IGNORE_DIRS.has(ent.name)) continue;

      const full = path.join(dir, ent.name);
      const rel = path.relative(root, full).replace(/\\/g, "/");

      if (ent.isDirectory()) {
        out.push({ path: rel, isDir: true, kind: "directory" });
        await walk(full, depth + 1);
        continue;
      }

      if (!ent.isFile()) continue;

      let stat = null;
      try { stat = await fs.stat(full); } catch {}
      out.push({
        path: rel,
        isDir: false,
        kind: "file",
        size: stat?.size ?? 0,
        binary: BINARY_RE.test(rel),
      });
    }
  }

  await walk(root, 0);
  return out;
}

function runShell(command: string, cwd: string, timeoutMs: number) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, {
      cwd,
      shell: true,
      env: { ...process.env, ADJUTORIX_WORKSPACE_ROOT: workspaceRoot() },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      try { child.kill("SIGTERM"); } catch {}
    }, timeoutMs);

    const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString("utf8");
      if (kind === "stdout") stdout += text;
      else stderr += text;

      if (stdout.length + stderr.length > MAX_COMMAND_BYTES) {
        stderr += "\n[adjutorix] command output truncated; process terminated.\n";
        try { child.kill("SIGTERM"); } catch {}
      }
    };

    child.stdout.on("data", (chunk) => append("stdout", chunk));
    child.stderr.on("data", (chunk) => append("stderr", chunk));

    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({
        ok: false,
        marker: MARKER,
        status: "spawn_error",
        command,
        cwd,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: String(error?.stack || error),
      });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      resolve({
        ok: exitCode === 0 && !killedByTimeout,
        marker: MARKER,
        status: killedByTimeout ? "timeout" : exitCode === 0 ? "ok" : "failed",
        command,
        cwd,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      });
    });
  });
}

function handle(channel: string, fn: Function) {
  try { ipcMain.removeHandler(channel); } catch {}
  ipcMain.handle(channel, async (_event, payload) => fn(payload || {}));
}

export function registerNativeControlPlaneV13() {
  const g = globalThis as any;
  if (g.__ADJUTORIX_NATIVE_CONTROL_PLANE_V13__) return;
  g.__ADJUTORIX_NATIVE_CONTROL_PLANE_V13__ = true;

  handle("adjutorix:v13:snapshot", async () => {
    const root = workspaceRoot();
    return {
      ok: true,
      marker: MARKER,
      root,
      cwd: process.cwd(),
      pid: process.pid,
      platform: process.platform,
      node: process.version,
      time: new Date().toISOString(),
    };
  });

  handle("adjutorix:v13:workspace:list", async () => {
    const root = workspaceRoot();
    const entries = await listFiles(root);
    return {
      ok: true,
      marker: MARKER,
      root,
      entries,
      files: entries.filter((e) => !e.isDir).length,
      directories: entries.filter((e) => e.isDir).length,
    };
  });

  handle("adjutorix:v13:file:read", async (payload) => {
    const target = payload.path || payload.filePath || payload.relativePath || ".";
    const { root, resolved, relative } = insideRoot(target);
    const stat = await fs.stat(resolved);
    if (stat.isDirectory()) throw new Error(`directory_read_rejected:${relative}`);
    if (stat.size > MAX_FILE_BYTES) throw new Error(`file_too_large:${relative}:${stat.size}`);
    const buf = await fs.readFile(resolved);
    const content = safeTextBuffer(buf, relative);
    return {
      ok: true,
      marker: MARKER,
      root,
      path: relative,
      absolutePath: resolved,
      size: stat.size,
      content,
    };
  });

  handle("adjutorix:v13:file:write", async (payload) => {
    const target = payload.path || payload.filePath || payload.relativePath;
    if (!target) throw new Error("missing_write_path");
    const content = String(payload.content ?? payload.text ?? payload.value ?? "");
    const { root, resolved, relative } = insideRoot(target);
    await fs.mkdir(path.dirname(resolved), { recursive: true });
    await fs.writeFile(resolved, content, "utf8");
    const stat = await fs.stat(resolved);
    return {
      ok: true,
      marker: MARKER,
      root,
      path: relative,
      absolutePath: resolved,
      bytes: stat.size,
    };
  });

  handle("adjutorix:v13:command:run", async (payload) => {
    const command = String(payload.command || payload.cmd || payload.intent || "").trim();
    if (!command) throw new Error("missing_command");
    const requestedCwd = String(payload.cwd || ".");
    const { resolved } = insideRoot(requestedCwd);
    const timeoutMs = Math.max(1000, Math.min(Number(payload.timeoutMs || 300000), 900000));
    return runShell(command, fssync.existsSync(resolved) ? resolved : workspaceRoot(), timeoutMs);
  });
}
