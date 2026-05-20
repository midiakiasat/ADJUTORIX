import fs from "node:fs";
import crypto from "node:crypto";

const failures = [];

const requiredFiles = [
  "configs/contracts/patch_custody_object.schema.json",
  "configs/runtime/patch_custody_policy.json",
  "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx"
];

for (const file of requiredFiles) {
  if (!fs.existsSync(file)) failures.push({ code: "MISSING_FILE", file });
}

const schemaPath = "configs/contracts/patch_custody_object.schema.json";
const policyPath = "configs/runtime/patch_custody_policy.json";
const cockpitPath = "packages/adjutorix-app/src/renderer/components/LocalOperatorCockpit.tsx";

const schema = fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : null;
const policy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : null;
const cockpit = fs.existsSync(cockpitPath) ? fs.readFileSync(cockpitPath, "utf8") : "";

if (schema?.properties?.object_type?.const !== "ADJUTORIX_PATCH_CUSTODY_OBJECT") {
  failures.push({ code: "SCHEMA_BAD_OBJECT_TYPE" });
}

for (const required of [
  "patch_custody_id",
  "plan_id",
  "workspace_root",
  "operator_intent",
  "custody",
  "basis",
  "target_scope",
  "patch_state",
  "review_gate",
  "verification_gate",
  "apply_gate",
  "rollback_gate",
  "evidence"
]) {
  if (!schema?.required?.includes(required)) failures.push({ code: "SCHEMA_MISSING_REQUIRED", required });
}

if (policy?.policy_type !== "ADJUTORIX_PATCH_CUSTODY_POLICY") {
  failures.push({ code: "POLICY_BAD_TYPE" });
}

for (const gate of [
  "requires_plan_object",
  "requires_workspace_bound",
  "patch_custody_may_not_mutate_files",
  "diff_materialization_requires_patch_pipeline",
  "operator_review_required",
  "verification_required_before_apply",
  "apply_requires_verify_pass",
  "apply_requires_apply_receipt",
  "rollback_required_after_apply",
  "rollback_requires_rollback_receipt"
]) {
  if (policy?.[gate] !== true) failures.push({ code: "POLICY_GATE_NOT_TRUE", gate });
}

for (const phrase of [
  "type PatchCustodyObject",
  "createPatchCustodyObject",
  "validatePatchCustodyObject",
  "ADJUTORIX_PATCH_CUSTODY_OBJECT",
  "patch.custody.created",
  "patch_custody_receipt",
  "Patch custody object",
  "Create patch custody",
  "may_mutate_files: false",
  "files_mutated: false"
]) {
  if (!cockpit.includes(phrase)) failures.push({ code: "COCKPIT_MISSING_PATCH_CUSTODY_PHRASE", phrase });
}

const report = {
  product: "ADJUTORIX_PLAN_TO_PATCH_CUSTODY",
  timestamp: new Date().toISOString(),
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  failures,
  checked_files: requiredFiles
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync("reports/current/patch-custody-object-readiness.json", JSON.stringify(report, null, 2) + "\n");

const historyDir = `reports/history/patch-custody-object-${report.timestamp.replace(/[:.]/g, "-")}`;
fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(`${historyDir}/patch-custody-object-readiness.json`, JSON.stringify(report, null, 2) + "\n");

const digest = crypto.createHash("sha256").update(JSON.stringify(report)).digest("hex");
fs.writeFileSync(`${historyDir}/manifest.json`, JSON.stringify({
  product: report.product,
  timestamp: report.timestamp,
  verdict: report.verdict,
  sha256: digest
}, null, 2) + "\n");

console.log(`ADJUTORIX_PATCH_CUSTODY_OBJECT_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/patch-custody-object-readiness.json");
console.log(`HISTORY=${historyDir}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
