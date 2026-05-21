#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const repo = process.env.GITHUB_REPOSITORY || "qzro/ADJUTORIX";
const tag = process.env.ADJUTORIX_V020_TAG || "adjutorix-local-operator-cockpit-v0.2.0";
const expectedSha = process.env.ADJUTORIX_V020_RELEASE_SHA || "b39a7736809d94e79bdcd445071e2c55401c585b";

const failures = [];

function run(command, args) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function maybe(command, args) {
  try {
    return run(command, args);
  } catch {
    return "";
  }
}

function requireFile(path) {
  if (!fs.existsSync(path)) failures.push({ code: "MISSING_FILE", path });
}

function requireText(path, phrase) {
  if (!fs.existsSync(path)) {
    failures.push({ code: "MISSING_FILE", path });
    return;
  }
  const text = fs.readFileSync(path, "utf8");
  if (!text.includes(phrase)) failures.push({ code: "MISSING_TEXT", path, phrase });
}

function requireJson(path) {
  requireFile(path);
  if (!fs.existsSync(path)) return null;
  try {
    return JSON.parse(fs.readFileSync(path, "utf8"));
  } catch (error) {
    failures.push({ code: "BAD_JSON", path, error: String(error?.message || error) });
    return null;
  }
}

let tagSha = maybe("git", ["rev-list", "-n", "1", tag]);
if (!tagSha) {
  maybe("git", ["fetch", "--force", "origin", `refs/tags/${tag}:refs/tags/${tag}`]);
  tagSha = maybe("git", ["rev-list", "-n", "1", tag]);
}

if (tagSha !== expectedSha) {
  failures.push({ code: "TAG_SHA_MISMATCH", tag, expected: expectedSha, actual: tagSha || null });
}

const releaseEvidenceDir = "reports/releases/adjutorix-local-operator-cockpit-v0.2.0";
const releaseManifestPath = `${releaseEvidenceDir}/manifest.json`;
const releaseReadmePath = `${releaseEvidenceDir}/RELEASE.md`;

requireFile(releaseReadmePath);
const releaseManifest = requireJson(releaseManifestPath);

if (releaseManifest) {
  const manifestSha = releaseManifest.release_main_sha || releaseManifest.main_sha || releaseManifest.sha || null;
  if (releaseManifest.tag !== tag) failures.push({ code: "RELEASE_MANIFEST_TAG_MISMATCH", expected: tag, actual: releaseManifest.tag });
  if (manifestSha !== expectedSha) failures.push({ code: "RELEASE_MANIFEST_SHA_MISMATCH", expected: expectedSha, actual: manifestSha });

  if (!Array.isArray(releaseManifest.assets) || releaseManifest.assets.length < 3) {
    failures.push({ code: "RELEASE_MANIFEST_ASSETS_MISSING" });
  }

  for (const asset of releaseManifest.assets || []) {
    if (!asset.path) failures.push({ code: "RELEASE_ASSET_PATH_MISSING", asset });
    if (!asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256)) failures.push({ code: "RELEASE_ASSET_SHA256_BAD", asset });
    if (typeof asset.bytes !== "number" || asset.bytes <= 0) failures.push({ code: "RELEASE_ASSET_BYTES_BAD", asset });
  }
}

const cockpit = "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx";
for (const phrase of [
  "ADJUTORIX_INTENT_PLAN_OBJECT",
  "ADJUTORIX_PATCH_CUSTODY_OBJECT",
  "ADJUTORIX_VERIFICATION_GATE_OBJECT",
  "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
  "ADJUTORIX_APPLY_GATE_OBJECT",
  "ADJUTORIX_APPLY_RECEIPT_OBJECT",
  "ADJUTORIX_ROLLBACK_GATE_OBJECT",
  "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
  "apply_requires_verify_pass",
  "rollback_requires_apply_receipt",
  "may_mutate_files: false",
  "may_apply_patch: false",
  "apply with receipt",
  "rollback with receipt"
]) {
  requireText(cockpit, phrase);
}

const releaseRaw = maybe("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName,name,isDraft,isPrerelease,targetCommitish,url,assets"]);
if (releaseRaw) {
  let release = null;
  try {
    release = JSON.parse(releaseRaw);
  } catch (error) {
    failures.push({ code: "GH_RELEASE_JSON_BAD", error: String(error?.message || error) });
  }

  if (release) {
    if (release.tagName !== tag) failures.push({ code: "GH_RELEASE_TAG_MISMATCH", expected: tag, actual: release.tagName });
    if (release.isDraft !== false) failures.push({ code: "GH_RELEASE_IS_DRAFT", actual: release.isDraft });
    if (release.isPrerelease !== false) failures.push({ code: "GH_RELEASE_IS_PRERELEASE", actual: release.isPrerelease });

    const assetNames = new Set((release.assets || []).map((asset) => asset.name));
    for (const required of [
      "Adjutorix-0.1.0-arm64.dmg",
      "Adjutorix-0.1.0-arm64.dmg.blockmap",
      "builder-effective-config.yaml",
      "manifest.json",
      "RELEASE.md"
    ]) {
      if (!assetNames.has(required)) failures.push({ code: "GH_RELEASE_ASSET_MISSING", asset: required });
    }
  }
} else if (process.env.CI) {
  failures.push({ code: "GH_RELEASE_VIEW_FAILED", tag, repo });
}

const report = {
  product: "ADJUTORIX_V020_RELEASE_FINALITY_GUARD",
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  tag,
  release_main_sha: expectedSha,
  checked_at: new Date().toISOString(),
  guarantees: [
    "release tag resolves to immutable v0.2.0 cockpit commit",
    "release evidence exists",
    "release manifest contains hashed package artifacts",
    "LocalOperatorCockpit contains governed object chain",
    "unsafe apply and rollback invariants remain source-bound",
    "GitHub release assets exist"
  ],
  failures,
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/adjutorix-v020-release-finality.json", JSON.stringify(report, null, 2) + "\n");

console.log(`ADJUTORIX_V020_RELEASE_FINALITY=${report.verdict}`);
console.log("REPORT=reports/current/adjutorix-v020-release-finality.json");

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
