import fs from "node:fs";
import crypto from "node:crypto";

const failures = [];

const requiredFiles = [
  "configs/runtime/local_operator_loop_complete.json",
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx",
  "configs/contracts/intent_plan_object.schema.json",
  "configs/contracts/patch_custody_object.schema.json",
  "configs/contracts/verification_gate_object.schema.json",
  "configs/contracts/verify_receipt_object.schema.json",
  "configs/contracts/apply_gate_object.schema.json",
  "configs/contracts/apply_receipt_object.schema.json",
  "configs/contracts/rollback_gate_object.schema.json",
  "configs/contracts/rollback_receipt_object.schema.json",
  "scripts/product/assert-local-operator-cockpit.mjs",
  "scripts/product/assert-intent-plan-object.mjs",
  "scripts/product/assert-patch-custody-object.mjs",
  "scripts/product/assert-verification-gate-object.mjs",
  "scripts/product/assert-verify-receipt-object.mjs",
  "scripts/product/assert-apply-gate-object.mjs",
  "scripts/product/assert-apply-receipt-object.mjs",
  "scripts/product/assert-rollback-gate-object.mjs",
  "scripts/product/assert-rollback-receipt-object.mjs"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_FILE", file });
}

const cockpit = fs.existsSync(requiredFiles[1]) ? fs.readFileSync(requiredFiles[1], "utf8") : "";

for (const phrase of [
  "ADJUTORIX_INTENT_PLAN_OBJECT",
  "ADJUTORIX_PATCH_CUSTODY_OBJECT",
  "ADJUTORIX_VERIFICATION_GATE_OBJECT",
  "ADJUTORIX_VERIFY_RECEIPT_OBJECT",
  "ADJUTORIX_APPLY_GATE_OBJECT",
  "ADJUTORIX_APPLY_RECEIPT_OBJECT",
  "ADJUTORIX_ROLLBACK_GATE_OBJECT",
  "ADJUTORIX_ROLLBACK_RECEIPT_OBJECT",
  "ROLLBACK_COMPLETE",
  "operator_loop_complete: true"
]) {
  if (!cockpit.includes(phrase)) failures.push({ code: "COCKPIT_MISSING_COMPLETE_LOOP_PHRASE", phrase });
}

const currentReports = [
  "reports/current/local-operator-cockpit-readiness.json",
  "reports/current/intent-plan-object-readiness.json",
  "reports/current/patch-custody-object-readiness.json",
  "reports/current/verification-gate-object-readiness.json",
  "reports/current/verify-receipt-object-readiness.json",
  "reports/current/apply-gate-object-readiness.json",
  "reports/current/apply-receipt-object-readiness.json",
  "reports/current/rollback-gate-object-readiness.json",
  "reports/current/rollback-receipt-object-readiness.json"
];

for (const reportPath of currentReports) {
  if (!fs.existsSync(reportPath)) {
    failures.push({ code: "MISSING_CURRENT_REPORT", reportPath });
    continue;
  }

  const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
  if (report.verdict !== "PASS") failures.push({ code: "CURRENT_REPORT_NOT_PASS", reportPath, verdict: report.verdict });
}

const report = {
  product: "ADJUTORIX_LOCAL_OPERATOR_LOOP_COMPLETE",
  timestamp: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
  checked_files: requiredFiles,
  checked_reports: currentReports,
  terminal_state: "ROLLBACK_COMPLETE"
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/local-operator-loop-complete-readiness.json", JSON.stringify(report, null, 2) + "\n");

const historyDir = `reports/history/local-operator-loop-complete-${report.timestamp.replace(/[:.]/g, "-")}`;
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(`${historyDir}/local-operator-loop-complete-readiness.json`, JSON.stringify(report, null, 2) + "\n");

const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
fs.writeFileSync(`${historyDir}/manifest.json`, JSON.stringify({
  product: report.product,
  timestamp: report.timestamp,
  verdict: report.verdict,
  sha256: digest
}, null, 2) + "\n");

console.log(`ADJUTORIX_LOCAL_OPERATOR_LOOP_COMPLETE_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/local-operator-loop-complete-readiness.json");
console.log(`HISTORY=${historyDir}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
