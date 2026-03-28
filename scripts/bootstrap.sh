#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX BOOTSTRAP ENTRYPOINT
#
# Purpose
# - provide one authoritative zero-to-ready bootstrap flow for local developer
#   machines, CI runners, and freshly cloned worktrees
# - validate repository shape and host toolchain, materialize deterministic temp
#   and runtime directories, install Node/Python dependencies, provision local
#   environment overlays, initialize token/runtime prerequisites, and run a
#   bounded sanity pass so the workspace reaches a mechanically defined ready
#   state
#
# Scope
# - host and workspace preparation only
# - no release packaging, no signing, no notarization
# - may optionally invoke check/verify/smoke after install as readiness gates
#
# Design constraints
# - no hidden fallback to undeclared package managers or interpreters
# - no mutation outside repository root and explicitly allowed user-local state
#   such as ~/.adjutorix
# - every phase is explicit, timed, logged, and summary-reported
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

: "${ADJUTORIX_BOOTSTRAP_STACK_NAME:=adjutorix-bootstrap}"
: "${ADJUTORIX_BOOTSTRAP_USE_COLOR:=true}"
: "${ADJUTORIX_BOOTSTRAP_FAIL_FAST:=true}"
: "${ADJUTORIX_BOOTSTRAP_RUNTIME_MODE:=development}"
: "${ADJUTORIX_BOOTSTRAP_CHANNEL:=dev}"
: "${ADJUTORIX_BOOTSTRAP_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_BOOTSTRAP_INSTALL_NODE:=true}"
: "${ADJUTORIX_BOOTSTRAP_INSTALL_PYTHON:=true}"
: "${ADJUTORIX_BOOTSTRAP_CREATE_ENV_OVERRIDES:=true}"
: "${ADJUTORIX_BOOTSTRAP_CREATE_TOKEN:=false}"
: "${ADJUTORIX_BOOTSTRAP_RUN_CHECK:=true}"
: "${ADJUTORIX_BOOTSTRAP_RUN_VERIFY:=false}"
: "${ADJUTORIX_BOOTSTRAP_RUN_SMOKE:=false}"
: "${ADJUTORIX_BOOTSTRAP_NODE_PACKAGE_MANAGER:=npm}"
: "${ADJUTORIX_BOOTSTRAP_NODE_INSTALL_CMD:=npm install}"
: "${ADJUTORIX_BOOTSTRAP_ROOT_TMP:=${REPO_ROOT}/.tmp/bootstrap}"
: "${ADJUTORIX_BOOTSTRAP_LOG_DIR:=${ADJUTORIX_BOOTSTRAP_ROOT_TMP}/logs}"
: "${ADJUTORIX_BOOTSTRAP_REPORT_DIR:=${ADJUTORIX_BOOTSTRAP_ROOT_TMP}/reports}"
: "${ADJUTORIX_BOOTSTRAP_RUNTIME_DIR:=${REPO_ROOT}/.tmp}"
: "${ADJUTORIX_BOOTSTRAP_BOOT_LOG:=${ADJUTORIX_BOOTSTRAP_LOG_DIR}/bootstrap.log}"
: "${ADJUTORIX_BOOTSTRAP_SUMMARY_FILE:=${ADJUTORIX_BOOTSTRAP_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_BOOTSTRAP_PHASE_FILE:=${ADJUTORIX_BOOTSTRAP_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_BOOTSTRAP_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_BOOTSTRAP_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_BOOTSTRAP_CLI_DIR:=${REPO_ROOT}/packages/adjutorix-cli}"
: "${ADJUTORIX_BOOTSTRAP_RUNTIME_CONFIG_DIR:=${REPO_ROOT}/configs/runtime}"
: "${ADJUTORIX_BOOTSTRAP_APP_ENV_EXAMPLE:=${REPO_ROOT}/configs/runtime/app.env.example}"
: "${ADJUTORIX_BOOTSTRAP_AGENT_ENV_EXAMPLE:=${REPO_ROOT}/configs/runtime/agent.env.example}"
: "${ADJUTORIX_BOOTSTRAP_APP_ENV_LOCAL:=${REPO_ROOT}/.env.local}"
: "${ADJUTORIX_BOOTSTRAP_AGENT_ENV_LOCAL:=${REPO_ROOT}/.env.agent.local}"
: "${ADJUTORIX_BOOTSTRAP_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_BOOTSTRAP_USER_DATA_DIR:=${REPO_ROOT}/.tmp/bootstrap/user-data}"
: "${ADJUTORIX_BOOTSTRAP_CHECK_CMD:=bash scripts/check.sh --no-color}"
: "${ADJUTORIX_BOOTSTRAP_VERIFY_CMD:=bash scripts/verify.sh --no-color}"
: "${ADJUTORIX_BOOTSTRAP_SMOKE_CMD:=bash scripts/smoke.sh --no-color --no-wait}"
: "${ADJUTORIX_BOOTSTRAP_ALLOW_MISSING_VENV:=true}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
PHASE_RESULTS=()
PHASE_INDEX=0
OVERALL_FAILURES=0
PYTHON_VENV_PATH="${REPO_ROOT}/.venv"
PYTHON_BIN="python"
PIP_BIN=""
BOOTSTRAP_STATUS="unknown"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_BOOTSTRAP_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_BOOTSTRAP_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  BOOTSTRAP_STATUS="failed"
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_BOOTSTRAP_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/bootstrap.sh [options]

