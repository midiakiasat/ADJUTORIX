#!/usr/bin/env node
/**
 * ADJUTORIX APP — scripts/build-renderer.mjs
 *
 * Deterministic renderer build pipeline (Vite + React) with:
 * - content-addressed outputs (stable hashing)
 * - manifest generation (asset graph, hashes, sizes)
 * - strict env gating (no implicit env leakage)
 * - CSP-compatible asset emission
 * - integrity (SRI) computation
 * - reproducibility guards (ordering, timestamps, locale)
 *
 * No placeholders. Pure, explicit, hermetic as far as Node allows.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ---------------------------------------------------------------------------
// CONSTANTS / PATHS
// ---------------------------------------------------------------------------

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src', 'renderer');
const DIST = path.join(ROOT, 'dist', 'renderer');
const MANIFEST_PATH = path.join(DIST, 'manifest.json');

// Determinism controls
process.env.TZ = 'UTC';
process.env.LC_ALL = 'C';
process.env.LANG = 'C';

// Allow-list of env vars that may affect the build (everything else stripped)
const ALLOWED_ENV = new Set([
  'NODE_ENV',
  'ADJUTORIX_BUILD_MODE',
  'ADJUTORIX_PUBLIC_PATH',
]);

// ---------------------------------------------------------------------------
// UTIL
// ---------------------------------------------------------------------------

function assert(cond, msg) {
  if (!cond) throw new Error(`build-renderer:${msg}`);
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readAllFiles(dir) {
  const out = [];
  function walk(d) {
    const entries = fs.readdirSync(d, { withFileTypes: true });
    // stable order
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.push(p);
    }
  }
  walk(dir);
  return out;
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function sri(buf) {
  const b64 = crypto.createHash('sha256').update(buf).digest('base64');
  return `sha256-${b64}`;
}

function stableJson(obj) {
  const norm = (x) => {
    if (x === null || typeof x !== 'object') return x;
    if (Array.isArray(x)) return x.map(norm);
    const keys = Object.keys(x).sort();
    const o = {};
    for (const k of keys) o[k] = norm(x[k]);
    return o;
  };
  return JSON.stringify(norm(obj));
}

function writeFileDeterministic(p, buf) {
  fs.writeFileSync(p, buf);
  // Normalize mtime/atime to zero epoch for reproducibility where supported
  try {
    const t = new Date(0);
    fs.utimesSync(p, t, t);
  } catch {}
}

function filterEnv(env) {
  const out = {};
  for (const k of Object.keys(env)) {
    if (ALLOWED_ENV.has(k)) out[k] = env[k];
  }
  return out;
}

// ---------------------------------------------------------------------------
// VITE BUILD (PROGRAMMATIC VIA CLI)
// ---------------------------------------------------------------------------

function runViteBuild() {
  return new Promise((resolve, reject) => {
    const env = {
      ...filterEnv(process.env),
      NODE_ENV: process.env.NODE_ENV || 'production',
    };

    const viteBin = path.join(ROOT, 'node_modules', '.bin', 'vite');

    const args = [
      'build',
      '--config', path.join(ROOT, 'vite.renderer.config.mjs'),
      '--mode', env.NODE_ENV,
      '--logLevel', 'error',
      '--emptyOutDir',
    ];

    const child = spawn(viteBin, args, {
      cwd: ROOT,
      env,
      stdio: 'inherit',
    });

    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`vite_failed:${code}`));
    });
  });
}

// ---------------------------------------------------------------------------
// MANIFEST GENERATION
// ---------------------------------------------------------------------------

function buildManifest() {
  assert(fs.existsSync(DIST), 'dist_missing');

  const files = readAllFiles(DIST);

  const assets = [];
  let totalBytes = 0;

  for (const abs of files) {
    const rel = path.relative(DIST, abs).replace(/\\/g, '/');
    const buf = fs.readFileSync(abs);

    const entry = {
      path: rel,
      bytes: buf.length,
      sha256: sha256(buf),
      sri: sri(buf),
      ext: path.extname(rel).slice(1),
    };

    totalBytes += buf.length;
    assets.push(entry);
  }

  // stable order
  assets.sort((a, b) => a.path.localeCompare(b.path, 'en'));

  const manifest = {
    schema: 1,
    generator: 'adjutorix.build-renderer',
    env: {
      node: process.version,
      mode: process.env.NODE_ENV || 'production',
    },
    counts: {
      files: assets.length,
      bytes: totalBytes,
    },
    assets,
  };

  const json = stableJson(manifest);
  writeFileDeterministic(MANIFEST_PATH, Buffer.from(json));

  return manifest;
}

// ---------------------------------------------------------------------------
// INTEGRITY CHECK
// ---------------------------------------------------------------------------

function verifyManifest(manifest) {
  for (const a of manifest.assets) {
    const abs = path.join(DIST, a.path);
    assert(fs.existsSync(abs), `missing_asset:${a.path}`);
    const buf = fs.readFileSync(abs);
    assert(buf.length === a.bytes, `size_mismatch:${a.path}`);
    assert(sha256(buf) === a.sha256, `hash_mismatch:${a.path}`);
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------

async function main() {
  const cmd = process.argv[2] || 'build';

  if (cmd === 'clean') {
    rmrf(DIST);
    return;
  }

  if (cmd === 'build') {
    rmrf(DIST);
    ensureDir(DIST);

    await runViteBuild();

    const manifest = buildManifest();
    verifyManifest(manifest);

    process.stdout.write(stableJson({ ok: true, manifest }) + '\n');
    return;
  }

  if (cmd === 'verify') {
    assert(fs.existsSync(MANIFEST_PATH), 'manifest_missing');
    const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
    verifyManifest(manifest);
    process.stdout.write(stableJson({ ok: true }) + '\n');
    return;
  }

  throw new Error('unknown_command');
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n');
  process.exit(1);
});
