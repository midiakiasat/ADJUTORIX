#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX AGENT STOP ENTRYPOINT
#
# Purpose
# - provide one authoritative entrypoint for stopping the governed ADJUTORIX
#   local agent runtime
# - validate PID/process identity, request graceful shutdown, escalate on
#   bounded timeout, clean stale runtime state, confirm health endpoint loss,
#   and emit auditable shutdown artifacts
# - ensure "agent stopped" means one verified terminal service state rather
#   than an ad hoc signal sent to an unknown process
#
# Scope
# - local agent process shutdown orchestration only
# - no mutation outside repository temp dirs and explicit user-local auth state
# - no assumptions about external supervisors; this script verifies what it can
#
# Design constraints
# - no killing an unverified process identity unless explicitly forced
# - no successful exit while the agent still appears live on the configured port
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

: "${ADJUTORIX_AGENT_STOP_STACK_NAME:=adjutorix-agent-stop}"
: "${ADJUTORIX_AGENT_STOP_USE_COLOR:=true}"
: "${ADJUTORIX_AGENT_STOP_FAIL_FAST:=true}"
: "${ADJUTORIX_AGENT_STOP_HOST:=127.0.0.1}"
: "${ADJUTORIX_AGENT_STOP_PORT:=8000}"
: "${ADJUTORIX_AGENT_STOP_BASE_URL:=http://${ADJUTORIX_AGENT_STOP_HOST}:${ADJUTORIX_AGENT_STOP_PORT}}"
: "${ADJUTORIX_AGENT_STOP_HEALTH_PATH:=/health}"
: "${ADJUTORIX_AGENT_STOP_PID_FILE:=${REPO_ROOT}/.tmp/agent/pids/agent.pid}"
: "${ADJUTORIX_AGENT_STOP_ROOT_TMP:=${REPO_ROOT}/.tmp/agent}"
: "${ADJUTORIX_AGENT_STOP_LOG_DIR:=${ADJUTORIX_AGENT_STOP_ROOT_TMP}/logs}"
: "${ADJUTORIX_AGENT_STOP_REPORT_DIR:=${ADJUTORIX_AGENT_STOP_ROOT_TMP}/reports}"
: "${ADJUTORIX_AGENT_STOP_BOOT_LOG:=${ADJUTORIX_AGENT_STOP_LOG_DIR}/stop.log}"
: "${ADJUTORIX_AGENT_STOP_SUMMARY_FILE:=${ADJUTORIX_AGENT_STOP_REPORT_DIR}/stop-summary.txt}"
: "${ADJUTORIX_AGENT_STOP_PHASE_FILE:=${ADJUTORIX_AGENT_STOP_REPORT_DIR}/stop-phases.tsv}"
: "${ADJUTORIX_AGENT_STOP_GRACE_SIGNAL:=TERM}"
: "${ADJUTORIX_AGENT_STOP_GRACE_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_AGENT_STOP_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_AGENT_STOP_FORCE_AFTER_TIMEOUT:=true}"
: "${ADJUTORIX_AGENT_STOP_FORCE_SIGNAL:=KILL}"
: "${ADJUTORIX_AGENT_STOP_ACCEPT_MISSING_PID:=true}"
: "${ADJUTORIX_AGENT_STOP_VERIFY_PROCESS_IDENTITY:=true}"
: "${ADJUTORIX_AGENT_STOP_EXPECTED_MODULE_HINT:=adjutorix_agent.server.main}"
: "${ADJUTORIX_AGENT_STOP_CLEAN_STALE_PID:=true}"
: "${ADJUTORIX_AGENT_STOP_CONFIRM_HEALTH_DOWN:=true}"
: "${ADJUTORIX_AGENT_STOP_CONFIRM_PORT_RELEASED:=true}"
: "${ADJUTORIX_AGENT_STOP_EXTRA_KILL_BY_PORT:=false}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
TARGET_PID=""
PROCESS_CMDLINE=""
HEALTH_URL=""
PORT_OWNER_BEFORE=""
PORT_OWNER_AFTER=""
STOP_RESULT="unknown"
FORCE_USED=false
PID_FILE_PRESENT="no"
PID_WAS_STALE="no"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_AGENT_STOP_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_AGENT_STOP_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  STOP_RESULT="failed"
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_AGENT_STOP_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/agent/stop.sh [options]

