#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX CLEAN ENTRYPOINT
#
# Purpose
# - provide one authoritative cleanup command for local development, CI reset,
#   and failure recovery
# - remove deterministic generated state, caches, logs, PID files, build
#   artifacts, temp directories, coverage outputs, and interrupted runtime
#   residue without touching governed source-of-truth files
# - make cleanup explicit, auditable, and bounded by policy
#
# Design constraints
# - no silent deletion outside repository root unless explicitly enabled
# - no ambiguous globbing; every clean target is declared and classified
# - destructive scopes require explicit flags
# - default behavior is safe-clean, not scorched-earth
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROGRAM_NAME="$(basename -- "$0")"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

readonly SCRIPT_DIR
readonly REPO_ROOT
readonly PROGRAM_NAME
readonly START_TS

###############################################################################
# DEFAULTS
###############################################################################

: "${ADJUTORIX_CLEAN_STACK_NAME:=adjutorix-clean}"
: "${ADJUTORIX_CLEAN_USE_COLOR:=true}"
: "${ADJUTORIX_CLEAN_DRY_RUN:=false}"
: "${ADJUTORIX_CLEAN_VERBOSE:=false}"
: "${ADJUTORIX_CLEAN_FORCE:=false}"
: "${ADJUTORIX_CLEAN_KILL_PROCESSES:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_NODE_MODULES:=false}"
: "${ADJUTORIX_CLEAN_REMOVE_LOCKFILES:=false}"
: "${ADJUTORIX_CLEAN_REMOVE_VENV:=false}"
: "${ADJUTORIX_CLEAN_REMOVE_PYTEST_CACHE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_MYPY_CACHE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_RUFF_CACHE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_TURBO_CACHE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_NPM_CACHE_ARTIFACTS:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_BUILD_OUTPUTS:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_LOGS:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_REPORTS:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_RUNTIME_STATE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_COVERAGE:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_SCREENSHOTS:=true}"
: "${ADJUTORIX_CLEAN_REMOVE_PACKAGING_OUTPUTS:=true}"
: "${ADJUTORIX_CLEAN_REQUIRE_REPO_GIT:=true}"
: "${ADJUTORIX_CLEAN_ALLOW_HOME_TOKEN_REMOVAL:=false}"
: "${ADJUTORIX_CLEAN_REMOVE_TOKEN_FILE:=false}"
: "${ADJUTORIX_CLEAN_ROOT_TMP:=${REPO_ROOT}/.tmp}"
: "${ADJUTORIX_CLEAN_BOOT_LOG:=${REPO_ROOT}/.tmp/clean/clean.log}"
: "${ADJUTORIX_CLEAN_REPORT_FILE:=${REPO_ROOT}/.tmp/clean/summary.txt}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE="${ADJUTORIX_CLEAN_VERBOSE}"
DRY_RUN="${ADJUTORIX_CLEAN_DRY_RUN}"
FORCE="${ADJUTORIX_CLEAN_FORCE}"
PROFILE_SAFE=true
PROFILE_DEEP=false
PROFILE_DISTCLEAN=false
REMOVED_COUNT=0
SKIPPED_COUNT=0
FAILED_COUNT=0
TARGETS=()

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_CLEAN_USE_COLOR}" != "true" || ! -t 1 ]]; then
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_CYAN=""
  C_BOLD=""
else
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_CYAN=$'\033[36m'
  C_BOLD=$'\033[1m'
fi

ensure_dir() { mkdir -p "$1"; }

