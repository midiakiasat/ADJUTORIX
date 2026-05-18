#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
CSS="packages/adjutorix-app/src/renderer/native-workbench.css"

echo "=== V14 SOURCE CONTRACT ==="
grep -q 'ADJUTORIX_NATIVE_PRODUCT_WORKBENCH_V14' "$SRC"
grep -q 'const TASKS' "$SRC"
grep -q 'COMMAND_PATHS' "$SRC"
grep -q 'READ_PATHS' "$SRC"
grep -q 'WRITE_PATHS' "$SRC"
grep -q 'writeAgentContext' "$SRC"
grep -q 'runGrep' "$SRC"
grep -q 'parseProblems' "$SRC"
grep -q 'diffOf' "$SRC"
grep -q 'outlineOf' "$SRC"
grep -q 'importsOf' "$SRC"
grep -q 'v14-shell' "$CSS"
grep -q 'v14-palette' "$CSS"
echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUILD ==="
pnpm --dir packages/adjutorix-app run build

echo
echo "=== BUNDLE CONTRACT ==="
test -f packages/adjutorix-app/dist/main/index.js
test -f packages/adjutorix-app/dist/preload/preload.mjs
test -f packages/adjutorix-app/dist/renderer/index.html
grep -R "ADJUTORIX_NATIVE_PRODUCT_WORKBENCH_V14" packages/adjutorix-app/dist/renderer/assets >/dev/null
echo "BUNDLE_CONTRACT_OK=true"

echo
echo "ADJUTORIX_NATIVE_PRODUCT_WORKBENCH_V14_GATE_PASS=true"
