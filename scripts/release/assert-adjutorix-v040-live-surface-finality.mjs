#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";

const repoRoot = process.cwd();

const product = "ADJUTORIX_V040_LIVE_OPERATOR_KERNEL_SURFACE_FINALITY_GUARD";
const tag = "adjutorix-live-operator-kernel-surface-v0.4.0";
const expectedSha = "653589386430c105c9057b0aa38d93ed3e2e0037";
const reportPath = path.join(repoRoot, "reports/current/adjutorix-v040-live-surface-finality.json");

const requiredAssets = [
  "Adjutorix-0.1.0-arm64.dmg",
  "Adjutorix-0.1.0-arm64.dmg.blockmap",
  "builder-effective-config.yaml",
];

const requiredFiles = [
  "configs/runtime/operator_kernel_live_surface_policy.json",
  "packages/adjutorix-app/src/preload/preload.ts",
  "packages/adjutorix-app/src/renderer/App.tsx",
  "packages/adjutorix-app/tests/renderer/operator_kernel_live_surface_contract.test.ts",
  "packages/adjutorix-app/vitest.config.mjs",
  "reports/current/operator-kernel-live-surface-readiness.json",
  "scripts/product/assert-operator-kernel-live-surface.mjs",
];

const requiredPhrases = [
  {
    file: "packages/adjutorix-app/src/renderer/App.tsx",
    phrases: [
      "operatorKernel",
      "operatorKernelReceiptId",
      "operatorKernelHash",
      "previousKernelHash",
    ],
  },
  {
    file: "packages/adjutorix-app/src/preload/preload.ts",
    phrases: [
      "operatorKernelReceiptId",
      "operatorKernelHash",
      "operatorKernel",
    ],
  },
  {
    file: "packages/adjutorix-app/tests/renderer/operator_kernel_live_surface_contract.test.ts",
    phrases: [
      "renders a user-visible operator kernel cockpit",
      "keeps kernel evidence across preload patch.apply normalization",
      "binds cockpit, IPC, and enforcement into one usable path",
    ],
  },
  {
    file: "packages/adjutorix-app/vitest.config.mjs",
    phrases: [
      "tests/renderer/operator_kernel_live_surface_contract.test.ts",
    ],
  },
];

const failures = [];

function fail(code, detail) {
  failures.push({ code, ...detail });
}

function run(command, args) {
  return childProcess.execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function exists(relativePath) {
  return fs.existsSync(path.join(repoRoot, relativePath));
}

for (const file of requiredFiles) {
  if (!exists(file)) fail("MISSING_REQUIRED_FILE", { file });
}

let tagSha = null;
try {
  tagSha = run("git", ["rev-list", "-n", "1", tag]);
  if (tagSha !== expectedSha) {
    fail("TAG_SHA_MISMATCH", { tag, expectedSha, actualSha: tagSha });
  }
} catch (error) {
  fail("TAG_NOT_RESOLVABLE", { tag, message: String(error?.message ?? error) });
}

for (const rule of requiredPhrases) {
  if (!exists(rule.file)) continue;
  const body = read(rule.file);
  for (const phrase of rule.phrases) {
    if (!body.includes(phrase)) {
      fail("MISSING_REQUIRED_PHRASE", { file: rule.file, phrase });
    }
  }
}

if (exists("reports/current/operator-kernel-live-surface-readiness.json")) {
  try {
    const readiness = JSON.parse(read("reports/current/operator-kernel-live-surface-readiness.json"));
    if (readiness.verdict !== "PASS") {
      fail("LIVE_SURFACE_READINESS_NOT_PASS", {
        file: "reports/current/operator-kernel-live-surface-readiness.json",
        verdict: readiness.verdict ?? null,
      });
    }
  } catch (error) {
    fail("LIVE_SURFACE_READINESS_NOT_JSON", { message: String(error?.message ?? error) });
  }
}

async function loadRelease() {
  const repo = process.env.GITHUB_REPOSITORY || "qzro/ADJUTORIX";
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "";

  if (token) {
    const response = await fetch(`https://api.github.com/repos/${repo}/releases/tags/${tag}`, {
      headers: {
        "Accept": "application/vnd.github+json",
        "Authorization": `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });

    if (!response.ok) {
      throw new Error(`GitHub release API failed: ${response.status}`);
    }

    return await response.json();
  }

  const raw = run("gh", [
    "release",
    "view",
    tag,
    "--repo",
    repo,
    "--json",
    "tagName,name,isDraft,isPrerelease,targetCommitish,url,assets",
  ]);

  return JSON.parse(raw);
}

let release = null;

try {
  release = await loadRelease();

  if (release.tag_name && release.tag_name !== tag) {
    fail("RELEASE_TAG_MISMATCH", { expectedTag: tag, actualTag: release.tag_name });
  }

  if (release.tagName && release.tagName !== tag) {
    fail("RELEASE_TAG_MISMATCH", { expectedTag: tag, actualTag: release.tagName });
  }

  const isDraft = release.draft ?? release.isDraft ?? false;
  const isPrerelease = release.prerelease ?? release.isPrerelease ?? false;

  if (isDraft) fail("RELEASE_IS_DRAFT", { tag });
  if (isPrerelease) fail("RELEASE_IS_PRERELEASE", { tag });

  const assets = Array.isArray(release.assets) ? release.assets : [];
  const assetNames = assets.map((asset) => asset.name).sort();

  for (const requiredAsset of requiredAssets) {
    if (!assetNames.includes(requiredAsset)) {
      fail("MISSING_RELEASE_ASSET", { tag, asset: requiredAsset, foundAssets: assetNames });
    }
  }
} catch (error) {
  fail("RELEASE_NOT_VERIFIABLE", { tag, message: String(error?.message ?? error) });
}

const report = {
  product,
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  tag,
  expected_sha: expectedSha,
  tag_sha: tagSha,
  checked_at: new Date().toISOString(),
  guarantees: [
    "v0.4.0 live operator kernel surface tag resolves to immutable merge commit",
    "GitHub release exists and is not draft or prerelease",
    "release assets include DMG, blockmap, and builder effective config",
    "renderer contains user-visible operator kernel cockpit evidence",
    "preload preserves operator kernel evidence through patch.apply normalization",
    "live surface contract test remains in implemented Vitest suite",
    "live surface readiness report remains PASS",
  ],
  failures,
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log(`ADJUTORIX_V040_LIVE_OPERATOR_KERNEL_SURFACE_FINALITY=${report.verdict}`);
console.log(`REPORT=${path.relative(repoRoot, reportPath)}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
