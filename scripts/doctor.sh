#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX DOCTOR ENTRYPOINT
#
# Purpose
# - provide one authoritative diagnostic command for local development,
#   onboarding, CI bootstrap debugging, and broken-runtime triage
# - inspect repository structure, toolchain, environment files, package health,
#   Python/Node runtime state, token presence, ports, processes, and selected
#   configuration integrity without mutating the system
# - produce explicit PASS/WARN/FAIL findings with actionable summaries and a
#   machine-readable report
#
# Design constraints
# - read-only by default; no hidden repair actions
# - deterministic inspection order and explicit bounded scope
# - every diagnosis emits a stable finding code, status, and evidence summary
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

: "${ADJUTORIX_DOCTOR_STACK_NAME:=adjutorix-doctor}"
: "${ADJUTORIX_DOCTOR_USE_COLOR:=true}"
: "${ADJUTORIX_DOCTOR_RUNTIME_MODE:=development}"
: "${ADJUTORIX_DOCTOR_AGENT_HOST:=127.0.0.1}"
: "${ADJUTORIX_DOCTOR_AGENT_PORT:=8000}"
: "${ADJUTORIX_DOCTOR_AGENT_URL:=http://${ADJUTORIX_DOCTOR_AGENT_HOST}:${ADJUTORIX_DOCTOR_AGENT_PORT}}"
: "${ADJUTORIX_DOCTOR_HEALTH_PATH:=/health}"
: "${ADJUTORIX_DOCTOR_HTTP_TIMEOUT_SECONDS:=3}"
: "${ADJUTORIX_DOCTOR_ROOT_TMP:=${REPO_ROOT}/.tmp/doctor}"
: "${ADJUTORIX_DOCTOR_LOG_DIR:=${ADJUTORIX_DOCTOR_ROOT_TMP}/logs}"
: "${ADJUTORIX_DOCTOR_REPORT_DIR:=${ADJUTORIX_DOCTOR_ROOT_TMP}/reports}"
: "${ADJUTORIX_DOCTOR_BOOT_LOG:=${ADJUTORIX_DOCTOR_LOG_DIR}/doctor.log}"
: "${ADJUTORIX_DOCTOR_REPORT_JSON:=${ADJUTORIX_DOCTOR_REPORT_DIR}/doctor.json}"
: "${ADJUTORIX_DOCTOR_SUMMARY_TXT:=${ADJUTORIX_DOCTOR_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_DOCTOR_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_DOCTOR_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_DOCTOR_CLI_DIR:=${REPO_ROOT}/packages/adjutorix-cli}"
: "${ADJUTORIX_DOCTOR_CONTRACTS_DIR:=${REPO_ROOT}/configs/contracts}"
: "${ADJUTORIX_DOCTOR_POLICY_DIR:=${REPO_ROOT}/configs/policy}"
: "${ADJUTORIX_DOCTOR_RUNTIME_DIR:=${REPO_ROOT}/configs/runtime}"
: "${ADJUTORIX_DOCTOR_OBSERVABILITY_DIR:=${REPO_ROOT}/configs/observability}"
: "${ADJUTORIX_DOCTOR_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_DOCTOR_ENV_OVERRIDE_FILE:=${REPO_ROOT}/.env.local}"
: "${ADJUTORIX_DOCTOR_AGENT_ENV_OVERRIDE_FILE:=${REPO_ROOT}/.env.agent.local}"
: "${ADJUTORIX_DOCTOR_INCLUDE_OPTIONAL_SCAN:=true}"
: "${ADJUTORIX_DOCTOR_SCAN_NODE_MODULES:=false}"
: "${ADJUTORIX_DOCTOR_SCAN_RUNNING_PROCESSES:=true}"
: "${ADJUTORIX_DOCTOR_SCAN_PORTS:=true}"
: "${ADJUTORIX_DOCTOR_SCAN_HTTP_HEALTH:=true}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
FINDINGS_TSV=()
PASS_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0
INFO_COUNT=0

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_DOCTOR_USE_COLOR}" != "true" || ! -t 1 ]]; then
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_CYAN=""
  C_BOLD=""
else
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_DOCTOR_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_DOCTOR_BOOT_LOG" >&2
}

###############################################################################
# HELPERS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/doctor.sh [options]

