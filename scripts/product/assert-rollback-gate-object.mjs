import fs from "node:fs";
import crypto from "node:crypto";

const failures = [];

const requiredFiles = [
  "configs/contracts/rollback_gate_object.schema.json",
  "configs/runtime/rollback_gate_policy.json",
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_FILE", file });
}

const schema = fs.existsSync(requiredFiles[0]) ? JSON.parse(fs.readFileSync(requiredFiles[0], "utf8")) : null;
const policy = fs.existsSync(requiredFiles[1]) ? JSON.parse(fs.readFileSync(requiredFiles[1], "utf8")) : null;
const cockpit = fs.existsSync(requiredFiles[2]) ? fs.readFileSync(requiredFiles[2], "utf8") : "";

if (schema?.properties?.object_type?.const !== "ADJUTORIX_ROLLBACK_GATE_OBJECT") failures.push({ code: "SCHEMA_BAD_OBJECT_TYPE" });

for (const required of [
  "rollback_gate_id",
  "apply_receipt_id",
  "workspace_root",
  "custody",
  "basis",
  "inputs",
  "gate_state",
  "execution",
  "rollback_receipt",
  "evidence"
]) {
  if (!schema?.required?.includes(required)) failures.push({ code: "SCHEMA_MISSING_REQUIRED", required });
}

for (const gate of [
  "requires_apply_receipt_object",
  "requires_apply_receipt_created",
  "rollback_gate_may_not_mutate_files",
  "rollback_execution_requires_operator_trigger",
  "rollback_execution_requires_rollback_receipt",
  "rollback_receipt_required"
]) {
  if (policy?.[gate] !== true) failures.push({ code: "POLICY_GATE_NOT_TRUE", gate });
}

for (const phrase of [
  "type RollbackGateObject",
  "createRollbackGateObject",
  "validateRollbackGateObject",
  "ADJUTORIX_ROLLBACK_GATE_OBJECT",
  "rollback.gate.created",
  "rollback_gate_receipt",
  "Rollback Gate object",
  "Create rollback gate",
  "rollbackGateReady",
  "may_mutate_files: false",
  "may_rollback: false",
  "rollback_unlocked: true"
]) {
  if (!cockpit.includes(phrase)) failures.push({ code: "COCKPIT_MISSING_ROLLBACK_GATE_PHRASE", phrase });
}

const report = {
  product: "ADJUTORIX_APPLY_RECEIPT_TO_ROLLBACK_GATE",
  timestamp: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
  checked_files: requiredFiles
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/rollback-gate-object-readiness.json", JSON.stringify(report, null, 2) + "\n");

const historyDir = `reports/history/rollback-gate-object-${report.timestamp.replace(/[:.]/g, "-")}`;
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(`${historyDir}/rollback-gate-object-readiness.json`, JSON.stringify(report, null, 2) + "\n");

const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
fs.writeFileSync(`${historyDir}/manifest.json`, JSON.stringify({
  product: report.product,
  timestamp: report.timestamp,
  verdict: report.verdict,
  sha256: digest
}, null, 2) + "\n");

console.log(`ADJUTORIX_ROLLBACK_GATE_OBJECT_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/rollback-gate-object-readiness.json");
console.log(`HISTORY=${historyDir}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
