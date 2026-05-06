#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX SMOKE ENTRYPOINT
#
# Purpose
# - run a deterministic smoke suite against the integrated local stack
# - validate that the governed agent, desktop app, preload bridge, renderer,
#   and selected persistence/UI surfaces boot and behave coherently
# - provide one authoritative smoke command for local use and CI
#
# Scope
# - orchestration only: environment prep, process lifecycle, readiness checks,
#   targeted smoke execution, artifact/report collection, explicit teardown
# - not a replacement for full verify, invariant, integration, or packaging runs
#
# Design constraints
# - no hidden background state beyond tracked child processes
# - no silent fallback to alternative ports, dirs, or test sets
# - every phase is explicit, timed, and logged
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

: "${ADJUTORIX_SMOKE_STACK_NAME:=adjutorix-smoke}"
: "${ADJUTORIX_SMOKE_RUNTIME_MODE:=test}"
: "${ADJUTORIX_SMOKE_CHANNEL:=dev}"
: "${ADJUTORIX_SMOKE_USE_COLOR:=true}"
: "${ADJUTORIX_SMOKE_FAIL_FAST:=true}"
: "${ADJUTORIX_SMOKE_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_SMOKE_RUN_INSTALL:=false}"
: "${ADJUTORIX_SMOKE_KILL_CONFLICTING_PORTS:=true}"
: "${ADJUTORIX_SMOKE_AGENT_HOST:=127.0.0.1}"
: "${ADJUTORIX_SMOKE_AGENT_PORT:=8000}"
: "${ADJUTORIX_SMOKE_AGENT_URL:=http://${ADJUTORIX_SMOKE_AGENT_HOST}:${ADJUTORIX_SMOKE_AGENT_PORT}}"
: "${ADJUTORIX_SMOKE_HEALTH_PATH:=/health}"
: "${ADJUTORIX_SMOKE_HEALTH_TIMEOUT_SECONDS:=45}"
: "${ADJUTORIX_SMOKE_HEALTH_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_SMOKE_ROOT_TMP:=${REPO_ROOT}/.tmp/smoke}"
: "${ADJUTORIX_SMOKE_LOG_DIR:=${ADJUTORIX_SMOKE_ROOT_TMP}/logs}"
: "${ADJUTORIX_SMOKE_PID_DIR:=${ADJUTORIX_SMOKE_ROOT_TMP}/pids}"
: "${ADJUTORIX_SMOKE_REPORT_DIR:=${ADJUTORIX_SMOKE_ROOT_TMP}/reports}"
: "${ADJUTORIX_SMOKE_RUNTIME_DIR:=${ADJUTORIX_SMOKE_ROOT_TMP}/runtime}"
: "${ADJUTORIX_SMOKE_BOOT_LOG:=${ADJUTORIX_SMOKE_LOG_DIR}/smoke.log}"
: "${ADJUTORIX_SMOKE_AGENT_LOG:=${ADJUTORIX_SMOKE_LOG_DIR}/agent.log}"
: "${ADJUTORIX_SMOKE_APP_LOG:=${ADJUTORIX_SMOKE_LOG_DIR}/app.log}"
: "${ADJUTORIX_SMOKE_TEST_LOG:=${ADJUTORIX_SMOKE_LOG_DIR}/tests.log}"
: "${ADJUTORIX_SMOKE_SUMMARY_FILE:=${ADJUTORIX_SMOKE_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_SMOKE_PHASE_FILE:=${ADJUTORIX_SMOKE_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_SMOKE_AGENT_PID_FILE:=${ADJUTORIX_SMOKE_PID_DIR}/agent.pid}"
: "${ADJUTORIX_SMOKE_APP_PID_FILE:=${ADJUTORIX_SMOKE_PID_DIR}/app.pid}"
: "${ADJUTORIX_SMOKE_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_SMOKE_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_SMOKE_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_SMOKE_TARGET:=tests/smoke}"
: "${ADJUTORIX_SMOKE_NODE_PACKAGE_MANAGER:=npm}"
: "${ADJUTORIX_SMOKE_ADDITIONAL_TEST_ARGS:=}"
: "${ADJUTORIX_SMOKE_ALLOW_MISSING_OPTIONAL_ENV:=true}"