Options:
  --agent-port <port>          Override expected agent port
  --agent-host <host>          Override expected agent host
  --agent-url <url>            Override agent base URL
  --no-http-health             Skip HTTP health probing
  --no-port-scan               Skip port inspection
  --no-process-scan            Skip running-process inspection
  --scan-node-modules          Include node_modules size/presence scan
  --quiet                      Reduce non-error terminal output
  --verbose                    Emit debug logs
  --no-color                   Disable ANSI colors
  --help                       Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --agent-port)
        shift
        [[ $# -gt 0 ]] || die "--agent-port requires a value"
        ADJUTORIX_DOCTOR_AGENT_PORT="$1"
        ADJUTORIX_DOCTOR_AGENT_URL="http://${ADJUTORIX_DOCTOR_AGENT_HOST}:${ADJUTORIX_DOCTOR_AGENT_PORT}"
        ;;
      --agent-host)
        shift
        [[ $# -gt 0 ]] || die "--agent-host requires a value"
        ADJUTORIX_DOCTOR_AGENT_HOST="$1"
        ADJUTORIX_DOCTOR_AGENT_URL="http://${ADJUTORIX_DOCTOR_AGENT_HOST}:${ADJUTORIX_DOCTOR_AGENT_PORT}"
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_DOCTOR_AGENT_URL="$1"
        ;;
      --no-http-health)
        ADJUTORIX_DOCTOR_SCAN_HTTP_HEALTH=false
        ;;
      --no-port-scan)
        ADJUTORIX_DOCTOR_SCAN_PORTS=false
        ;;
      --no-process-scan)
        ADJUTORIX_DOCTOR_SCAN_RUNNING_PROCESSES=false
        ;;
      --scan-node-modules)
        ADJUTORIX_DOCTOR_SCAN_NODE_MODULES=true
        ;;
      --quiet)
        QUIET=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_DOCTOR_USE_COLOR=false
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

require_command() {
  command -v "$1" >/dev/null 2>&1 || return 1
}

path_exists() {
  [[ -e "$1" || -L "$1" ]]
}

