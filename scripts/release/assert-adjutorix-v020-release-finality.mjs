import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TAG = "adjutorix-local-operator-cockpit-v0.2.0";
const RELEASE_SHA = "b39a7736809d94e79bdcd445071e2c55401c585b";
const RELEASE_DIR = `reports/releases/${TAG}`;
const requiredFiles = [
  `${RELEASE_DIR}/RELEASE.md`,
  `${RELEASE_DIR}/manifest.json`,
  "configs/runtime/local_operator_loop_complete.json",
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx",
  "packages/adjutorix-app/tests/smoke/local_operator_loop.smoke.test.tsx",
  "scripts/product/assert-local-operator-loop-complete.mjs",
  "scripts/product/assert-real-root-smoke.mjs"
];

function sh(cmd, args) {
  return execFileSync(cmd, args, { encoding: "utf8" }).trim();
}

const failures = [];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_REQUIRED_FILE", file });
}

let tagSha = "";
try {
  tagSha = sh("git", ["rev-list", "-n", "1", TAG]);
} catch (error) {
  failures.push({ code: "TAG_NOT_FOUND", tag: TAG });
}

if (tagSha && tagSha !== RELEASE_SHA) {
  failures.push({ code: "TAG_SHA_DRIFT", expected: RELEASE_SHA, actual: tagSha });
}

let manifest = null;
try {
  manifest = JSON.parse(fs.readFileSync(`${RELEASE_DIR}/manifest.json`, "utf8"));
} catch (error) {
  failures.push({ code: "BAD_RELEASE_MANIFEST", file: `${RELEASE_DIR}/manifest.json` });
}

if (manifest) {
  if (manifest.tag !== TAG) failures.push({ code: "MANIFEST_TAG_DRIFT", expected: TAG, actual: manifest.tag });
  if (manifest.main_sha !== RELEASE_SHA) failures.push({ code: "MANIFEST_RELEASE_SHA_DRIFT", expected: RELEASE_SHA, actual: manifest.main_sha });

  const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
  for (const expected of [
    "Adjutorix-0.1.0-arm64.dmg",
    "Adjutorix-0.1.0-arm64.dmg.blockmap",
    "builder-effective-config.yaml"
  ]) {
    if (!assets.some((asset) => String(asset.path || "").endsWith(expected))) {
      failures.push({ code: "MANIFEST_ASSET_MISSING", asset: expected });
    }
  }

  for (const asset of assets) {
    if (!asset.sha256 || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
      failures.push({ code: "BAD_ASSET_SHA256", asset: asset.path });
    }
    if (!Number.isInteger(asset.bytes) || asset.bytes <= 0) {
      failures.push({ code: "BAD_ASSET_SIZE", asset: asset.path });
    }
  }
}

const cockpit = fs.existsSync("packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx")
  ? fs.readFileSync("packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx", "utf8")
  : "";

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
  "ROLLBACK_COMPLETE"
]) {
  if (!cockpit.includes(phrase)) {
    failures.push({ code: "COCKPIT_FINALITY_PHRASE_MISSING", phrase });
  }
}

const report = {
  product: "ADJUTORIX_V020_RELEASE_FINALITY_GUARD",
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  timestamp: new Date().toISOString(),
  tag: TAG,
  release_sha: RELEASE_SHA,
  observed_tag_sha: tagSha,
  checked_files: requiredFiles,
  failures
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync(
  "reports/current/adjutorix-v020-release-finality.json",
  JSON.stringify(report, null, 2) + "\n"
);

console.log(`ADJUTORIX_V020_RELEASE_FINALITY=${report.verdict}`);
console.log("REPORT=reports/current/adjutorix-v020-release-finality.json");

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
