#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = process.cwd();

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function fail(code, detail) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function requireContains(file, text) {
  const content = read(file);
  if (!content.includes(text)) {
    fail("OPERATOR_SURFACE_SPINE_REQUIRED_TEXT_MISSING", { file, text });
  }
}

const appPath = "packages/adjutorix-app/src/renderer/App.tsx";
const componentPath = "packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx";
const policyPath = "configs/runtime/operator_surface_spine_policy.json";
const vitestPath = "packages/adjutorix-app/vitest.config.mjs";
const testPath = "packages/adjutorix-app/tests/renderer/operator_surface_spine_contract.test.ts";

for (const file of [appPath, componentPath, policyPath, vitestPath, testPath]) {
  if (!fs.existsSync(path.join(repoRoot, file))) {
    fail("OPERATOR_SURFACE_SPINE_REQUIRED_FILE_MISSING", file);
  }
}

requireContains(appPath, "OperatorSurfaceSpinePanel");
requireContains(appPath, "missionControl={<OperatorMissionControlPanel />}");
requireContains(appPath, "executionRunway={<OperatorExecutionRunwayPanel />}");
requireContains(appPath, "liveKernelCockpit={");

requireContains(componentPath, "ADJUTORIX_OPERATOR_SURFACE_SPINE");
requireContains(componentPath, 'data-testid="operator-surface-spine"');
requireContains(componentPath, "operator-surface-spine-path");
requireContains(componentPath, "mission-control");
requireContains(componentPath, "live-kernel");
requireContains(componentPath, "execution-runway");
requireContains(componentPath, "evidence-finality");

const policy = JSON.parse(read(policyPath));
if (policy.surface !== "ADJUTORIX_OPERATOR_SURFACE_SPINE") {
  fail("OPERATOR_SURFACE_SPINE_POLICY_SURFACE_INVALID", policy.surface);
}
if (policy.required !== true) {
  fail("OPERATOR_SURFACE_SPINE_POLICY_REQUIRED_FALSE", policy.required);
}
for (const required of ["mission-control", "live-kernel", "execution-runway", "evidence-finality"]) {
  if (!policy.requiredSurfaces?.includes(required)) {
    fail("OPERATOR_SURFACE_SPINE_POLICY_REQUIRED_SURFACE_MISSING", required);
  }
}

requireContains(vitestPath, "tests/renderer/operator_surface_spine_contract.test.ts");

const app = read(appPath);
const spineIndex = app.indexOf("<OperatorSurfaceSpinePanel");
const missionIndex = app.indexOf("<OperatorMissionControlPanel />");
const runwayIndex = app.indexOf("<OperatorExecutionRunwayPanel />");
const liveKernelIndex = app.indexOf("liveKernelCockpit={");

if (spineIndex < 0 || missionIndex < spineIndex || runwayIndex < spineIndex || liveKernelIndex < spineIndex) {
  fail("OPERATOR_SURFACE_SPINE_REACHABILITY_INVALID", {
    spineIndex,
    missionIndex,
    runwayIndex,
    liveKernelIndex,
  });
}

const report = {
  ok: true,
  surface: "ADJUTORIX_OPERATOR_SURFACE_SPINE",
  version: "v0.6.0",
  branch: "adjutorix/v060-operator-surface-spine",
  requiredSurfaces: policy.requiredSurfaces,
  checkedAt: new Date().toISOString(),
};

fs.mkdirSync(path.join(repoRoot, "reports/current"), { recursive: true });
fs.writeFileSync(
  path.join(repoRoot, "reports/current/operator-surface-spine-readiness.json"),
  JSON.stringify(report, null, 2) + "\n",
);

console.log("ADJUTORIX_OPERATOR_SURFACE_SPINE_READINESS=PASS");
console.log("REPORT=reports/current/operator-surface-spine-readiness.json");