json_escape() {
  python3 - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

record_finding() {
  local code="$1"
  local status="$2"
  local category="$3"
  local summary="$4"
  local evidence="$5"
  FINDINGS_TSV+=("${code}	${status}	${category}	${summary}	${evidence}")
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

record_path_presence() {
  local code="$1"
  local category="$2"
  local path="$3"
  local summary_present="$4"
  local summary_missing="$5"
  if path_exists "$path"; then
    record_finding "$code" PASS "$category" "$summary_present" "$path"
  else
    record_finding "$code" FAIL "$category" "$summary_missing" "$path"
  fi
}

file_contains() {
  local path="$1"
  local needle="$2"
  grep -q -- "$needle" "$path"
}

port_listener_info() {
  local port="$1"
  lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null || true
}

http_probe() {
  local url="$1"
  curl -fsS --max-time "$ADJUTORIX_DOCTOR_HTTP_TIMEOUT_SECONDS" "$url" >/dev/null 2>&1
}

###############################################################################
# DIAGNOSTIC CHECKS
###############################################################################

check_repo_layout() {
  section "Repository layout"
  record_path_presence D_REPO_ROOT repo "$REPO_ROOT" "Repository root found" "Repository root missing"
  record_path_presence D_REPO_PACKAGE_JSON repo "$REPO_ROOT/package.json" "Root package.json found" "Root package.json missing"
  record_path_presence D_APP_DIR repo "$ADJUTORIX_DOCTOR_APP_DIR" "App package directory found" "App package directory missing"
  record_path_presence D_AGENT_DIR repo "$ADJUTORIX_DOCTOR_AGENT_DIR" "Agent package directory found" "Agent package directory missing"
  record_path_presence D_CLI_DIR repo "$ADJUTORIX_DOCTOR_CLI_DIR" "CLI package directory found" "CLI package directory missing"
  record_path_presence D_CONTRACTS_DIR repo "$ADJUTORIX_DOCTOR_CONTRACTS_DIR" "Contracts directory found" "Contracts directory missing"
  record_path_presence D_POLICY_DIR repo "$ADJUTORIX_DOCTOR_POLICY_DIR" "Policy directory found" "Policy directory missing"
  record_path_presence D_RUNTIME_DIR repo "$ADJUTORIX_DOCTOR_RUNTIME_DIR" "Runtime directory found" "Runtime directory missing"
  record_path_presence D_OBSERVABILITY_DIR repo "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR" "Observability directory found" "Observability directory missing"
}

check_git_state() {
  section "Git state"
  if require_command git && git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    record_finding D_GIT_ROOT PASS git "Git worktree detected" "$REPO_ROOT"
    local branch status_count
    branch="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
    status_count="$(git -C "$REPO_ROOT" status --porcelain | wc -l | tr -d ' ')"
    if [[ "$status_count" == "0" ]]; then
      record_finding D_GIT_CLEAN PASS git "Git worktree clean" "branch=${branch}"
    else
      record_finding D_GIT_CLEAN WARN git "Git worktree has uncommitted changes" "branch=${branch} dirty_entries=${status_count}"
    fi
  else
    record_finding D_GIT_ROOT FAIL git "Repository is not a git worktree" "$REPO_ROOT"
  fi
}

check_toolchain() {
  section "Toolchain"
  local cmd version
  for cmd in bash python3 node npm git curl lsof; do
    if require_command "$cmd"; then
      version="$($cmd --version 2>/dev/null | head -n 1 || true)"
      record_finding "D_TOOL_$(printf "%s" "$cmd" | tr "[:lower:]" "[:upper:]" | tr -c "[:alnum:]_" "_")" PASS toolchain "Command available" "${cmd}: ${version:-version unavailable}"
    else
      record_finding "D_TOOL_$(printf "%s" "$cmd" | tr "[:lower:]" "[:upper:]" | tr -c "[:alnum:]_" "_")" FAIL toolchain "Required command missing" "$cmd"
    fi
  done
}

check_package_files() {
  section "Package manifests and config files"
  record_path_presence D_APP_PACKAGE app "$ADJUTORIX_DOCTOR_APP_DIR/package.json" "App package manifest found" "App package manifest missing"
  record_path_presence D_AGENT_PYPROJECT agent "$ADJUTORIX_DOCTOR_AGENT_DIR/pyproject.toml" "Agent pyproject found" "Agent pyproject missing"
  record_path_presence D_CLI_PYPROJECT cli "$ADJUTORIX_DOCTOR_CLI_DIR/pyproject.toml" "CLI pyproject found" "CLI pyproject missing"

  local file
  for file in \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/protocol_versions.json" \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/patch_artifact.schema.json" \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/transaction_states.json" \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/ledger_edges.json" \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/verify_summary.schema.json" \
    "$ADJUTORIX_DOCTOR_CONTRACTS_DIR/governance_decision.schema.json" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/feature_flags.json" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/logging.json" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/limits.json" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/timeouts.json" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/scheduling.json"; do
    if path_exists "$file"; then
      if python3 - <<'PY' "$file" >/dev/null 2>&1
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    json.load(fh)
PY
      then
        record_finding D_JSON_PARSE PASS config "JSON parsed successfully" "$file"
      else
        record_finding D_JSON_PARSE FAIL config "JSON parse failed" "$file"
      fi
    else
      record_finding D_JSON_PARSE FAIL config "Required JSON file missing" "$file"
    fi
  done

  for file in \
    "$ADJUTORIX_DOCTOR_POLICY_DIR/mutation_policy.yaml" \
    "$ADJUTORIX_DOCTOR_POLICY_DIR/workspace_policy.yaml" \
    "$ADJUTORIX_DOCTOR_POLICY_DIR/verify_policy.yaml" \
    "$ADJUTORIX_DOCTOR_POLICY_DIR/trust_policy.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/metrics.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/event_catalog.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/error_codes.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/log_redaction.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/tracing.yaml" \
    "$ADJUTORIX_DOCTOR_OBSERVABILITY_DIR/dashboards.yaml"; do
    if path_exists "$file"; then
      if file_contains "$file" ":"; then
        record_finding D_TEXT_SHAPE PASS config "Structured text file present with expected delimiter shape" "$file"
      else
        record_finding D_TEXT_SHAPE WARN config "Structured text file lacks obvious key-value markers" "$file"
      fi
    else
      record_finding D_TEXT_SHAPE FAIL config "Required structured text file missing" "$file"
    fi
  done
}

check_environment_files() {
  section "Environment files"
  local file
  for file in \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/app.env.example" \
    "$ADJUTORIX_DOCTOR_RUNTIME_DIR/agent.env.example"; do
    if path_exists "$file"; then
      if grep -Eq 'ADJUTORIX_|VITE_' "$file"; then
        record_finding D_ENV_EXAMPLE PASS env "Environment example has expected prefixes" "$file"
      else
        record_finding D_ENV_EXAMPLE WARN env "Environment example lacks expected prefixes" "$file"
      fi
    else
      record_finding D_ENV_EXAMPLE FAIL env "Environment example missing" "$file"
    fi
  done

  if path_exists "$ADJUTORIX_DOCTOR_ENV_OVERRIDE_FILE"; then
    record_finding D_ENV_OVERRIDE INFO env "Optional app override env file present" "$ADJUTORIX_DOCTOR_ENV_OVERRIDE_FILE"
  else
    record_finding D_ENV_OVERRIDE WARN env "Optional app override env file absent" "$ADJUTORIX_DOCTOR_ENV_OVERRIDE_FILE"
  fi

  if path_exists "$ADJUTORIX_DOCTOR_AGENT_ENV_OVERRIDE_FILE"; then
    record_finding D_AGENT_ENV_OVERRIDE INFO env "Optional agent override env file present" "$ADJUTORIX_DOCTOR_AGENT_ENV_OVERRIDE_FILE"
  else
    record_finding D_AGENT_ENV_OVERRIDE WARN env "Optional agent override env file absent" "$ADJUTORIX_DOCTOR_AGENT_ENV_OVERRIDE_FILE"
  fi
}

check_token_state() {
  section "Token state"
  if path_exists "$ADJUTORIX_DOCTOR_TOKEN_FILE"; then
    local bytes
    bytes="$(wc -c < "$ADJUTORIX_DOCTOR_TOKEN_FILE" | tr -d ' ')"
    if [[ "$bytes" -gt 0 ]]; then
      record_finding D_TOKEN_FILE PASS auth "Token file present and non-empty" "path=$ADJUTORIX_DOCTOR_TOKEN_FILE bytes=$bytes"
    else
      record_finding D_TOKEN_FILE WARN auth "Token file present but empty" "path=$ADJUTORIX_DOCTOR_TOKEN_FILE"
    fi
  else
    record_finding D_TOKEN_FILE WARN auth "Token file absent" "$ADJUTORIX_DOCTOR_TOKEN_FILE"
  fi
}

check_python_imports() {
  section "Python package imports"
  if [[ -d "$ADJUTORIX_DOCTOR_AGENT_DIR" ]]; then
    if (cd "$ADJUTORIX_DOCTOR_AGENT_DIR" && python3 - <<'PY' >/dev/null 2>&1
import importlib
importlib.import_module('adjutorix_agent')
PY
    ); then
      record_finding D_AGENT_IMPORT PASS python3 "adjutorix_agent import succeeded" "$ADJUTORIX_DOCTOR_AGENT_DIR"
    else
      record_finding D_AGENT_IMPORT FAIL python3 "adjutorix_agent import failed" "$ADJUTORIX_DOCTOR_AGENT_DIR"
    fi
  fi

  if [[ -d "$ADJUTORIX_DOCTOR_CLI_DIR" ]]; then
    if (cd "$ADJUTORIX_DOCTOR_CLI_DIR" && python3 - <<'PY' >/dev/null 2>&1
import importlib
importlib.import_module('adjutorix_cli')
PY
    ); then
      record_finding D_CLI_IMPORT PASS python3 "adjutorix_cli import succeeded" "$ADJUTORIX_DOCTOR_CLI_DIR"
    else
      record_finding D_CLI_IMPORT FAIL python3 "adjutorix_cli import failed" "$ADJUTORIX_DOCTOR_CLI_DIR"
    fi
  fi
}


is_true() {
  case "${1:-}" in
    1|true|TRUE|yes|YES|y|Y|on|ON) return 0 ;;
    *) return 1 ;;
  esac
}

