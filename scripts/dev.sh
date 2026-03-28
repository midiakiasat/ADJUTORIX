#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX DEVELOPMENT ORCHESTRATION ENTRYPOINT
#
# Purpose
# - boot a reproducible local development stack for ADJUTORIX
# - validate toolchain, repository shape, env files, and runtime prerequisites
# - provision deterministic temp/log directories
# - start governed agent and desktop app processes with coordinated lifecycle
# - expose explicit health/readiness checks and fail fast on ambiguity
#
# Non-goals
# - no background hidden bootstrap beyond tracked child processes
# - no silent fallback to unknown ports, shells, or repo layouts
# - no placeholder behavior; every branch either executes or fails explicitly
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"

readonly SCRIPT_DIR
readonly REPO_ROOT

PROGRAM_NAME="$(basename -- "$0")"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

###############################################################################
# DEFAULTS (override via env or flags)
###############################################################################

: "${ADJUTORIX_DEV_STACK_NAME:=adjutorix-dev}"
: "${ADJUTORIX_DEV_RUNTIME_MODE:=development}"
: "${ADJUTORIX_DEV_CHANNEL:=dev}"
: "${ADJUTORIX_DEV_AGENT_HOST:=127.0.0.1}"
: "${ADJUTORIX_DEV_AGENT_PORT:=8000}"
: "${ADJUTORIX_DEV_AGENT_URL:=http://${ADJUTORIX_DEV_AGENT_HOST}:${ADJUTORIX_DEV_AGENT_PORT}}"
: "${ADJUTORIX_DEV_HEALTH_PATH:=/health}"
: "${ADJUTORIX_DEV_HEALTH_TIMEOUT_SECONDS:=45}"
: "${ADJUTORIX_DEV_HEALTH_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_DEV_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_DEV_RUN_INSTALL:=false}"
: "${ADJUTORIX_DEV_RUN_VERIFY_BOOT:=false}"
: "${ADJUTORIX_DEV_KILL_CONFLICTING_PORTS:=false}"
: "${ADJUTORIX_DEV_OPEN_APP:=true}"
: "${ADJUTORIX_DEV_OPEN_AGENT:=true}"
: "${ADJUTORIX_DEV_ALLOW_MISSING_ENV_FILES:=true}"
: "${ADJUTORIX_DEV_FORWARD_SIGNALS:=true}"
: "${ADJUTORIX_DEV_USE_COLOR:=true}"
: "${ADJUTORIX_DEV_AGENT_LOG_LEVEL:=info}"
: "${ADJUTORIX_DEV_APP_LOG_LEVEL:=info}"
: "${ADJUTORIX_DEV_ROOT_TMP:=${REPO_ROOT}/.tmp/dev}"
: "${ADJUTORIX_DEV_LOG_DIR:=${ADJUTORIX_DEV_ROOT_TMP}/logs}"
: "${ADJUTORIX_DEV_PID_DIR:=${ADJUTORIX_DEV_ROOT_TMP}/pids}"
: "${ADJUTORIX_DEV_RUNTIME_DIR:=${ADJUTORIX_DEV_ROOT_TMP}/runtime}"
: "${ADJUTORIX_DEV_AGENT_LOG_FILE:=${ADJUTORIX_DEV_LOG_DIR}/agent.log}"
: "${ADJUTORIX_DEV_APP_LOG_FILE:=${ADJUTORIX_DEV_LOG_DIR}/app.log}"
: "${ADJUTORIX_DEV_BOOT_LOG_FILE:=${ADJUTORIX_DEV_LOG_DIR}/boot.log}"
: "${ADJUTORIX_DEV_AGENT_PID_FILE:=${ADJUTORIX_DEV_PID_DIR}/agent.pid}"
: "${ADJUTORIX_DEV_APP_PID_FILE:=${ADJUTORIX_DEV_PID_DIR}/app.pid}"
: "${ADJUTORIX_DEV_WAIT_FOREVER:=true}"
: "${ADJUTORIX_DEV_APP_WORKDIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_DEV_AGENT_WORKDIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_DEV_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_DEV_ROOT_ENV_FILE:=${REPO_ROOT}/configs/runtime/app.env.example}"
: "${ADJUTORIX_DEV_AGENT_ENV_FILE:=${REPO_ROOT}/configs/runtime/agent.env.example}"
: "${ADJUTORIX_DEV_ENV_OVERRIDE_FILE:=${REPO_ROOT}/.env.local}"
: "${ADJUTORIX_DEV_AGENT_ENV_OVERRIDE_FILE:=${REPO_ROOT}/.env.agent.local}"

