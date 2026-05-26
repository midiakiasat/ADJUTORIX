#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), "utf8");
}

function fail(code, detail = {}) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function countMatches(text, pattern) {
  return [...text.matchAll(pattern)].length;
}

const files = {
  app: "packages/adjutorix-app/src/renderer/App.tsx",
  spine: "packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx",
  policy: "configs/runtime/operator_unified_control_spine_policy.json",
  test: "packages/adjutorix-app/tests/renderer/operator_unified_control_spine_contract.test.ts",
  vitest: "packages/adjutorix-app/vitest.config.mjs",
};

for (const [name, relativePath] of Object.entries(files)) {
  if (!fs.existsSync(path.join(root, relativePath))) {
    fail("V090_REQUIRED_FILE_MISSING", { name, path: relativePath });
  }
}

const app = read(files.app);
const spine = read(files.spine);
const test = read(files.test);
const vitest = read(files.vitest);
const policy = JSON.parse(read(files.policy));

for (const token of [
  "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE",
  "evidence-ledger",
  "diagnostics-console",
  "evidenceLedger",
  "diagnosticsConsole",
  "operator-unified-control-spine-active-surface",
]) {
  if (!spine.includes(token)) {
    fail("V090_SPINE_TOKEN_MISSING", { token });
  }
}

if (
  !spine.includes("operator-unified-control-spine-step-${step.id}") &&
  !spine.includes("operator-unified-control-spine-step-")
) {
  fail("V090_SPINE_DYNAMIC_STEP_TESTID_MISSING", {});
}

for (const step of [
  "mission-control",
  "live-kernel",
  "execution-runway",
  "evidence-ledger",
  "diagnostics-console",
]) {
  if (!spine.includes(step)) {
    fail("V090_SPINE_STEP_MISSING", { step });
  }
}

if (!app.includes("<OperatorSurfaceSpinePanel")) {
  fail("V090_APP_SPINE_INVOCATION_MISSING", {});
}

const requiredAppPropPatterns = {
  missionControl: /missionControl\s*=\s*{\s*<OperatorMissionControlPanel\s*\/>\s*}/s,
  executionRunway: /executionRunway\s*=\s*{\s*<OperatorExecutionRunwayPanel\s*\/>\s*}/s,
  evidenceLedger: /evidenceLedger\s*=\s*{\s*<OperatorEvidenceLedgerPanel\s*\/>\s*}/s,
  diagnosticsConsole: /diagnosticsConsole\s*=\s*{\s*<OperatorDiagnosticsConsolePanel\s*\/>\s*}/s,
};

for (const [prop, pattern] of Object.entries(requiredAppPropPatterns)) {
  if (!pattern.test(app)) {
    fail("V090_APP_SPINE_PROP_MISSING", { prop, pattern: String(pattern) });
  }
}

for (const [component, pattern] of Object.entries({
  OperatorEvidenceLedgerPanel: /<OperatorEvidenceLedgerPanel\s*\/>/g,
  OperatorDiagnosticsConsolePanel: /<OperatorDiagnosticsConsolePanel\s*\/>/g,
})) {
  const count = countMatches(app, pattern);
  if (count !== 1) {
    fail("V090_SURFACE_MUST_EXIST_ONLY_INSIDE_SPINE", { component, count });
  }
}

if (policy.required !== true) {
  fail("V090_POLICY_REQUIRED_FALSE", policy);
}

if (policy.surface !== "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE") {
  fail("V090_POLICY_SURFACE_INVALID", policy);
}

const expectedPath = [
  "mission-control",
  "live-kernel",
  "execution-runway",
  "evidence-ledger",
  "diagnostics-console",
];

if (JSON.stringify(policy.governedPath) !== JSON.stringify(expectedPath)) {
  fail("V090_POLICY_GOVERNED_PATH_INVALID", {
    expectedPath,
    actualPath: policy.governedPath,
  });
}

if (!test.includes("operator unified control spine contract")) {
  fail("V090_CONTRACT_TEST_NAME_MISSING", {});
}

if (!vitest.includes("operator_unified_control_spine_contract.test.ts")) {
  fail("V090_VITEST_INCLUDE_MISSING", {});
}

const report = {
  ok: true,
  schema: "adjutorix.operator_unified_control_spine_readiness_report.v1",
  surface: "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE",
  version: "0.9.0",
  governedPath: policy.governedPath,
  baseTag: policy.baseTag,
  assertedAt: new Date().toISOString(),
};

fs.mkdirSync(path.join(root, "reports/current"), { recursive: true });
fs.writeFileSync(
  path.join(root, "reports/current/operator-unified-control-spine-readiness.json"),
  JSON.stringify(report, null, 2) + "\n",
);

console.log("ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE_READINESS=PASS");
console.log("REPORT=reports/current/operator-unified-control-spine-readiness.json");
