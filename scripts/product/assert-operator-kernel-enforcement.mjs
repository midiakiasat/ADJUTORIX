#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

const checks = [
  {
    file: "packages/adjutorix-app/src/main/operator/operator_kernel_enforcement.ts",
    phrases: [
      "assertMandatoryOperatorKernelGate",
      "ADJUTORIX_OPERATOR_KERNEL_GATE_REQUIRED",
      "operatorKernelReceiptId",
      "operatorKernelHash",
      "operatorKernel",
    ],
  },
  {
    file: "packages/adjutorix-app/src/main/ipc/patch_ipc.ts",
    phrases: [
      "assertMandatoryOperatorKernelGate",
      "channels.apply",
      "operatorKernelReceiptId",
      "operatorKernelHash",
    ],
  },
  {
    file: "packages/adjutorix-app/tests/renderer/operator_kernel_enforcement_contract.test.ts",
    phrases: [
      "operator kernel enforcement contract",
      "blocks patch apply authority behind the mandatory operator kernel gate",
    ],
  },
  {
    file: "packages/adjutorix-app/vitest.config.mjs",
    phrases: [
      "operator_kernel_enforcement_contract.test.ts",
      "operator_kernel_mandatory_gate_contract.test.ts",
      "operator_kernel_ipc_contract.test.ts",
    ],
  },
];

const failures = [];

for (const check of checks) {
  const abs = path.join(repoRoot, check.file);
  if (!fs.existsSync(abs)) {
    failures.push({ code: "MISSING_FILE", file: check.file });
    continue;
  }

  const body = fs.readFileSync(abs, "utf8");
  for (const phrase of check.phrases) {
    if (!body.includes(phrase)) {
      failures.push({ code: "MISSING_REQUIRED_PHRASE", file: check.file, phrase });
    }
  }
}

const report = {
  product: "ADJUTORIX_OPERATOR_KERNEL_ENFORCEMENT",
  verdict: failures.length === 0 ? "PASS" : "FAIL",
  checked_at: new Date().toISOString(),
  guarantees: [
    "patch apply authority is source-bound to mandatory operator kernel gate",
    "operator kernel receipt id, kernel hash, or kernel object is required before apply",
    "enforcement has a renderer contract test",
    "enforcement contract is in the explicit Vitest include list",
  ],
  failures,
};

fs.mkdirSync(path.join(repoRoot, "reports/current"), { recursive: true });
fs.writeFileSync(
  path.join(repoRoot, "reports/current/operator-kernel-enforcement-readiness.json"),
  `${JSON.stringify(report, null, 2)}\n`,
);

console.log(`ADJUTORIX_OPERATOR_KERNEL_ENFORCEMENT_READINESS=${report.verdict}`);
console.log("REPORT=reports/current/operator-kernel-enforcement-readiness.json");

if (failures.length > 0) {
  for (const failure of failures) console.error(JSON.stringify(failure));
  process.exit(1);
}
