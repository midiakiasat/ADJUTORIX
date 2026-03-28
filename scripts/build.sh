#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX BUILD ENTRYPOINT
#
# Purpose
# - provide one authoritative repository build command for local use and CI
# - validate prerequisites, run bounded preflight checks, compile/package the
#   relevant buildable surfaces, and emit a deterministic build manifest
# - fail loudly on drift, missing prerequisites, or partial outputs instead of
#   allowing ambiguous "successful" builds
#
# Scope
# - build orchestration only; full semantic verification belongs to verify.sh
# - may prepare app, agent, CLI, and shared/generated outputs as configured
# - does not perform release signing/notarization; that belongs to package flows
#
# Design constraints
# - no hidden mutation beyond declared build, temp, dist, and report directories
# - every phase is explicit, timed, logged, and summary-reported
# - build outputs must be validated after generation
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

: "${ADJUTORIX_BUILD_STACK_NAME:=adjutorix-build}"
: "${ADJUTORIX_BUILD_USE_COLOR:=true}"
: "${ADJUTORIX_BUILD_FAIL_FAST:=true}"
: "${ADJUTORIX_BUILD_RUNTIME_MODE:=production}"
: "${ADJUTORIX_BUILD_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_BUILD_RUN_INSTALL:=false}"
: "${ADJUTORIX_BUILD_RUN_CHECK:=true}"
: "${ADJUTORIX_BUILD_RUN_VERIFY:=false}"
: "${ADJUTORIX_BUILD_BUILD_ROOT:=false}"
: "${ADJUTORIX_BUILD_BUILD_APP:=true}"
: "${ADJUTORIX_BUILD_BUILD_AGENT:=true}"
: "${ADJUTORIX_BUILD_BUILD_CLI:=true}"
: "${ADJUTORIX_BUILD_VALIDATE_OUTPUTS:=true}"
: "${ADJUTORIX_BUILD_COLLECT_MANIFEST:=true}"
: "${ADJUTORIX_BUILD_NODE_PACKAGE_MANAGER:=npm}"
: "${ADJUTORIX_BUILD_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_BUILD_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_BUILD_CLI_DIR:=${REPO_ROOT}/packages/adjutorix-cli}"
: "${ADJUTORIX_BUILD_ROOT_TMP:=${REPO_ROOT}/.tmp/build}"
: "${ADJUTORIX_BUILD_LOG_DIR:=${ADJUTORIX_BUILD_ROOT_TMP}/logs}"
: "${ADJUTORIX_BUILD_REPORT_DIR:=${ADJUTORIX_BUILD_ROOT_TMP}/reports}"
: "${ADJUTORIX_BUILD_STAGING_DIR:=${ADJUTORIX_BUILD_ROOT_TMP}/staging}"
: "${ADJUTORIX_BUILD_BOOT_LOG:=${ADJUTORIX_BUILD_LOG_DIR}/build.log}"
: "${ADJUTORIX_BUILD_SUMMARY_FILE:=${ADJUTORIX_BUILD_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_BUILD_PHASE_FILE:=${ADJUTORIX_BUILD_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_BUILD_MANIFEST_FILE:=${ADJUTORIX_BUILD_REPORT_DIR}/build-manifest.json}"
: "${ADJUTORIX_BUILD_METADATA_FILE:=${ADJUTORIX_BUILD_REPORT_DIR}/build-metadata.json}"
: "${ADJUTORIX_BUILD_ROOT_BUILD_CMD:=npm run build}"
: "${ADJUTORIX_BUILD_ROOT_CHECK_CMD:=bash scripts/check.sh --no-color}"
: "${ADJUTORIX_BUILD_ROOT_VERIFY_CMD:=bash scripts/verify.sh --no-color}"
: "${ADJUTORIX_BUILD_APP_BUILD_CMD:=npm --prefix packages/adjutorix-app run build}"
: "${ADJUTORIX_BUILD_APP_TYPECHECK_CMD:=npm --prefix packages/adjutorix-app run typecheck}"
: "${ADJUTORIX_BUILD_AGENT_BUILD_CMD:=python -m build}"
: "${ADJUTORIX_BUILD_CLI_BUILD_CMD:=python -m build}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
PHASE_RESULTS=()
PHASE_INDEX=0
OVERALL_FAILURES=0
ARTIFACT_PATHS=()
ROOT_VERSION=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_BUILD_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_BUILD_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_BUILD_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/build.sh [options]