check_node_installation_state() {
  section "Node installation state"
  local root_nm app_nm
  root_nm="$REPO_ROOT/node_modules"
  app_nm="$ADJUTORIX_DOCTOR_APP_DIR/node_modules"

  if path_exists "$root_nm"; then
    record_finding D_ROOT_NODE_MODULES PASS node "Root node_modules present" "$root_nm"
  else
    record_finding D_ROOT_NODE_MODULES WARN node "Root node_modules absent" "$root_nm"
  fi

  if path_exists "$app_nm"; then
    record_finding D_APP_NODE_MODULES PASS node "App node_modules present" "$app_nm"
  else
    record_finding D_APP_NODE_MODULES WARN node "App node_modules absent" "$app_nm"
  fi

  if is_true "$ADJUTORIX_DOCTOR_SCAN_NODE_MODULES"; then
    local size
    if path_exists "$root_nm"; then
      size="$(du -sh "$root_nm" 2>/dev/null | awk '{print $1}')"
      record_finding D_ROOT_NODE_MODULES_SIZE INFO node "Root node_modules size measured" "$size"
    fi
    if path_exists "$app_nm"; then
      size="$(du -sh "$app_nm" 2>/dev/null | awk '{print $1}')"
      record_finding D_APP_NODE_MODULES_SIZE INFO node "App node_modules size measured" "$size"
    fi
  fi
}