log_raw() {
  local level="$1"
  shift
  local msg="$*"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_CLEAN_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_CLEAN_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/clean.sh [options]

Profiles:
  --safe              Clean generated temp/log/runtime/build residue only (default)
  --deep              Safe clean plus caches and selected heavyweight generated state
  --distclean         Deep clean plus node_modules and optional virtualenv removal

Options:
  --dry-run           Print what would be removed without deleting
  --force             Skip confirmation for destructive profiles
  --no-kill           Do not stop dev/runtime processes before cleaning
  --with-node-modules Remove node_modules
  --with-lockfiles    Remove package lockfiles and similar lock artifacts
  --with-venv         Remove .venv directories under repository root
  --with-token-file   Remove ~/.adjutorix/token (requires explicit allow env)
  --quiet             Reduce non-error terminal output
  --verbose           Emit debug logging
  --no-color          Disable ANSI colors
  --help              Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --safe)
        PROFILE_SAFE=true
        PROFILE_DEEP=false
        PROFILE_DISTCLEAN=false
        ;;
      --deep)
        PROFILE_SAFE=false
        PROFILE_DEEP=true
        PROFILE_DISTCLEAN=false
        ;;
      --distclean)
        PROFILE_SAFE=false
        PROFILE_DEEP=false
        PROFILE_DISTCLEAN=true
        ADJUTORIX_CLEAN_REMOVE_NODE_MODULES=true
        ;;
      --dry-run)
        DRY_RUN=true
        ;;
      --force)
        FORCE=true
        ;;
      --no-kill)
        ADJUTORIX_CLEAN_KILL_PROCESSES=false
        ;;
      --with-node-modules)
        ADJUTORIX_CLEAN_REMOVE_NODE_MODULES=true
        ;;
      --with-lockfiles)
        ADJUTORIX_CLEAN_REMOVE_LOCKFILES=true
        ;;
      --with-venv)
        ADJUTORIX_CLEAN_REMOVE_VENV=true
        ;;
      --with-token-file)
        ADJUTORIX_CLEAN_REMOVE_TOKEN_FILE=true
        ;;
      --quiet)
        QUIET=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_CLEAN_USE_COLOR=false
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

###############################################################################
# HELPERS
###############################################################################

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

is_true() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

path_exists() {
  [[ -e "$1" || -L "$1" ]]
}

canonicalize_parent() {
  local path="$1"
  python - "$path" <<'PY'
import os, sys
p = sys.argv[1]
parent = os.path.dirname(os.path.abspath(p)) or os.getcwd()
print(os.path.realpath(parent))
PY
}

canonicalize_path_if_exists() {
  local path="$1"
  python - "$path" <<'PY'
import os, sys
p = sys.argv[1]
if os.path.lexists(p):
    print(os.path.realpath(p))
else:
    print("")
PY
}

assert_repo_guardrails() {
  section "Validating repository and clean guardrails"
  require_command git
  require_command python
  require_command find
  require_command rm
  require_command lsof

  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
  [[ -f "$REPO_ROOT/package.json" ]] || die "Repository package.json not found: $REPO_ROOT/package.json"

  if is_true "$ADJUTORIX_CLEAN_REQUIRE_REPO_GIT"; then
    git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Repository root is not a git worktree: $REPO_ROOT"
  fi
}

prepare_runtime_dirs() {
  ensure_dir "$(dirname "$ADJUTORIX_CLEAN_BOOT_LOG")"
  ensure_dir "$(dirname "$ADJUTORIX_CLEAN_REPORT_FILE")"
  : >"$ADJUTORIX_CLEAN_BOOT_LOG"
  : >"$ADJUTORIX_CLEAN_REPORT_FILE"
}

confirm_destructive_profile_if_needed() {
  if [[ "$PROFILE_DISTCLEAN" != true && "$PROFILE_DEEP" != true ]]; then
    return 0
  fi
  if [[ "$FORCE" == true || ! -t 0 ]]; then
    return 0
  fi
  printf '%sDestructive clean profile selected. Continue? [y/N] %s' "$C_YELLOW" "$C_RESET" >&2
  local reply
  read -r reply || true
  case "${reply,,}" in
    y|yes) ;;
    *) die "Aborted by user" ;;
  esac
}

register_target() {
  local label="$1"
  local kind="$2"
  local path="$3"
  TARGETS+=("${label}|${kind}|${path}")
}

register_if_exists() {
  local label="$1"
  local kind="$2"
  local path="$3"
  if path_exists "$path"; then
    register_target "$label" "$kind" "$path"
  else
    SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
    log_debug "Skipping missing target: ${path}"
  fi
}

register_globbed_paths() {
  local label="$1"
  local kind="$2"
  shift 2
  local path
  for path in "$@"; do
    register_if_exists "$label" "$kind" "$path"
  done
}