Options:
  --require-clean-worktree      Fail if git worktree is dirty
  --no-node                     Skip Node dependency installation
  --no-python                   Skip Python dependency installation
  --no-env                      Skip creating local env override files
  --create-token                Create ~/.adjutorix/token if missing
  --verify                      Run scripts/verify.sh after bootstrap
  --smoke                       Run scripts/smoke.sh after bootstrap
  --no-check                    Skip scripts/check.sh post-bootstrap
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logging
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --require-clean-worktree)
        ADJUTORIX_BOOTSTRAP_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --no-node)
        ADJUTORIX_BOOTSTRAP_INSTALL_NODE=false
        ;;
      --no-python)
        ADJUTORIX_BOOTSTRAP_INSTALL_PYTHON=false
        ;;
      --no-env)
        ADJUTORIX_BOOTSTRAP_CREATE_ENV_OVERRIDES=false
        ;;
      --create-token)
        ADJUTORIX_BOOTSTRAP_CREATE_TOKEN=true
        ;;
      --verify)
        ADJUTORIX_BOOTSTRAP_RUN_VERIFY=true
        ;;
      --smoke)
        ADJUTORIX_BOOTSTRAP_RUN_SMOKE=true
        ;;
      --no-check)
        ADJUTORIX_BOOTSTRAP_RUN_CHECK=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_BOOTSTRAP_USE_COLOR=false
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

is_true() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_BOOTSTRAP_PHASE_FILE"
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
    if [[ "$ADJUTORIX_BOOTSTRAP_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

run_cmd_logged() {
  local phase="$1"
  shift
  log_debug "Running command for phase=${phase}: $*"
  "$@" >>"$ADJUTORIX_BOOTSTRAP_BOOT_LOG" 2>&1
}

copy_example_if_missing() {
  local source="$1"
  local destination="$2"
  if [[ -f "$destination" ]]; then
    log_info "Local env override already exists: $destination"
    return 0
  fi
  cp "$source" "$destination"
  log_info "Created local env override from example: $destination"
}

maybe_generate_token() {
  local token_file="$1"
  if [[ -f "$token_file" && -s "$token_file" ]]; then
    log_info "Token file already present: $token_file"
    return 0
  fi
  ensure_dir "$(dirname "$token_file")"
  python - <<'PY' "$token_file"
import secrets, sys
path = sys.argv[1]
with open(path, 'w', encoding='utf-8') as fh:
    fh.write(secrets.token_hex(32))
PY
  chmod 600 "$token_file" || true
  log_info "Created token file: $token_file"
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_BOOTSTRAP_LOG_DIR"
  ensure_dir "$ADJUTORIX_BOOTSTRAP_REPORT_DIR"
  ensure_dir "$ADJUTORIX_BOOTSTRAP_ROOT_TMP"
  ensure_dir "$ADJUTORIX_BOOTSTRAP_RUNTIME_DIR"
  ensure_dir "$ADJUTORIX_BOOTSTRAP_USER_DATA_DIR"
  : >"$ADJUTORIX_BOOTSTRAP_BOOT_LOG"
  : >"$ADJUTORIX_BOOTSTRAP_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_BOOTSTRAP_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_BOOTSTRAP_APP_DIR"
  require_dir "$ADJUTORIX_BOOTSTRAP_AGENT_DIR"
  require_dir "$ADJUTORIX_BOOTSTRAP_CLI_DIR"
  require_dir "$ADJUTORIX_BOOTSTRAP_RUNTIME_CONFIG_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_BOOTSTRAP_APP_DIR/package.json"
  require_file "$ADJUTORIX_BOOTSTRAP_AGENT_DIR/pyproject.toml"
  require_file "$ADJUTORIX_BOOTSTRAP_CLI_DIR/pyproject.toml"
  require_file "$ADJUTORIX_BOOTSTRAP_APP_ENV_EXAMPLE"
  require_file "$ADJUTORIX_BOOTSTRAP_AGENT_ENV_EXAMPLE"
  require_command git
  require_command python
  require_command node
  require_command npm
}

phase_git_state() {
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
  if [[ "$ADJUTORIX_BOOTSTRAP_REQUIRE_CLEAN_WORKTREE" == "true" ]]; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]]
  fi
}

