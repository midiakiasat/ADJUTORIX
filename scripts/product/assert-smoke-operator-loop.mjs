import fs from "node:fs";
import crypto from "node:crypto";

const failures = [];

const requiredFiles = [
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx",
  "packages/adjutorix-app/tests/smoke/local_operator_loop.smoke.test.tsx",
  "packages/adjutorix-app/vitest.smoke.config.ts",
  "packages/adjutorix-app/package.json"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_FILE", file });
}

const cockpit = fs.existsSync(requiredFiles[0]) ? fs.readFileSync(requiredFiles[0], "utf8") : "";
const smoke = fs.existsSync(requiredFiles[1]) ? fs.readFileSync(requiredFiles[1], "utf8") : "";
const smokeConfig = fs.existsSync(requiredFiles[2]) ? fs.readFileSync(requiredFiles[2], "utf8") : "";
const packageJson = fs.existsSync(requiredFiles[3]) ? JSON.parse(fs.readFileSync(requiredFiles[3], "utf8")) : {};
const combined = `${cockpit}\n${smoke}\n${smokeConfig}\n${JSON.stringify(packageJson, null, 2)}`;

const requiredPhrases = [
  "LocalOperatorCockpit",
  "ADJUTORIX Operator Cockpit",
  "Repository custody",
  "Trust classification",
  "Intent capture",
  "Plan object",
  "Patch object",
  "Verification Gate object",
  "Verify receipt object",
  "Apply Gate object",
  "Apply Receipt object",
  "Rollback Gate object",
  "Rollback Receipt object",
  "Evidence timeline",
  "apply with receipt",
  "rollback with receipt",
  "apply_requires_verify_pass",
  "rollback_requires_apply_receipt",
  "workspace_requires_trust_classification",
  "advanced_surfaces_hidden_by_default",
  "may_mutate_files: false",
  "may_apply: false",
  "may_rollback: false",
  "receipt_required: true",
  "rollback_unlocked: true",
  "terminal_state: \"ROLLBACK_COMPLETE\"",
  "ADJUTORIX_INTENT_PLAN_OBJECT",
  "ADJUTORIX_PATCH_CUSTODY_OBJECT",
  "ADJUTORIX_VERIFICATION_GATE_OBJECT",
  "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
  "ADJUTORIX_APPLY_GATE_OBJECT",
  "ADJUTORIX_APPLY_RECEIPT_OBJECT",
  "ADJUTORIX_ROLLBACK_GATE_OBJECT",
  "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
  "ROLLBACK_COMPLETE",
  "operator_loop_complete"
];

for (const phrase of requiredPhrases) {
  if (!combined.includes(phrase)) {
    failures.push({ code: "MISSING_OPERATOR_LOOP_SMOKE_PHRASE", phrase });
  }
}

if (!smokeConfig.includes("tests/smoke/**/*.{test,spec}.{ts,tsx}")) {
  failures.push({ code: "SMOKE_CONFIG_DOES_NOT_BIND_ACTIVE_SMOKE_GLOB" });
}

if (!smokeConfig.includes("quarantined-pre-local-operator-loop")) {
  failures.push({ code: "SMOKE_CONFIG_DOES_NOT_EXCLUDE_PRE_LOOP_QUARANTINE" });
}

if (packageJson?.scripts?.["test:smoke"] !== "vitest run --config vitest.smoke.config.ts") {
  failures.push({ code: "PACKAGE_TEST_SMOKE_SCRIPT_NOT_BOUND" });
}

const activeSmokeFiles = fs.readdirSync("packages/adjutorix-app/tests/smoke")
  .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx") || name.endsWith(".spec.ts") || name.endsWith(".spec.tsx"));

if (activeSmokeFiles.length !== 1 || activeSmokeFiles[0] !== "local_operator_loop.smoke.test.tsx") {
  failures.push({ code: "ACTIVE_SMOKE_SET_NOT_SINGLE_OPERATOR_LOOP", activeSmokeFiles });
}

const report = {
  product: "ADJUTORIX_OPERATOR_LOOP_SMOKE",
  timestamp: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
  active_smoke_files: activeSmokeFiles,
  checked_files: requiredFiles
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/operator-loop-smoke-readiness.json", JSON.stringify(report, null, 2) + "\n");

const historyDir = `reports/history/operator-loop-smoke-${report.timestamp.replace(/[:.]/g, "-")}`;
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(`${historyDir}/operator-loop-smoke-readiness.json`, JSON.stringify(report, null, 2) + "\n");

const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
fs.writeFileSync(`${historyDir}/manifest.json`, JSON.stringify({
  product: report.product,
  timestamp: report.timestamp,
  verdict: report.verdict,
  sha256: digest
}, null, 2) + "\n");

console.log(`ADJUTORIX_OPERATOR_LOOP_SMOKE_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/operator-loop-smoke-readiness.json");
console.log(`HISTORY=${historyDir}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