Options:
  --install                     Run dependency installation before build
  --verify                      Run scripts/verify.sh before build
  --no-check                    Skip scripts/check.sh preflight
  --build-root                  Include root build command
  --no-app                      Skip app build
  --no-agent                    Skip agent build
  --no-cli                      Skip CLI build
  --require-clean-worktree      Fail if git worktree is dirty
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logging
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --install)
        ADJUTORIX_BUILD_RUN_INSTALL=true
        ;;
      --verify)
        ADJUTORIX_BUILD_RUN_VERIFY=true
        ;;
      --no-check)
        ADJUTORIX_BUILD_RUN_CHECK=false
        ;;
      --build-root)
        ADJUTORIX_BUILD_BUILD_ROOT=true
        ;;
      --no-app)
        ADJUTORIX_BUILD_BUILD_APP=false
        ;;
      --no-agent)
        ADJUTORIX_BUILD_BUILD_AGENT=false
        ;;
      --no-cli)
        ADJUTORIX_BUILD_BUILD_CLI=false
        ;;
      --require-clean-worktree)
        ADJUTORIX_BUILD_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_BUILD_USE_COLOR=false
        ;;
      --quiet)
        QUIET=true
        ;;
      --verbose)
        VERBOSE=true
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

require_file() {
  [[ -f "$1" ]] || die "Required file not found: $1"
}

require_dir() {
  [[ -d "$1" ]] || die "Required directory not found: $1"
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_BUILD_PHASE_FILE"
  PHASE_RESULTS+=("${phase}:${status}:${duration_ms}")
}

run_phase() {
  local phase="$1"
  shift
  PHASE_INDEX=$((PHASE_INDEX + 1))
  local started started_epoch_ms finished duration_ms
  started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  started_epoch_ms="$(python - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  section "[${PHASE_INDEX}] ${phase}"
  if "$@"; then
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" PASS "$started" "$finished" "$duration_ms"
    log_info "Phase passed: ${phase} (${duration_ms} ms)"
  else
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" FAIL "$started" "$finished" "$duration_ms"
    OVERALL_FAILURES=$((OVERALL_FAILURES + 1))
    log_error "Phase failed: ${phase} (${duration_ms} ms)"
    if [[ "$ADJUTORIX_BUILD_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

run_cmd_logged() {
  local phase="$1"
  shift
  log_debug "Running command for phase=${phase}: $*"
  "$@" >>"$ADJUTORIX_BUILD_BOOT_LOG" 2>&1
}

append_artifacts_from_dir() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0
  local file
  while IFS= read -r -d '' file; do
    ARTIFACT_PATHS+=("$file")
  done < <(find "$dir" -maxdepth 4 -type f -print0 2>/dev/null || true)
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_BUILD_LOG_DIR"
  ensure_dir "$ADJUTORIX_BUILD_REPORT_DIR"
  ensure_dir "$ADJUTORIX_BUILD_STAGING_DIR"
  : >"$ADJUTORIX_BUILD_BOOT_LOG"
  : >"$ADJUTORIX_BUILD_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_BUILD_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_BUILD_APP_DIR"
  require_dir "$ADJUTORIX_BUILD_AGENT_DIR"
  require_dir "$ADJUTORIX_BUILD_CLI_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_BUILD_APP_DIR/package.json"
  require_file "$ADJUTORIX_BUILD_AGENT_DIR/pyproject.toml"
  require_file "$ADJUTORIX_BUILD_CLI_DIR/pyproject.toml"
  require_command git
  require_command python
  require_command node
  require_command npm
  require_command find
  require_command shasum
}

phase_git_state() {
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
  if [[ "$ADJUTORIX_BUILD_REQUIRE_CLEAN_WORKTREE" == "true" ]]; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]]
  fi
}

