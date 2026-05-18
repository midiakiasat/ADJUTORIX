#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SRC="packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
CSS="packages/adjutorix-app/src/renderer/native-workbench.css"
MAIN="packages/adjutorix-app/src/renderer/main.tsx"

echo "=== V17 SOURCE CONTRACT ==="
grep -q 'ADJUTORIX_NATIVE_PORTFOLIO_WORKBENCH_V17' "$SRC"
grep -q 'Open any folder' "$SRC"
grep -q 'Discover workspaces' "$SRC"
grep -q 'buildTools' "$SRC"
grep -q 'package.json' "$SRC"
grep -q 'pyproject.toml' "$SRC"
grep -q '.github/workflows' "$SRC"
grep -q 'externalWorkspaceV16' "$SRC"
grep -q 'NativeControlPlaneWorkbench' "$MAIN"

! grep -q 'Open core product surfaces' "$SRC"
! grep -q 'ADJUTORIX Agent Context' "$SRC"
! grep -q 'Produce the next concrete patch' "$SRC"

grep -q '.v17-shell' "$CSS"
grep -q '.v17-inspector' "$CSS"
echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUILD ==="
pnpm --dir packages/adjutorix-app run build

echo
echo "=== BUNDLE CONTRACT ==="
test -f packages/adjutorix-app/dist/main/index.js
test -f packages/adjutorix-app/dist/main/native-external-workspace-v16.js
test -f packages/adjutorix-app/dist/preload/preload.mjs
test -f packages/adjutorix-app/dist/renderer/index.html
grep -R 'ADJUTORIX_NATIVE_PORTFOLIO_WORKBENCH_V17' packages/adjutorix-app/dist/renderer/assets >/dev/null
grep -R 'Discover workspaces' packages/adjutorix-app/dist/renderer/assets >/dev/null
echo "BUNDLE_CONTRACT_OK=true"

echo
echo "ADJUTORIX_NATIVE_PORTFOLIO_WORKBENCH_V17_GATE_PASS=true"
