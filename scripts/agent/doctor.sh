#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX AGENT DOCTOR ENTRYPOINT
#
# Purpose
# - provide one authoritative diagnostic command for the local ADJUTORIX agent
#   runtime and its immediate prerequisites
# - inspect repository shape, Python environment, package importability, token
#   materialization, env overlays, PID/port residue, health and RPC reachability,
#   log presence, and runtime directory state without mutating the environment
# - emit explicit PASS/WARN/FAIL findings and machine-readable artifacts so
#   broken agent state has one coherent mechanical explanation
#
# Scope
# - read-only inspection except for report generation under repository .tmp
# - no restart, repair, install, or cleanup actions
# - bounded to the local workstation/runtime context
#
# Design constraints
# - no unverifiable claims about process identity or network reachability
# - no silent fallback between different runtime roots or token locations
# - every diagnosis phase explicit, timed, logged, and summary-reported
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

: "${ADJUTORIX_AGENT_DOCTOR_STACK_NAME:=adjutorix-agent-doctor}"
: "${ADJUTORIX_AGENT_DOCTOR_USE_COLOR:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_FAIL_FAST:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_HOST:=127.0.0.1}"
: "${ADJUTORIX_AGENT_DOCTOR_PORT:=8000}"
: "${ADJUTORIX_AGENT_DOCTOR_BASE_URL:=http://${ADJUTORIX_AGENT_DOCTOR_HOST}:${ADJUTORIX_AGENT_DOCTOR_PORT}}"
: "${ADJUTORIX_AGENT_DOCTOR_HEALTH_PATH:=/health}"
: "${ADJUTORIX_AGENT_DOCTOR_RPC_PATH:=/rpc}"
: "${ADJUTORIX_AGENT_DOCTOR_HTTP_TIMEOUT_SECONDS:=3}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_HTTP:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_RPC:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_PROCESSES:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_PORTS:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_IMPORTS:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_SCAN_LOG_TAIL:=true}"
: "${ADJUTORIX_AGENT_DOCTOR_LOG_TAIL_LINES:=20}"
: "${ADJUTORIX_AGENT_DOCTOR_EXPECTED_MODULE_HINT:=adjutorix_agent.server.main}"
: "${ADJUTORIX_AGENT_DOCTOR_ROOT_TMP:=${REPO_ROOT}/.tmp/agent}"
: "${ADJUTORIX_AGENT_DOCTOR_RUNTIME_DIR:=${ADJUTORIX_AGENT_DOCTOR_ROOT_TMP}/runtime}"
: "${ADJUTORIX_AGENT_DOCTOR_LOG_DIR:=${ADJUTORIX_AGENT_DOCTOR_ROOT_TMP}/logs}"
: "${ADJUTORIX_AGENT_DOCTOR_PID_DIR:=${ADJUTORIX_AGENT_DOCTOR_ROOT_TMP}/pids}"
: "${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR:=${ADJUTORIX_AGENT_DOCTOR_ROOT_TMP}/reports}"
: "${ADJUTORIX_AGENT_DOCTOR_BOOT_LOG:=${ADJUTORIX_AGENT_DOCTOR_LOG_DIR}/doctor.log}"
: "${ADJUTORIX_AGENT_DOCTOR_SUMMARY_FILE:=${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR}/doctor-summary.txt}"
: "${ADJUTORIX_AGENT_DOCTOR_PHASE_FILE:=${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR}/doctor-phases.tsv}"
: "${ADJUTORIX_AGENT_DOCTOR_JSON_FILE:=${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR}/doctor.json}"
: "${ADJUTORIX_AGENT_DOCTOR_FINDINGS_FILE:=${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR}/doctor-findings.tsv}"
: "${ADJUTORIX_AGENT_DOCTOR_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_AGENT_DOCTOR_PID_FILE:=${ADJUTORIX_AGENT_DOCTOR_PID_DIR}/agent.pid}"
: "${ADJUTORIX_AGENT_DOCTOR_AGENT_LOG:=${ADJUTORIX_AGENT_DOCTOR_LOG_DIR}/agent.log}"
: "${ADJUTORIX_AGENT_DOCTOR_START_LOG:=${ADJUTORIX_AGENT_DOCTOR_LOG_DIR}/start.log}"
: "${ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_AGENT_DOCTOR_ENV_EXAMPLE:=${REPO_ROOT}/configs/runtime/agent.env.example}"
: "${ADJUTORIX_AGENT_DOCTOR_ENV_LOCAL:=${REPO_ROOT}/.env.agent.local}"
: "${ADJUTORIX_AGENT_DOCTOR_APP_ENV_LOCAL:=${REPO_ROOT}/.env.local}"
: "${ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN:=python}"

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
FINDINGS=()
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0
LOG_TAIL_FILE=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_AGENT_DOCTOR_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_AGENT_DOCTOR_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_AGENT_DOCTOR_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/agent/doctor.sh [options]