AGENT_CMD=(python -m adjutorix_agent.server.main)
APP_CMD=(npm run dev)
VERIFY_BOOT_CMD=(npm run verify)
INSTALL_CMD=(npm install)

###############################################################################
# GLOBAL STATE
###############################################################################

USE_COLOR="${ADJUTORIX_DEV_USE_COLOR}"
SHUTTING_DOWN=false
AGENT_PID=""
APP_PID=""
CHILD_PIDS=()
PRINT_ENV_SUMMARY=true
ONLY_AGENT=false
ONLY_APP=false
NO_WAIT=false
NO_COLOR=false
QUIET=false
VERBOSE=false

###############################################################################
# LOGGING
###############################################################################

if [[ "${NO_COLOR}" == "true" || "${USE_COLOR}" != "true" || ! -t 1 ]]; then
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

log_raw() {
  local level="$1"
  shift
  local msg="$*"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_DEV_BOOT_LOG_FILE" >&2
}

log_info() { log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() {
  if [[ "$VERBOSE" == "true" ]]; then
    log_raw DEBUG "$@"
  fi
}

die() {
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_DEV_BOOT_LOG_FILE" >&2
}

###############################################################################
# HELP / ARGUMENT PARSING
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/dev.sh [options]

Options:
  --agent-only                 Start only the governed agent
  --app-only                   Start only the desktop app
  --install                    Run package installation before boot
  --verify-boot                Run repository verify before boot
  --require-clean-worktree     Fail if git worktree is dirty
  --kill-conflicting-ports     Terminate processes already bound to agent port
  --no-wait                    Start child processes and exit once healthy
  --no-color                   Disable ANSI color output
  --quiet                      Reduce non-error terminal output
  --verbose                    Enable debug logging
  --agent-port <port>          Override agent port
  --agent-host <host>          Override agent host
  --agent-url <url>            Override agent URL
  --help                       Show this help

Environment overrides:
  ADJUTORIX_DEV_*              See script defaults for supported overrides
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --agent-only)
        ONLY_AGENT=true
        ADJUTORIX_DEV_OPEN_APP=false
        ;;
      --app-only)
        ONLY_APP=true
        ADJUTORIX_DEV_OPEN_AGENT=false
        ;;
      --install)
        ADJUTORIX_DEV_RUN_INSTALL=true
        ;;
      --verify-boot)
        ADJUTORIX_DEV_RUN_VERIFY_BOOT=true
        ;;
      --require-clean-worktree)
        ADJUTORIX_DEV_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --kill-conflicting-ports)
        ADJUTORIX_DEV_KILL_CONFLICTING_PORTS=true
        ;;
      --no-wait)
        NO_WAIT=true
        ADJUTORIX_DEV_WAIT_FOREVER=false
        ;;
      --no-color)
        NO_COLOR=true
        USE_COLOR=false
        ;;
      --quiet)
        QUIET=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --agent-port)
        shift
        [[ $# -gt 0 ]] || die "--agent-port requires a value"
        ADJUTORIX_DEV_AGENT_PORT="$1"
        ADJUTORIX_DEV_AGENT_URL="http://${ADJUTORIX_DEV_AGENT_HOST}:${ADJUTORIX_DEV_AGENT_PORT}"
        ;;
      --agent-host)
        shift
        [[ $# -gt 0 ]] || die "--agent-host requires a value"
        ADJUTORIX_DEV_AGENT_HOST="$1"
        ADJUTORIX_DEV_AGENT_URL="http://${ADJUTORIX_DEV_AGENT_HOST}:${ADJUTORIX_DEV_AGENT_PORT}"
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_DEV_AGENT_URL="$1"
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

  if [[ "$ONLY_AGENT" == "true" && "$ONLY_APP" == "true" ]]; then
    die "--agent-only and --app-only are mutually exclusive"
  fi
}

###############################################################################
# VALIDATION / UTILITIES
###############################################################################

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || die "Required file not found: $path"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || die "Required directory not found: $path"
}

ensure_dir() {
  mkdir -p "$1"
}

is_true() {
  case "${1,,}" in
    1|true|yes|y|on) return 0 ;;
    *) return 1 ;;
  esac
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
    log_warn "Killing processes listening on port $port: $pids"
    # shellcheck disable=SC2086
    kill $pids || true
    sleep 1
    pids="$(lsof -tiTCP:"$port" -sTCP:LISTEN || true)"
    if [[ -n "$pids" ]]; then
      log_warn "Force-killing persistent listeners on port $port: $pids"
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

