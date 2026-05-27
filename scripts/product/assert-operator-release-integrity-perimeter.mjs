#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const reportPath = "reports/current/operator-release-integrity-perimeter-readiness.json";

const protectedTags = [
  { tag: "adjutorix-operator-execution-runway-surface-v0.5.0", sha: "10339e3", minimumAssets: 0, class: "surface" },
  { tag: "adjutorix-v050-execution-runway-finality-guard-v0.5.1", sha: "64e1209", minimumAssets: 0, class: "finality" },
  { tag: "adjutorix-operator-surface-spine-v0.6.0", sha: "c775ce9", minimumAssets: 3, class: "packaged-surface" },
  { tag: "adjutorix-v060-operator-surface-spine-finality-guard-v0.6.1", sha: "a7b0da2", minimumAssets: 0, class: "finality" },
  { tag: "adjutorix-operator-evidence-ledger-surface-v0.7.0", sha: "4d5952e", minimumAssets: 3, class: "packaged-surface" },
  { tag: "adjutorix-v070-evidence-ledger-finality-guard-v0.7.1", sha: "30a89a8", minimumAssets: 0, class: "finality" },
  { tag: "adjutorix-operator-diagnostics-console-surface-v0.8.0", sha: "99b1014", minimumAssets: 3, class: "packaged-surface" },
  { tag: "adjutorix-v080-diagnostics-console-finality-guard-v0.8.1", sha: "e8b21ae", minimumAssets: 0, class: "finality" },
  { tag: "adjutorix-operator-unified-control-spine-v0.9.0", sha: "045d2d8", minimumAssets: 3, class: "packaged-surface" },
  { tag: "adjutorix-v090-operator-unified-control-spine-finality-guard-v0.9.1", sha: "bab19b6", minimumAssets: 0, class: "finality" }
];

const requiredFiles = [
  "configs/runtime/operator_release_integrity_perimeter_policy.json",
  "scripts/product/assert-operator-release-integrity-perimeter.mjs",
  ".github/workflows/adjutorix-v100-operator-release-integrity-perimeter.yml",
  "configs/runtime/operator_unified_control_spine_policy.json",
  "packages/adjutorix-app/src/renderer/App.tsx",
  "packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx",
  "reports/current/operator-unified-control-spine-readiness.json",
  "reports/current/adjutorix-v090-operator-unified-control-spine-finality.json",
  "scripts/release/assert-adjutorix-v090-operator-unified-control-spine-finality.mjs"
];

const requiredFinalityWorkflows = [
  ".github/workflows/adjutorix-v050-execution-runway-finality.yml",
  ".github/workflows/adjutorix-v060-operator-surface-spine-finality.yml",
  ".github/workflows/adjutorix-v070-evidence-ledger-finality.yml",
  ".github/workflows/adjutorix-v080-diagnostics-console-finality.yml",
  ".github/workflows/adjutorix-v090-operator-unified-control-spine-finality.yml"
];

function fail(code, detail = {}) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function sh(command) {
  try {
    return execSync(command, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch (error) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_COMMAND_FAILED", {
      command,
      stdout: error.stdout?.toString() ?? "",
      stderr: error.stderr?.toString() ?? ""
    });
  }
}

function read(path) {
  if (!existsSync(path)) fail("ADJUTORIX_RELEASE_INTEGRITY_FILE_MISSING", { path });
  return readFileSync(path, "utf8");
}

function assertContains(path, token) {
  const text = read(path);
  if (!text.includes(token)) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_TOKEN_MISSING", { path, token });
  }
}

function assertJsonOk(path, label) {
  let parsed;
  try {
    parsed = JSON.parse(read(path));
  } catch {
    fail("ADJUTORIX_RELEASE_INTEGRITY_JSON_INVALID", { path, label });
  }

  if (parsed.ok !== true) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_JSON_NOT_OK", { path, label, parsed });
  }

  return parsed;
}

function assertTag(tagSpec) {
  const actual = sh(`git rev-list -n 1 ${tagSpec.tag}`);
  if (!actual.startsWith(tagSpec.sha)) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_TAG_MOVED", {
      tag: tagSpec.tag,
      expectedPrefix: tagSpec.sha,
      actual
    });
  }

  sh(`git merge-base --is-ancestor ${tagSpec.tag} HEAD`);

  return {
    tag: tagSpec.tag,
    expectedPrefix: tagSpec.sha,
    actualSha: actual,
    class: tagSpec.class,
    minimumAssets: tagSpec.minimumAssets
  };
}

