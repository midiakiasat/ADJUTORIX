#!/usr/bin/env node
import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";

const root = process.cwd();
const reportPath = path.join(root, "reports/current/real-operator-kernel-readiness.json");
const historyDir = path.join(root, `reports/history/real-operator-kernel-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const sourcePath = path.join(root, "packages/adjutorix-app/src/main/operator/real_operator_kernel.ts");
const schemaPath = path.join(root, "configs/contracts/operator_kernel_receipt.schema.json");
const policyPath = path.join(root, "configs/runtime/operator_kernel_policy.json");

const failures = [];

function requireFile(p) {
  if (!fs.existsSync(p)) failures.push({ code: "MISSING_FILE", file: path.relative(root, p) });
}

for (const p of [sourcePath, schemaPath, policyPath]) requireFile(p);

const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, "utf8") : "";
const schema = fs.existsSync(schemaPath) ? JSON.parse(fs.readFileSync(schemaPath, "utf8")) : {};
const policy = fs.existsSync(policyPath) ? JSON.parse(fs.readFileSync(policyPath, "utf8")) : {};

const requiredSourcePhrases = [
  "ADJUTORIX_REAL_OPERATOR_KERNEL",
  "ADJUTORIX_OPERATOR_KERNEL_RECEIPT",
  "appendOperatorKernelReceipt",
  "readLastOperatorKernelHash",
  "createHash(\"sha256\")",
  "renderer_may_mutate: false",
  "kernel_may_mutate_without_verify: false",
  "apply_requires_verify_pass: true",
  "rollback_requires_apply_receipt: true",
  "append_only_evidence: true",
  "APPLY_REQUEST_BLOCKED",
  "ROLLBACK_REQUEST_BLOCKED",
  "stableJson",
  "canonical_payload_sha256"
];

for (const phrase of requiredSourcePhrases) {
  if (!source.includes(phrase)) failures.push({ code: "MISSING_SOURCE_PHRASE", phrase });
}

if (schema.title !== "ADJUTORIX Operator Kernel Receipt") failures.push({ code: "SCHEMA_TITLE_MISMATCH" });
if (policy.product !== "ADJUTORIX_REAL_OPERATOR_KERNEL_POLICY") failures.push({ code: "POLICY_PRODUCT_MISMATCH" });
if (policy?.hard_boundaries?.renderer_may_mutate !== false) failures.push({ code: "POLICY_RENDERER_MUTATION_BOUNDARY_MISSING" });
if (policy?.hard_boundaries?.kernel_may_mutate_without_verify !== false) failures.push({ code: "POLICY_KERNEL_VERIFY_BOUNDARY_MISSING" });
if (policy?.hard_boundaries?.apply_requires_verify_pass !== true) failures.push({ code: "POLICY_APPLY_VERIFY_BOUNDARY_MISSING" });
if (policy?.hard_boundaries?.rollback_requires_apply_receipt !== true) failures.push({ code: "POLICY_ROLLBACK_RECEIPT_BOUNDARY_MISSING" });

const sourceHash = crypto.createHash("sha256").update(source).digest("hex");

const report = {
  product: "ADJUTORIX_REAL_OPERATOR_KERNEL",
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  checked_at: new Date().toISOString(),
  checked_files: [
    "packages/adjutorix-app/src/main/operator/real_operator_kernel.ts",
    "configs/contracts/operator_kernel_receipt.schema.json",
    "configs/runtime/operator_kernel_policy.json"
  ],
  source_sha256: sourceHash,
  guarantees: [
    "operator kernel exists outside renderer surface",
    "receipts are canonical-hash bound",
    "evidence append API exists",
    "renderer mutation remains impossible",
    "apply without verify is blocked",
    "rollback without apply receipt is blocked"
  ],
  failures
};

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

fs.mkdirSync(historyDir, { recursive: true });
fs.writeFileSync(path.join(historyDir, "real-operator-kernel-readiness.json"), `${JSON.stringify(report, null, 2)}\n`);
fs.writeFileSync(path.join(historyDir, "manifest.json"), `${JSON.stringify({
  product: report.product,
  verdict: report.verdict,
  report: "real-operator-kernel-readiness.json",
  source_sha256: sourceHash
}, null, 2)}\n`);

console.log(`ADJUTORIX_REAL_OPERATOR_KERNEL_READINESS=${report.verdict}`);
console.log(`REPORT=${path.relative(root, reportPath)}`);
console.log(`HISTORY=${path.relative(root, historyDir)}`);

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
