#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX AGENT RESTART ENTRYPOINT
#
# Purpose
# - provide one authoritative entrypoint for restarting the governed ADJUTORIX
#   local agent runtime
# - coordinate bounded shutdown, runtime continuity capture, fresh startup,
#   readiness verification, and restart evidence emission so the resulting agent
#   state is explicit and mechanically auditable
# - ensure "agent restarted" means one verified stop/start lifecycle transition
#   rather than an informal sequence of shell commands
#
# Scope
# - local agent lifecycle orchestration only
# - no hidden supervisor integration beyond explicit child process control
# - mutation limited to repository temp dirs and explicitly allowed user-local
#   auth/token state
#
# Design constraints
# - no silent fallback from graceful restart to ambiguous process replacement
# - no successful exit until the new agent instance is verified ready unless
#   detach semantics are explicitly requested
# - every phase explicit, timed, logged, and summary-reported
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
PROGRAM_NAME="$(basename -- "$0")"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

readonly SCRIPT_DIR
readonly REPO_ROOT
readonly PROGRAM_NAME
readonly START_TS

###############################################################################
# DEFAULTS
###############################################################################

: "${ADJUTORIX_AGENT_RESTART_STACK_NAME:=adjutorix-agent-restart}"
: "${ADJUTORIX_AGENT_RESTART_USE_COLOR:=true}"
: "${ADJUTORIX_AGENT_RESTART_FAIL_FAST:=true}"
: "${ADJUTORIX_AGENT_RESTART_HOST:=127.0.0.1}"
: "${ADJUTORIX_AGENT_RESTART_PORT:=8000}"
: "${ADJUTORIX_AGENT_RESTART_BASE_URL:=http://${ADJUTORIX_AGENT_RESTART_HOST}:${ADJUTORIX_AGENT_RESTART_PORT}}"
: "${ADJUTORIX_AGENT_RESTART_HEALTH_PATH:=/health}"
: "${ADJUTORIX_AGENT_RESTART_REQUIRE_RUNNING_BEFORE_RESTART:=false}"
: "${ADJUTORIX_AGENT_RESTART_KILL_CONFLICTING_PORTS:=true}"
: "${ADJUTORIX_AGENT_RESTART_CREATE_TOKEN_IF_MISSING:=false}"
: "${ADJUTORIX_AGENT_RESTART_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_AGENT_RESTART_DETACH:=false}"
: "${ADJUTORIX_AGENT_RESTART_WAIT_FOREVER:=true}"
: "${ADJUTORIX_AGENT_RESTART_RUNTIME_MODE:=development}"
: "${ADJUTORIX_AGENT_RESTART_LOG_LEVEL:=info}"
: "${ADJUTORIX_AGENT_RESTART_STOP_GRACE_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_AGENT_RESTART_START_HEALTH_TIMEOUT_SECONDS:=45}"
: "${ADJUTORIX_AGENT_RESTART_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_AGENT_RESTART_ROOT_TMP:=${REPO_ROOT}/.tmp/agent}"
: "${ADJUTORIX_AGENT_RESTART_LOG_DIR:=${ADJUTORIX_AGENT_RESTART_ROOT_TMP}/logs}"
: "${ADJUTORIX_AGENT_RESTART_PID_DIR:=${ADJUTORIX_AGENT_RESTART_ROOT_TMP}/pids}"
: "${ADJUTORIX_AGENT_RESTART_REPORT_DIR:=${ADJUTORIX_AGENT_RESTART_ROOT_TMP}/reports}"
: "${ADJUTORIX_AGENT_RESTART_RUNTIME_DIR:=${ADJUTORIX_AGENT_RESTART_ROOT_TMP}/runtime}"
: "${ADJUTORIX_AGENT_RESTART_BOOT_LOG:=${ADJUTORIX_AGENT_RESTART_LOG_DIR}/restart.log}"
: "${ADJUTORIX_AGENT_RESTART_AGENT_LOG:=${ADJUTORIX_AGENT_RESTART_LOG_DIR}/agent.log}"
: "${ADJUTORIX_AGENT_RESTART_SUMMARY_FILE:=${ADJUTORIX_AGENT_RESTART_REPORT_DIR}/restart-summary.txt}"
: "${ADJUTORIX_AGENT_RESTART_PHASE_FILE:=${ADJUTORIX_AGENT_RESTART_REPORT_DIR}/restart-phases.tsv}"
: "${ADJUTORIX_AGENT_RESTART_PID_FILE:=${ADJUTORIX_AGENT_RESTART_PID_DIR}/agent.pid}"
: "${ADJUTORIX_AGENT_RESTART_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_AGENT_RESTART_ENV_EXAMPLE:=${REPO_ROOT}/configs/runtime/agent.env.example}"
: "${ADJUTORIX_AGENT_RESTART_ENV_LOCAL:=${REPO_ROOT}/.env.agent.local}"
: "${ADJUTORIX_AGENT_RESTART_APP_ENV_LOCAL:=${REPO_ROOT}/.env.local}"
: "${ADJUTORIX_AGENT_RESTART_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_AGENT_RESTART_MODULE:=adjutorix_agent.server.main}"
: "${ADJUTORIX_AGENT_RESTART_EXPECTED_MODULE_HINT:=adjutorix_agent.server.main}"
: "${ADJUTORIX_AGENT_RESTART_EXTRA_ARGS:=}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
NO_WAIT=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
SHUTTING_DOWN=false
HEALTH_URL=""
OLD_PID=""
OLD_CMDLINE=""
OLD_PORT_OWNER=""
NEW_PID=""
NEW_CMDLINE=""
TOKEN_VALUE=""
RESTART_RESULT="unknown"
FORCE_USED=false

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_AGENT_RESTART_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_AGENT_RESTART_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  RESTART_RESULT="failed"
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_AGENT_RESTART_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/agent/restart.sh [options]

