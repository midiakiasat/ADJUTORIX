#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT"

CONSTITUTION_CHECKER="${ROOT}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT}/.tmp/ci/guard_renderer_release_surface/constitution-report.json"

printf '
== Repository constitution preflight ==
'
test -x "$CONSTITUTION_CHECKER"
node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT"

constitution_stratum_for_path() {
  local rel_path="${1#./}"
  node "$ROOT/scripts/lib/constitution-classifier.mjs" "$ROOT" "$rel_path"
}

should_skip_renderer_release_source_scan() {
  local rel_path="${1#./}"
  local stratum

  case "$rel_path" in
    */tests/*|*/quarantine/*|packages/adjutorix-app/src/renderer/lib/release_surface_guard.ts)
      return 0
      ;;
  esac

  stratum="$(constitution_stratum_for_path "$rel_path" || printf 'unclassified')"

  case "$stratum" in
    "authority/tests"|"ephemeral/runtime"|"derived/build"|"release/distributable"|"forbidden")
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

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
  while IFS= read -r -d '' path; do
    rel_path="${path#./}"
    if should_skip_renderer_release_source_scan "$rel_path"; then
      continue
    fi
    grep -HnE 'click\(capture\)|pointerdown\(capture\)|pointerup\(capture\)|pointermove\(capture\)|target=.*xy=' "$path" 2>/dev/null || true
  done < <(
    find packages/adjutorix-app/src/renderer \
      -type f \( -name '*.ts' -o -name '*.tsx' \) \
      -print0
  )
)"
if [ -n "$SOURCE_BAD" ]; then
  printf '%s\n' "$SOURCE_BAD"
  exit 1
fi

echo "[guard:renderer_release_surface] pass"
