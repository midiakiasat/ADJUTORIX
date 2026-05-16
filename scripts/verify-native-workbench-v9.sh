#!/usr/bin/env bash
set -euo pipefail

SRC="packages/adjutorix-app/src/renderer/RevolutionWorkbench.tsx"
MAIN="packages/adjutorix-app/src/renderer/main.tsx"
CSS="packages/adjutorix-app/src/renderer/native-workbench.css"
ASSET_DIR="packages/adjutorix-app/dist/renderer/assets"

check_file() {
  test -f "$1" || { echo "MISSING_FILE=$1"; exit 1; }
}

check_src() {
  local pattern="$1"
  if ! grep -Fq "$pattern" "$SRC"; then
    echo "MISSING_SOURCE_PATTERN=$pattern"
    exit 1
  fi
}

check_src_any() {
  local label="$1"
  shift
  for pattern in "$@"; do
    if grep -Fq "$pattern" "$SRC"; then
      echo "SOURCE_OK=$label => $pattern"
      return 0
    fi
  done
  echo "MISSING_SOURCE_ANY=$label"
  printf '  tried: %s\n' "$@"
  exit 1
}

echo "=== SOURCE CONTRACT ==="
check_file "$SRC"
check_file "$MAIN"
check_file "$CSS"

check_src "ADJUTORIX_NATIVE_IDE_WORKBENCH_V9"
check_src "shell.execute"
check_src "workspace.readFile"
check_src "workspace.writeFile"
check_src "workspace.open"
check_src "native-agent-context.md"
check_src "QUICK_COMMANDS"
check_src "CAPABILITIES"

check_src_any "command bridge collection" \
  "COMMAND_BRIDGES" \
  "COMMAND_BRIDGE" \
  "COMMAND_BRIDGE_PATHS" \
  "commandBridges" \
  "commandBridgePaths"

check_src_any "agent context writer" \
  "writeAgentContext" \
  "writeAgentHandoff" \
  "native-agent-context.md"

grep -Fq 'native-workbench.css' "$MAIN" || { echo "MAIN_DOES_NOT_IMPORT_NATIVE_CSS=true"; exit 1; }

echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUNDLE CONTRACT ==="
test -n "$(ls "$ASSET_DIR"/*.js 2>/dev/null)" || { echo "MISSING_JS_BUNDLE=true"; exit 1; }
test -n "$(ls "$ASSET_DIR"/*.css 2>/dev/null)" || { echo "MISSING_CSS_BUNDLE=true"; exit 1; }

node <<'NODE'
const fs = require("node:fs");
const path = require("node:path");

const dir = "packages/adjutorix-app/dist/renderer/assets";

const js = fs.readdirSync(dir)
  .filter((file) => file.endsWith(".js"))
  .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
  .join("\n");

const css = fs.readdirSync(dir)
  .filter((file) => file.endsWith(".css"))
  .map((file) => fs.readFileSync(path.join(dir, file), "utf8"))
  .join("\n");

const requiredJs = [
  "ADJUTORIX_NATIVE_IDE_WORKBENCH_V9",
  "shell.execute",
  "workspace.writeFile",
  "workspace.readFile",
  "workspace.open",
  "native-agent-context.md",
  "Open workspace",
  "command palette",
  "SCM status",
  "Build app",
  "Typecheck app",
];

for (const marker of requiredJs) {
  if (!js.includes(marker)) {
    console.error(`MISSING_BUNDLE_RUNTIME_STRING=${marker}`);
    process.exit(1);
  }
}

const requiredCss = [
  "adj-root",
  "adj-shell",
  "adj-main",
  "adj-editor",
  "adj-palette",
];

for (const marker of requiredCss) {
  if (!css.includes(marker)) {
    console.error(`MISSING_CSS_MARKER=${marker}`);
    process.exit(1);
  }
}

const forbidden = [
  "Open Visual Studio Code",
  "Open Cursor",
  "Antigravity",
  "launcher toy",
  "BROKEN_OR_TOY_ROUTE",
  "TOY_SURFACE_STILL_PRESENT",
];

for (const marker of forbidden) {
  if (js.includes(marker) || css.includes(marker)) {
    console.error(`FORBIDDEN_MARKER=${marker}`);
    process.exit(1);
  }
}

console.log("BUNDLE_CONTRACT_OK=true");
NODE

echo
echo "=== DEAD SURFACE CONTRACT ==="
if rg -n "Open Visual Studio Code|Open Cursor|Antigravity|launcher toy|BROKEN_OR_TOY_ROUTE|TOY_SURFACE_STILL_PRESENT" \
  packages/adjutorix-app/src/renderer \
  packages/adjutorix-app/dist/renderer/assets/*.js \
  packages/adjutorix-app/dist/renderer/assets/*.css; then
  echo "DEAD_SURFACE_STILL_PRESENT=true"
  exit 1
fi

echo "ADJUTORIX_NATIVE_WORKBENCH_V9_GATE_PASS=true"