phase_detect_python() {
  if [[ -x "${PYTHON_VENV_PATH}/bin/python" ]]; then
    PYTHON_BIN="${PYTHON_VENV_PATH}/bin/python"
    PIP_BIN="${PYTHON_VENV_PATH}/bin/pip"
    log_info "Using repository virtualenv python: ${PYTHON_BIN}"
    return 0
  fi

  PYTHON_BIN="$(command -v python3 || command -v python || true)"
  [[ -n "$PYTHON_BIN" ]] || die "No usable Python interpreter found"
  PIP_BIN="${PYTHON_BIN} -m pip"
  log_info "Using system python: ${PYTHON_BIN}"
}

phase_create_runtime_dirs() {
  ensure_dir "$REPO_ROOT/.tmp/dev"
  ensure_dir "$REPO_ROOT/.tmp/verify"
  ensure_dir "$REPO_ROOT/.tmp/check"
  ensure_dir "$REPO_ROOT/.tmp/smoke"
  ensure_dir "$REPO_ROOT/.tmp/build"
  ensure_dir "$REPO_ROOT/.tmp/package-macos"
  ensure_dir "$REPO_ROOT/.tmp/doctor"
}

phase_install_node() {
  if [[ "$ADJUTORIX_BOOTSTRAP_INSTALL_NODE" != "true" ]]; then
    return 0
  fi
  run_cmd_logged install_node bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BOOTSTRAP_NODE_INSTALL_CMD}"
}

phase_install_python() {
  if [[ "$ADJUTORIX_BOOTSTRAP_INSTALL_PYTHON" != "true" ]]; then
    return 0
  fi

  if [[ ! -x "${PYTHON_VENV_PATH}/bin/python" ]]; then
    run_cmd_logged create_venv bash -lc "cd '$REPO_ROOT' && '${PYTHON_BIN}' -m venv .venv"
    PYTHON_BIN="${PYTHON_VENV_PATH}/bin/python"
    PIP_BIN="${PYTHON_VENV_PATH}/bin/pip"
  fi

  run_cmd_logged pip_upgrade bash -lc "cd '$REPO_ROOT' && '${PYTHON_VENV_PATH}/bin/python' -m pip install --upgrade pip setuptools wheel build"

  if [[ -f "${ADJUTORIX_BOOTSTRAP_AGENT_DIR}/pyproject.toml" ]]; then
    run_cmd_logged install_agent_editable bash -lc "cd '$ADJUTORIX_BOOTSTRAP_AGENT_DIR' && '${PYTHON_VENV_PATH}/bin/python' -m pip install -e ."
  fi
  if [[ -f "${ADJUTORIX_BOOTSTRAP_CLI_DIR}/pyproject.toml" ]]; then
    run_cmd_logged install_cli_editable bash -lc "cd '$ADJUTORIX_BOOTSTRAP_CLI_DIR' && '${PYTHON_VENV_PATH}/bin/python' -m pip install -e ."
  fi
}

phase_create_env_overrides() {
  if [[ "$ADJUTORIX_BOOTSTRAP_CREATE_ENV_OVERRIDES" != "true" ]]; then
    return 0
  fi
  copy_example_if_missing "$ADJUTORIX_BOOTSTRAP_APP_ENV_EXAMPLE" "$ADJUTORIX_BOOTSTRAP_APP_ENV_LOCAL"
  copy_example_if_missing "$ADJUTORIX_BOOTSTRAP_AGENT_ENV_EXAMPLE" "$ADJUTORIX_BOOTSTRAP_AGENT_ENV_LOCAL"
}

