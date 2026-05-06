#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX AGENT STATUS ENTRYPOINT
#
# Purpose
# - provide one authoritative entrypoint for inspecting the governed ADJUTORIX
#   local agent runtime
# - collect deterministic evidence about PID state, process identity, port
#   ownership, token materialization, health/RPC reachability, runtime files,
#   and stale residue so "agent status" means one coherent observed state
# - emit human-readable and machine-readable status artifacts suitable for local
#   debugging, CI diagnostics, and operator triage
#
# Scope
# - read-only inspection of local runtime state except for report generation
# - no mutation outside repository temp/report directories
# - no attempt to repair or restart the service in this command
#
# Design constraints
# - no silent fallback from PID-based to port-based identity without recording it
# - no unverifiable claims about health or liveness
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

: "${ADJUTORIX_AGENT_STATUS_STACK_NAME:=adjutorix-agent-status}"
: "${ADJUTORIX_AGENT_STATUS_USE_COLOR:=true}"
: "${ADJUTORIX_AGENT_STATUS_FAIL_FAST:=true}"
: "${ADJUTORIX_AGENT_STATUS_HOST:=127.0.0.1}"
: "${ADJUTORIX_AGENT_STATUS_PORT:=8000}"
: "${ADJUTORIX_AGENT_STATUS_BASE_URL:=http://${ADJUTORIX_AGENT_STATUS_HOST}:${ADJUTORIX_AGENT_STATUS_PORT}}"
: "${ADJUTORIX_AGENT_STATUS_HEALTH_PATH:=/health}"
: "${ADJUTORIX_AGENT_STATUS_RPC_PATH:=/rpc}"
: "${ADJUTORIX_AGENT_STATUS_HTTP_TIMEOUT_SECONDS:=3}"
: "${ADJUTORIX_AGENT_STATUS_PID_FILE:=${REPO_ROOT}/.tmp/agent/pids/agent.pid}"
: "${ADJUTORIX_AGENT_STATUS_ROOT_TMP:=${REPO_ROOT}/.tmp/agent}"
: "${ADJUTORIX_AGENT_STATUS_LOG_DIR:=${ADJUTORIX_AGENT_STATUS_ROOT_TMP}/logs}"
: "${ADJUTORIX_AGENT_STATUS_REPORT_DIR:=${ADJUTORIX_AGENT_STATUS_ROOT_TMP}/reports}"
: "${ADJUTORIX_AGENT_STATUS_RUNTIME_DIR:=${ADJUTORIX_AGENT_STATUS_ROOT_TMP}/runtime}"
: "${ADJUTORIX_AGENT_STATUS_BOOT_LOG:=${ADJUTORIX_AGENT_STATUS_LOG_DIR}/status.log}"
: "${ADJUTORIX_AGENT_STATUS_SUMMARY_FILE:=${ADJUTORIX_AGENT_STATUS_REPORT_DIR}/status-summary.txt}"
: "${ADJUTORIX_AGENT_STATUS_PHASE_FILE:=${ADJUTORIX_AGENT_STATUS_REPORT_DIR}/status-phases.tsv}"
: "${ADJUTORIX_AGENT_STATUS_JSON_FILE:=${ADJUTORIX_AGENT_STATUS_REPORT_DIR}/status.json}"
: "${ADJUTORIX_AGENT_STATUS_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_AGENT_STATUS_EXPECTED_MODULE_HINT:=adjutorix_agent.server.main}"
: "${ADJUTORIX_AGENT_STATUS_VERIFY_RPC:=true}"
: "${ADJUTORIX_AGENT_STATUS_VERIFY_HEALTH:=true}"
: "${ADJUTORIX_AGENT_STATUS_INCLUDE_LOG_TAIL:=true}"
: "${ADJUTORIX_AGENT_STATUS_LOG_TAIL_LINES:=20}"
: "${ADJUTORIX_AGENT_STATUS_AGENT_LOG:=${ADJUTORIX_AGENT_STATUS_LOG_DIR}/agent.log}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
HEALTH_URL=""
RPC_URL=""
PID_FILE_PRESENT="no"
TARGET_PID=""
PID_RUNNING="no"
PID_STALE="no"
PROCESS_CMDLINE=""
PROCESS_IDENTITY_OK="unknown"
PORT_LISTENING="no"
PORT_OWNER=""
TOKEN_PRESENT="no"
TOKEN_BYTES="0"
HEALTH_OK="no"
RPC_REACHABLE="no"
AGENT_LOG_PRESENT="no"
AGENT_LOG_SIZE="0"
STATUS_CLASS="unknown"
LOG_TAIL_FILE=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_AGENT_STATUS_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_AGENT_STATUS_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  STATUS_CLASS="failed_inspection"
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_AGENT_STATUS_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/agent/status.sh [options]

