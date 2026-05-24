#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const repoRoot = process.cwd();
const expectedSha = "1f8e1dc3a9f26b9092711f4b5fc68f41787cd74c";
const tag = "adjutorix-enforced-operator-kernel-gate-v0.3.3";
const repo = "qzro/ADJUTORIX";

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function git(args) {
  return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

function gh(args) {
  return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8" }).trim();
}

const failures = [];

function requireEqual(code, actual, expected) {
  if (actual !== expected) failures.push({ code, actual, expected });
}

function requireIncludes(file, phrase) {
  const text = read(file);
  if (!text.includes(phrase)) failures.push({ code: "MISSING_REQUIRED_PHRASE", file, phrase });
}

function requireReleaseAsset(assets, name) {
  if (!assets.some((asset) => asset.name === name)) {
    failures.push({ code: "MISSING_RELEASE_ASSET", name });
  }
}

const tagSha = git(["rev-list", "-n", "1", tag]);
requireEqual("V033_TAG_SHA_MISMATCH", tagSha, expectedSha);

let release = null;
try {
  release = JSON.parse(
    gh([
      "release",
      "view",
      tag,
      "--repo",
      repo,
      "--json",
      "tagName,name,isDraft,isPrerelease,targetCommitish,url,assets",
    ]),
  );
} catch (error) {
  failures.push({ code: "GH_RELEASE_VIEW_FAILED", message: String(error?.message || error) });
}

if (release) {
  requireEqual("RELEASE_TAG_MISMATCH", release.tagName, tag);
  requireEqual("RELEASE_DRAFT_NOT_FALSE", String(release.isDraft), "false");
  requireEqual("RELEASE_PRERELEASE_NOT_FALSE", String(release.isPrerelease), "false");

  if (release.targetCommitish !== expectedSha) {
    failures.push({
      code: "RELEASE_TARGET_NOT_SHA_PINNED",
      actual: release.targetCommitish,
      expected: expectedSha,
    });
  }

  requireReleaseAsset(release.assets || [], "Adjutorix-0.1.0-arm64.dmg");
  requireReleaseAsset(release.assets || [], "Adjutorix-0.1.0-arm64.dmg.blockmap");
  requireReleaseAsset(release.assets || [], "builder-effective-config.yaml");
}

requireIncludes(
  "packages/adjutorix-app/src/main/operator/operator_kernel_enforcement.ts",
  "assertMandatoryOperatorKernelGate",
);
requireIncludes(
  "packages/adjutorix-app/src/main/operator/operator_kernel_enforcement.ts",
  "requirePatchIdFromKernelGatedPayload",
);
requireIncludes(
  "packages/adjutorix-app/src/main/ipc/patch_ipc.ts",
  "assertMandatoryOperatorKernelGate",
);
requireIncludes(
  "packages/adjutorix-app/src/main/index.ts",
  "assertMandatoryOperatorKernelGate",
);
requireIncludes(
  "packages/adjutorix-app/src/main/runtime/bootstrap.ts",
  "assertMandatoryOperatorKernelGate",
);
requireIncludes(
  "packages/adjutorix-app/tests/renderer/operator_kernel_enforcement_contract.test.ts",
  "closes every known main-process patch apply handler",
);
requireIncludes(
  "packages/adjutorix-app/vitest.config.mjs",
  "tests/renderer/operator_kernel_enforcement_contract.test.ts",
);
requireIncludes(
  "reports/current/operator-kernel-enforcement-readiness.json",
  "\"verdict\": \"PASS\"",
);

const report = {
  product: "ADJUTORIX_V033_OPERATOR_KERNEL_ENFORCEMENT_FINALITY",
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  tag,
  expected_sha: expectedSha,
  release_url: release?.url || null,
  guarantees: [
    "v0.3.3 tag resolves to locked enforcement commit",
    "GitHub release exists and is not draft/prerelease",
    "release target is SHA-pinned",
    "release assets exist",
    "patch apply IPC boundary is operator-kernel gated",
    "legacy main apply boundary is operator-kernel gated",
    "runtime bootstrap apply boundary is operator-kernel gated",
    "enforcement contract test remains in implemented Vitest suite",
    "enforcement readiness report remains PASS",
  ],
  failures,
};

const out = path.join(repoRoot, "reports/current/adjutorix-v033-enforcement-finality.json");
fs.writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);

if (failures.length > 0) {
  console.error("ADJUTORIX_V033_OPERATOR_KERNEL_ENFORCEMENT_FINALITY=FAIL");
  console.error(`REPORT=${path.relative(repoRoot, out)}`);
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}

console.log("ADJUTORIX_V033_OPERATOR_KERNEL_ENFORCEMENT_FINALITY=PASS");
console.log(`REPORT=${path.relative(repoRoot, out)}`);