Options:
  --host <host>                 Override expected bind host
  --port <port>                 Override expected bind port
  --base-url <url>              Override expected base URL
  --pid-file <path>             Override PID file location
  --force-now                   Skip grace period and force kill verified target
  --no-identity-check           Disable process identity verification
  --kill-by-port                After PID-based shutdown, kill remaining listener on configured port
  --no-health-confirm           Skip HTTP health-down confirmation
  --no-port-confirm             Skip port-release confirmation
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --host)
        shift
        [[ $# -gt 0 ]] || die "--host requires a value"
        ADJUTORIX_AGENT_STOP_HOST="$1"
        ADJUTORIX_AGENT_STOP_BASE_URL="http://${ADJUTORIX_AGENT_STOP_HOST}:${ADJUTORIX_AGENT_STOP_PORT}"
        ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value"
        ADJUTORIX_AGENT_STOP_PORT="$1"
        ADJUTORIX_AGENT_STOP_BASE_URL="http://${ADJUTORIX_AGENT_STOP_HOST}:${ADJUTORIX_AGENT_STOP_PORT}"
        ;;
      --base-url)
        shift
        [[ $# -gt 0 ]] || die "--base-url requires a value"
        ADJUTORIX_AGENT_STOP_BASE_URL="$1"
        ;;
      --pid-file)
        shift
        [[ $# -gt 0 ]] || die "--pid-file requires a value"
        ADJUTORIX_AGENT_STOP_PID_FILE="$1"
        ;;
      --force-now)
        ADJUTORIX_AGENT_STOP_GRACE_TIMEOUT_SECONDS=0
        ADJUTORIX_AGENT_STOP_FORCE_AFTER_TIMEOUT=true
        ;;
      --no-identity-check)
        ADJUTORIX_AGENT_STOP_VERIFY_PROCESS_IDENTITY=false
        ;;
      --kill-by-port)
        ADJUTORIX_AGENT_STOP_EXTRA_KILL_BY_PORT=true
        ;;
      --no-health-confirm)
        ADJUTORIX_AGENT_STOP_CONFIRM_HEALTH_DOWN=false
        ;;
      --no-port-confirm)
        ADJUTORIX_AGENT_STOP_CONFIRM_PORT_RELEASED=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_AGENT_STOP_USE_COLOR=false
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

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_AGENT_STOP_PHASE_FILE"
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
    if [[ "$ADJUTORIX_AGENT_STOP_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

http_up() {
  curl -fsS --max-time 2 "$HEALTH_URL" >/dev/null 2>&1
}

port_listener_info() {
  lsof -nP -iTCP:"$ADJUTORIX_AGENT_STOP_PORT" -sTCP:LISTEN 2>/dev/null || true
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

wait_for_health_down() {
  local timeout_seconds="$1"
  local poll_seconds="$2"
  local started now elapsed
  started="$(date +%s)"
  while true; do
    if ! http_up; then
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

kill_port_owners() {
  local pids
  pids="$(lsof -tiTCP:"$ADJUTORIX_AGENT_STOP_PORT" -sTCP:LISTEN || true)"
  if [[ -n "$pids" ]]; then
    log_warn "Killing remaining listeners on port ${ADJUTORIX_AGENT_STOP_PORT}: $pids"
    # shellcheck disable=SC2086
    kill -${ADJUTORIX_AGENT_STOP_FORCE_SIGNAL} $pids >/dev/null 2>&1 || true
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_AGENT_STOP_LOG_DIR"
  ensure_dir "$ADJUTORIX_AGENT_STOP_REPORT_DIR"
  : >"$ADJUTORIX_AGENT_STOP_BOOT_LOG"
  : >"$ADJUTORIX_AGENT_STOP_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_AGENT_STOP_PHASE_FILE"
  HEALTH_URL="${ADJUTORIX_AGENT_STOP_BASE_URL}${ADJUTORIX_AGENT_STOP_HEALTH_PATH}"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command curl
  require_command lsof
  require_command ps
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_capture_pre_state() {
  PORT_OWNER_BEFORE="$(port_listener_info | tr '\n' ';' | sed 's/;$/ /')"
  if [[ -f "$ADJUTORIX_AGENT_STOP_PID_FILE" ]]; then
    PID_FILE_PRESENT="yes"
    TARGET_PID="$(tr -d '[:space:]' < "$ADJUTORIX_AGENT_STOP_PID_FILE")"
  else
    PID_FILE_PRESENT="no"
    TARGET_PID=""
  fi
}

phase_resolve_target_pid() {
  if [[ -z "$TARGET_PID" ]]; then
    if [[ "$ADJUTORIX_AGENT_STOP_ACCEPT_MISSING_PID" == "true" ]]; then
      log_warn "PID file missing or empty; shutdown will rely on optional port confirmation/cleanup"
      return 0
    fi
    die "PID file missing or empty: ${ADJUTORIX_AGENT_STOP_PID_FILE}"
  fi

  if child_is_running "$TARGET_PID"; then
    PROCESS_CMDLINE="$(ps -o command= -p "$TARGET_PID" | sed 's/^[[:space:]]*//' || true)"
  else
    PID_WAS_STALE="yes"
    PROCESS_CMDLINE=""
    if [[ "$ADJUTORIX_AGENT_STOP_CLEAN_STALE_PID" == "true" ]]; then
      rm -f "$ADJUTORIX_AGENT_STOP_PID_FILE"
    fi
  fi
}

phase_verify_identity() {
  if [[ -z "$TARGET_PID" || "$PID_WAS_STALE" == "yes" ]]; then
    return 0
  fi
  if [[ "$ADJUTORIX_AGENT_STOP_VERIFY_PROCESS_IDENTITY" != "true" ]]; then
    return 0
  fi
  [[ -n "$PROCESS_CMDLINE" ]] || die "Unable to resolve process command line for pid=${TARGET_PID}"
  [[ "$PROCESS_CMDLINE" == *"${ADJUTORIX_AGENT_STOP_EXPECTED_MODULE_HINT}"* ]] || die "Refusing to stop non-agent process pid=${TARGET_PID}: ${PROCESS_CMDLINE}"
}

phase_request_shutdown() {
  if [[ -z "$TARGET_PID" || "$PID_WAS_STALE" == "yes" ]]; then
    return 0
  fi

  if ! child_is_running "$TARGET_PID"; then
    return 0
  fi

  if (( ADJUTORIX_AGENT_STOP_GRACE_TIMEOUT_SECONDS == 0 )); then
    FORCE_USED=true
    kill -${ADJUTORIX_AGENT_STOP_FORCE_SIGNAL} "$TARGET_PID"
    return 0
  fi

  kill -${ADJUTORIX_AGENT_STOP_GRACE_SIGNAL} "$TARGET_PID"
  if wait_for_process_exit "$TARGET_PID" "$ADJUTORIX_AGENT_STOP_GRACE_TIMEOUT_SECONDS" "$ADJUTORIX_AGENT_STOP_POLL_INTERVAL_SECONDS"; then
    STOP_RESULT="graceful"
    return 0
  fi

  if [[ "$ADJUTORIX_AGENT_STOP_FORCE_AFTER_TIMEOUT" == "true" ]]; then
    FORCE_USED=true
    log_warn "Graceful shutdown timed out; escalating with ${ADJUTORIX_AGENT_STOP_FORCE_SIGNAL}"
    kill -${ADJUTORIX_AGENT_STOP_FORCE_SIGNAL} "$TARGET_PID"
    wait_for_process_exit "$TARGET_PID" 5 1
    STOP_RESULT="forced"
    return 0
  fi

  die "Graceful shutdown timed out and force escalation is disabled"
}

phase_cleanup_pid() {
  if [[ -f "$ADJUTORIX_AGENT_STOP_PID_FILE" ]]; then
    rm -f "$ADJUTORIX_AGENT_STOP_PID_FILE"
  fi
}

phase_confirm_health_down() {
  if [[ "$ADJUTORIX_AGENT_STOP_CONFIRM_HEALTH_DOWN" != "true" ]]; then
    return 0
  fi
  if wait_for_health_down 10 "$ADJUTORIX_AGENT_STOP_POLL_INTERVAL_SECONDS"; then
    return 0
  fi
  die "Health endpoint still responds after shutdown attempt: ${HEALTH_URL}"
}

phase_confirm_port_release() {
  if [[ "$ADJUTORIX_AGENT_STOP_CONFIRM_PORT_RELEASED" != "true" ]]; then
    return 0
  fi

  if [[ "$ADJUTORIX_AGENT_STOP_EXTRA_KILL_BY_PORT" == "true" ]]; then
    kill_port_owners
    sleep 1
  fi

  PORT_OWNER_AFTER="$(port_listener_info | tr '\n' ';' | sed 's/;$/ /')"
  [[ -z "$PORT_OWNER_AFTER" ]] || die "Configured port still has a listener: ${PORT_OWNER_AFTER}"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX agent stop summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "host: ${ADJUTORIX_AGENT_STOP_HOST}"
    echo "port: ${ADJUTORIX_AGENT_STOP_PORT}"
    echo "base_url: ${ADJUTORIX_AGENT_STOP_BASE_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "pid_file: ${ADJUTORIX_AGENT_STOP_PID_FILE}"
    echo "pid_file_present: ${PID_FILE_PRESENT}"
    echo "target_pid: ${TARGET_PID}"
    echo "pid_was_stale: ${PID_WAS_STALE}"
    echo "identity_checked: ${ADJUTORIX_AGENT_STOP_VERIFY_PROCESS_IDENTITY}"
    echo "process_cmdline: ${PROCESS_CMDLINE}"
    echo "force_used: ${FORCE_USED}"
    echo "stop_result: ${STOP_RESULT}"
    echo "port_owner_before: ${PORT_OWNER_BEFORE}"
    echo "port_owner_after: ${PORT_OWNER_AFTER}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_AGENT_STOP_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_AGENT_STOP_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_AGENT_STOP_PHASE_FILE}"
  } >"$ADJUTORIX_AGENT_STOP_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX agent stop"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "base_url=${ADJUTORIX_AGENT_STOP_BASE_URL} pid_file=${ADJUTORIX_AGENT_STOP_PID_FILE}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase capture_pre_state phase_capture_pre_state
  run_phase resolve_target_pid phase_resolve_target_pid
  run_phase verify_identity phase_verify_identity
  run_phase request_shutdown phase_request_shutdown
  run_phase cleanup_pid phase_cleanup_pid
  run_phase confirm_health_down phase_confirm_health_down
  run_phase confirm_port_release phase_confirm_port_release

  if [[ "$STOP_RESULT" == "unknown" ]]; then
    if [[ "$PID_WAS_STALE" == "yes" || -z "$TARGET_PID" ]]; then
      STOP_RESULT="already_stopped_or_untracked"
    else
      STOP_RESULT="graceful"
    fi
  fi

  write_summary

  section "Agent stop complete"
  log_info "summary=${ADJUTORIX_AGENT_STOP_SUMMARY_FILE}"
  log_info "stop_result=${STOP_RESULT}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Agent stop failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
