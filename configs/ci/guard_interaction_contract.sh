#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[guard:interaction_contract] no capture overlay"
./configs/ci/guard_renderer_release_surface.sh

echo "[guard:interaction_contract] interaction contract source exists"
test -f packages/adjutorix-app/src/renderer/lib/interaction_contract.ts
test -f packages/adjutorix-app/tests/renderer/interaction_contract.test.tsx

echo "[guard:interaction_contract] no misleading dead-entry copy"
BAD="$(
  grep -RInE 'Start from the surface you need|Open a workspace, inspect diagnostics first' \
    packages/adjutorix-app/src/renderer \
    --include='*.ts' --include='*.tsx' 2>/dev/null || true
)"
if [ -n "$BAD" ]; then
  printf '%s\n' "$BAD"
  exit 1
fi

echo "[guard:interaction_contract] pass"
