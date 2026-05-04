#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX generated-artifact discipline guard
#
# Purpose:
# - fail fast when generated, packaged, cached, or machine-local artifacts leak into source-controlled surfaces
# - enforce a clean boundary between authoritative source files and derived outputs
# - catch both tracked and untracked artifact residue that would make verification, diffs, and replay claims ambiguous
# - provide deterministic, auditable reasons for every blocked artifact class

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT_DIR"

readonly SCRIPT_DIR
readonly ROOT_DIR

CONSTITUTION_CHECKER="${ROOT_DIR}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT_DIR}/.tmp/ci/guard_generated_artifacts/constitution-report.json"
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_TRACKED_CHECK="${STRICT_TRACKED_CHECK:-1}"
STRICT_UNTRACKED_CHECK="${STRICT_UNTRACKED_CHECK:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/generated-artifacts.allowlist}"


constitution_stratum_for_path() {
  local rel_path="${1#./}"
  local root_dir="${ROOT_DIR:-${ROOT:-$(git rev-parse --show-toplevel)}}"

  node "$root_dir/scripts/lib/constitution-classifier.mjs" "$root_dir" "$rel_path"
}

classify_generated_artifact_from_constitution() {
  local rel_path="${1#./}"
  local stratum

  stratum="$(constitution_stratum_for_path "$rel_path")"

  case "$stratum" in
    "ephemeral/runtime")
      printf '%s
' "runtime-ephemeral"
      ;;
    "release/distributable")
      printf '%s
' "release-distributable"
      ;;
    "forbidden")
      printf '%s
