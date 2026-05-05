#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ROOT_DIR="$ROOT"
cd "$ROOT"

readonly ROOT ROOT_DIR
CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_interaction_contract/constitution-report.json}"

run_constitution_preflight() {
  printf '\n== Repository constitution preflight ==\n'
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "[error] Required command not found: node" >&2
    return 1
  fi
  if [[ ! -x "$CONSTITUTION_CHECKER" ]]; then
    printf '%s\n' "[error] Missing executable constitution checker: $CONSTITUTION_CHECKER" >&2
    return 1
  fi
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --root "$ROOT_DIR" --json --out "$CONSTITUTION_REPORT"
}


constitution_stratum_for_path() {
  local rel_path="${1#./}"
  node "$ROOT_DIR/scripts/lib/constitution-classifier.mjs" "$ROOT_DIR" "$rel_path"
}

assert_constitution_stratum() {
  local rel_path="${1#./}"
  local expected="$2"
  local stratum

  stratum="$(constitution_stratum_for_path "$rel_path" || printf 'unclassified')"
  if [[ "$stratum" != "$expected" ]]; then
    printf '[guard:interaction_contract] expected %s for %s, got %s\n' "$expected" "$rel_path" "$stratum" >&2
    return 1
  fi
}

run_constitution_preflight

echo "[guard:interaction_contract] no capture overlay"
./configs/ci/guard_renderer_release_surface.sh

echo "[guard:interaction_contract] interaction contract source exists"
test -f packages/adjutorix-app/src/renderer/lib/interaction_contract.ts
test -f packages/adjutorix-app/tests/renderer/interaction_contract.test.tsx

echo "[guard:interaction_contract] interaction contract surfaces are constitutional authority"
assert_constitution_stratum "packages/adjutorix-app/src/renderer/lib/interaction_contract.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/tests/renderer/interaction_contract.test.tsx" "authority/tests"

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
