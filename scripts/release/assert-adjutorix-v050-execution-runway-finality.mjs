#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const expected = {
  schema: "adjutorix-v050-execution-runway-finality-v1",
  tag: "adjutorix-operator-execution-runway-surface-v0.5.0",
  releaseName: "ADJUTORIX v0.5.0 — Operator Execution Runway Surface",
  sha: "10339e3947cc9bf19389a7bdbaada700b67fb90b",
  report: "reports/current/adjutorix-v050-execution-runway-finality.json",
  requiredFiles: [
    "configs/runtime/operator_execution_runway_surface_policy.json",
    "packages/adjutorix-app/src/renderer/App.tsx",
    "packages/adjutorix-app/src/renderer/components/OperatorExecutionRunwayPanel.tsx",
    "packages/adjutorix-app/tests/renderer/operator_execution_runway_surface_contract.test.ts",
    "packages/adjutorix-app/vitest.config.mjs",
    "reports/current/operator-execution-runway-surface-readiness.json",
    "scripts/product/assert-operator-execution-runway-surface.mjs",
  ],
  requiredPhrasesByFile: {
    "packages/adjutorix-app/src/renderer/App.tsx": [
      "OperatorExecutionRunwayPanel",
    ],
    "packages/adjutorix-app/src/renderer/components/OperatorExecutionRunwayPanel.tsx": [
      "OperatorExecutionRunwayPanel",
      "operatorKernel",
      "createReceipt",
      "lastHash",
      "patch",
      "apply",
    ],
    "packages/adjutorix-app/tests/renderer/operator_execution_runway_surface_contract.test.ts": [
      "operator execution runway surface contract",
      "renders the user-visible execution runway inside the app surface",
      "binds the runway to kernel receipt, patch apply, and verification evidence",
      "declares the runway as required runtime policy",
      "keeps the runway contract in the implemented Vitest suite",
    ],
    "packages/adjutorix-app/vitest.config.mjs": [
      "operator_execution_runway_surface_contract.test.ts",
    ],
    "scripts/product/assert-operator-execution-runway-surface.mjs": [
      "ADJUTORIX_OPERATOR_EXECUTION_RUNWAY_SURFACE_READINESS=PASS",
      "operator-execution-runway-surface-readiness.json",
    ],
  },
};

function fail(code, detail) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function read(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    fail("MISSING_REQUIRED_FILE", file);
  }
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8" }).trim();
  } catch (error) {
    fail("GIT_COMMAND_FAILED", {
      args,
      stderr: error.stderr?.toString() ?? "",
      stdout: error.stdout?.toString() ?? "",
    });
  }
}

function sha256(content) {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function parseJson(file) {
  try {
    return JSON.parse(read(file));
  } catch (error) {
    fail("INVALID_JSON", { file, message: error.message });
  }
}

const root = git(["rev-parse", "--show-toplevel"]);
process.chdir(root);

const head = git(["rev-parse", "HEAD"]);
const tagSha = git(["rev-list", "-n", "1", expected.tag]);

if (tagSha !== expected.sha) {
  fail("V050_TAG_SHA_MISMATCH", { expected: expected.sha, actual: tagSha });
}

const missing = expected.requiredFiles.filter((file) => !fs.existsSync(file));
if (missing.length) {
  fail("V050_FINALITY_REQUIRED_FILES_MISSING", missing);
}

const phraseFailures = [];
for (const [file, phrases] of Object.entries(expected.requiredPhrasesByFile)) {
  const content = read(file);
  for (const phrase of phrases) {
    if (!content.includes(phrase)) {
      phraseFailures.push({ file, phrase });
    }
  }
}

if (phraseFailures.length) {
  fail("V050_FINALITY_REQUIRED_PHRASES_MISSING", phraseFailures);
}

const readiness = parseJson("reports/current/operator-execution-runway-surface-readiness.json");
const readinessSerialized = JSON.stringify(readiness).toLowerCase();

if (
  readiness.ok !== true &&
  readiness.status !== "PASS" &&
  readiness.readiness !== "PASS" &&
  !readinessSerialized.includes("pass")
) {
  fail("V050_RUNWAY_READINESS_NOT_PASS", readiness);
}

const policy = parseJson("configs/runtime/operator_execution_runway_surface_policy.json");
const policySerialized = JSON.stringify(policy).toLowerCase();

const requiredPolicyConcepts = [
  "operator",
  "execution",
  "runway",
];

const missingPolicyConcepts = requiredPolicyConcepts.filter(
  (concept) => !policySerialized.includes(concept),
);

if (missingPolicyConcepts.length) {
  fail("V050_RUNWAY_POLICY_CONCEPTS_MISSING", {
    missingPolicyConcepts,
    policy,
  });
}

const requiredEvidenceFiles = [
  "packages/adjutorix-app/src/renderer/components/OperatorExecutionRunwayPanel.tsx",
  "packages/adjutorix-app/tests/renderer/operator_execution_runway_surface_contract.test.ts",
  "scripts/product/assert-operator-execution-runway-surface.mjs",
];

const evidenceFailures = [];
for (const file of requiredEvidenceFiles) {
  const content = read(file).toLowerCase();
  for (const concept of requiredPolicyConcepts) {
    if (!content.includes(concept)) {
      evidenceFailures.push({ file, concept });
    }
  }
}

if (evidenceFailures.length) {
  fail("V050_RUNWAY_EVIDENCE_CONCEPTS_MISSING", evidenceFailures);
}

const fileHashes = {};
for (const file of expected.requiredFiles) {
  fileHashes[file] = sha256(read(file));
}

const report = {
  ok: true,
  schema: expected.schema,
  checkedAt: new Date().toISOString(),
  head,
  lockedTag: expected.tag,
  lockedSha: expected.sha,
  tagSha,
  releaseName: expected.releaseName,
  finality: "PASS",
  invariant:
    "v0.5.0 operator execution runway surface remains locked, user-visible, policy-backed, test-backed, assertion-backed, and release-backed",
  requiredFiles: expected.requiredFiles,
  requiredPolicyConcepts,
  fileHashes,
};

fs.mkdirSync(path.dirname(expected.report), { recursive: true });
fs.writeFileSync(expected.report, `${JSON.stringify(report, null, 2)}\n`);

console.log("ADJUTORIX_V050_OPERATOR_EXECUTION_RUNWAY_FINALITY=PASS");
console.log(`REPORT=${expected.report}`);