Options:
  --host <host>                 Override expected bind host
  --port <port>                 Override expected bind port
  --base-url <url>              Override expected base URL
  --no-http                     Skip health endpoint probing
  --no-rpc                      Skip RPC endpoint probing
  --no-processes                Skip process inspection
  --no-ports                    Skip port inspection
  --no-imports                  Skip Python import diagnostics
  --no-log-tail                 Skip log tail artifact generation
  --log-tail-lines <n>          Tail this many lines from agent log
  --python <path>               Override Python interpreter for import checks
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
        ADJUTORIX_AGENT_DOCTOR_HOST="$1"
        ADJUTORIX_AGENT_DOCTOR_BASE_URL="http://${ADJUTORIX_AGENT_DOCTOR_HOST}:${ADJUTORIX_AGENT_DOCTOR_PORT}"
        ;;
      --port)
        shift
        [[ $# -gt 0 ]] || die "--port requires a value"
        ADJUTORIX_AGENT_DOCTOR_PORT="$1"
        ADJUTORIX_AGENT_DOCTOR_BASE_URL="http://${ADJUTORIX_AGENT_DOCTOR_HOST}:${ADJUTORIX_AGENT_DOCTOR_PORT}"
        ;;
      --base-url)
        shift
        [[ $# -gt 0 ]] || die "--base-url requires a value"
        ADJUTORIX_AGENT_DOCTOR_BASE_URL="$1"
        ;;
      --no-http)
        ADJUTORIX_AGENT_DOCTOR_SCAN_HTTP=false
        ;;
      --no-rpc)
        ADJUTORIX_AGENT_DOCTOR_SCAN_RPC=false
        ;;
      --no-processes)
        ADJUTORIX_AGENT_DOCTOR_SCAN_PROCESSES=false
        ;;
      --no-ports)
        ADJUTORIX_AGENT_DOCTOR_SCAN_PORTS=false
        ;;
      --no-imports)
        ADJUTORIX_AGENT_DOCTOR_SCAN_IMPORTS=false
        ;;
      --no-log-tail)
        ADJUTORIX_AGENT_DOCTOR_SCAN_LOG_TAIL=false
        ;;
      --log-tail-lines)
        shift
        [[ $# -gt 0 ]] || die "--log-tail-lines requires a value"
        ADJUTORIX_AGENT_DOCTOR_LOG_TAIL_LINES="$1"
        ;;
      --python)
        shift
        [[ $# -gt 0 ]] || die "--python requires a value"
        ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN="$1"
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_AGENT_DOCTOR_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_AGENT_DOCTOR_PHASE_FILE"
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
    if [[ "$ADJUTORIX_AGENT_DOCTOR_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

record_finding() {
  local code="$1"
  local status="$2"
  local category="$3"
  local summary="$4"
  local evidence="$5"
  FINDINGS+=("${code}	${status}	${category}	${summary}	${evidence}")
  case "$status" in
    PASS) PASS_COUNT=$((PASS_COUNT + 1)) ;;
    WARN) WARN_COUNT=$((WARN_COUNT + 1)) ;;
    FAIL) FAIL_COUNT=$((FAIL_COUNT + 1)) ;;
    INFO) INFO_COUNT=$((INFO_COUNT + 1)) ;;
  esac
  case "$status" in
    PASS) log_info "[${code}] PASS - ${summary} :: ${evidence}" ;;
    WARN) log_warn "[${code}] WARN - ${summary} :: ${evidence}" ;;
    FAIL) log_error "[${code}] FAIL - ${summary} :: ${evidence}" ;;
    INFO) log_info "[${code}] INFO - ${summary} :: ${evidence}" ;;
  esac
}

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

http_ok() {
  local url="$1"
  curl -fsS --max-time "$ADJUTORIX_AGENT_DOCTOR_HTTP_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1
}