load_env_file() {
  local env_file="$1"
  local strict_missing="$2"
  if [[ -f "$env_file" ]]; then
    log_debug "Loading env file: $env_file"
    set -a
    # shellcheck disable=SC1090
    source "$env_file"
    set +a
  else
    if is_true "$strict_missing"; then
      die "Env file missing: $env_file"
    else
      log_debug "Env file missing but allowed: $env_file"
    fi
  fi
}

print_summary() {
  [[ "$QUIET" == "true" ]] && return 0
  cat <<EOF >&2
${C_BOLD}ADJUTORIX dev summary${C_RESET}
  repo_root:         ${REPO_ROOT}
  stack_name:        ${ADJUTORIX_DEV_STACK_NAME}
  runtime_mode:      ${ADJUTORIX_DEV_RUNTIME_MODE}
  release_channel:   ${ADJUTORIX_DEV_CHANNEL}
  agent_url:         ${ADJUTORIX_DEV_AGENT_URL}
  open_agent:        ${ADJUTORIX_DEV_OPEN_AGENT}
  open_app:          ${ADJUTORIX_DEV_OPEN_APP}
  run_install:       ${ADJUTORIX_DEV_RUN_INSTALL}
  run_verify_boot:   ${ADJUTORIX_DEV_RUN_VERIFY_BOOT}
  require_clean_git: ${ADJUTORIX_DEV_REQUIRE_CLEAN_WORKTREE}
  log_dir:           ${ADJUTORIX_DEV_LOG_DIR}
  boot_log:          ${ADJUTORIX_DEV_BOOT_LOG_FILE}
EOF
}

###############################################################################
# REPO / TOOLCHAIN CHECKS
###############################################################################

validate_repo_layout() {
  section "Validating repository layout"
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_DEV_APP_WORKDIR"
  require_dir "$ADJUTORIX_DEV_AGENT_WORKDIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_DEV_APP_WORKDIR/package.json"
  require_file "$ADJUTORIX_DEV_ROOT_ENV_FILE"
  require_file "$ADJUTORIX_DEV_AGENT_ENV_FILE"
}

validate_toolchain() {
  section "Validating toolchain"
  require_command git
  require_command curl
  require_command lsof
  require_command python
  require_command npm
  require_command node

  if [[ "$ADJUTORIX_DEV_OPEN_AGENT" == "true" ]]; then
    require_command python
  fi
}

validate_git_state() {
  section "Checking git worktree"
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "Repository root is not a git worktree: $REPO_ROOT"
  if is_true "$ADJUTORIX_DEV_REQUIRE_CLEAN_WORKTREE"; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]] || die "Worktree is dirty and clean worktree is required"
  fi
}

prepare_runtime_dirs() {
  section "Preparing runtime directories"
  ensure_dir "$ADJUTORIX_DEV_ROOT_TMP"
  ensure_dir "$ADJUTORIX_DEV_LOG_DIR"
  ensure_dir "$ADJUTORIX_DEV_PID_DIR"
  ensure_dir "$ADJUTORIX_DEV_RUNTIME_DIR"
  : >"$ADJUTORIX_DEV_BOOT_LOG_FILE"
  : >"$ADJUTORIX_DEV_AGENT_LOG_FILE"
  : >"$ADJUTORIX_DEV_APP_LOG_FILE"
}