INSTALL_CMD=("${ADJUTORIX_SMOKE_NODE_PACKAGE_MANAGER}" install)
APP_SMOKE_CMD_BASE=("${ADJUTORIX_SMOKE_NODE_PACKAGE_MANAGER}" test -- "$ADJUTORIX_SMOKE_TARGET")
AGENT_CMD=(python3 -m adjutorix_agent.server.main)
APP_DEV_CMD=("${ADJUTORIX_SMOKE_NODE_PACKAGE_MANAGER}" run dev)

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
NO_WAIT=false
AGENT_PID=""
APP_PID=""
CHILD_PIDS=()
PHASE_RESULTS=()
PHASE_INDEX=0
OVERALL_FAILURES=0
SHUTTING_DOWN=false

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_SMOKE_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_SMOKE_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_SMOKE_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/smoke.sh [options]

Options:
  --install                     Run dependency installation before smoke
  --require-clean-worktree      Fail if git worktree is dirty
  --no-fail-fast                Continue after failed smoke phases
  --agent-port <port>           Override agent port
  --agent-host <host>           Override agent host
  --agent-url <url>             Override agent URL
  --target <path>               Override smoke test target under app package
  --test-arg <arg>              Additional argument passed through to smoke test command (repeatable)
  --no-wait                     Exit after smoke execution and teardown without tailing child state
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logging
  --help                        Show this help
EOF
}

