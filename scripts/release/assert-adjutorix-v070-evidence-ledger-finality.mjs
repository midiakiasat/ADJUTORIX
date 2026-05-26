#!/usr/bin/env node
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const TAG = "adjutorix-operator-evidence-ledger-surface-v0.7.0";
const EXPECTED_SHA = "4d5952e53e84c31a564b2b99771cf00c3cf0ccea";

const requiredFiles = [
  "configs/runtime/operator_evidence_ledger_surface_policy.json",
  "packages/adjutorix-app/src/renderer/App.tsx",
  "packages/adjutorix-app/src/renderer/components/OperatorEvidenceLedgerPanel.tsx",
  "packages/adjutorix-app/tests/renderer/operator_evidence_ledger_surface_contract.test.ts",
  "packages/adjutorix-app/vitest.config.mjs",
  "reports/current/operator-evidence-ledger-surface-readiness.json",
  "scripts/product/assert-operator-evidence-ledger-surface.mjs"
];

const requiredContent = [
  {
    file: "packages/adjutorix-app/src/renderer/App.tsx",
    phrases: ["OperatorEvidenceLedgerPanel"]
  },
  {
    file: "packages/adjutorix-app/src/renderer/components/OperatorEvidenceLedgerPanel.tsx",
    phrases: ["OperatorEvidenceLedgerPanel", "timeline", "heads", "stats", "entry"]
  },
  {
    file: "packages/adjutorix-app/tests/renderer/operator_evidence_ledger_surface_contract.test.ts",
    phrases: [
      "user-visible evidence ledger surface",
      "every governed ledger bridge path",
      "required runtime surface policy",
      "implemented Vitest suite"
    ]
  },
  {
    file: "packages/adjutorix-app/vitest.config.mjs",
    phrases: ["operator_evidence_ledger_surface_contract.test.ts"]
  },
  {
    file: "scripts/product/assert-operator-evidence-ledger-surface.mjs",
    phrases: ["ADJUTORIX_OPERATOR_EVIDENCE_LEDGER_SURFACE_READINESS=PASS"]
  }
];

function fail(code, detail) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function read(file) {
  if (!fs.existsSync(file)) fail("V070_FINALITY_REQUIRED_FILE_MISSING", { file });
  return fs.readFileSync(file, "utf8");
}

const tagSha = git(["rev-list", "-n", "1", TAG]);
if (tagSha !== EXPECTED_SHA) {
  fail("V070_FINALITY_TAG_SHA_MISMATCH", { tag: TAG, expected: EXPECTED_SHA, actual: tagSha });
}

try {
  execFileSync("git", ["merge-base", "--is-ancestor", TAG, "HEAD"], { stdio: "ignore" });
} catch {
  fail("V070_FINALITY_TAG_NOT_ANCESTOR_OF_HEAD", { tag: TAG });
}

for (const file of requiredFiles) read(file);

for (const check of requiredContent) {
  const body = read(check.file);
  for (const phrase of check.phrases) {
    if (!body.includes(phrase)) {
      fail("V070_FINALITY_REQUIRED_PHRASE_MISSING", { file: check.file, phrase });
    }
  }
}

const policy = read("configs/runtime/operator_evidence_ledger_surface_policy.json").toLowerCase();
for (const token of ["operator", "evidence", "ledger", "surface"]) {
  if (!policy.includes(token)) {
    fail("V070_FINALITY_POLICY_SEMANTIC_TOKEN_MISSING", { token });
  }
}

const readinessRaw = read("reports/current/operator-evidence-ledger-surface-readiness.json");
let readiness;
try {
  readiness = JSON.parse(readinessRaw);
} catch (error) {
  fail("V070_FINALITY_READINESS_JSON_INVALID", { message: String(error?.message ?? error) });
}

const readinessText = JSON.stringify(readiness).toLowerCase();
for (const token of ["operator", "evidence", "ledger"]) {
  if (!readinessText.includes(token)) {
    fail("V070_FINALITY_READINESS_TOKEN_MISSING", { token });
  }
}

const report = {
  ok: true,
  schema: "adjutorix-v070-evidence-ledger-finality-v1",
  finality: "ADJUTORIX_V070_OPERATOR_EVIDENCE_LEDGER_SURFACE_FINALITY",
  tag: TAG,
  lockedSha: EXPECTED_SHA,
  actualTagSha: tagSha,
  checkedFiles: requiredFiles,
  checkedAt: new Date().toISOString()
};

fs.mkdirSync("reports/current", { recursive: true });
fs.writeFileSync(
  "reports/current/adjutorix-v070-evidence-ledger-finality.json",
  `${JSON.stringify(report, null, 2)}\n`
);

console.log("ADJUTORIX_V070_OPERATOR_EVIDENCE_LEDGER_FINALITY=PASS");
console.log("REPORT=reports/current/adjutorix-v070-evidence-ledger-finality.json");