' "forbidden-surface"
      ;;
    "derived/build")
      case "$rel_path" in
        packages/*/assets/asset-manifest.json)
          # Tracked promoted manifest already exists in the current constitution baseline.
          # This preserves pre-patch guard behavior while routing build-surface identity
          # through the constitution classifier.
          return 0
          ;;
        *)
          printf '%s
' "derived-build"
          ;;
      esac
      ;;
    "authority/source"|"authority/tests"|"authority/config"|"unclassified"|"")
      return 0
      ;;
    *)
      return 0
      ;;
  esac
}

color() {
  local code="$1"
  shift
  if [[ "$FORCE_COLOR" == "0" ]]; then
    printf '%s' "$*"
  else
    printf '\033[%sm%s\033[0m' "$code" "$*"
  fi
}

log() {
  printf '%s %s\n' "$(color '36' '[adjutorix-artifacts]')" "$*"
}

ok() {
  printf '%s %s\n' "$(color '32' '[ok]')" "$*"
}

warn() {
  printf '%s %s\n' "$(color '33' '[warn]')" "$*"
}

err() {
  printf '%s %s\n' "$(color '31' '[error]')" "$*" >&2
}

die() {
  err "$*"
  exit 1
}

section() {
  printf '\n%s\n' "$(color '1;37' "== $* ==")"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_repo_root() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "Missing package.json at repo root"
  [[ -d "$ROOT_DIR/packages" ]] || die "Missing packages/ directory"
  [[ -d "$ROOT_DIR/configs/ci" ]] || die "Missing configs/ci directory"
}

load_allow_patterns() {
  local patterns=()
  if [[ -f "$ALLOWLIST_FILE" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      patterns+=("$line")
    done < "$ALLOWLIST_FILE"
  fi
  printf '%s\n' "${patterns[@]:-}"
}

matches_allowlist() {
  local path="$1"
  shift || true
  local pattern
  for pattern in "$@"; do
    [[ -z "$pattern" ]] && continue
    if [[ "$path" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

classify_generated_path() {
  local path="$1"

  case "$(classify_generated_artifact_from_constitution "${path}")" in
    runtime-ephemeral|release-distributable|forbidden-surface|derived-build)
      classify_generated_artifact_from_constitution "${path}"
      ;;
    *)
      return 1
      ;;
  esac
}

collect_tracked_generated_paths() {
  git ls-files -z | while IFS= read -r -d '' path; do
    if artifact_class="$(classify_generated_path "$path")"; then
      printf '%s\t%s\n' "$artifact_class" "$path"
    fi
  done
}

collect_untracked_generated_paths() {
  git ls-files --others --exclude-standard -z | while IFS= read -r -d '' path; do
    if artifact_class="$(classify_generated_path "$path")"; then
      printf '%s\t%s\n' "$artifact_class" "$path"
    fi
  done
}

collect_dirty_generated_paths() {
  git status --porcelain=v1 -z | while IFS= read -r -d '' entry; do
    local meta path
    meta="${entry:0:3}"
    path="${entry:3}"
    if artifact_class="$(classify_generated_path "$path")"; then
      printf '%s\t%s\t%s\n' "$artifact_class" "$meta" "$path"
    fi
  done
}

print_blocked_table() {
  local title="$1"
  shift
  local rows=("$@")
  [[ "${#rows[@]}" -gt 0 ]] || return 0

  printf '%s\n' "$(color '1;31' "$title")"
  printf '  %-28s %s\n' 'artifact-class' 'path'
  printf '  %-28s %s\n' '--------------' '----'
  local row klass path
  for row in "${rows[@]}"; do
    klass="${row%%$'\t'*}"
    path="${row#*$'\t'}"
    printf '  %-28s %s\n' "$klass" "$path"
  done
}

print_dirty_blocked_table() {
  local title="$1"
  shift
  local rows=("$@")
  [[ "${#rows[@]}" -gt 0 ]] || return 0

  printf '%s\n' "$(color '1;31' "$title")"
  printf '  %-28s %-6s %s\n' 'artifact-class' 'status' 'path'
  printf '  %-28s %-6s %s\n' '--------------' '------' '----'
  local row klass meta path rest
  for row in "${rows[@]}"; do
    klass="${row%%$'\t'*}"
    rest="${row#*$'\t'}"
    meta="${rest%%$'\t'*}"
    path="${rest#*$'\t'}"
    printf '  %-28s %-6s %s\n' "$klass" "$meta" "$path"
  done
}

main() {
  section "Generated artifact discipline"
  require_cmd git
  require_cmd node
  require_repo_root

  section "Repository constitution preflight"
  [[ -x "$CONSTITUTION_CHECKER" ]] || die "Missing executable constitution checker: $CONSTITUTION_CHECKER"
  run_constitution_output="$(node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT")"
  printf '%s\n' "$run_constitution_output"

  local allow_patterns=()
  local allow_pattern
  while IFS= read -r allow_pattern; do
    [[ -z "$allow_pattern" ]] && continue
    allow_patterns+=("$allow_pattern")
  done < <(load_allow_patterns)

  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No generated-artifact allowlist entries loaded"
  fi

  local tracked_raw=()
  local tracked_blocked=()
  local untracked_raw=()
  local untracked_blocked=()
  local dirty_raw=()
  local dirty_blocked=()
  local line class path rest meta

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    tracked_raw+=("$line")
  done < <(collect_tracked_generated_paths)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    class="${line%%$'\t'*}"
    path="${line#*$'\t'}"
    [[ -z "$class" ]] && continue
    if ! matches_allowlist "$path" ${allow_patterns[@]+"${allow_patterns[@]}"}; then
      tracked_blocked+=("$class"$'\t'"$path")
    fi
  done < <(printf '%s\n' "${tracked_raw[@]:-}")

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    untracked_raw+=("$line")
  done < <(collect_untracked_generated_paths)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    class="${line%%$'\t'*}"
    path="${line#*$'\t'}"
    [[ -z "$class" ]] && continue
    if ! matches_allowlist "$path" ${allow_patterns[@]+"${allow_patterns[@]}"}; then
      untracked_blocked+=("$class"$'\t'"$path")
    fi
  done < <(printf '%s\n' "${untracked_raw[@]:-}")

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    dirty_raw+=("$line")
  done < <(collect_dirty_generated_paths)

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    class="${line%%$'\t'*}"
    rest="${line#*$'\t'}"
    meta="${rest%%$'\t'*}"
    path="${rest#*$'\t'}"
    [[ -z "$class" ]] && continue
    if ! matches_allowlist "$path" ${allow_patterns[@]+"${allow_patterns[@]}"}; then
      dirty_blocked+=("$class"$'\t'"$meta"$'\t'"$path")
    fi
  done < <(printf '%s\n' "${dirty_raw[@]:-}")

  if [[ "$STRICT_TRACKED_CHECK" == "1" && "${#tracked_blocked[@]}" -gt 0 ]]; then
    print_blocked_table "Tracked generated artifacts detected" "${tracked_blocked[@]}"
    die "Tracked generated/package/cache artifacts are present in source-controlled paths."
  elif [[ "${#tracked_blocked[@]}" -gt 0 ]]; then
    print_blocked_table "Tracked generated artifacts detected (warning only)" "${tracked_blocked[@]}"
    warn "Tracked generated artifacts detected but STRICT_TRACKED_CHECK=$STRICT_TRACKED_CHECK"
  fi

  if [[ "$STRICT_UNTRACKED_CHECK" == "1" && "${#untracked_blocked[@]}" -gt 0 ]]; then
    print_blocked_table "Untracked generated artifacts detected" "${untracked_blocked[@]}"
    die "Untracked generated/package/cache artifacts are present and would pollute verification surfaces."
  elif [[ "${#untracked_blocked[@]}" -gt 0 ]]; then
    print_blocked_table "Untracked generated artifacts detected (warning only)" "${untracked_blocked[@]}"
    warn "Untracked generated artifacts detected but STRICT_UNTRACKED_CHECK=$STRICT_UNTRACKED_CHECK"
  fi

  if [[ "${#dirty_blocked[@]}" -gt 0 ]]; then
    print_dirty_blocked_table "Dirty generated artifacts detected" "${dirty_blocked[@]}"
    die "Generated/package/cache artifacts are modified or staged, making repository truth ambiguous."
  fi

  ok "No blocked generated artifacts detected"
}

main "$@"
