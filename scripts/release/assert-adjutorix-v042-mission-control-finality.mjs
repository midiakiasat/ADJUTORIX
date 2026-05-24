#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

const expectedTag = "adjutorix-operator-mission-control-surface-v0.4.2";
const expectedSha = "e20129f54fa28418f194505edd6034aed3778852";

function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function read(relativePath) {
  const absolutePath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`missing required file: ${relativePath}`);
  }
  return fs.readFileSync(absolutePath, "utf8");
}

function requirePhrase(relativePath, phrase) {
  const text = read(relativePath);
  if (!text.includes(phrase)) {
    throw new Error(`missing required phrase in ${relativePath}: ${phrase}`);
  }
}

function requireJson(relativePath) {
  return JSON.parse(read(relativePath));
}

const tagSha = git(["rev-list", "-n", "1", expectedTag]);
if (tagSha !== expectedSha) {
  throw new Error(`tag ${expectedTag} moved: expected ${expectedSha}, got ${tagSha}`);
}

const requiredFiles = [
  "configs/runtime/operator_mission_control_surface_policy.json",
  "packages/adjutorix-app/src/renderer/components/OperatorMissionControlPanel.tsx",
  "packages/adjutorix-app/src/renderer/App.tsx",
  "packages/adjutorix-app/tests/renderer/operator_mission_control_surface_contract.test.ts",
  "packages/adjutorix-app/vitest.config.mjs",
  "reports/current/operator-mission-control-surface-readiness.json",
  "scripts/product/assert-operator-mission-control-surface.mjs",
];

for (const file of requiredFiles) {
  read(file);
}

requirePhrase("packages/adjutorix-app/src/renderer/components/OperatorMissionControlPanel.tsx", "OperatorMissionControlPanel");
requirePhrase("packages/adjutorix-app/src/renderer/components/OperatorMissionControlPanel.tsx", "operatorIntent");
requirePhrase("packages/adjutorix-app/src/renderer/components/OperatorMissionControlPanel.tsx", "previousKernelHash");
requirePhrase("packages/adjutorix-app/src/renderer/components/OperatorMissionControlPanel.tsx", "createReceipt");

requirePhrase("packages/adjutorix-app/src/renderer/App.tsx", "OperatorMissionControlPanel");

requirePhrase(
  "packages/adjutorix-app/tests/renderer/operator_mission_control_surface_contract.test.ts",
  "operator mission control surface contract",
);
requirePhrase(
  "packages/adjutorix-app/tests/renderer/operator_mission_control_surface_contract.test.ts",
  "operator_mission_control_surface_policy.json",
);
requirePhrase(
  "packages/adjutorix-app/vitest.config.mjs",
  "tests/renderer/operator_mission_control_surface_contract.test.ts",
);

requirePhrase(
  "scripts/product/assert-operator-mission-control-surface.mjs",
  "ADJUTORIX_OPERATOR_MISSION_CONTROL_SURFACE_READINESS",
);

const policyText = read("configs/runtime/operator_mission_control_surface_policy.json").toLowerCase();
for (const phrase of ["mission", "control", "operator", "kernel"]) {
  if (!policyText.includes(phrase)) {
    throw new Error(`mission control policy missing semantic marker: ${phrase}`);
  }
}
requireJson("configs/runtime/operator_mission_control_surface_policy.json");

const readiness = requireJson("reports/current/operator-mission-control-surface-readiness.json");
if (readiness.ok !== true && readiness.status !== "PASS" && readiness.readiness !== "PASS") {
  throw new Error("operator mission control readiness report is not explicitly passing");
}

const report = {
  ok: true,
  guard: "adjutorix-v042-mission-control-finality",
  expectedTag,
  expectedSha,
  tagSha,
  lockedSurface: "operator-mission-control",
  requiredFiles,
  checkedAt: new Date().toISOString(),
};

const reportPath = path.join(repoRoot, "reports/current/adjutorix-v042-mission-control-finality.json");
fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

console.log("ADJUTORIX_V042_OPERATOR_MISSION_CONTROL_SURFACE_FINALITY=PASS");
console.log("REPORT=reports/current/adjutorix-v042-mission-control-finality.json");