load_environment() {
  section "Loading environment"
  local strict_missing=false
  if ! is_true "$ADJUTORIX_DEV_ALLOW_MISSING_ENV_FILES"; then
    strict_missing=true
  fi

  load_env_file "$ADJUTORIX_DEV_ROOT_ENV_FILE" "$strict_missing"
  load_env_file "$ADJUTORIX_DEV_AGENT_ENV_FILE" "$strict_missing"
  load_env_file "$ADJUTORIX_DEV_ENV_OVERRIDE_FILE" false
  load_env_file "$ADJUTORIX_DEV_AGENT_ENV_OVERRIDE_FILE" false

  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_DEV_RUNTIME_MODE"
  export VITE_APP_CHANNEL="$ADJUTORIX_DEV_CHANNEL"
  export VITE_APP_VERSION="${VITE_APP_VERSION:-0.1.0-dev}"
  export VITE_APP_BUILD_ID="${VITE_APP_BUILD_ID:-local-dev}"
  export ADJUTORIX_AGENT_URL="$ADJUTORIX_DEV_AGENT_URL"
  export ADJUTORIX_AGENT_HOST="$ADJUTORIX_DEV_AGENT_HOST"
  export ADJUTORIX_AGENT_PORT="$ADJUTORIX_DEV_AGENT_PORT"
  export ADJUTORIX_AGENT_LOG_LEVEL="$ADJUTORIX_DEV_AGENT_LOG_LEVEL"
  export ADJUTORIX_LOG_LEVEL="$ADJUTORIX_DEV_APP_LOG_LEVEL"
  export ADJUTORIX_AGENT_LOG_DIR="$ADJUTORIX_DEV_LOG_DIR"
  export ADJUTORIX_LOG_DIR="$ADJUTORIX_DEV_LOG_DIR"
  export ADJUTORIX_UNDER_TEST="false"
  export ADJUTORIX_TEST_MODE="false"
  export ADJUTORIX_LOCAL_GOVERNANCE_AUDIT="true"
  export ADJUTORIX_ENABLE_GOVERNANCE_DEBUG="true"
  export ADJUTORIX_STRICT_GOVERNANCE="true"
  export ADJUTORIX_ENABLE_HEALTH_ENDPOINT="true"
  export ADJUTORIX_ENABLE_CRASH_RESUME="true"
  export ADJUTORIX_TOKEN_FILE="$ADJUTORIX_DEV_TOKEN_FILE"
}

install_if_requested() {
  if ! is_true "$ADJUTORIX_DEV_RUN_INSTALL"; then
    return 0
  fi
  section "Installing dependencies"
  (cd "$REPO_ROOT" && "${INSTALL_CMD[@]}") | tee -a "$ADJUTORIX_DEV_BOOT_LOG_FILE"
}

verify_if_requested() {
  if ! is_true "$ADJUTORIX_DEV_RUN_VERIFY_BOOT"; then
    return 0
  fi
  section "Running boot verification"
  (cd "$REPO_ROOT" && "${VERIFY_BOOT_CMD[@]}") | tee -a "$ADJUTORIX_DEV_BOOT_LOG_FILE"
}

ensure_port_policy() {
  section "Checking agent port policy"
  if port_is_listening "$ADJUTORIX_DEV_AGENT_HOST" "$ADJUTORIX_DEV_AGENT_PORT"; then
    if is_true "$ADJUTORIX_DEV_KILL_CONFLICTING_PORTS"; then
      kill_port_owners "$ADJUTORIX_DEV_AGENT_PORT"
    else
      die "Agent port already in use: ${ADJUTORIX_DEV_AGENT_PORT}. Re-run with --kill-conflicting-ports or change port."
    fi
  fi
}

###############################################################################
# PROCESS LIFECYCLE
###############################################################################

record_pid() {
  local pid="$1"
  local file="$2"
  printf '%s\n' "$pid" >"$file"
}

register_child() {
  local pid="$1"
  CHILD_PIDS+=("$pid")
}

start_agent() {
  if [[ "$ADJUTORIX_DEV_OPEN_AGENT" != "true" ]]; then
    return 0
  fi

  section "Starting governed agent"
  (
    cd "$ADJUTORIX_DEV_AGENT_WORKDIR"
    exec "${AGENT_CMD[@]}"
  ) >>"$ADJUTORIX_DEV_AGENT_LOG_FILE" 2>&1 &
  AGENT_PID="$!"
  register_child "$AGENT_PID"
  record_pid "$AGENT_PID" "$ADJUTORIX_DEV_AGENT_PID_FILE"
  log_info "Agent started with pid=${AGENT_PID} log=${ADJUTORIX_DEV_AGENT_LOG_FILE}"

  local health_url="${ADJUTORIX_DEV_AGENT_URL}${ADJUTORIX_DEV_HEALTH_PATH}"
  if wait_for_http_ok "$health_url" "$ADJUTORIX_DEV_HEALTH_TIMEOUT_SECONDS" "$ADJUTORIX_DEV_HEALTH_INTERVAL_SECONDS"; then
    log_info "Agent health check passed: ${health_url}"
  else
    die "Agent health check failed within ${ADJUTORIX_DEV_HEALTH_TIMEOUT_SECONDS}s: ${health_url}"
  fi
}