parse_args() {
  local extra_test_args=()
  while (($# > 0)); do
    case "$1" in
      --install)
        ADJUTORIX_SMOKE_RUN_INSTALL=true
        ;;
      --require-clean-worktree)
        ADJUTORIX_SMOKE_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --no-fail-fast)
        ADJUTORIX_SMOKE_FAIL_FAST=false
        ;;
      --agent-port)
        shift
        [[ $# -gt 0 ]] || die "--agent-port requires a value"
        ADJUTORIX_SMOKE_AGENT_PORT="$1"
        ADJUTORIX_SMOKE_AGENT_URL="http://${ADJUTORIX_SMOKE_AGENT_HOST}:${ADJUTORIX_SMOKE_AGENT_PORT}"
        ;;
      --agent-host)
        shift
        [[ $# -gt 0 ]] || die "--agent-host requires a value"
        ADJUTORIX_SMOKE_AGENT_HOST="$1"
        ADJUTORIX_SMOKE_AGENT_URL="http://${ADJUTORIX_SMOKE_AGENT_HOST}:${ADJUTORIX_SMOKE_AGENT_PORT}"
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_SMOKE_AGENT_URL="$1"
        ;;
      --target)
        shift
        [[ $# -gt 0 ]] || die "--target requires a value"
        ADJUTORIX_SMOKE_TARGET="$1"
        ;;
      --test-arg)
        shift
        [[ $# -gt 0 ]] || die "--test-arg requires a value"
        extra_test_args+=("$1")
        ;;
      --no-wait)
        NO_WAIT=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_SMOKE_USE_COLOR=false
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

  if ((${#extra_test_args[@]} > 0)); then
    ADJUTORIX_SMOKE_ADDITIONAL_TEST_ARGS="${extra_test_args[*]}"
  fi
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

load_env_file_if_present() {
  local path="$1"
  if [[ -f "$path" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$path"
    set +a
    log_debug "Loaded env file: $path"
  fi
}

port_is_listening() {
  local host="$1"
  local port="$2"
  if command -v nc >/dev/null 2>&1; then
    nc -z "$host" "$port" >/dev/null 2>&1
  else
    lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  fi
}

kill_port_owners() {
  local port="$1"
  local pids
  pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    log_warn "Killing listeners on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids || true
    sleep 1
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
    if [[ -n "$pids" ]]; then
      log_warn "Force-killing listeners on port $port: $pids"
      # shellcheck disable=SC2086
      kill -9 $pids || true
    fi
  fi
}

wait_for_http_ok() {
  local url="$1"
  local deadline_seconds="$2"
  local interval_seconds="$3"
  local started_at now elapsed
  started_at="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started_at))
    if (( elapsed >= deadline_seconds )); then
      return 1
    fi
    sleep "$interval_seconds"
  done
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_SMOKE_PHASE_FILE"
  PHASE_RESULTS+=("${phase}:${status}:${duration_ms}")
}

run_phase() {
  local phase="$1"
  shift
  PHASE_INDEX=$((PHASE_INDEX + 1))

  local started started_epoch_ms finished duration_ms
  started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  started_epoch_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  section "[${PHASE_INDEX}] ${phase}"
  if "$@"; then
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python3 - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" PASS "$started" "$finished" "$duration_ms"
    log_info "Phase passed: ${phase} (${duration_ms} ms)"
  else
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python3 - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" FAIL "$started" "$finished" "$duration_ms"
    OVERALL_FAILURES=$((OVERALL_FAILURES + 1))
    log_error "Phase failed: ${phase} (${duration_ms} ms)"
    if [[ "$ADJUTORIX_SMOKE_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

record_pid() {
  local pid="$1"
  local path="$2"
  printf '%s\n' "$pid" >"$path"
}

register_child() {
  local pid="$1"
  CHILD_PIDS+=("$pid")
}

terminate_child() {
  local pid="$1"
  local label="$2"
  [[ -n "$pid" ]] || return 0
  if child_is_running "$pid"; then
    log_warn "Stopping ${label} pid=${pid}"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! child_is_running "$pid"; then
        return 0
      fi
      sleep 0.25
    done
    log_warn "Force-stopping ${label} pid=${pid}"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ "$SHUTTING_DOWN" == true ]]; then
    return 0
  fi
  SHUTTING_DOWN=true
  section "Cleaning up smoke runtime"
  terminate_child "$APP_PID" "app"
  terminate_child "$AGENT_PID" "agent"
  rm -f "$ADJUTORIX_SMOKE_AGENT_PID_FILE" "$ADJUTORIX_SMOKE_APP_PID_FILE"
}

forward_signal() {
  local sig="$1"
  log_warn "Received signal: $sig"
  cleanup
  exit 130
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_SMOKE_LOG_DIR"
  ensure_dir "$ADJUTORIX_SMOKE_PID_DIR"
  ensure_dir "$ADJUTORIX_SMOKE_REPORT_DIR"
  ensure_dir "$ADJUTORIX_SMOKE_RUNTIME_DIR"
  : >"$ADJUTORIX_SMOKE_BOOT_LOG"
  : >"$ADJUTORIX_SMOKE_AGENT_LOG"
  : >"$ADJUTORIX_SMOKE_APP_LOG"
  : >"$ADJUTORIX_SMOKE_TEST_LOG"
  : >"$ADJUTORIX_SMOKE_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_SMOKE_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_SMOKE_APP_DIR"
  require_dir "$ADJUTORIX_SMOKE_AGENT_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_SMOKE_APP_DIR/package.json"
  require_command git
  require_command python3
  require_command node
  require_command npm
  require_command curl
  require_command lsof
}

phase_git_state() {
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
  if [[ "$ADJUTORIX_SMOKE_REQUIRE_CLEAN_WORKTREE" == "true" ]]; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]]
  fi
}

phase_load_environment() {
  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_SMOKE_RUNTIME_MODE"
  export VITE_APP_CHANNEL="$ADJUTORIX_SMOKE_CHANNEL"
  export ADJUTORIX_AGENT_URL="$ADJUTORIX_SMOKE_AGENT_URL"
  export ADJUTORIX_AGENT_HOST="$ADJUTORIX_SMOKE_AGENT_HOST"
  export ADJUTORIX_AGENT_PORT="$ADJUTORIX_SMOKE_AGENT_PORT"
  export ADJUTORIX_TOKEN_FILE="$ADJUTORIX_SMOKE_TOKEN_FILE"
  export ADJUTORIX_UNDER_TEST="true"
  export ADJUTORIX_TEST_MODE="true"
  export ADJUTORIX_ENABLE_GOVERNANCE_DEBUG="true"
  export ADJUTORIX_STRICT_GOVERNANCE="true"
  export ADJUTORIX_ENABLE_HEALTH_ENDPOINT="true"
  export ADJUTORIX_ENABLE_CRASH_RESUME="true"
  export ADJUTORIX_LOG_DIR="$ADJUTORIX_SMOKE_LOG_DIR"
  export ADJUTORIX_AGENT_LOG_DIR="$ADJUTORIX_SMOKE_LOG_DIR"
  export CI="${CI:-true}"

  load_env_file_if_present "$REPO_ROOT/.env.local"
  load_env_file_if_present "$REPO_ROOT/.env.agent.local"
}

phase_install_if_requested() {
  if [[ "$ADJUTORIX_SMOKE_RUN_INSTALL" != "true" ]]; then
    return 0
  fi
  (cd "$REPO_ROOT" && "${INSTALL_CMD[@]}") >>"$ADJUTORIX_SMOKE_BOOT_LOG" 2>&1
}

phase_prepare_ports() {
  if port_is_listening "$ADJUTORIX_SMOKE_AGENT_HOST" "$ADJUTORIX_SMOKE_AGENT_PORT"; then
    if [[ "$ADJUTORIX_SMOKE_KILL_CONFLICTING_PORTS" == "true" ]]; then
      kill_port_owners "$ADJUTORIX_SMOKE_AGENT_PORT"
    else
      die "Expected agent port is already in use: ${ADJUTORIX_SMOKE_AGENT_PORT}"
    fi
  fi
}

phase_start_agent() {
  (
    cd "$ADJUTORIX_SMOKE_AGENT_DIR"
    exec "${AGENT_CMD[@]}"
  ) >>"$ADJUTORIX_SMOKE_AGENT_LOG" 2>&1 &
  AGENT_PID="$!"
  register_child "$AGENT_PID"
  record_pid "$AGENT_PID" "$ADJUTORIX_SMOKE_AGENT_PID_FILE"
  log_info "Agent started pid=${AGENT_PID}"

  local health_url="${ADJUTORIX_SMOKE_AGENT_URL}${ADJUTORIX_SMOKE_HEALTH_PATH}"
  wait_for_http_ok "$health_url" "$ADJUTORIX_SMOKE_HEALTH_TIMEOUT_SECONDS" "$ADJUTORIX_SMOKE_HEALTH_INTERVAL_SECONDS"
}

phase_start_app() {
  (
    cd "$ADJUTORIX_SMOKE_APP_DIR"
    exec "${APP_DEV_CMD[@]}"
  ) >>"$ADJUTORIX_SMOKE_APP_LOG" 2>&1 &
  APP_PID="$!"
  register_child "$APP_PID"
  record_pid "$APP_PID" "$ADJUTORIX_SMOKE_APP_PID_FILE"
  log_info "App started pid=${APP_PID}"

  sleep 5
  child_is_running "$APP_PID"
}

phase_run_smoke_tests() {
  local cmd=("${APP_SMOKE_CMD_BASE[@]}")
  if [[ -n "$ADJUTORIX_SMOKE_ADDITIONAL_TEST_ARGS" ]]; then
    # shellcheck disable=SC2206
    local extra=( $ADJUTORIX_SMOKE_ADDITIONAL_TEST_ARGS )
    cmd+=("${extra[@]}")
  fi
  (
    cd "$ADJUTORIX_SMOKE_APP_DIR"
    exec "${cmd[@]}"
  ) >>"$ADJUTORIX_SMOKE_TEST_LOG" 2>&1
}

phase_post_assertions() {
  [[ -f "$ADJUTORIX_SMOKE_TEST_LOG" ]]
  grep -Eq 'pass|passing|ok' "$ADJUTORIX_SMOKE_TEST_LOG"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX smoke summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "runtime_mode: ${ADJUTORIX_SMOKE_RUNTIME_MODE}"
    echo "channel: ${ADJUTORIX_SMOKE_CHANNEL}"
    echo "agent_url: ${ADJUTORIX_SMOKE_AGENT_URL}"
    echo "target: ${ADJUTORIX_SMOKE_TARGET}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "logs:"
    echo "  - boot:  ${ADJUTORIX_SMOKE_BOOT_LOG}"
    echo "  - agent: ${ADJUTORIX_SMOKE_AGENT_LOG}"
    echo "  - app:   ${ADJUTORIX_SMOKE_APP_LOG}"
    echo "  - tests: ${ADJUTORIX_SMOKE_TEST_LOG}"
  } >"$ADJUTORIX_SMOKE_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  trap 'cleanup' EXIT
  trap 'forward_signal INT' INT
  trap 'forward_signal TERM' TERM

  section "ADJUTORIX smoke orchestration"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "agent_url=${ADJUTORIX_SMOKE_AGENT_URL} target=${ADJUTORIX_SMOKE_TARGET}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase git_state phase_git_state
  run_phase load_environment phase_load_environment
  run_phase install_if_requested phase_install_if_requested
  run_phase prepare_ports phase_prepare_ports
  run_phase start_agent phase_start_agent
  run_phase start_app phase_start_app
  run_phase run_smoke_tests phase_run_smoke_tests
  run_phase post_assertions phase_post_assertions

  write_summary
  section "Smoke complete"
  log_info "summary=${ADJUTORIX_SMOKE_SUMMARY_FILE}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Smoke failed with ${OVERALL_FAILURES} failed phase(s)"
  fi

  if [[ "$NO_WAIT" == "true" ]]; then
    log_info "No-wait requested; exiting after smoke completion"
  fi
}

main "$@"