assert_path_safe_to_remove() {
  local path="$1"
  [[ -n "$path" ]] || die "Refusing to remove empty path"
  [[ "$path" != "/" ]] || die "Refusing to remove filesystem root"
  [[ "$path" != "$HOME" ]] || die "Refusing to remove HOME"
  [[ "$path" != "$REPO_ROOT" ]] || die "Refusing to remove repository root"

  local parent_real
  parent_real="$(canonicalize_parent "$path")"
  case "$parent_real" in
    "$REPO_ROOT"|"$REPO_ROOT"/*|"$HOME/.adjutorix")
      ;;
    *)
      die "Refusing to remove path outside allowed roots: $path (parent=$parent_real)"
      ;;
  esac
}

remove_target() {
  local label="$1"
  local kind="$2"
  local path="$3"
  assert_path_safe_to_remove "$path"

  if [[ "$DRY_RUN" == true ]]; then
    log_info "[dry-run] would remove ${kind}: ${path} (${label})"
    return 0
  fi

  if [[ "$kind" == "dir" ]]; then
    rm -rf -- "$path"
  else
    rm -f -- "$path"
  fi

  REMOVED_COUNT=$((REMOVED_COUNT + 1))
  log_info "Removed ${kind}: ${path} (${label})"
}

stop_runtime_processes() {
  if ! is_true "$ADJUTORIX_CLEAN_KILL_PROCESSES"; then
    return 0
  fi

  section "Stopping known ADJUTORIX processes"
  local patterns=(
    "adjutorix_agent.server.main"
    "packages/adjutorix-app"
    "electron"
    "vite"
    "adjutorix_cli"
  )
  local pattern
  for pattern in "${patterns[@]}"; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      log_warn "Stopping processes matching: $pattern"
      pkill -f "$pattern" || true
    fi
  done
}

###############################################################################
# TARGET DISCOVERY
###############################################################################

collect_safe_targets() {
  section "Collecting safe-clean targets"

  if is_true "$ADJUTORIX_CLEAN_REMOVE_RUNTIME_STATE"; then
    register_if_exists runtime_tmp dir "$REPO_ROOT/.tmp"
    register_if_exists test_results dir "$REPO_ROOT/test-results"
    register_if_exists playwright_report dir "$REPO_ROOT/playwright-report"
    register_if_exists coverage_dir dir "$REPO_ROOT/coverage"
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_LOGS"; then
    register_if_exists root_log_dir dir "$REPO_ROOT/logs"
    while IFS= read -r -d '' f; do
      register_target log_file file "$f"
    done < <(find "$REPO_ROOT" -type f \( -name '*.log' -o -name '*.log.jsonl' \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_REPORTS"; then
    while IFS= read -r -d '' d; do
      register_target report_dir dir "$d"
    done < <(find "$REPO_ROOT" -type d \( -name '.pytest_cache' -o -name '.mypy_cache' -o -name '.ruff_cache' -o -name '.turbo' \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_COVERAGE"; then
    while IFS= read -r -d '' f; do
      register_target coverage_file file "$f"
    done < <(find "$REPO_ROOT" -maxdepth 4 -type f \( -name '.coverage' -o -name 'coverage-final.json' -o -name 'lcov.info' \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_BUILD_OUTPUTS"; then
    while IFS= read -r -d '' d; do
      register_target build_dir dir "$d"
    done < <(find "$REPO_ROOT" -type d \( -name dist -o -name build -o -name out -o -name .vite \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_SCREENSHOTS"; then
    while IFS= read -r -d '' d; do
      register_target screenshot_dir dir "$d"
    done < <(find "$REPO_ROOT" -type d \( -name '__screenshots__' -o -name '__image_snapshots__' \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_PACKAGING_OUTPUTS"; then
    register_if_exists release_dir dir "$REPO_ROOT/release"
    register_if_exists artifacts_dir dir "$REPO_ROOT/artifacts"
  fi

  while IFS= read -r -d '' f; do
    register_target pid_file file "$f"
  done < <(find "$REPO_ROOT" -type f \( -name '*.pid' -o -name '*.pid.lock' \) -print0 2>/dev/null || true)
}

collect_deep_targets() {
  section "Collecting deep-clean targets"

  if is_true "$ADJUTORIX_CLEAN_REMOVE_NPM_CACHE_ARTIFACTS"; then
    while IFS= read -r -d '' d; do
      register_target npm_cache_dir dir "$d"
    done < <(find "$REPO_ROOT" -type d \( -name .cache -o -name .parcel-cache -o -name .eslintcache \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_PYTEST_CACHE"; then
    while IFS= read -r -d '' d; do
      register_target pytest_cache dir "$d"
    done < <(find "$REPO_ROOT" -type d -name .pytest_cache -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_MYPY_CACHE"; then
    while IFS= read -r -d '' d; do
      register_target mypy_cache dir "$d"
    done < <(find "$REPO_ROOT" -type d -name .mypy_cache -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_RUFF_CACHE"; then
    while IFS= read -r -d '' d; do
      register_target ruff_cache dir "$d"
    done < <(find "$REPO_ROOT" -type d -name .ruff_cache -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_TURBO_CACHE"; then
    while IFS= read -r -d '' d; do
      register_target turbo_cache dir "$d"
    done < <(find "$REPO_ROOT" -type d -name .turbo -print0 2>/dev/null || true)
  fi
}

collect_distclean_targets() {
  section "Collecting distclean targets"

  if is_true "$ADJUTORIX_CLEAN_REMOVE_NODE_MODULES"; then
    while IFS= read -r -d '' d; do
      register_target node_modules dir "$d"
    done < <(find "$REPO_ROOT" -type d -name node_modules -prune -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_LOCKFILES"; then
    while IFS= read -r -d '' f; do
      register_target lockfile file "$f"
    done < <(find "$REPO_ROOT" -maxdepth 4 -type f \( -name package-lock.json -o -name pnpm-lock.yaml -o -name yarn.lock \) -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_VENV"; then
    while IFS= read -r -d '' d; do
      register_target venv dir "$d"
    done < <(find "$REPO_ROOT" -type d \( -name .venv -o -name venv \) -prune -print0 2>/dev/null || true)
  fi

  if is_true "$ADJUTORIX_CLEAN_REMOVE_TOKEN_FILE"; then
    if ! is_true "$ADJUTORIX_CLEAN_ALLOW_HOME_TOKEN_REMOVAL"; then
      die "Refusing to remove ~/.adjutorix/token without ADJUTORIX_CLEAN_ALLOW_HOME_TOKEN_REMOVAL=true"
    fi
    register_if_exists home_token file "$HOME/.adjutorix/token"
  fi
}

sort_and_deduplicate_targets() {
  if ((${#TARGETS[@]} == 0)); then
    return 0
  fi
  mapfile -t TARGETS < <(printf '%s
' "${TARGETS[@]}" | awk '!seen[$0]++')
}

###############################################################################
# EXECUTION
###############################################################################

execute_clean() {
  section "Executing cleanup"
  sort_and_deduplicate_targets

  local entry label kind path
  for entry in "${TARGETS[@]}"; do
    IFS='|' read -r label kind path <<<"$entry"
    if path_exists "$path"; then
      if ! remove_target "$label" "$kind" "$path"; then
        FAILED_COUNT=$((FAILED_COUNT + 1))
        log_error "Failed removing ${path}"
      fi
    else
      SKIPPED_COUNT=$((SKIPPED_COUNT + 1))
      log_debug "Target already absent: ${path}"
    fi
  done
}

write_summary() {
  {
    echo "ADJUTORIX clean summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "stack_name: ${ADJUTORIX_CLEAN_STACK_NAME}"
    echo "dry_run: ${DRY_RUN}"
    echo "profile_safe: ${PROFILE_SAFE}"
    echo "profile_deep: ${PROFILE_DEEP}"
    echo "profile_distclean: ${PROFILE_DISTCLEAN}"
    echo "removed_count: ${REMOVED_COUNT}"
    echo "skipped_count: ${SKIPPED_COUNT}"
    echo "failed_count: ${FAILED_COUNT}"
    echo ""
    echo "targets:"
    printf '  - %s
' "${TARGETS[@]}"
  } >"$ADJUTORIX_CLEAN_REPORT_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX clean"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "boot_log=${ADJUTORIX_CLEAN_BOOT_LOG} summary_file=${ADJUTORIX_CLEAN_REPORT_FILE}"

  assert_repo_guardrails
  confirm_destructive_profile_if_needed
  stop_runtime_processes

  collect_safe_targets
  if [[ "$PROFILE_DEEP" == true || "$PROFILE_DISTCLEAN" == true ]]; then
    collect_deep_targets
  fi
  if [[ "$PROFILE_DISTCLEAN" == true ]]; then
    collect_distclean_targets
  fi

  execute_clean
  write_summary

  section "Clean complete"
  log_info "removed=${REMOVED_COUNT} skipped=${SKIPPED_COUNT} failed=${FAILED_COUNT} dry_run=${DRY_RUN}"
  log_info "summary=${ADJUTORIX_CLEAN_REPORT_FILE}"

  if (( FAILED_COUNT > 0 )); then
    die "Clean completed with ${FAILED_COUNT} failure(s)"
  fi
}

main "$@"