Options:
  --host <host>                 Override bind host
  --port <port>                 Override bind port
  --base-url <url>              Override expected base URL
  --require-running             Fail if no existing running agent is found
  --create-token                Create token if missing
  --no-token-required           Allow restart without token materialization
  --detach                      Restart and exit after readiness
  --no-wait                     Alias for --detach
  --log-level <level>           Override runtime log level
  --extra-arg <arg>             Append extra argument to python3 module command
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  local extra_args=()
  while (($# > 0)); do
    case "$1" in
      --host)
        shift
        [[ $# -gt 0 ]] || die "--host requires a value"
        ADJUTORIX_AGENT_RESTART_HOST="$1"
        ADJUTORIX_AGENT_RESTART_BASE_URL="http://${ADJUTORIX_AGENT_RESTART_HOST}:${ADJUTORIX_AGENT_RESTART_PORT}"
        ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value"
        ADJUTORIX_AGENT_RESTART_PORT="$1"
        ADJUTORIX_AGENT_RESTART_BASE_URL="http://${ADJUTORIX_AGENT_RESTART_HOST}:${ADJUTORIX_AGENT_RESTART_PORT}"
        ;;
      --base-url)
        shift
        [[ $# -gt 0 ]] || die "--base-url requires a value"
        ADJUTORIX_AGENT_RESTART_BASE_URL="$1"
        ;;
      --require-running)
        ADJUTORIX_AGENT_RESTART_REQUIRE_RUNNING_BEFORE_RESTART=true
        ;;
      --create-token)
        ADJUTORIX_AGENT_RESTART_CREATE_TOKEN_IF_MISSING=true
        ;;
      --no-token-required)
        ADJUTORIX_AGENT_RESTART_REQUIRE_TOKEN=false
        ;;
      --detach)
        ADJUTORIX_AGENT_RESTART_DETACH=true
        ADJUTORIX_AGENT_RESTART_WAIT_FOREVER=false
        ;;
      --no-wait)
        NO_WAIT=true
        ADJUTORIX_AGENT_RESTART_DETACH=true
        ADJUTORIX_AGENT_RESTART_WAIT_FOREVER=false
        ;;
      --log-level)
        shift
        [[ $# -gt 0 ]] || die "--log-level requires a value"
        ADJUTORIX_AGENT_RESTART_LOG_LEVEL="$1"
        ;;
      --extra-arg)
        shift
        [[ $# -gt 0 ]] || die "--extra-arg requires a value"
        extra_args+=("$1")
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_AGENT_RESTART_USE_COLOR=false
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

  if ((${#extra_args[@]} > 0)); then
    ADJUTORIX_AGENT_RESTART_EXTRA_ARGS="${extra_args[*]}"
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

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

http_up() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

wait_for_http_ok() {
  local url="$1"
  local deadline_seconds="$2"
  local interval_seconds="$3"
  local started now elapsed
  started="$(date +%s)"
  while true; do
    if curl -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= deadline_seconds )); then
      return 1
    fi
    sleep "$interval_seconds"
  done
}

wait_for_process_exit() {
  local pid="$1"
  local timeout_seconds="$2"
  local poll_seconds="$3"
  local started now elapsed
  started="$(date +%s)"
  while true; do
    if ! child_is_running "$pid"; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= timeout_seconds )); then
      return 1
    fi
    sleep "$poll_seconds"
  done
}

port_listener_info() {
  lsof -nP -iTCP:"$ADJUTORIX_AGENT_RESTART_PORT" -sTCP:LISTEN 2>/dev/null || true
}

kill_port_owners() {
  local pids
  pids="$(lsof -tiTCP:"$ADJUTORIX_AGENT_RESTART_PORT" -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    log_warn "Killing listeners on port ${ADJUTORIX_AGENT_RESTART_PORT}: $pids"
    # shellcheck disable=SC2086
    kill $pids >/dev/null 2>&1 || true
    sleep 1
    pids="$(lsof -tiTCP:"$ADJUTORIX_AGENT_RESTART_PORT" -sTCP:LISTEN || true)"
    if [[ -n "$pids" ]]; then
      FORCE_USED=true
      # shellcheck disable=SC2086
      kill -9 $pids >/dev/null 2>&1 || true
    fi
  fi
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_AGENT_RESTART_PHASE_FILE"
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
    if [[ "$ADJUTORIX_AGENT_RESTART_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
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

maybe_generate_token() {
  local path="$1"
  ensure_dir "$(dirname "$path")"
  python3 - <<'PY' "$path"
import secrets, sys
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    fh.write(secrets.token_hex(32))
PY
  chmod 600 "$path" || true
}

cleanup() {
  if [[ "$SHUTTING_DOWN" == true ]]; then
    return 0
  fi
  SHUTTING_DOWN=true
  if [[ "$ADJUTORIX_AGENT_RESTART_DETACH" == "true" ]]; then
    return 0
  fi
  if [[ -n "$NEW_PID" ]] && ! child_is_running "$NEW_PID"; then
    rm -f "$ADJUTORIX_AGENT_RESTART_PID_FILE" 2>/dev/null || true
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_AGENT_RESTART_LOG_DIR"
  ensure_dir "$ADJUTORIX_AGENT_RESTART_PID_DIR"
  ensure_dir "$ADJUTORIX_AGENT_RESTART_REPORT_DIR"
  ensure_dir "$ADJUTORIX_AGENT_RESTART_RUNTIME_DIR"
  : >"$ADJUTORIX_AGENT_RESTART_BOOT_LOG"
  : >"$ADJUTORIX_AGENT_RESTART_AGENT_LOG"
  : >"$ADJUTORIX_AGENT_RESTART_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_AGENT_RESTART_PHASE_FILE"
  HEALTH_URL="${ADJUTORIX_AGENT_RESTART_BASE_URL}${ADJUTORIX_AGENT_RESTART_HEALTH_PATH}"
}

phase_repo_and_toolchain() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_AGENT_RESTART_AGENT_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_AGENT_RESTART_AGENT_DIR/pyproject.toml"
  require_file "$ADJUTORIX_AGENT_RESTART_ENV_EXAMPLE"
  require_command python3
  require_command curl
  require_command lsof
  require_command ps
}

phase_load_environment() {
  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_AGENT_RESTART_RUNTIME_MODE"
  export ADJUTORIX_AGENT_HOST="$ADJUTORIX_AGENT_RESTART_HOST"
  export ADJUTORIX_AGENT_PORT="$ADJUTORIX_AGENT_RESTART_PORT"
  export ADJUTORIX_AGENT_URL="$ADJUTORIX_AGENT_RESTART_BASE_URL"
  export ADJUTORIX_AGENT_LOG_LEVEL="$ADJUTORIX_AGENT_RESTART_LOG_LEVEL"
  export ADJUTORIX_LOG_DIR="$ADJUTORIX_AGENT_RESTART_LOG_DIR"
  export ADJUTORIX_AGENT_LOG_DIR="$ADJUTORIX_AGENT_RESTART_LOG_DIR"
  export ADJUTORIX_ENABLE_HEALTH_ENDPOINT="true"
  export ADJUTORIX_ENABLE_CRASH_RESUME="true"
  export ADJUTORIX_TOKEN_FILE="$ADJUTORIX_AGENT_RESTART_TOKEN_FILE"

  load_env_file_if_present "$ADJUTORIX_AGENT_RESTART_ENV_EXAMPLE"
  load_env_file_if_present "$ADJUTORIX_AGENT_RESTART_APP_ENV_LOCAL"
  load_env_file_if_present "$ADJUTORIX_AGENT_RESTART_ENV_LOCAL"
}

phase_capture_old_state() {
  OLD_PORT_OWNER="$(port_listener_info | tr '\n' ';' | sed 's/;$/ /')"
  if [[ -f "$ADJUTORIX_AGENT_RESTART_PID_FILE" ]]; then
    OLD_PID="$(tr -d '[:space:]' < "$ADJUTORIX_AGENT_RESTART_PID_FILE")"
  fi
  if [[ -n "$OLD_PID" && $(child_is_running "$OLD_PID"; echo $?) -eq 0 ]]; then
    OLD_CMDLINE="$(ps -o command= -p "$OLD_PID" | sed 's/^[[:space:]]*//' || true)"
  fi

  if [[ "$ADJUTORIX_AGENT_RESTART_REQUIRE_RUNNING_BEFORE_RESTART" == "true" ]]; then
    if [[ -z "$OLD_PID" ]] && ! http_up; then
      die "Restart requested but no running agent was detected"
    fi
  fi
}

phase_resolve_token() {
  if [[ -f "$ADJUTORIX_AGENT_RESTART_TOKEN_FILE" && -s "$ADJUTORIX_AGENT_RESTART_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_AGENT_RESTART_TOKEN_FILE")"
    return 0
  fi

  if [[ "$ADJUTORIX_AGENT_RESTART_CREATE_TOKEN_IF_MISSING" == "true" ]]; then
    maybe_generate_token "$ADJUTORIX_AGENT_RESTART_TOKEN_FILE"
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_AGENT_RESTART_TOKEN_FILE")"
    return 0
  fi

  if [[ "$ADJUTORIX_AGENT_RESTART_REQUIRE_TOKEN" == "true" ]]; then
    die "Required token file missing or empty: $ADJUTORIX_AGENT_RESTART_TOKEN_FILE"
  fi
}

phase_stop_old_agent() {
  if [[ -n "$OLD_PID" ]] && child_is_running "$OLD_PID"; then
    if [[ -n "$OLD_CMDLINE" && "$OLD_CMDLINE" != *"${ADJUTORIX_AGENT_RESTART_EXPECTED_MODULE_HINT}"* ]]; then
      die "Refusing to restart over non-agent pid=${OLD_PID}: ${OLD_CMDLINE}"
    fi
    kill -TERM "$OLD_PID"
    if ! wait_for_process_exit "$OLD_PID" "$ADJUTORIX_AGENT_RESTART_STOP_GRACE_TIMEOUT_SECONDS" "$ADJUTORIX_AGENT_RESTART_POLL_INTERVAL_SECONDS"; then
      FORCE_USED=true
      kill -9 "$OLD_PID"
      wait_for_process_exit "$OLD_PID" 5 1 || die "Old agent process did not exit after forced kill"
    fi
  fi
  rm -f "$ADJUTORIX_AGENT_RESTART_PID_FILE" 2>/dev/null || true
}

phase_prepare_port() {
  if [[ "$ADJUTORIX_AGENT_RESTART_KILL_CONFLICTING_PORTS" == "true" ]]; then
    kill_port_owners
  fi
  local owner
  owner="$(port_listener_info)"
  [[ -z "$owner" ]] || die "Configured port still occupied before restart start phase: ${owner//$'\n'/; }"
}

phase_start_new_agent() {
  local cmd=(python3 -m "$ADJUTORIX_AGENT_RESTART_MODULE")
  if [[ -n "$ADJUTORIX_AGENT_RESTART_EXTRA_ARGS" ]]; then
    # shellcheck disable=SC2206
    local extra=( $ADJUTORIX_AGENT_RESTART_EXTRA_ARGS )
    cmd+=("${extra[@]}")
  fi

  (
    cd "$ADJUTORIX_AGENT_RESTART_AGENT_DIR"
    exec "${cmd[@]}"
  ) >>"$ADJUTORIX_AGENT_RESTART_AGENT_LOG" 2>&1 &

  NEW_PID="$!"
  printf '%s\n' "$NEW_PID" >"$ADJUTORIX_AGENT_RESTART_PID_FILE"
}

phase_wait_for_readiness() {
  wait_for_http_ok "$HEALTH_URL" "$ADJUTORIX_AGENT_RESTART_START_HEALTH_TIMEOUT_SECONDS" "$ADJUTORIX_AGENT_RESTART_POLL_INTERVAL_SECONDS"
}

phase_validate_new_runtime() {
  [[ -n "$NEW_PID" ]] || die "New PID missing after startup"
  child_is_running "$NEW_PID" || die "New agent process is not running"
  NEW_CMDLINE="$(ps -o command= -p "$NEW_PID" | sed 's/^[[:space:]]*//' || true)"
  [[ -n "$NEW_CMDLINE" ]] || die "Unable to resolve command line for new pid=${NEW_PID}"
  [[ "$NEW_CMDLINE" == *"${ADJUTORIX_AGENT_RESTART_EXPECTED_MODULE_HINT}"* ]] || die "New process identity does not match expected agent module: ${NEW_CMDLINE}"
  [[ "$NEW_PID" != "$OLD_PID" || -z "$OLD_PID" ]] || die "Restart did not produce a new process identity"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX agent restart summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_dir: ${ADJUTORIX_AGENT_RESTART_AGENT_DIR}"
    echo "host: ${ADJUTORIX_AGENT_RESTART_HOST}"
    echo "port: ${ADJUTORIX_AGENT_RESTART_PORT}"
    echo "base_url: ${ADJUTORIX_AGENT_RESTART_BASE_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "runtime_mode: ${ADJUTORIX_AGENT_RESTART_RUNTIME_MODE}"
    echo "log_level: ${ADJUTORIX_AGENT_RESTART_LOG_LEVEL}"
    echo "token_file: ${ADJUTORIX_AGENT_RESTART_TOKEN_FILE}"
    echo "token_present: $( [[ -n "$TOKEN_VALUE" ]] && echo yes || echo no )"
    echo "old_pid: ${OLD_PID}"
    echo "old_cmdline: ${OLD_CMDLINE}"
    echo "old_port_owner: ${OLD_PORT_OWNER}"
    echo "new_pid: ${NEW_PID}"
    echo "new_cmdline: ${NEW_CMDLINE}"
    echo "force_used: ${FORCE_USED}"
    echo "restart_result: ${RESTART_RESULT}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_AGENT_RESTART_BOOT_LOG}"
    echo "  - agent_log: ${ADJUTORIX_AGENT_RESTART_AGENT_LOG}"
    echo "  - pid_file: ${ADJUTORIX_AGENT_RESTART_PID_FILE}"
    echo "  - summary: ${ADJUTORIX_AGENT_RESTART_SUMMARY_FILE}"
  } >"$ADJUTORIX_AGENT_RESTART_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs
  trap 'cleanup' EXIT

  section "ADJUTORIX agent restart"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "base_url=${ADJUTORIX_AGENT_RESTART_BASE_URL} runtime_mode=${ADJUTORIX_AGENT_RESTART_RUNTIME_MODE}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase load_environment phase_load_environment
  run_phase capture_old_state phase_capture_old_state
  run_phase resolve_token phase_resolve_token
  run_phase stop_old_agent phase_stop_old_agent
  run_phase prepare_port phase_prepare_port
  run_phase start_new_agent phase_start_new_agent
  run_phase wait_for_readiness phase_wait_for_readiness
  run_phase validate_new_runtime phase_validate_new_runtime

  RESTART_RESULT="ready"
  write_summary

  section "Agent restart complete"
  log_info "summary=${ADJUTORIX_AGENT_RESTART_SUMMARY_FILE}"
  log_info "new_pid=${NEW_PID}"

  if [[ "$ADJUTORIX_AGENT_RESTART_DETACH" == "true" || "$NO_WAIT" == "true" ]]; then
    trap - EXIT
    exit 0
  fi

  while true; do
    if ! child_is_running "$NEW_PID"; then
      die "Restarted agent exited unexpectedly; see ${ADJUTORIX_AGENT_RESTART_AGENT_LOG}"
    fi
    sleep 1
  done
}

main "$@"