function assertRelease(tagSpec) {
  const raw = sh(`gh release view ${tagSpec.tag} --json tagName,name,isDraft,isPrerelease,targetCommitish,assets,url`);
  let release;

  try {
    release = JSON.parse(raw);
  } catch {
    fail("ADJUTORIX_RELEASE_INTEGRITY_RELEASE_JSON_INVALID", {
      tag: tagSpec.tag,
      raw
    });
  }

  if (release.tagName !== tagSpec.tag) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_RELEASE_TAG_MISMATCH", {
      expected: tagSpec.tag,
      actual: release.tagName
    });
  }

  if (release.isDraft !== false) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_RELEASE_IS_DRAFT", { tag: tagSpec.tag });
  }

  if (release.isPrerelease !== false) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_RELEASE_IS_PRERELEASE", { tag: tagSpec.tag });
  }

  const assetCount = Array.isArray(release.assets) ? release.assets.length : 0;
  if (assetCount < tagSpec.minimumAssets) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_RELEASE_ASSETS_MISSING", {
      tag: tagSpec.tag,
      expectedMinimum: tagSpec.minimumAssets,
      actual: assetCount
    });
  }

  return {
    tag: release.tagName,
    name: release.name,
    targetCommitish: release.targetCommitish,
    assetCount,
    url: release.url,
    draft: release.isDraft,
    prerelease: release.isPrerelease
  };
}

for (const path of requiredFiles) read(path);
for (const path of requiredFinalityWorkflows) read(path);

const policy = JSON.parse(read("configs/runtime/operator_release_integrity_perimeter_policy.json"));
if (policy.required !== true) {
  fail("ADJUTORIX_RELEASE_INTEGRITY_POLICY_NOT_REQUIRED", policy);
}

if (!Array.isArray(policy.protected_release_chain) || policy.protected_release_chain.length !== protectedTags.length) {
  fail("ADJUTORIX_RELEASE_INTEGRITY_POLICY_CHAIN_INVALID", {
    expectedCount: protectedTags.length,
    actual: policy.protected_release_chain
  });
}

for (const tagSpec of protectedTags) {
  if (!policy.protected_release_chain.includes(tagSpec.tag)) {
    fail("ADJUTORIX_RELEASE_INTEGRITY_POLICY_CHAIN_TAG_MISSING", { tag: tagSpec.tag });
  }
}

for (const token of [
  "ADJUTORIX_OPERATOR_RELEASE_INTEGRITY_PERIMETER",
  "protected_release_chain",
  "release integrity assertion",
  "v0.9.1"
]) {
  assertContains("configs/runtime/operator_release_integrity_perimeter_policy.json", token);
}

for (const token of [
  "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE",
  "required"
]) {
  assertContains("configs/runtime/operator_unified_control_spine_policy.json", token);
}

for (const token of [
  "operator-unified-control-spine",
  "evidence-ledger",
  "diagnostics-console",
  "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE"
]) {
  assertContains("packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx", token);
}

for (const token of [
  "OperatorSurfaceSpinePanel",
  "missionControl=",
  "liveKernelCockpit=",
  "executionRunway=",
  "evidenceLedger=",
  "diagnosticsConsole="
]) {
  assertContains("packages/adjutorix-app/src/renderer/App.tsx", token);
}

assertJsonOk("reports/current/operator-unified-control-spine-readiness.json", "operator-unified-control-spine-readiness");
assertJsonOk("reports/current/adjutorix-v090-operator-unified-control-spine-finality.json", "v090-unified-control-spine-finality");

const tagResults = protectedTags.map(assertTag);
const releaseResults = protectedTags.map(assertRelease);

const packagedReleaseCount = releaseResults.filter((release) => release.assetCount >= 3).length;
if (packagedReleaseCount < 4) {
  fail("ADJUTORIX_RELEASE_INTEGRITY_PACKAGED_RELEASE_COUNT_LOW", {
    expectedMinimum: 4,
    actual: packagedReleaseCount
  });
}

const mainSha = sh("git rev-parse HEAD");

const report = {
  ok: true,
  surface: "ADJUTORIX_OPERATOR_RELEASE_INTEGRITY_PERIMETER",
  readiness: "PASS",
  version: "1.0.0",
  mainSha,
  protectedTagCount: protectedTags.length,
  packagedReleaseCount,
  tagResults,
  releaseResults,
  requiredFinalityWorkflows,
  invariants: [
    "protected tags resolve to recorded commits",
    "main descends from all protected tags",
    "protected releases are non-draft and non-prerelease",
    "packaged releases expose release assets",
    "v0.9.1 finality is preserved before v1.0.0 admission",
    "release integrity perimeter is executable in CI"
  ]
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log("ADJUTORIX_OPERATOR_RELEASE_INTEGRITY_PERIMETER_READINESS=PASS");
console.log(`REPORT=${reportPath}`);