Options:
  --host <host>                 Override expected bind host
  --port <port>                 Override expected bind port
  --base-url <url>              Override expected base URL
  --pid-file <path>             Override PID file location
  --no-health                   Skip health endpoint probe
  --no-rpc                      Skip RPC endpoint probe
  --no-log-tail                 Skip log tail artifact generation
  --log-tail-lines <n>          Tail this many lines from agent log
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
        ADJUTORIX_AGENT_STATUS_HOST="$1"
        ADJUTORIX_AGENT_STATUS_BASE_URL="http://${ADJUTORIX_AGENT_STATUS_HOST}:${ADJUTORIX_AGENT_STATUS_PORT}"
        ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value"
        ADJUTORIX_AGENT_STATUS_PORT="$1"
        ADJUTORIX_AGENT_STATUS_BASE_URL="http://${ADJUTORIX_AGENT_STATUS_HOST}:${ADJUTORIX_AGENT_STATUS_PORT}"
        ;;
      --base-url)
        shift
        [[ $# -gt 0 ]] || die "--base-url requires a value"
        ADJUTORIX_AGENT_STATUS_BASE_URL="$1"
        ;;
      --pid-file)
        shift
        [[ $# -gt 0 ]] || die "--pid-file requires a value"
        ADJUTORIX_AGENT_STATUS_PID_FILE="$1"
        ;;
      --no-health)
        ADJUTORIX_AGENT_STATUS_VERIFY_HEALTH=false
        ;;
      --no-rpc)
        ADJUTORIX_AGENT_STATUS_VERIFY_RPC=false
        ;;
      --no-log-tail)
        ADJUTORIX_AGENT_STATUS_INCLUDE_LOG_TAIL=false
        ;;
      --log-tail-lines)
        shift
        [[ $# -gt 0 ]] || die "--log-tail-lines requires a value"
        ADJUTORIX_AGENT_STATUS_LOG_TAIL_LINES="$1"
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_AGENT_STATUS_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_AGENT_STATUS_PHASE_FILE"
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
    if [[ "$ADJUTORIX_AGENT_STATUS_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

http_ok() {
  local url="$1"
  curl -fsS --max-time "$ADJUTORIX_AGENT_STATUS_HTTP_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1
}

port_listener_info() {
  lsof -nP -iTCP:"$ADJUTORIX_AGENT_STATUS_PORT" -sTCP:LISTEN 2>/dev/null || true
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_AGENT_STATUS_LOG_DIR"
  ensure_dir "$ADJUTORIX_AGENT_STATUS_REPORT_DIR"
  : >"$ADJUTORIX_AGENT_STATUS_BOOT_LOG"
  : >"$ADJUTORIX_AGENT_STATUS_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_AGENT_STATUS_PHASE_FILE"
  HEALTH_URL="${ADJUTORIX_AGENT_STATUS_BASE_URL}${ADJUTORIX_AGENT_STATUS_HEALTH_PATH}"
  RPC_URL="${ADJUTORIX_AGENT_STATUS_BASE_URL}${ADJUTORIX_AGENT_STATUS_RPC_PATH}"
  LOG_TAIL_FILE="${ADJUTORIX_AGENT_STATUS_REPORT_DIR}/agent-log-tail.txt"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command curl
  require_command lsof
  require_command ps
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_inspect_pid_state() {
  if [[ -f "$ADJUTORIX_AGENT_STATUS_PID_FILE" ]]; then
    PID_FILE_PRESENT="yes"
    TARGET_PID="$(tr -d '[:space:]' < "$ADJUTORIX_AGENT_STATUS_PID_FILE")"
  else
    PID_FILE_PRESENT="no"
    TARGET_PID=""
  fi

  if [[ -n "$TARGET_PID" ]]; then
    if child_is_running "$TARGET_PID"; then
      PID_RUNNING="yes"
      PROCESS_CMDLINE="$(ps -o command= -p "$TARGET_PID" | sed 's/^[[:space:]]*//' || true)"
      if [[ "$PROCESS_CMDLINE" == *"${ADJUTORIX_AGENT_STATUS_EXPECTED_MODULE_HINT}"* ]]; then
        PROCESS_IDENTITY_OK="yes"
      else
        PROCESS_IDENTITY_OK="no"
      fi
    else
      PID_RUNNING="no"
      PID_STALE="yes"
      PROCESS_CMDLINE=""
      PROCESS_IDENTITY_OK="unknown"
    fi
  fi
}

phase_inspect_port_state() {
  PORT_OWNER="$(port_listener_info | tr '\n' ';' | sed 's/;$/ /')"
  if [[ -n "$PORT_OWNER" ]]; then
    PORT_LISTENING="yes"
  else
    PORT_LISTENING="no"
  fi
}

phase_inspect_token_state() {
  if [[ -f "$ADJUTORIX_AGENT_STATUS_TOKEN_FILE" ]]; then
    TOKEN_PRESENT="yes"
    TOKEN_BYTES="$(wc -c < "$ADJUTORIX_AGENT_STATUS_TOKEN_FILE" | tr -d ' ')"
  else
    TOKEN_PRESENT="no"
    TOKEN_BYTES="0"
  fi
}

phase_probe_health() {
  if [[ "$ADJUTORIX_AGENT_STATUS_VERIFY_HEALTH" != "true" ]]; then
    return 0
  fi
  if http_ok "$HEALTH_URL"; then
    HEALTH_OK="yes"
  else
    HEALTH_OK="no"
  fi
}

phase_probe_rpc() {
  if [[ "$ADJUTORIX_AGENT_STATUS_VERIFY_RPC" != "true" ]]; then
    return 0
  fi
  if curl -fsS --max-time "$ADJUTORIX_AGENT_STATUS_HTTP_TIMEOUT_SECONDS" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"rpc.capabilities","params":{}}' "$RPC_URL" >/dev/null 2>&1; then
    RPC_REACHABLE="yes"
  else
    RPC_REACHABLE="no"
  fi
}

phase_inspect_runtime_artifacts() {
  if [[ -f "$ADJUTORIX_AGENT_STATUS_AGENT_LOG" ]]; then
    AGENT_LOG_PRESENT="yes"
    AGENT_LOG_SIZE="$(wc -c < "$ADJUTORIX_AGENT_STATUS_AGENT_LOG" | tr -d ' ')"
    if [[ "$ADJUTORIX_AGENT_STATUS_INCLUDE_LOG_TAIL" == "true" ]]; then
      tail -n "$ADJUTORIX_AGENT_STATUS_LOG_TAIL_LINES" "$ADJUTORIX_AGENT_STATUS_AGENT_LOG" >"$LOG_TAIL_FILE" 2>/dev/null || true
    fi
  else
    AGENT_LOG_PRESENT="no"
    AGENT_LOG_SIZE="0"
    if [[ "$ADJUTORIX_AGENT_STATUS_INCLUDE_LOG_TAIL" == "true" ]]; then
      : >"$LOG_TAIL_FILE"
    fi
  fi
}

phase_classify_status() {
  if [[ "$PID_RUNNING" == "yes" && "$PROCESS_IDENTITY_OK" == "yes" && "$PORT_LISTENING" == "yes" && "$HEALTH_OK" == "yes" ]]; then
    STATUS_CLASS="ready"
  elif [[ "$PORT_LISTENING" == "yes" && "$HEALTH_OK" == "yes" ]]; then
    STATUS_CLASS="reachable_untracked"
  elif [[ "$PID_STALE" == "yes" ]]; then
    STATUS_CLASS="stale_pid"
  elif [[ "$PID_RUNNING" == "yes" && "$PROCESS_IDENTITY_OK" == "no" ]]; then
    STATUS_CLASS="pid_identity_mismatch"
  elif [[ "$PORT_LISTENING" == "yes" || "$PID_RUNNING" == "yes" ]]; then
    STATUS_CLASS="degraded_running"
  else
    STATUS_CLASS="stopped"
  fi
}

phase_write_json() {
  python3 - <<'PY' \
    "$ADJUTORIX_AGENT_STATUS_JSON_FILE" \
    "$PROGRAM_NAME" \
    "$START_TS" \
    "$REPO_ROOT" \
    "$ADJUTORIX_AGENT_STATUS_BASE_URL" \
    "$HEALTH_URL" \
    "$RPC_URL" \
    "$ADJUTORIX_AGENT_STATUS_PID_FILE" \
    "$PID_FILE_PRESENT" \
    "$TARGET_PID" \
    "$PID_RUNNING" \
    "$PID_STALE" \
    "$PROCESS_CMDLINE" \
    "$PROCESS_IDENTITY_OK" \
    "$PORT_LISTENING" \
    "$PORT_OWNER" \
    "$TOKEN_PRESENT" \
    "$TOKEN_BYTES" \
    "$HEALTH_OK" \
    "$RPC_REACHABLE" \
    "$AGENT_LOG_PRESENT" \
    "$AGENT_LOG_SIZE" \
    "$STATUS_CLASS"
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    'program': sys.argv[2],
    'started_at': sys.argv[3],
    'repo_root': sys.argv[4],
    'base_url': sys.argv[5],
    'health_url': sys.argv[6],
    'rpc_url': sys.argv[7],
    'pid_file': sys.argv[8],
    'pid_file_present': sys.argv[9],
    'target_pid': sys.argv[10],
    'pid_running': sys.argv[11],
    'pid_stale': sys.argv[12],
    'process_cmdline': sys.argv[13],
    'process_identity_ok': sys.argv[14],
    'port_listening': sys.argv[15],
    'port_owner': sys.argv[16],
    'token_present': sys.argv[17],
    'token_bytes': sys.argv[18],
    'health_ok': sys.argv[19],
    'rpc_reachable': sys.argv[20],
    'agent_log_present': sys.argv[21],
    'agent_log_size': sys.argv[22],
    'status_class': sys.argv[23],
}
path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX agent status summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "base_url: ${ADJUTORIX_AGENT_STATUS_BASE_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "pid_file: ${ADJUTORIX_AGENT_STATUS_PID_FILE}"
    echo "pid_file_present: ${PID_FILE_PRESENT}"
    echo "target_pid: ${TARGET_PID}"
    echo "pid_running: ${PID_RUNNING}"
    echo "pid_stale: ${PID_STALE}"
    echo "process_identity_ok: ${PROCESS_IDENTITY_OK}"
    echo "process_cmdline: ${PROCESS_CMDLINE}"
    echo "port_listening: ${PORT_LISTENING}"
    echo "port_owner: ${PORT_OWNER}"
    echo "token_present: ${TOKEN_PRESENT}"
    echo "token_bytes: ${TOKEN_BYTES}"
    echo "health_ok: ${HEALTH_OK}"
    echo "rpc_reachable: ${RPC_REACHABLE}"
    echo "agent_log_present: ${AGENT_LOG_PRESENT}"
    echo "agent_log_size: ${AGENT_LOG_SIZE}"
    echo "status_class: ${STATUS_CLASS}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_AGENT_STATUS_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_AGENT_STATUS_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_AGENT_STATUS_PHASE_FILE}"
    echo "  - json: ${ADJUTORIX_AGENT_STATUS_JSON_FILE}"
    if [[ "$ADJUTORIX_AGENT_STATUS_INCLUDE_LOG_TAIL" == "true" ]]; then
      echo "  - log_tail: ${LOG_TAIL_FILE}"
    fi
  } >"$ADJUTORIX_AGENT_STATUS_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX agent status"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "base_url=${ADJUTORIX_AGENT_STATUS_BASE_URL} pid_file=${ADJUTORIX_AGENT_STATUS_PID_FILE}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase inspect_pid_state phase_inspect_pid_state
  run_phase inspect_port_state phase_inspect_port_state
  run_phase inspect_token_state phase_inspect_token_state
  run_phase probe_health phase_probe_health
  run_phase probe_rpc phase_probe_rpc
  run_phase inspect_runtime_artifacts phase_inspect_runtime_artifacts
  run_phase classify_status phase_classify_status
  run_phase write_json phase_write_json

  write_summary

  section "Agent status complete"
  log_info "summary=${ADJUTORIX_AGENT_STATUS_SUMMARY_FILE}"
  log_info "status_class=${STATUS_CLASS}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Agent status inspection failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