check_processes() {
  if ! is_true "$ADJUTORIX_DOCTOR_SCAN_RUNNING_PROCESSES"; then
    return 0
  fi
  section "Running processes"

  local matched=false
  local pattern
  for pattern in \
    'adjutorix_agent.server.main' \
    'packages/adjutorix-app' \
    'adjutorix_cli' \
    'vite' \
    'electron'; do
    if pgrep -f "$pattern" >/dev/null 2>&1; then
      matched=true
      local lines
      lines="$(pgrep -af "$pattern" | tr '
' ';' | sed 's/;$/ /')"
      record_finding D_PROCESS_MATCH INFO process "Matching runtime processes found" "pattern=$pattern procs=$lines"
    fi
  done

  if [[ "$matched" != true ]]; then
    record_finding D_PROCESS_MATCH WARN process "No known ADJUTORIX runtime processes found" "patterns=agent/app/cli/vite/electron"
  fi
}

check_ports() {
  if ! is_true "$ADJUTORIX_DOCTOR_SCAN_PORTS"; then
    return 0
  fi
  section "Port inspection"

  local info
  info="$(port_listener_info "$ADJUTORIX_DOCTOR_AGENT_PORT")"
  if [[ -n "$info" ]]; then
    record_finding D_AGENT_PORT PASS port "Agent port has a listening process" "port=$ADJUTORIX_DOCTOR_AGENT_PORT"
    record_finding D_AGENT_PORT_OWNER INFO port "Agent port listener details" "$info"
  else
    record_finding D_AGENT_PORT WARN port "No process listening on expected agent port" "port=$ADJUTORIX_DOCTOR_AGENT_PORT"
  fi
}

check_http_health() {
  if ! is_true "$ADJUTORIX_DOCTOR_SCAN_HTTP_HEALTH"; then
    return 0
  fi
  section "HTTP health"
  local url="${ADJUTORIX_DOCTOR_AGENT_URL}${ADJUTORIX_DOCTOR_HEALTH_PATH}"
  if http_probe "$url"; then
    record_finding D_AGENT_HEALTH PASS health "Agent health endpoint responded successfully" "$url"
  else
    record_finding D_AGENT_HEALTH WARN health "Agent health endpoint did not respond successfully" "$url"
  fi
}

check_optional_artifacts() {
  if ! is_true "$ADJUTORIX_DOCTOR_INCLUDE_OPTIONAL_SCAN"; then
    return 0
  fi
  section "Optional runtime artifacts"

  local optional_paths=(
    "$REPO_ROOT/.tmp"
    "$REPO_ROOT/test-results"
    "$REPO_ROOT/playwright-report"
    "$REPO_ROOT/coverage"
    "$REPO_ROOT/release"
    "$REPO_ROOT/artifacts"
  )
  local path
  for path in "${optional_paths[@]}"; do
    if path_exists "$path"; then
      record_finding D_OPTIONAL_ARTIFACT INFO artifact "Optional generated artifact directory present" "$path"
    else
      record_finding D_OPTIONAL_ARTIFACT WARN artifact "Optional generated artifact directory absent" "$path"
    fi
  done
}

###############################################################################
# REPORTING
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX doctor summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_DOCTOR_AGENT_URL}"
    echo "pass_count: ${PASS_COUNT}"
    echo "warn_count: ${WARN_COUNT}"
    echo "fail_count: ${FAIL_COUNT}"
    echo "info_count: ${INFO_COUNT}"
    echo
    echo "findings:"
    local line
    for line in "${FINDINGS_TSV[@]}"; do
      printf '  - %s
