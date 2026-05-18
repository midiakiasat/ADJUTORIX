#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "=== V13 SOURCE CONTRACT ==="
grep -q "ADJUTORIX_NATIVE_CONTROL_PLANE_V13" "$ROOT/packages/adjutorix-app/src/main/native-control-plane-v13.ts"
grep -q "adjutorix:v13:command:run" "$ROOT/packages/adjutorix-app/src/main/native-control-plane-v13.ts"
grep -q "adjutorixNativeV13" "$ROOT/packages/adjutorix-app/src/preload/preload.ts"
grep -q "ADJUTORIX_NATIVE_CONTROL_PLANE_WORKBENCH_V13" "$ROOT/packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
grep -q "native().runCommand" "$ROOT/packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
grep -q "native().readFile" "$ROOT/packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
grep -q "native().writeFile" "$ROOT/packages/adjutorix-app/src/renderer/NativeControlPlaneWorkbench.tsx"
echo "SOURCE_CONTRACT_OK=true"

echo
echo "=== BUILD ==="
pnpm --dir "$ROOT/packages/adjutorix-app" run build

echo
echo "=== BUNDLE CONTRACT ==="
test -f "$ROOT/packages/adjutorix-app/dist/main/index.js"
test -f "$ROOT/packages/adjutorix-app/dist/preload/preload.mjs"
test -f "$ROOT/packages/adjutorix-app/dist/renderer/index.html"
grep -R "ADJUTORIX_NATIVE_CONTROL_PLANE_WORKBENCH_V13" "$ROOT/packages/adjutorix-app/dist/renderer/assets" >/dev/null
grep -R "ADJUTORIX_NATIVE_CONTROL_PLANE_V13" "$ROOT/packages/adjutorix-app/dist/main" >/dev/null
grep -R "ADJUTORIX_NATIVE_PRELOAD_V13" "$ROOT/packages/adjutorix-app/dist/preload" >/dev/null
echo "BUNDLE_CONTRACT_OK=true"

echo
echo "ADJUTORIX_NATIVE_CONTROL_PLANE_V13_GATE_PASS=true"