port_listener_info() {
  lsof -nP -iTCP:"$ADJUTORIX_AGENT_DOCTOR_PORT" -sTCP:LISTEN 2>/dev/null || true
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_AGENT_DOCTOR_LOG_DIR"
  ensure_dir "$ADJUTORIX_AGENT_DOCTOR_REPORT_DIR"
  : >"$ADJUTORIX_AGENT_DOCTOR_BOOT_LOG"
  : >"$ADJUTORIX_AGENT_DOCTOR_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_AGENT_DOCTOR_PHASE_FILE"
  printf 'code\tstatus\tcategory\tsummary\tevidence\n' >"$ADJUTORIX_AGENT_DOCTOR_FINDINGS_FILE"
  HEALTH_URL="${ADJUTORIX_AGENT_DOCTOR_BASE_URL}${ADJUTORIX_AGENT_DOCTOR_HEALTH_PATH}"
  RPC_URL="${ADJUTORIX_AGENT_DOCTOR_BASE_URL}${ADJUTORIX_AGENT_DOCTOR_RPC_PATH}"
  LOG_TAIL_FILE="${ADJUTORIX_AGENT_DOCTOR_REPORT_DIR}/doctor-log-tail.txt"
}

phase_repo_and_toolchain() {
  require_command python
  require_command curl
  require_command lsof
  require_command ps
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
  [[ -d "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR" ]] || die "Agent package dir not found: $ADJUTORIX_AGENT_DOCTOR_AGENT_DIR"
}

phase_check_repository_shape() {
  [[ -f "$REPO_ROOT/package.json" ]] && \
    record_finding D_REPO_PACKAGE PASS repo "Root package manifest present" "$REPO_ROOT/package.json" || \
    record_finding D_REPO_PACKAGE FAIL repo "Root package manifest missing" "$REPO_ROOT/package.json"

  [[ -f "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR/pyproject.toml" ]] && \
    record_finding D_AGENT_PYPROJECT PASS repo "Agent pyproject present" "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR/pyproject.toml" || \
    record_finding D_AGENT_PYPROJECT FAIL repo "Agent pyproject missing" "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR/pyproject.toml"

  [[ -f "$ADJUTORIX_AGENT_DOCTOR_ENV_EXAMPLE" ]] && \
    record_finding D_AGENT_ENV_EXAMPLE PASS repo "Agent env example present" "$ADJUTORIX_AGENT_DOCTOR_ENV_EXAMPLE" || \
    record_finding D_AGENT_ENV_EXAMPLE FAIL repo "Agent env example missing" "$ADJUTORIX_AGENT_DOCTOR_ENV_EXAMPLE"
}

phase_check_python_environment() {
  if command -v "$ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN" >/dev/null 2>&1; then
    local version
    version="$($ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN --version 2>&1 | head -n 1 || true)"
    record_finding D_PYTHON_BIN PASS python "Python interpreter available" "${ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN}: ${version}"
  else
    record_finding D_PYTHON_BIN FAIL python "Python interpreter unavailable" "$ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN"
  fi

  if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_IMPORTS" == "true" ]]; then
    if (cd "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR" && "$ADJUTORIX_AGENT_DOCTOR_PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import importlib
importlib.import_module('adjutorix_agent')
PY
    ); then
      record_finding D_AGENT_IMPORT PASS python "adjutorix_agent import succeeded" "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR"
    else
      record_finding D_AGENT_IMPORT FAIL python "adjutorix_agent import failed" "$ADJUTORIX_AGENT_DOCTOR_AGENT_DIR"
    fi
  else
    record_finding D_AGENT_IMPORT INFO python "Import diagnostics skipped" "scan_imports=false"
  fi
}

phase_check_env_and_token() {
  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_ENV_LOCAL" ]]; then
    record_finding D_ENV_LOCAL INFO env "Agent local env override present" "$ADJUTORIX_AGENT_DOCTOR_ENV_LOCAL"
  else
    record_finding D_ENV_LOCAL WARN env "Agent local env override absent" "$ADJUTORIX_AGENT_DOCTOR_ENV_LOCAL"
  fi

  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_APP_ENV_LOCAL" ]]; then
    record_finding D_APP_ENV_LOCAL INFO env "App local env override present" "$ADJUTORIX_AGENT_DOCTOR_APP_ENV_LOCAL"
  else
    record_finding D_APP_ENV_LOCAL WARN env "App local env override absent" "$ADJUTORIX_AGENT_DOCTOR_APP_ENV_LOCAL"
  fi

  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE" ]]; then
    local bytes
    bytes="$(wc -c < "$ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE" | tr -d ' ')"
    if [[ "$bytes" -gt 0 ]]; then
      record_finding D_TOKEN_FILE PASS auth "Token file present and non-empty" "path=$ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE bytes=$bytes"
    else
      record_finding D_TOKEN_FILE WARN auth "Token file present but empty" "$ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE"
    fi
  else
    record_finding D_TOKEN_FILE WARN auth "Token file absent" "$ADJUTORIX_AGENT_DOCTOR_TOKEN_FILE"
  fi
}