' "$line"
    done
  } >"$ADJUTORIX_DOCTOR_SUMMARY_TXT"
}

write_json_report() {
  python3 - <<'PY' "$ADJUTORIX_DOCTOR_REPORT_JSON" "${PASS_COUNT}" "${WARN_COUNT}" "${FAIL_COUNT}" "${INFO_COUNT}" "${PROGRAM_NAME}" "${START_TS}" "${REPO_ROOT}" "${ADJUTORIX_DOCTOR_AGENT_URL}" "${FINDINGS_TSV[*]}"
import json, sys
report_path = sys.argv[1]
pass_count = int(sys.argv[2])
warn_count = int(sys.argv[3])
fail_count = int(sys.argv[4])
info_count = int(sys.argv[5])
program = sys.argv[6]
started_at = sys.argv[7]
repo_root = sys.argv[8]
agent_url = sys.argv[9]
raw = sys.argv[10]
findings = []
if raw:
    for item in raw.split(" "):
        pass
# rebuild from env-independent file-like input via stdin would be cleaner, but preserve shell simplicity here
# use the boot summary file instead for structured output by passing full lines through environment is fragile,
# so re-read a temporary representation from a companion file is better.
PY
}

write_json_report_from_tsv() {
  local tmp_tsv="${ADJUTORIX_DOCTOR_REPORT_DIR}/findings.tsv"
  : >"$tmp_tsv"
  local line
  for line in "${FINDINGS_TSV[@]}"; do
    printf '%b
' "$line" >>"$tmp_tsv"
  done

  python3 - <<'PY' "$tmp_tsv" "$ADJUTORIX_DOCTOR_REPORT_JSON" "$PROGRAM_NAME" "$START_TS" "$REPO_ROOT" "$ADJUTORIX_DOCTOR_AGENT_URL" "$PASS_COUNT" "$WARN_COUNT" "$FAIL_COUNT" "$INFO_COUNT"
import csv
import json
import sys
from pathlib import Path

tsv_path = Path(sys.argv[1])
json_path = Path(sys.argv[2])
program = sys.argv[3]
started_at = sys.argv[4]
repo_root = sys.argv[5]
agent_url = sys.argv[6]
pass_count = int(sys.argv[7])
warn_count = int(sys.argv[8])
fail_count = int(sys.argv[9])
info_count = int(sys.argv[10])

findings = []
if tsv_path.exists():
    with tsv_path.open('r', encoding='utf-8') as fh:
        reader = csv.reader(fh, delimiter='\t')
        for row in reader:
            if len(row) != 5:
                continue
            findings.append({
                'code': row[0],
                'status': row[1],
                'category': row[2],
                'summary': row[3],
                'evidence': row[4],
            })

payload = {
    'program': program,
    'started_at': started_at,
    'repo_root': repo_root,
    'agent_url': agent_url,
    'counts': {
        'pass': pass_count,
        'warn': warn_count,
        'fail': fail_count,
        'info': info_count,
    },
    'findings': findings,
}
json_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_DOCTOR_LOG_DIR"
  ensure_dir "$ADJUTORIX_DOCTOR_REPORT_DIR"
  : >"$ADJUTORIX_DOCTOR_BOOT_LOG"
}

print_terminal_summary() {
  section "Doctor summary"
  log_info "PASS=${PASS_COUNT} WARN=${WARN_COUNT} FAIL=${FAIL_COUNT} INFO=${INFO_COUNT}"
  log_info "summary=${ADJUTORIX_DOCTOR_SUMMARY_TXT}"
  log_info "json=${ADJUTORIX_DOCTOR_REPORT_JSON}"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX doctor"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "agent_url=${ADJUTORIX_DOCTOR_AGENT_URL}"

  check_repo_layout
  check_git_state
  check_toolchain
  check_package_files
  check_environment_files
  check_token_state
  check_python_imports
  check_node_installation_state
  check_processes
  check_ports
  check_http_health
  check_optional_artifacts

  write_summary
  write_json_report_from_tsv
  print_terminal_summary

  if (( FAIL_COUNT > 0 )); then
    die "Doctor found ${FAIL_COUNT} failing condition(s)"
  fi
}

main "$@"
