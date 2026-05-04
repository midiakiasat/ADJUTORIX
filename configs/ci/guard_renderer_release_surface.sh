#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT"

CONSTITUTION_CHECKER="${ROOT}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT}/.tmp/ci/guard_renderer_release_surface/constitution-report.json"

echo "[guard:renderer_release_surface] constitution"
test -x "$CONSTITUTION_CHECKER"
node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT"

echo "[guard:renderer_release_surface] no runtime sanitizer import"
IMPORT_BAD="$(
  grep -RInE 'release_surface_guard|installReleaseSurfaceGuard' \
    packages/adjutorix-app/src/renderer \
    --include='*.ts' --include='*.tsx' 2>/dev/null \
    | grep -v 'src/renderer/lib/release_surface_guard.ts' || true
)"
if [ -n "$IMPORT_BAD" ]; then
  printf '%s\n' "$IMPORT_BAD"
  exit 1
fi

echo "[guard:renderer_release_surface] no shipped capture overlay source"
SOURCE_BAD="$(
  find packages/adjutorix-app/src/renderer \
    -type f \( -name '*.ts' -o -name '*.tsx' \) \
    ! -path '*/tests/*' \
    ! -path '*/quarantine/*' \
    ! -path '*/lib/release_surface_guard.ts' \
    -print0 \
  | xargs -0 grep -RInE 'click\(capture\)|pointerdown\(capture\)|pointerup\(capture\)|pointermove\(capture\)|target=.*xy=' 2>/dev/null || true
)"
if [ -n "$SOURCE_BAD" ]; then
  printf '%s\n' "$SOURCE_BAD"
  exit 1
fi

echo "[guard:renderer_release_surface] pass"
