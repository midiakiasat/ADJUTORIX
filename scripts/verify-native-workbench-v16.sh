#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
MAIN="packages/adjutorix-app/src/main/native-external-workspace-v16.ts"
PRELOAD="packages/adjutorix-app/src/preload/preload.ts"

echo "=== V16 SOURCE CONTRACT ==="
grep -q 'ADJUTORIX_NATIVE_MULTIROOT_WORKBENCH_V16' "$SRC"
grep -q 'externalWorkspaceV16' "$SRC"
grep -q 'openAnyFolder' "$SRC"
grep -q 'Open folder' "$SRC"
grep -q 'adjutorix:v16:dialog:openFolder' "$MAIN"
grep -q 'adjutorix:v16:workspace:scan' "$MAIN"
grep -q 'adjutorix:v16:file:read' "$MAIN"
grep -q 'adjutorix:v16:file:write' "$MAIN"
grep -q 'adjutorix:v16:shell:execute' "$MAIN"
grep -q 'adjutorixExternalWorkspaceV16' "$PRELOAD"
grep -q 'native-external-workspace-v16.js' packages/adjutorix-app/src/main/index.ts
echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUILD ==="
pnpm --dir packages/adjutorix-app run build

echo
echo "=== BUNDLE CONTRACT ==="
test -f packages/adjutorix-app/dist/main/native-external-workspace-v16.js
test -f packages/adjutorix-app/dist/main/index.js
test -f packages/adjutorix-app/dist/preload/preload.mjs
test -f packages/adjutorix-app/dist/renderer/index.html
grep -R "ADJUTORIX_NATIVE_MULTIROOT_WORKBENCH_V16" packages/adjutorix-app/dist/renderer/assets >/dev/null
grep -R "adjutorixExternalWorkspaceV16" packages/adjutorix-app/dist/preload >/dev/null
echo "BUNDLE_CONTRACT_OK=true"

echo
echo "ADJUTORIX_NATIVE_MULTIROOT_WORKBENCH_V16_GATE_PASS=true"
