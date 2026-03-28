#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX workspace cleanliness guard
#
# Purpose:
# - fail fast when the repository workspace is not in a trustworthy baseline state for verification or packaging
# - distinguish acceptable ignored residue from dangerous tracked, staged, modified, or policy-sensitive files
# - make workspace ambiguity explicit before any verify/replay/build step claims authoritative results
# - provide one canonical cleanliness judgment for local and CI entrypoints

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_UNTRACKED="${STRICT_UNTRACKED:-1}"
STRICT_IGNORED="${STRICT_IGNORED:-0}"
STRICT_SUBMODULES="${STRICT_SUBMODULES:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/workspace-clean.allowlist}"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-workspace-clean]')" "$*"
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
  git rev-parse --show-toplevel >/dev/null 2>&1 || die "Current directory is not inside a git worktree"
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
  local candidate="$1"
  shift || true
  local pattern
  for pattern in "$@"; do
    [[ -z "$pattern" ]] && continue
    if [[ "$candidate" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

collect_status_rows() {
  git status --porcelain=v1 -z | while IFS= read -r -d '' row; do
    local meta path
    meta="${row:0:3}"
    path="${row:3}"
    printf '%s\t%s\n' "$meta" "$path"
  done
}

collect_untracked_rows() {
  git ls-files --others --exclude-standard -z | while IFS= read -r -d '' path; do
    printf '%s\n' "$path"
  done
}

collect_ignored_rows() {
  git ls-files --others -i --exclude-standard -z | while IFS= read -r -d '' path; do
    printf '%s\n' "$path"
  done
}

collect_submodule_rows() {
  if [[ -f "$ROOT_DIR/.gitmodules" ]]; then
    git submodule status --recursive || true
  fi
}

classify_path_risk() {
  local path="$1"
  case "$path" in
    dist/*|build/*|out/*|coverage/*|.tmp/*|tmp/*|node_modules/*|*.pyc|__pycache__/*|*.tsbuildinfo)
      printf 'generated'
      ;;
    *.dmg|*.pkg|*.app|*.zip|*.whl|*.tar.gz)
      printf 'packaging'
      ;;
    package-lock.json|pyproject.toml|package.json|*.yml|*.yaml|*.sh|*.ts|*.tsx|*.py|*.json|*.md)
      printf 'source'
      ;;
    *)
      printf 'unknown'
      ;;
  esac
}

print_status_table() {
  local title="$1"
  shift
  local rows=("$@")
  [[ "${#rows[@]}" -gt 0 ]] || return 0

  printf '%s\n' "$(color '1;31' "$title")"
  printf '  %-8s %-14s %s\n' 'status' 'risk' 'path'
  printf '  %-8s %-14s %s\n' '------' '----' '----'

  local row meta path risk
  for row in "${rows[@]}"; do
    meta="${row%%$'\t'*}"
    path="${row#*$'\t'}"
    risk="$(classify_path_risk "$path")"
    printf '  %-8s %-14s %s\n' "$meta" "$risk" "$path"
  done
}

print_simple_table() {
  local title="$1"
  shift
  local rows=("$@")
  [[ "${#rows[@]}" -gt 0 ]] || return 0

  printf '%s\n' "$(color '1;31' "$title")"
  printf '  %-14s %s\n' 'risk' 'path'
  printf '  %-14s %s\n' '----' '----'

  local path risk
  for path in "${rows[@]}"; do
    risk="$(classify_path_risk "$path")"
    printf '  %-14s %s\n' "$risk" "$path"
  done
}

main() {
  section "Workspace cleanliness discipline"
  require_cmd git
  require_repo_root

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No workspace cleanliness allowlist entries loaded"
  fi

  local branch_head
  branch_head="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || true)"
  log "Evaluating workspace at $ROOT_DIR on ref ${branch_head:-detached}"

  local raw_status=()
  local raw_untracked=()
  local raw_ignored=()
  local blocked_status=()
  local blocked_untracked=()
  local blocked_ignored=()
  local candidate meta path

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    raw_status+=("$candidate")
  done < <(collect_status_rows)

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    raw_untracked+=("$candidate")
  done < <(collect_untracked_rows)

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    raw_ignored+=("$candidate")
  done < <(collect_ignored_rows)

  for candidate in "${raw_status[@]:-}"; do
    meta="${candidate%%$'\t'*}"
    path="${candidate#*$'\t'}"
    if matches_allowlist "$path" "${allow_patterns[@]}" || matches_allowlist "$meta:$path" "${allow_patterns[@]}"; then
      continue
    fi
    blocked_status+=("$candidate")
  done

  for path in "${raw_untracked[@]:-}"; do
    [[ -z "$path" ]] && continue
    if matches_allowlist "$path" "${allow_patterns[@]}" || matches_allowlist "untracked:$path" "${allow_patterns[@]}"; then
      continue
    fi
    blocked_untracked+=("$path")
  done

  for path in "${raw_ignored[@]:-}"; do
    [[ -z "$path" ]] && continue
    if matches_allowlist "$path" "${allow_patterns[@]}" || matches_allowlist "ignored:$path" "${allow_patterns[@]}"; then
      continue
    fi
    blocked_ignored+=("$path")
  done

  local submodule_output
  submodule_output="$(collect_submodule_rows)"
  if [[ "$STRICT_SUBMODULES" == "1" && -n "$submodule_output" ]]; then
    if printf '%s\n' "$submodule_output" | grep -E '^[+-U]' >/dev/null 2>&1; then
      printf '%s\n' "$submodule_output"
      die "Submodule state is not clean or synchronized."
    fi
  fi

  local failed=0

  if [[ "${#blocked_status[@]}" -gt 0 ]]; then
    print_status_table "Tracked/staged workspace dirt detected" "${blocked_status[@]}"
    failed=1
  fi

  if [[ "$STRICT_UNTRACKED" == "1" && "${#blocked_untracked[@]}" -gt 0 ]]; then
    print_simple_table "Untracked workspace residue detected" "${blocked_untracked[@]}"
    failed=1
  elif [[ "${#blocked_untracked[@]}" -gt 0 ]]; then
    print_simple_table "Untracked workspace residue detected (warning only)" "${blocked_untracked[@]}"
    warn "Untracked residue detected but STRICT_UNTRACKED=$STRICT_UNTRACKED"
  fi

  if [[ "$STRICT_IGNORED" == "1" && "${#blocked_ignored[@]}" -gt 0 ]]; then
    print_simple_table "Ignored-but-present workspace residue detected" "${blocked_ignored[@]}"
    failed=1
  elif [[ "${#blocked_ignored[@]}" -gt 0 ]]; then
    warn "Ignored workspace residue exists; tolerated because STRICT_IGNORED=$STRICT_IGNORED"
  fi

  if [[ "$failed" -ne 0 ]]; then
    die "Workspace is not clean enough to claim authoritative verification baseline."
  fi

  ok "Workspace cleanliness guard passed"
}

main "$@"
