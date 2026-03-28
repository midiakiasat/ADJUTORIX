#!/usr/bin/env node
/**
 * ADJUTORIX APP — scripts/smoke.js
 *
 * End-to-end desktop smoke harness for the Electron app.
 *
 * Scope:
 * - validates built artifacts exist and are internally consistent
 * - launches the Electron main process against the built app
 * - verifies preload API exposure contract
 * - verifies renderer bootstrap readiness
 * - exercises minimal IPC roundtrip(s)
 * - optionally checks Adjutorix agent reachability
 * - captures deterministic diagnostics and exits non-zero on any failure
 *
 * Design constraints:
 * - no placeholder probes
 * - fail-closed
 * - no hidden retries beyond explicit bounded polling
 * - deterministic ordering and stable JSON output
 *
 * Environment knobs:
 *   ADJUTORIX_SMOKE_TIMEOUT_MS       total timeout (default 30000)
 *   ADJUTORIX_SMOKE_AGENT_URL        optional agent URL to probe
 *   ADJUTORIX_SMOKE_HEADLESS         "1" to suppress UI assumptions where possible
 *   ADJUTORIX_SMOKE_KEEP_OPEN        "1" to keep app alive after success (debug only)
 *   ADJUTORIX_SMOKE_LOG_STDIO        "1" to echo app stdout/stderr live
 *
 * Usage:
 *   node ./scripts/smoke.js
 *
 * NO PLACEHOLDERS.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import https from 'node:https';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const DIST_MAIN = path.join(DIST, 'main.js');
const DIST_PRELOAD = path.join(DIST, 'preload.js');
const DIST_RENDERER = path.join(DIST, 'renderer');
const DIST_RENDERER_MANIFEST = path.join(DIST_RENDERER, 'manifest.json');
const DIST_RENDERER_ASSET_MANIFEST = path.join(DIST_RENDERER, 'assets', 'asset-manifest.json');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const TMP_DIR = path.join(ROOT, '.adjutorix-smoke');
const SMOKE_OUT = path.join(TMP_DIR, 'smoke-result.json');

const TOTAL_TIMEOUT_MS = Number.parseInt(process.env.ADJUTORIX_SMOKE_TIMEOUT_MS || '30000', 10);
const AGENT_URL = process.env.ADJUTORIX_SMOKE_AGENT_URL || '';
const KEEP_OPEN = process.env.ADJUTORIX_SMOKE_KEEP_OPEN === '1';
const LOG_STDIO = process.env.ADJUTORIX_SMOKE_LOG_STDIO === '1';
const HEADLESS = process.env.ADJUTORIX_SMOKE_HEADLESS === '1';

const REQUIRED_PRELOAD_KEYS = [
  'adjutorix',
];

const REQUIRED_ADJUTORIX_API_KEYS = [
  'rpc',
  'workspace',
  'patch',
  'verify',
  'ledger',
];

function assert(cond, msg) {
  if (!cond) throw new Error(`smoke:${msg}`);
}

function nowMs() {
  return Date.now();
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableJson(value) {
  const normalize = (v) => {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(normalize);
    const out = {};
    for (const k of Object.keys(v).sort()) out[k] = normalize(v[k]);
    return out;
  };
  return JSON.stringify(normalize(value), null, 2) + '\n';
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function existsFile(p) {
  return fs.existsSync(p) && fs.statSync(p).isFile();
}

function findElectronBinary() {
  const local = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'electron.cmd' : 'electron');
  if (existsFile(local)) return local;

  try {
    const mod = path.join(ROOT, 'node_modules', 'electron', 'index.js');
    if (existsFile(mod)) {
      const req = createRequireCompat(import.meta.url);
      const electronPath = req('electron');
      if (electronPath) return electronPath;
    }
  } catch {}

  throw new Error('smoke:electron_binary_not_found');
}

function createRequireCompat(base) {
  // Lazy inline compatibility without importing node:module globally
  // eslint-disable-next-line global-require
  const { createRequire } = require('node:module');
  return createRequire(base);
}

function verifyBuildArtifacts() {
  assert(existsFile(PACKAGE_JSON), 'package_json_missing');
  assert(existsFile(DIST_MAIN), 'dist_main_missing');
  assert(existsFile(DIST_PRELOAD), 'dist_preload_missing');
  assert(existsFile(DIST_RENDERER_MANIFEST), 'renderer_manifest_missing');
  assert(existsFile(DIST_RENDERER_ASSET_MANIFEST), 'renderer_asset_manifest_missing');

  const pkg = readJson(PACKAGE_JSON);
  assert(pkg.name, 'package_name_missing');

  const rendererManifest = readJson(DIST_RENDERER_MANIFEST);
  const assetManifest = readJson(DIST_RENDERER_ASSET_MANIFEST);

  assert(rendererManifest.assets || rendererManifest.counts || rendererManifest.schema, 'renderer_manifest_malformed');
  assert(Array.isArray(assetManifest.entries), 'asset_manifest_entries_missing');

  // Verify emitted asset hashes
  for (const entry of assetManifest.entries) {
    const p = path.join(DIST_RENDERER, 'assets', entry.path.replace(/^assets\//, ''));
    assert(existsFile(p), `asset_missing:${entry.path}`);
    const buf = fs.readFileSync(p);
    assert(buf.length === entry.bytes, `asset_size_mismatch:${entry.path}`);
    assert(sha256(buf) === entry.sha256, `asset_hash_mismatch:${entry.path}`);
  }

  return {
    packageName: pkg.name,
    rendererManifestSha256: sha256(fs.readFileSync(DIST_RENDERER_MANIFEST)),
    rendererAssetManifestSha256: sha256(fs.readFileSync(DIST_RENDERER_ASSET_MANIFEST)),
  };
}

function makeProbeScript(outFile) {
  // Executed inside Electron main process before app boot logic finalizes.
  // Captures preload exposure + DOM readiness via injected browser-window hooks.
  return `
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const electron = require('electron');
const { app, BrowserWindow, ipcMain } = electron;

const OUT = ${JSON.stringify(outFile)};
const RESULT = {
  started: false,
  appReady: false,
  windowsCreated: 0,
  domReady: false,
  rendererLoaded: false,
  preloadExposedKeys: [],
  adjutorixApiKeys: [],
  ipcRoundtrip: null,
  errors: [],
  timestamps: {},
};

function now() { return Date.now(); }
function flush() {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(RESULT, Object.keys(RESULT).sort(), 2));
  } catch (e) {
    // best effort only
  }
}
function recordError(e) {
  RESULT.errors.push(String(e && e.stack || e));
  flush();
}

process.on('uncaughtException', recordError);
process.on('unhandledRejection', recordError);

RESULT.started = true;
RESULT.timestamps.started = now();
flush();

ipcMain.handle('__adjutorix_smoke_ping__', async () => ({ ok: true, ts: now() }));

app.on('browser-window-created', (_evt, win) => {
  RESULT.windowsCreated += 1;
  flush();

  win.webContents.on('dom-ready', async () => {
    RESULT.domReady = true;
    RESULT.timestamps.domReady = now();
    try {
      const snapshot = await win.webContents.executeJavaScript(
        `(() => {
          const topKeys = Object.keys(window).sort();
          const hasAdjutorix = typeof window.adjutorix === 'object' && !!window.adjutorix;
          const adjutorixKeys = hasAdjutorix ? Object.keys(window.adjutorix).sort() : [];
          return {
            topKeys,
            hasAdjutorix,
            adjutorixKeys,
            title: document.title,
            readyState: document.readyState,
            bodyPresent: !!document.body,
          };
        })()`
      );
      RESULT.preloadExposedKeys = snapshot.hasAdjutorix ? ['adjutorix'] : [];
      RESULT.adjutorixApiKeys = snapshot.adjutorixKeys;
      RESULT.rendererLoaded = snapshot.readyState === 'complete' || snapshot.readyState === 'interactive';

      try {
        const roundtrip = await win.webContents.executeJavaScript(
          `window.adjutorix && window.adjutorix.rpc && typeof window.adjutorix.rpc.invoke === 'function'
            ? window.adjutorix.rpc.invoke('__adjutorix_smoke_ping__', {})
            : null`
        );
        RESULT.ipcRoundtrip = roundtrip;
      } catch (e) {
        RESULT.errors.push('ipc_roundtrip:' + String(e && e.message || e));
      }
    } catch (e) {
      RESULT.errors.push('dom_probe:' + String(e && e.message || e));
    }
    flush();
  });
});

app.whenReady().then(() => {
  RESULT.appReady = true;
  RESULT.timestamps.appReady = now();
  flush();
}).catch(recordError);

setInterval(flush, 100).unref();
`;
}

function spawnElectron(probeOutFile) {
  const electronBin = findElectronBinary();
  const probeScript = makeProbeScript(probeOutFile);
  const probeFile = path.join(TMP_DIR, 'electron-smoke-probe.cjs');
  fs.writeFileSync(probeFile, probeScript);

  const env = {
    ...process.env,
    NODE_ENV: 'production',
    ADJUTORIX_SMOKE_MODE: '1',
    ADJUTORIX_SMOKE_HEADLESS: HEADLESS ? '1' : '0',
    ADJUTORIX_SMOKE_PROBE_OUT: probeOutFile,
  };

  const args = [
    '--require', probeFile,
    ROOT,
  ];

  const child = spawn(electronBin, args, {
    cwd: ROOT,
    env,
    stdio: LOG_STDIO ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';

  if (!LOG_STDIO) {
    child.stdout?.on('data', (d) => { stdout += String(d); });
    child.stderr?.on('data', (d) => { stderr += String(d); });
  }

  return { child, getStdout: () => stdout, getStderr: () => stderr };
}

async function poll(predicate, timeoutMs, intervalMs = 100) {
  const deadline = nowMs() + timeoutMs;
  while (nowMs() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

function validateProbeResult(result) {
  assert(result.started === true, 'probe_not_started');
  assert(result.appReady === true, 'app_not_ready');
  assert(result.windowsCreated >= 1, 'no_window_created');
  assert(result.domReady === true, 'dom_not_ready');
  assert(result.rendererLoaded === true, 'renderer_not_loaded');
  assert(Array.isArray(result.preloadExposedKeys), 'preload_keys_missing');
  assert(Array.isArray(result.adjutorixApiKeys), 'adjutorix_api_keys_missing');

  for (const key of REQUIRED_PRELOAD_KEYS) {
    assert(result.preloadExposedKeys.includes(key), `missing_preload_key:${key}`);
  }

  for (const key of REQUIRED_ADJUTORIX_API_KEYS) {
    assert(result.adjutorixApiKeys.includes(key), `missing_adjutorix_api_key:${key}`);
  }

  assert(result.ipcRoundtrip && result.ipcRoundtrip.ok === true, 'ipc_roundtrip_failed');
  assert(Array.isArray(result.errors), 'probe_errors_missing');
  assert(result.errors.length === 0, `probe_errors_present:${result.errors.join('|')}`);
}

function httpRequest(url) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(u, { method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

async function probeAgent(url) {
  const res = await httpRequest(url);
  return {
    reachable: res.status >= 200 && res.status < 500,
    status: res.status,
    bodySha256: sha256(Buffer.from(res.body)),
  };
}

async function main() {
  ensureDir(TMP_DIR);
  const startedAt = nowMs();
  const buildInfo = verifyBuildArtifacts();

  const probeOutFile = path.join(TMP_DIR, 'probe-result.json');
  if (fs.existsSync(probeOutFile)) fs.unlinkSync(probeOutFile);

  const electron = spawnElectron(probeOutFile);

  let childExit = null;
  electron.child.on('exit', (code, signal) => {
    childExit = { code, signal };
  });

  try {
    const probeResult = await poll(() => {
      if (!fs.existsSync(probeOutFile)) return null;
      const parsed = JSON.parse(fs.readFileSync(probeOutFile, 'utf8'));
      if (parsed.domReady && parsed.appReady) return parsed;
      return null;
    }, TOTAL_TIMEOUT_MS, 150);

    assert(probeResult, 'probe_timeout');
    validateProbeResult(probeResult);

    let agent = null;
    if (AGENT_URL) {
      agent = await probeAgent(AGENT_URL);
      assert(agent.reachable === true, 'agent_unreachable');
    }

    const result = {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      build: buildInfo,
      probe: probeResult,
      agent,
      durationMs: nowMs() - startedAt,
      childExit,
      stdoutSha256: sha256(Buffer.from(electron.getStdout() || '')),
      stderrSha256: sha256(Buffer.from(electron.getStderr() || '')),
    };

    fs.writeFileSync(SMOKE_OUT, stableJson(result));
    process.stdout.write(stableJson(result));

    if (!KEEP_OPEN) {
      electron.child.kill('SIGTERM');
    }
    process.exit(0);
  } catch (err) {
    const failure = {
      ok: false,
      error: String(err && err.stack || err),
      durationMs: nowMs() - startedAt,
      childExit,
      stdoutSha256: sha256(Buffer.from(electron.getStdout() || '')),
      stderrSha256: sha256(Buffer.from(electron.getStderr() || '')),
    };

    try { fs.writeFileSync(SMOKE_OUT, stableJson(failure)); } catch {}
    try { electron.child.kill('SIGTERM'); } catch {}
    process.stderr.write(stableJson(failure));
    process.exit(1);
  }
}

main().catch((err) => {
  process.stderr.write(stableJson({ ok: false, error: String(err && err.stack || err) }));
  process.exit(1);
});
