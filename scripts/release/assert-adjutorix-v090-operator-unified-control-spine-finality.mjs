#!/usr/bin/env node
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const protectedTag = "adjutorix-operator-unified-control-spine-v0.9.0";
const protectedSha = "045d2d81c6564cb3fb837a2a944f7015f26daeca";
const reportPath = "reports/current/adjutorix-v090-operator-unified-control-spine-finality.json";

function fail(code, detail = {}) {
  console.error(JSON.stringify({ ok: false, code, detail }, null, 2));
  process.exit(1);
}

function sh(command) {
  return execSync(command, { encoding: "utf8" }).trim();
}

function read(path) {
  if (!existsSync(path)) fail("V090_FINALITY_FILE_MISSING", { path });
  return readFileSync(path, "utf8");
}

function expectContains(path, token) {
  const text = read(path);
  if (!text.includes(token)) fail("V090_FINALITY_TOKEN_MISSING", { path, token });
}

function expectSingleOccurrence(path, token) {
  const text = read(path);
  const count = text.split(token).length - 1;
  if (count !== 1) fail("V090_FINALITY_SINGLE_OCCURRENCE_BROKEN", { path, token, count });
}

function extractSpineInvocation(path) {
  const text = read(path);
  const start = text.indexOf("<OperatorSurfaceSpinePanel");
  if (start < 0) fail("V090_FINALITY_SPINE_INVOCATION_MISSING", { path });

  let braceDepth = 0;
  let inString = null;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      continue;
    }

    if (char === "}") {
      braceDepth--;
      if (braceDepth < 0) {
        fail("V090_FINALITY_SPINE_INVOCATION_BRACE_UNDERFLOW", { path, index: i });
      }
      continue;
    }

    if (braceDepth === 0 && char === ">") {
      let previous = i - 1;
      while (previous >= start && /\s/.test(text[previous])) previous--;

      if (text[previous] === "/") {
        return text.slice(start, i + 1);
      }
    }
  }

  fail("V090_FINALITY_SPINE_INVOCATION_UNCLOSED", { path });
}

function extractJsxPropExpression(invocation, propName) {
  const propStart = invocation.indexOf(`${propName}=`);
  if (propStart < 0) {
    fail("V090_FINALITY_APP_SPINE_PROP_MISSING", { propName });
  }

  let cursor = propStart + `${propName}=`.length;
  while (cursor < invocation.length && /\s/.test(invocation[cursor])) cursor++;

  if (invocation[cursor] !== "{") {
    fail("V090_FINALITY_APP_SPINE_PROP_NOT_BRACED", {
      propName,
      found: invocation.slice(cursor, cursor + 40),
    });
  }

  let braceDepth = 0;
  let inString = null;
  let escaped = false;

  for (let i = cursor; i < invocation.length; i++) {
    const char = invocation[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = char;
      continue;
    }

    if (char === "{") {
      braceDepth++;
      continue;
    }

    if (char === "}") {
      braceDepth--;

      if (braceDepth === 0) {
        const expression = invocation.slice(cursor + 1, i).trim();
        if (!expression) fail("V090_FINALITY_APP_SPINE_PROP_EMPTY", { propName });
        return expression;
      }

      if (braceDepth < 0) {
        fail("V090_FINALITY_APP_SPINE_PROP_BRACE_UNDERFLOW", { propName });
      }
    }
  }

  fail("V090_FINALITY_APP_SPINE_PROP_UNCLOSED", { propName });
}

const tagSha = sh(`git rev-list -n 1 ${protectedTag}`);
if (tagSha !== protectedSha) {
  fail("V090_FINALITY_PROTECTED_TAG_MOVED", {
    protectedTag,
    expected: protectedSha,
    actual: tagSha,
  });
}

const requiredFiles = [
  "configs/runtime/operator_unified_control_spine_policy.json",
  "packages/adjutorix-app/src/renderer/App.tsx",
  "packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx",
  "packages/adjutorix-app/tests/renderer/operator_unified_control_spine_contract.test.ts",
  "packages/adjutorix-app/tests/renderer/operator_surface_spine_contract.test.ts",
  "packages/adjutorix-app/vitest.config.mjs",
  "reports/current/operator-unified-control-spine-readiness.json",
  "scripts/product/assert-operator-unified-control-spine.mjs",
];

for (const path of requiredFiles) read(path);

const policy = read("configs/runtime/operator_unified_control_spine_policy.json");
for (const token of ["unified", "control", "spine"]) {
  if (!policy.toLowerCase().includes(token)) {
    fail("V090_FINALITY_POLICY_SEMANTIC_TOKEN_MISSING", { token });
  }
}

const component = "packages/adjutorix-app/src/renderer/components/OperatorSurfaceSpinePanel.tsx";