phase_prepare_local_runtime_defaults() {
  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_BOOTSTRAP_RUNTIME_MODE"
  export VITE_APP_CHANNEL="$ADJUTORIX_BOOTSTRAP_CHANNEL"
  export ADJUTORIX_UNDER_TEST="false"
  export ADJUTORIX_TEST_MODE="false"
  export ADJUTORIX_USER_DATA_DIR="$ADJUTORIX_BOOTSTRAP_USER_DATA_DIR"
  export ADJUTORIX_TOKEN_FILE="$ADJUTORIX_BOOTSTRAP_TOKEN_FILE"
}

phase_create_token_if_requested() {
  if [[ "$ADJUTORIX_BOOTSTRAP_CREATE_TOKEN" != "true" ]]; then
    return 0
  fi
  maybe_generate_token "$ADJUTORIX_BOOTSTRAP_TOKEN_FILE"
}

phase_python_import_sanity() {
  if [[ ! -x "${PYTHON_VENV_PATH}/bin/python" ]]; then
    if [[ "$ADJUTORIX_BOOTSTRAP_ALLOW_MISSING_VENV" == "true" ]]; then
      log_warn "Repository virtualenv missing; skipping Python import sanity"
      return 0
    fi
    die "Repository virtualenv missing and missing venv is not allowed"
  fi

  run_cmd_logged python_import_sanity bash -lc "cd '$REPO_ROOT' && '${PYTHON_VENV_PATH}/bin/python' - <<'PY'
import importlib
importlib.import_module('adjutorix_agent')
importlib.import_module('adjutorix_cli')
print('python-import-sanity-ok')
PY"
}

phase_post_check() {
  if [[ "$ADJUTORIX_BOOTSTRAP_RUN_CHECK" != "true" ]]; then
    return 0
  fi
  run_cmd_logged post_check bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BOOTSTRAP_CHECK_CMD}"
}

phase_post_verify() {
  if [[ "$ADJUTORIX_BOOTSTRAP_RUN_VERIFY" != "true" ]]; then
    return 0
  fi
  run_cmd_logged post_verify bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BOOTSTRAP_VERIFY_CMD}"
}

phase_post_smoke() {
  if [[ "$ADJUTORIX_BOOTSTRAP_RUN_SMOKE" != "true" ]]; then
    return 0
  fi
  run_cmd_logged post_smoke bash -lc "cd '$REPO_ROOT' && ${ADJUTORIX_BOOTSTRAP_SMOKE_CMD}"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX bootstrap summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "runtime_mode: ${ADJUTORIX_BOOTSTRAP_RUNTIME_MODE}"
    echo "channel: ${ADJUTORIX_BOOTSTRAP_CHANNEL}"
    echo "python_bin: ${PYTHON_BIN}"
    echo "venv_path: ${PYTHON_VENV_PATH}"
    echo "token_file: ${ADJUTORIX_BOOTSTRAP_TOKEN_FILE}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo "bootstrap_status: ${BOOTSTRAP_STATUS}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_BOOTSTRAP_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_BOOTSTRAP_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_BOOTSTRAP_PHASE_FILE}"
  } >"$ADJUTORIX_BOOTSTRAP_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX bootstrap"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "runtime_mode=${ADJUTORIX_BOOTSTRAP_RUNTIME_MODE} channel=${ADJUTORIX_BOOTSTRAP_CHANNEL}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase git_state phase_git_state
  run_phase detect_python phase_detect_python
  run_phase create_runtime_dirs phase_create_runtime_dirs
  run_phase install_node phase_install_node
  run_phase install_python phase_install_python
  run_phase create_env_overrides phase_create_env_overrides
  run_phase prepare_local_runtime_defaults phase_prepare_local_runtime_defaults
  run_phase create_token_if_requested phase_create_token_if_requested
  run_phase python_import_sanity phase_python_import_sanity
  run_phase post_check phase_post_check
  run_phase post_verify phase_post_verify
  run_phase post_smoke phase_post_smoke

  if (( OVERALL_FAILURES > 0 )); then
    BOOTSTRAP_STATUS="failed"
  else
    BOOTSTRAP_STATUS="ready"
  fi

  write_summary

  section "Bootstrap complete"
  log_info "summary=${ADJUTORIX_BOOTSTRAP_SUMMARY_FILE}"
  log_info "boot_log=${ADJUTORIX_BOOTSTRAP_BOOT_LOG}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Bootstrap failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
