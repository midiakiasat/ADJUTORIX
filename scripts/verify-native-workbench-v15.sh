#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
CSS="packages/adjutorix-app/src/renderer/native-workbench.css"

echo "=== V15 SOURCE CONTRACT ==="
grep -q 'ADJUTORIX_NATIVE_ALL_TOOLS_WORKBENCH_V15' "$SRC"
grep -q 'TOOL_SEEDS' "$SRC"
grep -q 'discoveredTools' "$SRC"
grep -q 'scriptTool' "$SRC"
grep -q 'surfaceFiles' "$SRC"
grep -q 'openCoreSurfaces' "$SRC"
grep -q 'writeAgentContext' "$SRC"
grep -q 'Agent, Verify, Patch, Ledger, Transaction' "$SRC"
grep -q 'v15-shell' "$CSS"
grep -q 'v15-toolgrid' "$CSS"
grep -q 'v15-domain-grid' "$CSS"
echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUILD ==="
pnpm --dir packages/adjutorix-app run build

echo
echo "=== BUNDLE CONTRACT ==="
test -f packages/adjutorix-app/dist/main/index.js
test -f packages/adjutorix-app/dist/preload/preload.mjs
test -f packages/adjutorix-app/dist/renderer/index.html
grep -R "ADJUTORIX_NATIVE_ALL_TOOLS_WORKBENCH_V15" packages/adjutorix-app/dist/renderer/assets >/dev/null
echo "BUNDLE_CONTRACT_OK=true"

echo
echo "ADJUTORIX_NATIVE_ALL_TOOLS_WORKBENCH_V15_GATE_PASS=true"