for (const token of [
  "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE",
  'data-testid="operator-unified-control-spine"',
  'data-testid="operator-unified-control-spine-path"',
  'data-testid="operator-unified-control-spine-active-surface"',
  "missionControl: React.ReactNode",
  "liveKernelCockpit: React.ReactNode",
  "executionRunway: React.ReactNode",
  "evidenceLedger: React.ReactNode",
  "diagnosticsConsole: React.ReactNode",
  'id: "mission-control"',
  'id: "live-kernel"',
  'id: "execution-runway"',
  'id: "evidence-ledger"',
  'id: "diagnostics-console"',
  "return missionControl",
  "return liveKernelCockpit",
  "return executionRunway",
  "return evidenceLedger",
  "return diagnosticsConsole",
]) {
  expectContains(component, token);
}

for (const legacyToken of [
  "ADJUTORIX_OPERATOR_SURFACE_SPINE",
  'data-testid="operator-surface-spine"',
  'data-testid="operator-surface-spine-posture"',
  'data-testid="operator-surface-spine-path"',
  'data-testid="operator-surface-spine-active-surface"',
  'data-testid="operator-surface-spine-step-mission-control"',
  'data-testid="operator-surface-spine-step-live-kernel"',
  'data-testid="operator-surface-spine-step-execution-runway"',
  'data-testid="operator-surface-spine-step-evidence-finality"',
  "evidence-finality",
]) {
  expectContains(component, legacyToken);
}

const appPath = "packages/adjutorix-app/src/renderer/App.tsx";
const spineInvocation = extractSpineInvocation(appPath);

const boundProps = {};
for (const propName of [
  "missionControl",
  "liveKernelCockpit",
  "executionRunway",
  "evidenceLedger",
  "diagnosticsConsole",
]) {
  boundProps[propName] = extractJsxPropExpression(spineInvocation, propName);
}

for (const [propName, expression] of Object.entries(boundProps)) {
  if (/^(undefined|null|false)$/m.test(expression)) {
    fail("V090_FINALITY_APP_SPINE_PROP_INVALID_EXPRESSION", { propName, expression });
  }
}

expectSingleOccurrence(appPath, "evidenceLedger=");
expectSingleOccurrence(appPath, "diagnosticsConsole=");

const requiredPropOrder = [
  "missionControl",
  "liveKernelCockpit",
  "executionRunway",
  "evidenceLedger",
  "diagnosticsConsole",
];

let previousIndex = -1;
for (const propName of requiredPropOrder) {
  const index = spineInvocation.indexOf(`${propName}=`);
  if (index < 0) fail("V090_FINALITY_APP_SPINE_PROP_MISSING", { propName });
  if (index <= previousIndex) {
    fail("V090_FINALITY_APP_SPINE_PROP_ORDER_BROKEN", {
      propName,
      previousIndex,
      index,
    });
  }
  previousIndex = index;
}

const unifiedTest = "packages/adjutorix-app/tests/renderer/operator_unified_control_spine_contract.test.ts";
for (const token of [
  "operator unified control spine contract",
  "evidence ledger",
  "diagnostics",
  "scattered siblings",
]) {
  expectContains(unifiedTest, token);
}

expectContains("packages/adjutorix-app/vitest.config.mjs", "operator_unified_control_spine_contract.test.ts");
expectContains("scripts/product/assert-operator-unified-control-spine.mjs", "ADJUTORIX_OPERATOR_UNIFIED_CONTROL_SPINE_READINESS");

const readiness = JSON.parse(read("reports/current/operator-unified-control-spine-readiness.json"));
if (readiness.ok !== true) fail("V090_FINALITY_READINESS_NOT_OK", readiness);

const report = {
  ok: true,
  finality: "ADJUTORIX_V090_OPERATOR_UNIFIED_CONTROL_SPINE_FINALITY",
  protectedTag,
  protectedSha,
  guardedSurface: "operator-unified-control-spine",
  guardedCommit: protectedSha,
  boundProps,
  invariants: [
    "v0.9.0 tag remains locked",
    "mission control remains bound into the spine",
    "live kernel remains bound into the spine without assuming JSX component names",
    "execution runway remains bound into the spine",
    "evidence ledger remains bound into the spine",
    "diagnostics console remains bound into the spine",
    "legacy v0.6.0 surface-spine finality tokens remain preserved",
    "ledger and diagnostics are not reintroduced as scattered siblings",
    "nested self-closing JSX inside prop expressions cannot truncate the guard scanner",
  ],
  requiredFiles,
};

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log("ADJUTORIX_V090_OPERATOR_UNIFIED_CONTROL_SPINE_FINALITY=PASS");
console.log(`REPORT=${reportPath}`);