start_app() {
  if [[ "$ADJUTORIX_DEV_OPEN_APP" != "true" ]]; then
    return 0
  fi

  section "Starting desktop app"
  (
    cd "$ADJUTORIX_DEV_APP_WORKDIR"
    exec "${APP_CMD[@]}"
  ) >>"$ADJUTORIX_DEV_APP_LOG_FILE" 2>&1 &
  APP_PID="$!"
  register_child "$APP_PID"
  record_pid "$APP_PID" "$ADJUTORIX_DEV_APP_PID_FILE"
  log_info "App started with pid=${APP_PID} log=${ADJUTORIX_DEV_APP_LOG_FILE}"
}

child_is_running() {
  local pid="$1"
  [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1
}

terminate_child() {
  local pid="$1"
  local name="$2"
  [[ -n "$pid" ]] || return 0
  if child_is_running "$pid"; then
    log_warn "Stopping ${name} pid=${pid}"
    kill "$pid" >/dev/null 2>&1 || true
    for _ in {1..20}; do
      if ! child_is_running "$pid"; then
        return 0
      fi
      sleep 0.25
    done
    log_warn "Force-stopping ${name} pid=${pid}"
    kill -9 "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  if [[ "$SHUTTING_DOWN" == true ]]; then
    return 0
  fi
  SHUTTING_DOWN=true
  section "Cleaning up"
  terminate_child "$APP_PID" "app"
  terminate_child "$AGENT_PID" "agent"
  rm -f "$ADJUTORIX_DEV_AGENT_PID_FILE" "$ADJUTORIX_DEV_APP_PID_FILE"
}

forward_signal() {
  local sig="$1"
  log_warn "Received signal: ${sig}"
  cleanup
  exit 130
}

watch_children() {
  [[ "$NO_WAIT" == "true" ]] && return 0
  [[ "$ADJUTORIX_DEV_WAIT_FOREVER" == "true" ]] || return 0

  section "Watching child processes"
  while true; do
    if [[ -n "$AGENT_PID" ]] && ! child_is_running "$AGENT_PID"; then
      die "Agent process exited unexpectedly. See ${ADJUTORIX_DEV_AGENT_LOG_FILE}"
    fi
    if [[ -n "$APP_PID" ]] && ! child_is_running "$APP_PID"; then
      die "App process exited unexpectedly. See ${ADJUTORIX_DEV_APP_LOG_FILE}"
    fi
    sleep 1
  done
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs
  section "ADJUTORIX dev bootstrap"
  log_info "Program=${PROGRAM_NAME} start=${START_TS}"

  trap 'cleanup' EXIT
  if is_true "$ADJUTORIX_DEV_FORWARD_SIGNALS"; then
    trap 'forward_signal INT' INT
    trap 'forward_signal TERM' TERM
  fi

  validate_repo_layout
  validate_toolchain
  validate_git_state
  load_environment
  print_summary
  install_if_requested
  verify_if_requested

  if [[ "$ADJUTORIX_DEV_OPEN_AGENT" == "true" ]]; then
    ensure_port_policy
    start_agent
  fi

  if [[ "$ADJUTORIX_DEV_OPEN_APP" == "true" ]]; then
    start_app
  fi

  section "Bootstrap complete"
  log_info "Boot logs: ${ADJUTORIX_DEV_BOOT_LOG_FILE}"
  if [[ "$ADJUTORIX_DEV_OPEN_AGENT" == "true" ]]; then
    log_info "Agent logs: ${ADJUTORIX_DEV_AGENT_LOG_FILE}"
  fi
  if [[ "$ADJUTORIX_DEV_OPEN_APP" == "true" ]]; then
    log_info "App logs: ${ADJUTORIX_DEV_APP_LOG_FILE}"
  fi

  if [[ "$NO_WAIT" == "true" ]]; then
    log_info "No-wait mode enabled; leaving child processes running"
    trap - EXIT
    exit 0
  fi

  watch_children
}

main "$@"