phase_check_pid_and_process() {
  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_PID_FILE" ]]; then
    local pid
    pid="$(tr -d '[:space:]' < "$ADJUTORIX_AGENT_DOCTOR_PID_FILE")"
    if [[ -n "$pid" ]]; then
      if child_is_running "$pid"; then
        local cmd
        cmd="$(ps -o command= -p "$pid" | sed 's/^[[:space:]]*//' || true)"
        record_finding D_PID_RUNNING PASS process "PID file points to running process" "pid=$pid cmd=$cmd"
        if [[ "$cmd" == *"${ADJUTORIX_AGENT_DOCTOR_EXPECTED_MODULE_HINT}"* ]]; then
          record_finding D_PID_IDENTITY PASS process "PID process identity matches expected agent module" "$cmd"
        else
          record_finding D_PID_IDENTITY WARN process "PID process identity does not match expected agent module" "$cmd"
        fi
      else
        record_finding D_PID_RUNNING WARN process "PID file appears stale" "pid=$pid file=$ADJUTORIX_AGENT_DOCTOR_PID_FILE"
      fi
    else
      record_finding D_PID_RUNNING WARN process "PID file present but empty" "$ADJUTORIX_AGENT_DOCTOR_PID_FILE"
    fi
  else
    record_finding D_PID_RUNNING WARN process "PID file absent" "$ADJUTORIX_AGENT_DOCTOR_PID_FILE"
  fi

  if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_PROCESSES" == "true" ]]; then
    local hits
    hits="$(pgrep -af "$ADJUTORIX_AGENT_DOCTOR_EXPECTED_MODULE_HINT" || true)"
    if [[ -n "$hits" ]]; then
      record_finding D_PROCESS_MATCH INFO process "Processes matching expected module hint found" "$hits"
    else
      record_finding D_PROCESS_MATCH WARN process "No processes matching expected module hint found" "$ADJUTORIX_AGENT_DOCTOR_EXPECTED_MODULE_HINT"
    fi
  else
    record_finding D_PROCESS_MATCH INFO process "Process scan skipped" "scan_processes=false"
  fi
}

phase_check_port_and_http() {
  if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_PORTS" == "true" ]]; then
    local owner
    owner="$(port_listener_info | tr '\n' ';' | sed 's/;$/ /')"
    if [[ -n "$owner" ]]; then
      record_finding D_PORT_LISTEN PASS network "Configured agent port has a listener" "port=$ADJUTORIX_AGENT_DOCTOR_PORT owner=$owner"
    else
      record_finding D_PORT_LISTEN WARN network "No listener on configured agent port" "port=$ADJUTORIX_AGENT_DOCTOR_PORT"
    fi
  else
    record_finding D_PORT_LISTEN INFO network "Port scan skipped" "scan_ports=false"
  fi

  if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_HTTP" == "true" ]]; then
    if http_ok "$HEALTH_URL"; then
      record_finding D_HEALTH PASS network "Health endpoint reachable" "$HEALTH_URL"
    else
      record_finding D_HEALTH WARN network "Health endpoint unreachable" "$HEALTH_URL"
    fi
  else
    record_finding D_HEALTH INFO network "HTTP health scan skipped" "scan_http=false"
  fi

  if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_RPC" == "true" ]]; then
    if curl -fsS --max-time "$ADJUTORIX_AGENT_DOCTOR_HTTP_TIMEOUT_SECONDS" -H 'Content-Type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"rpc.capabilities","params":{}}' "$RPC_URL" >/dev/null 2>&1; then
      record_finding D_RPC PASS network "RPC endpoint reachable" "$RPC_URL"
    else
      record_finding D_RPC WARN network "RPC endpoint unreachable" "$RPC_URL"
    fi
  else
    record_finding D_RPC INFO network "RPC scan skipped" "scan_rpc=false"
  fi
}