phase_detect_version() {
  ROOT_VERSION="$(python - <<'PY' "$REPO_ROOT/package.json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('version', '0.0.0-unknown'))
PY
)"
  [[ -n "$ROOT_VERSION" ]]
}

phase_install_if_requested() {
  if [[ "$ADJUTORIX_BUILD_RUN_INSTALL" != "true" ]]; then
    return 0
  fi
  run_cmd_logged install bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_NODE_PACKAGE_MANAGER} install"
}

phase_preflight_check() {
  if [[ "$ADJUTORIX_BUILD_RUN_CHECK" != "true" ]]; then
    return 0
  fi
  run_cmd_logged preflight_check bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_ROOT_CHECK_CMD}"
}

phase_preflight_verify() {
  if [[ "$ADJUTORIX_BUILD_RUN_VERIFY" != "true" ]]; then
    return 0
  fi
  run_cmd_logged preflight_verify bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_ROOT_VERIFY_CMD}"
}

phase_prepare_staging() {
  rm -rf "$ADJUTORIX_BUILD_STAGING_DIR"/* 2>/dev/null || true
  ensure_dir "$ADJUTORIX_BUILD_STAGING_DIR/root"
  ensure_dir "$ADJUTORIX_BUILD_STAGING_DIR/app"
  ensure_dir "$ADJUTORIX_BUILD_STAGING_DIR/agent"
  ensure_dir "$ADJUTORIX_BUILD_STAGING_DIR/cli"
}

phase_build_root() {
  if [[ "$ADJUTORIX_BUILD_BUILD_ROOT" != "true" ]]; then
    return 0
  fi
  run_cmd_logged build_root bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_ROOT_BUILD_CMD}"
}

phase_build_app() {
  if [[ "$ADJUTORIX_BUILD_BUILD_APP" != "true" ]]; then
    return 0
  fi
  run_cmd_logged app_typecheck bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_APP_TYPECHECK_CMD}"
  run_cmd_logged build_app bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BUILD_APP_BUILD_CMD}"
}

phase_build_agent() {
  if [[ "$ADJUTORIX_BUILD_BUILD_AGENT" != "true" ]]; then
    return 0
  fi
  run_cmd_logged build_agent bash -lc "cd '$ADJUTORIX_BUILD_AGENT_DIR' && ${ADJUTORIX_BUILD_AGENT_BUILD_CMD}"
}

phase_build_cli() {
  if [[ "$ADJUTORIX_BUILD_BUILD_CLI" != "true" ]]; then
    return 0
  fi
  run_cmd_logged build_cli bash -lc "cd '$ADJUTORIX_BUILD_CLI_DIR' && ${ADJUTORIX_BUILD_CLI_BUILD_CMD}"
}

phase_collect_artifacts() {
  ARTIFACT_PATHS=()
  if [[ "$ADJUTORIX_BUILD_BUILD_ROOT" == "true" ]]; then
    append_artifacts_from_dir "$REPO_ROOT/dist"
    append_artifacts_from_dir "$REPO_ROOT/build"
  fi
  if [[ "$ADJUTORIX_BUILD_BUILD_APP" == "true" ]]; then
    append_artifacts_from_dir "$ADJUTORIX_BUILD_APP_DIR/dist"
    append_artifacts_from_dir "$ADJUTORIX_BUILD_APP_DIR/build"
  fi
  if [[ "$ADJUTORIX_BUILD_BUILD_AGENT" == "true" ]]; then
    append_artifacts_from_dir "$ADJUTORIX_BUILD_AGENT_DIR/dist"
  fi
  if [[ "$ADJUTORIX_BUILD_BUILD_CLI" == "true" ]]; then
    append_artifacts_from_dir "$ADJUTORIX_BUILD_CLI_DIR/dist"
  fi
  [[ ${#ARTIFACT_PATHS[@]} -gt 0 ]]
}

phase_validate_outputs() {
  if [[ "$ADJUTORIX_BUILD_VALIDATE_OUTPUTS" != "true" ]]; then
    return 0
  fi
  local artifact
  for artifact in "${ARTIFACT_PATHS[@]}"; do
    [[ -f "$artifact" ]] || die "Expected build artifact is not a file: $artifact"
    [[ -s "$artifact" ]] || die "Build artifact is empty: $artifact"
  done
}

phase_generate_manifest() {
  if [[ "$ADJUTORIX_BUILD_COLLECT_MANIFEST" != "true" ]]; then
    return 0
  fi
  python - <<'PY' "$ADJUTORIX_BUILD_MANIFEST_FILE" "$ADJUTORIX_BUILD_METADATA_FILE" "$ROOT_VERSION" "$START_TS" "$REPO_ROOT" "$ADJUTORIX_BUILD_RUNTIME_MODE" "${ARTIFACT_PATHS[*]}"
import hashlib
import json
import sys
from pathlib import Path

manifest_path = Path(sys.argv[1])
metadata_path = Path(sys.argv[2])
version = sys.argv[3]
started_at = sys.argv[4]
repo_root = sys.argv[5]
runtime_mode = sys.argv[6]
artifact_paths = [p for p in sys.argv[7].split(' ') if p]

artifacts = []
for raw in artifact_paths:
    path = Path(raw)
    if not path.exists() or not path.is_file():
        continue
    data = path.read_bytes()
    artifacts.append({
        'path': str(path),
        'size_bytes': len(data),
        'sha256': hashlib.sha256(data).hexdigest(),
    })

manifest = {
    'manifest_id': 'adjutorix.build-artifacts',
    'version': 1,
    'started_at': started_at,
    'repo_root': repo_root,
    'artifacts': artifacts,
}
metadata = {
    'build_id': f'adjutorix-build-{version}',
    'version': version,
    'runtime_mode': runtime_mode,
    'artifact_count': len(artifacts),
}
manifest_path.write_text(json.dumps(manifest, indent=2), encoding='utf-8')
metadata_path.write_text(json.dumps(metadata, indent=2), encoding='utf-8')
PY
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX build summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "runtime_mode: ${ADJUTORIX_BUILD_RUNTIME_MODE}"
    echo "version: ${ROOT_VERSION}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    local artifact
    for artifact in "${ARTIFACT_PATHS[@]}"; do
      echo "  - ${artifact}"
    done
    echo
    echo "manifest: ${ADJUTORIX_BUILD_MANIFEST_FILE}"
    echo "metadata: ${ADJUTORIX_BUILD_METADATA_FILE}"
    echo "boot_log: ${ADJUTORIX_BUILD_BOOT_LOG}"
  } >"$ADJUTORIX_BUILD_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX build orchestration"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "runtime_mode=${ADJUTORIX_BUILD_RUNTIME_MODE}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase git_state phase_git_state
  run_phase detect_version phase_detect_version
  run_phase install_if_requested phase_install_if_requested
  run_phase preflight_check phase_preflight_check
  run_phase preflight_verify phase_preflight_verify
  run_phase prepare_staging phase_prepare_staging
  run_phase build_root phase_build_root
  run_phase build_app phase_build_app
  run_phase build_agent phase_build_agent
  run_phase build_cli phase_build_cli
  run_phase collect_artifacts phase_collect_artifacts
  run_phase validate_outputs phase_validate_outputs
  run_phase generate_manifest phase_generate_manifest

  write_summary

  section "Build complete"
  log_info "summary=${ADJUTORIX_BUILD_SUMMARY_FILE}"
  log_info "manifest=${ADJUTORIX_BUILD_MANIFEST_FILE}"
  log_info "metadata=${ADJUTORIX_BUILD_METADATA_FILE}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Build failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
