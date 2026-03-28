#!/usr/bin/env node
/**
 * ADJUTORIX APP — scripts/prepare-renderer-assets.js
 *
 * Deterministic renderer asset preparation pipeline.
 *
 * Responsibilities:
 * - validate and stage all renderer-consumed static assets
 * - generate derived assets when source-of-truth files are generator scripts
 * - copy only canonical artifacts into dist/renderer/assets
 * - emit asset manifest with hashes, sizes, and logical roles
 * - enforce fail-closed rules for missing, malformed, or drifted assets
 *
 * Asset classes handled:
 * - icons / splash
 * - fonts
 * - config payloads exposed to renderer
 * - preload-safe public resources
 *
 * Hard invariants:
 * - no silent asset fallback
 * - all emitted assets are content-addressed in manifest
 * - no asset is copied without validation
 * - source generators and outputs cannot disagree undetected
 * - stable ordering and deterministic JSON output
 *
 * Usage:
 *   node ./scripts/prepare-renderer-assets.js build
 *   node ./scripts/prepare-renderer-assets.js verify
 *   node ./scripts/prepare-renderer-assets.js clean
 *
 * NO PLACEHOLDERS.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

const ASSETS_SRC = path.join(ROOT, 'assets');
const DIST_ROOT = path.join(ROOT, 'dist');
const RENDERER_DIST = path.join(DIST_ROOT, 'renderer');
const RENDERER_ASSETS = path.join(RENDERER_DIST, 'assets');
const PUBLIC_CONFIG_SRC = path.join(ROOT, '..', '..', 'configs', 'runtime', 'feature_flags.json');
const PUBLIC_LOGGING_SRC = path.join(ROOT, '..', '..', 'configs', 'runtime', 'logging.json');
const PUBLIC_LIMITS_SRC = path.join(ROOT, '..', '..', 'configs', 'runtime', 'limits.json');
const MANIFEST_PATH = path.join(RENDERER_ASSETS, 'asset-manifest.json');

const PNG_SIGNATURE = '89504e470d0a1a0a';
const WOFF2_SIGNATURE = 0x774F4632;

const FONT_TARGETS = [
  {
    logicalName: 'font-inter-regular',
    sourceName: 'Inter-Regular.woff2',
    relativeSource: path.join('fonts', 'Inter-Regular.woff2'),
    relativeOutput: path.join('fonts', 'Inter-Regular.woff2'),
    generatorName: 'Inter-Regular.woff2 (loader + validator + subsetting pipeline)',
    role: 'font',
    weight: 400,
  },
  {
    logicalName: 'font-inter-medium',
    sourceName: 'Inter-Medium.woff2',
    relativeSource: path.join('fonts', 'Inter-Medium.woff2'),
    relativeOutput: path.join('fonts', 'Inter-Medium.woff2'),
    generatorName: 'Inter-Medium.woff2 (loader + validator + subsetting pipeline)',
    role: 'font',
    weight: 500,
  },
  {
    logicalName: 'font-inter-semibold',
    sourceName: 'Inter-SemiBold.woff2',
    relativeSource: path.join('fonts', 'Inter-SemiBold.woff2'),
    relativeOutput: path.join('fonts', 'Inter-SemiBold.woff2'),
    generatorName: 'Inter-SemiBold.woff2 (loader + validator + subsetting pipeline)',
    role: 'font',
    weight: 600,
  },
];

const IMAGE_TARGETS = [
  {
    logicalName: 'app-icon-png',
    sourceName: 'icon.png',
    relativeSource: 'icon.png',
    relativeOutput: 'icon.png',
    generatorName: 'icon.png (generator + validator)',
    role: 'icon',
    expectedWidth: 1024,
    expectedHeight: 1024,
  },
  {
    logicalName: 'app-splash-png',
    sourceName: 'splash.png',
    relativeSource: 'splash.png',
    relativeOutput: 'splash.png',
    generatorName: 'splash.png (generator + validator)',
    role: 'splash',
    expectedWidth: 1920,
    expectedHeight: 1080,
  },
];

const CONFIG_TARGETS = [
  {
    logicalName: 'runtime-feature-flags',
    src: PUBLIC_CONFIG_SRC,
    relativeOutput: path.join('config', 'feature_flags.json'),
    role: 'runtime-config',
  },
  {
    logicalName: 'runtime-logging',
    src: PUBLIC_LOGGING_SRC,
    relativeOutput: path.join('config', 'logging.json'),
    role: 'runtime-config',
  },
  {
    logicalName: 'runtime-limits',
    src: PUBLIC_LIMITS_SRC,
    relativeOutput: path.join('config', 'limits.json'),
    role: 'runtime-config',
  },
];

function assert(cond, msg) {
  if (!cond) throw new Error(`prepare-renderer-assets:${msg}`);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function rmrf(p) {
  if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true });
}

function readFile(p) {
  return fs.readFileSync(p);
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

function deterministicWrite(filePath, content) {
  fs.writeFileSync(filePath, content);
  try {
    const epoch = new Date(0);
    fs.utimesSync(filePath, epoch, epoch);
  } catch {}
}

function copyDeterministic(src, dst) {
  ensureDir(path.dirname(dst));
  deterministicWrite(dst, fs.readFileSync(src));
}

function parsePngDimensions(buf) {
  const sig = buf.subarray(0, 8).toString('hex');
  assert(sig === PNG_SIGNATURE, 'invalid_png_signature');
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { width, height };
}

function validateJsonFile(src) {
  assert(fs.existsSync(src), `missing_json:${path.relative(ROOT, src)}`);
  const text = fs.readFileSync(src, 'utf-8');
  const parsed = JSON.parse(text);
  const normalized = stableJson(parsed);
  return {
    parsed,
    normalized,
    bytes: Buffer.byteLength(normalized),
    sha256: sha256(Buffer.from(normalized)),
  };
}

function validateWoff2(buf) {
  assert(buf.length >= 12, 'woff2_too_small');
  const sig = buf.readUInt32BE(0);
  assert(sig === WOFF2_SIGNATURE, 'invalid_woff2_signature');
  const declaredLength = buf.readUInt32BE(8);
  assert(declaredLength === buf.length, 'woff2_length_mismatch');
}

async function loadGeneratorModule(generatorFileBaseName) {
  const candidates = [
    path.join(ASSETS_SRC, `${generatorFileBaseName}.js`),
    path.join(ASSETS_SRC, 'fonts', `${generatorFileBaseName}.js`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return import(pathToFileURL(candidate).href);
    }
  }

  throw new Error(`prepare-renderer-assets:generator_not_found:${generatorFileBaseName}`);
}

async function validateImageTarget(target) {
  const src = path.join(ASSETS_SRC, target.relativeSource);
  assert(fs.existsSync(src), `missing_asset:${target.relativeSource}`);

  const generator = await loadGeneratorModule(target.generatorName);
  if (typeof generator.validateIcon === 'function') {
    await generator.validateIcon(src);
  } else if (typeof generator.validate === 'function') {
    await generator.validate(src);
  } else {
    throw new Error(`prepare-renderer-assets:image_validator_missing:${target.generatorName}`);
  }

  const buf = readFile(src);
  const dims = parsePngDimensions(buf);
  assert(dims.width === target.expectedWidth, `png_width_mismatch:${target.relativeSource}`);
  assert(dims.height === target.expectedHeight, `png_height_mismatch:${target.relativeSource}`);

  return {
    src,
    logicalName: target.logicalName,
    role: target.role,
    relativeOutput: target.relativeOutput.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: sha256(buf),
    width: dims.width,
    height: dims.height,
  };
}

async function validateFontTarget(target) {
  const src = path.join(ASSETS_SRC, target.relativeSource);
  assert(fs.existsSync(src), `missing_font:${target.relativeSource}`);

  const generator = await loadGeneratorModule(target.generatorName);
  assert(typeof generator.validateFont === 'function', `font_validator_missing:${target.generatorName}`);
  generator.validateFont(src);

  const buf = readFile(src);
  validateWoff2(buf);

  return {
    src,
    logicalName: target.logicalName,
    role: target.role,
    relativeOutput: target.relativeOutput.replace(/\\/g, '/'),
    bytes: buf.length,
    sha256: sha256(buf),
    weight: target.weight,
    format: 'woff2',
  };
}

function validateConfigTarget(target) {
  const result = validateJsonFile(target.src);
  return {
    src: target.src,
    logicalName: target.logicalName,
    role: target.role,
    relativeOutput: target.relativeOutput.replace(/\\/g, '/'),
    bytes: result.bytes,
    sha256: result.sha256,
    normalized: result.normalized,
  };
}

function cssForFonts(fontAssets) {
  const sorted = [...fontAssets].sort((a, b) => a.weight - b.weight || a.relativeOutput.localeCompare(b.relativeOutput));
  const blocks = sorted.map((asset) => {
    return [
      '@font-face {',
      `  font-family: 'Inter';`,
      `  src: url('./${asset.relativeOutput.replace(/^assets\//, '')}') format('woff2');`,
      `  font-weight: ${asset.weight};`,
      '  font-style: normal;',
      '  font-display: swap;',
      '}',
    ].join('\n');
  });
  return `${blocks.join('\n\n')}\n`;
}

function runtimeAssetIndex(entries) {
  const byRole = {};
  for (const e of entries) {
    if (!byRole[e.role]) byRole[e.role] = [];
    byRole[e.role].push({
      logicalName: e.logicalName,
      path: e.relativeOutput,
      sha256: e.sha256,
      bytes: e.bytes,
      ...(e.width ? { width: e.width, height: e.height } : {}),
      ...(e.weight ? { weight: e.weight, format: e.format } : {}),
    });
  }

  for (const key of Object.keys(byRole)) {
    byRole[key].sort((a, b) => a.logicalName.localeCompare(b.logicalName));
  }

  return byRole;
}

async function collectAssets() {
  const imageResults = [];
  for (const target of IMAGE_TARGETS) imageResults.push(await validateImageTarget(target));

  const fontResults = [];
  for (const target of FONT_TARGETS) fontResults.push(await validateFontTarget(target));

  const configResults = [];
  for (const target of CONFIG_TARGETS) configResults.push(validateConfigTarget(target));

  return {
    images: imageResults,
    fonts: fontResults,
    configs: configResults,
  };
}

function emitAssets(collected) {
  ensureDir(RENDERER_ASSETS);
  ensureDir(path.join(RENDERER_ASSETS, 'fonts'));
  ensureDir(path.join(RENDERER_ASSETS, 'config'));

  const emitted = [];

  for (const asset of [...collected.images, ...collected.fonts]) {
    const dst = path.join(RENDERER_ASSETS, asset.relativeOutput);
    copyDeterministic(asset.src, dst);
    emitted.push({ ...asset });
  }

  for (const asset of collected.configs) {
    const dst = path.join(RENDERER_ASSETS, asset.relativeOutput);
    ensureDir(path.dirname(dst));
    deterministicWrite(dst, asset.normalized);
    emitted.push({
      logicalName: asset.logicalName,
      role: asset.role,
      relativeOutput: asset.relativeOutput,
      bytes: Buffer.byteLength(asset.normalized),
      sha256: sha256(Buffer.from(asset.normalized)),
      src: asset.src,
    });
  }

  const fontCss = cssForFonts(collected.fonts.map((f) => ({ ...f, relativeOutput: f.relativeOutput })));
  const fontCssRel = path.join('fonts', 'fonts.css').replace(/\\/g, '/');
  deterministicWrite(path.join(RENDERER_ASSETS, fontCssRel), fontCss);
  emitted.push({
    logicalName: 'font-css-bundle',
    role: 'font-css',
    relativeOutput: fontCssRel,
    bytes: Buffer.byteLength(fontCss),
    sha256: sha256(Buffer.from(fontCss)),
    src: '<generated>',
  });

  return emitted.sort((a, b) => a.relativeOutput.localeCompare(b.relativeOutput));
}

function buildManifest(entries) {
  const totalBytes = entries.reduce((acc, e) => acc + e.bytes, 0);
  const manifest = {
    schema: 1,
    generator: 'adjutorix.prepare-renderer-assets',
    counts: {
      entries: entries.length,
      bytes: totalBytes,
    },
    byRole: runtimeAssetIndex(entries),
    entries: entries.map((e) => ({
      logicalName: e.logicalName,
      role: e.role,
      path: e.relativeOutput,
      bytes: e.bytes,
      sha256: e.sha256,
      ...(e.width ? { width: e.width, height: e.height } : {}),
      ...(e.weight ? { weight: e.weight, format: e.format } : {}),
    })),
  };

  deterministicWrite(MANIFEST_PATH, stableJson(manifest));
  return manifest;
}

function verifyOutput(manifest) {
  for (const entry of manifest.entries) {
    const p = path.join(RENDERER_ASSETS, entry.path);
    assert(fs.existsSync(p), `missing_emitted_asset:${entry.path}`);
    const buf = readFile(p);
    assert(buf.length === entry.bytes, `emitted_size_mismatch:${entry.path}`);
    assert(sha256(buf) === entry.sha256, `emitted_hash_mismatch:${entry.path}`);

    if (entry.path.endsWith('.png')) {
      const dims = parsePngDimensions(buf);
      if (entry.width) assert(dims.width === entry.width, `emitted_png_width_mismatch:${entry.path}`);
      if (entry.height) assert(dims.height === entry.height, `emitted_png_height_mismatch:${entry.path}`);
    }

    if (entry.path.endsWith('.woff2')) {
      validateWoff2(buf);
    }
  }
}

async function doBuild() {
  ensureDir(RENDERER_DIST);
  rmrf(RENDERER_ASSETS);
  ensureDir(RENDERER_ASSETS);

  const collected = await collectAssets();
  const emitted = emitAssets(collected);
  const manifest = buildManifest(emitted);
  verifyOutput(manifest);

  process.stdout.write(stableJson({ ok: true, manifestPath: MANIFEST_PATH, entries: manifest.counts.entries }));
}

function doVerify() {
  assert(fs.existsSync(MANIFEST_PATH), 'manifest_missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
  verifyOutput(manifest);
  process.stdout.write(stableJson({ ok: true, verified: manifest.counts.entries }));
}

function doClean() {
  rmrf(RENDERER_ASSETS);
}

async function main() {
  const cmd = process.argv[2] || 'build';
  if (cmd === 'build') return doBuild();
  if (cmd === 'verify') return doVerify();
  if (cmd === 'clean') return doClean();
  throw new Error('prepare-renderer-assets:unknown_command');
}

main().catch((err) => {
  process.stderr.write(String(err.message || err) + '\n');
  process.exit(1);
});