phase_check_runtime_artifacts() {
  [[ -d "$ADJUTORIX_AGENT_DOCTOR_RUNTIME_DIR" ]] && \
    record_finding D_RUNTIME_DIR INFO runtime "Runtime directory present" "$ADJUTORIX_AGENT_DOCTOR_RUNTIME_DIR" || \
    record_finding D_RUNTIME_DIR WARN runtime "Runtime directory absent" "$ADJUTORIX_AGENT_DOCTOR_RUNTIME_DIR"

  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_AGENT_LOG" ]]; then
    local size
    size="$(wc -c < "$ADJUTORIX_AGENT_DOCTOR_AGENT_LOG" | tr -d ' ')"
    record_finding D_AGENT_LOG PASS logs "Agent log present" "path=$ADJUTORIX_AGENT_DOCTOR_AGENT_LOG bytes=$size"
    if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_LOG_TAIL" == "true" ]]; then
      tail -n "$ADJUTORIX_AGENT_DOCTOR_LOG_TAIL_LINES" "$ADJUTORIX_AGENT_DOCTOR_AGENT_LOG" >"$LOG_TAIL_FILE" 2>/dev/null || true
      record_finding D_AGENT_LOG_TAIL INFO logs "Agent log tail written" "$LOG_TAIL_FILE"
    fi
  else
    record_finding D_AGENT_LOG WARN logs "Agent log absent" "$ADJUTORIX_AGENT_DOCTOR_AGENT_LOG"
    if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_LOG_TAIL" == "true" ]]; then
      : >"$LOG_TAIL_FILE"
    fi
  fi

  if [[ -f "$ADJUTORIX_AGENT_DOCTOR_START_LOG" ]]; then
    record_finding D_START_LOG INFO logs "Start log present" "$ADJUTORIX_AGENT_DOCTOR_START_LOG"
  else
    record_finding D_START_LOG WARN logs "Start log absent" "$ADJUTORIX_AGENT_DOCTOR_START_LOG"
  fi
}

phase_write_findings_and_json() {
  local row
  for row in "${FINDINGS[@]}"; do
    printf '%b\n' "$row" >>"$ADJUTORIX_AGENT_DOCTOR_FINDINGS_FILE"
  done

  python - <<'PY' \
    "$ADJUTORIX_AGENT_DOCTOR_JSON_FILE" \
    "$PROGRAM_NAME" \
    "$START_TS" \
    "$REPO_ROOT" \
    "$ADJUTORIX_AGENT_DOCTOR_BASE_URL" \
    "$HEALTH_URL" \
    "$RPC_URL" \
    "$PASS_COUNT" \
    "$WARN_COUNT" \
    "$FAIL_COUNT" \
    "$INFO_COUNT" \
    "$ADJUTORIX_AGENT_DOCTOR_FINDINGS_FILE"
import csv
import json
import sys
from pathlib import Path

json_path = Path(sys.argv[1])
payload = {
    'program': sys.argv[2],
    'started_at': sys.argv[3],
    'repo_root': sys.argv[4],
    'base_url': sys.argv[5],
    'health_url': sys.argv[6],
    'rpc_url': sys.argv[7],
    'counts': {
        'pass': int(sys.argv[8]),
        'warn': int(sys.argv[9]),
        'fail': int(sys.argv[10]),
        'info': int(sys.argv[11]),
    },
    'findings': [],
}
with Path(sys.argv[12]).open('r', encoding='utf-8') as fh:
    reader = csv.reader(fh, delimiter='\t')
    next(reader, None)
    for row in reader:
        if len(row) != 5:
            continue
        payload['findings'].append({
            'code': row[0],
            'status': row[1],
            'category': row[2],
            'summary': row[3],
            'evidence': row[4],
        })
json_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX agent doctor summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "base_url: ${ADJUTORIX_AGENT_DOCTOR_BASE_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "pass_count: ${PASS_COUNT}"
    echo "warn_count: ${WARN_COUNT}"
    echo "fail_count: ${FAIL_COUNT}"
    echo "info_count: ${INFO_COUNT}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_AGENT_DOCTOR_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_AGENT_DOCTOR_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_AGENT_DOCTOR_PHASE_FILE}"
    echo "  - findings: ${ADJUTORIX_AGENT_DOCTOR_FINDINGS_FILE}"
    echo "  - json: ${ADJUTORIX_AGENT_DOCTOR_JSON_FILE}"
    if [[ "$ADJUTORIX_AGENT_DOCTOR_SCAN_LOG_TAIL" == "true" ]]; then
      echo "  - log_tail: ${LOG_TAIL_FILE}"
    fi
  } >"$ADJUTORIX_AGENT_DOCTOR_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX agent doctor"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "base_url=${ADJUTORIX_AGENT_DOCTOR_BASE_URL}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase check_repository_shape phase_check_repository_shape
  run_phase check_python_environment phase_check_python_environment
  run_phase check_env_and_token phase_check_env_and_token
  run_phase check_pid_and_process phase_check_pid_and_process
  run_phase check_port_and_http phase_check_port_and_http
  run_phase check_runtime_artifacts phase_check_runtime_artifacts
  run_phase write_findings_and_json phase_write_findings_and_json

  write_summary

  section "Agent doctor complete"
  log_info "summary=${ADJUTORIX_AGENT_DOCTOR_SUMMARY_FILE}"
  log_info "json=${ADJUTORIX_AGENT_DOCTOR_JSON_FILE}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Agent doctor failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
