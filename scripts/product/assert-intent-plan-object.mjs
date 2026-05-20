import fs from "node:fs";
import crypto from "node:crypto";

const failures = [];

const requiredFiles = [
  "configs/contracts/intent_plan_object.schema.json",
  "configs/runtime/intent_plan_policy.json",
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_FILE", file });
}

const schemaPath = "configs/contracts/intent_plan_object.schema.json";
const policyPath = "configs/runtime/intent_plan_policy.json";
const cockpitPath = "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx";

const schema = fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null;
const policy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : null;
const cockpit = fs.existsSync(cockpitPath) ? fs.readFileSync(cockpitPath, "utf8") : "";

if (schema?.properties?.object_type?.const !== "ADJUTORIX_INTENT_PLAN_OBJECT") {
  failures.push({ code: "SCHEMA_BAD_OBJECT_TYPE" });
}

for (const required of [
  "plan_id",
  "workspace_root",
  "operator_intent",
  "custody",
  "trust_snapshot",
  "mutation_scope",
  "verification_plan",
  "apply_gate",
  "rollback_plan",
  "evidence"
]) {
  if (!schema?.required?.includes(required)) failures.push({ code: "SCHEMA_MISSING_REQUIRED", required });
}

if (policy?.policy_type !== "ADJUTORIX_INTENT_PLAN_POLICY") {
  failures.push({ code: "POLICY_BAD_TYPE" });
}

for (const gate of [
  "intent_may_not_mutate_files",
  "plan_may_not_apply_patch",
  "plan_requires_workspace_bound",
  "plan_requires_patch_review",
  "plan_requires_verification",
  "apply_requires_verify_pass",
  "rollback_requires_apply_receipt"
]) {
  if (policy?.[gate] !== true) failures.push({ code: "POLICY_GATE_NOT_TRUE", gate });
}

for (const phrase of [
  "type IntentPlanObject",
  "createIntentPlanObject",
  "validateIntentPlanObject",
  "ADJUTORIX_INTENT_PLAN_OBJECT",
  "plan.object.created",
  "plan_receipt",
  "Intent plan object",
  "node scripts/product/assert-intent-plan-object.mjs"
]) {
  if (!cockpit.includes(phrase)) failures.push({ code: "COCKPIT_MISSING_PLAN_PHRASE", phrase });
}

const report = {
  product: "ADJUTORIX_INTENT_TO_PLAN_OBJECT",
  timestamp: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
  checked_files: requiredFiles
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/intent-plan-object-readiness.json", JSON.stringify(report, null, 2) + "\n");

const historyDir = `reports/history/intent-plan-object-${report.timestamp.replace(/[:.]/g, "-")}`;
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(`${historyDir}/intent-plan-object-readiness.json`, JSON.stringify(report, null, 2) + "\n");

const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
fs.writeFileSync(`${historyDir}/manifest.json`, JSON.stringify({
  product: report.product,
  timestamp: report.timestamp,
  verdict: report.verdict,
  sha256: digest
}, null, 2) + "\n");

console.log(`ADJUTORIX_INTENT_PLAN_OBJECT_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/intent-plan-object-readiness.json");
console.log(`HISTORY=${historyDir}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
