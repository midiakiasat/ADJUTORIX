#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX WORKSPACE OPEN ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for governed workspace opening
# - canonicalize and validate a target workspace path, evaluate baseline safety
#   and health preconditions, materialize deterministic local workspace state,
#   and optionally hand the resolved workspace to the local agent and/or app
# - emit explicit, auditable phase records so "workspace opened" is a real
#   transition rather than an informal path change
#
# Scope
# - workspace selection and local governance-oriented preparation only
# - no invisible mutation of user files inside the target workspace
# - local metadata may be created under repository .tmp or user-local state dirs
#
# Design constraints
# - no silent fallback to non-canonical paths
# - no opening of missing, unreadable, or obviously unsafe targets
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

: "${ADJUTORIX_WORKSPACE_OPEN_STACK_NAME:=adjutorix-workspace-open}"
: "${ADJUTORIX_WORKSPACE_OPEN_USE_COLOR:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_FAIL_FAST:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_REQUIRE_GIT_WORKTREE:=false}"
: "${ADJUTORIX_WORKSPACE_OPEN_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_REQUIRE_WRITABLE:=false}"
: "${ADJUTORIX_WORKSPACE_OPEN_REGISTER_RECENT:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_EVALUATE_HEALTH:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_EVALUATE_TRUST_HINTS:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_CREATE_LOCAL_STATE:=true}"
: "${ADJUTORIX_WORKSPACE_OPEN_TOUCH_SENTINELS:=false}"
: "${ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_AGENT:=false}"
: "${ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_APP:=false}"
: "${ADJUTORIX_WORKSPACE_OPEN_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_WORKSPACE_OPEN_AGENT_RPC_PATH:=/rpc}"
: "${ADJUTORIX_WORKSPACE_OPEN_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_WORKSPACE_OPEN_ROOT_TMP:=${REPO_ROOT}/.tmp/workspace-open}"
: "${ADJUTORIX_WORKSPACE_OPEN_LOG_DIR:=${ADJUTORIX_WORKSPACE_OPEN_ROOT_TMP}/logs}"
: "${ADJUTORIX_WORKSPACE_OPEN_REPORT_DIR:=${ADJUTORIX_WORKSPACE_OPEN_ROOT_TMP}/reports}"
: "${ADJUTORIX_WORKSPACE_OPEN_STATE_DIR:=${REPO_ROOT}/.tmp/workspaces}"
: "${ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG:=${ADJUTORIX_WORKSPACE_OPEN_LOG_DIR}/open.log}"
: "${ADJUTORIX_WORKSPACE_OPEN_SUMMARY_FILE:=${ADJUTORIX_WORKSPACE_OPEN_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_WORKSPACE_OPEN_PHASE_FILE:=${ADJUTORIX_WORKSPACE_OPEN_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_WORKSPACE_OPEN_RECENTS_FILE:=${HOME}/.adjutorix/recent-workspaces.json}"
: "${ADJUTORIX_WORKSPACE_OPEN_MAX_RECENTS:=20}"
: "${ADJUTORIX_WORKSPACE_OPEN_RUNTIME_MODE:=development}"
: "${ADJUTORIX_WORKSPACE_OPEN_CHANNEL:=dev}"
: "${ADJUTORIX_WORKSPACE_OPEN_HEALTH_LARGE_FILE_COUNT:=200000}"
: "${ADJUTORIX_WORKSPACE_OPEN_HEALTH_LARGE_BYTES:=2147483648}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
TARGET_INPUT=""
TARGET_CANONICAL=""
TARGET_NAME=""
WORKSPACE_ID=""
WORKSPACE_STATE_DIR=""
TRUST_HINT="unknown"
HEALTH_HINT="unknown"
FILE_COUNT_HINT="0"
TOTAL_BYTES_HINT="0"
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_WORKSPACE_OPEN_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/workspace/open.sh <workspace-path> [options]

Options:
  --git-required                Require target to be a git worktree
  --writable                    Require write access to target
  --agent                       Handoff resolved workspace to local agent
  --app                         Handoff resolved workspace to local app entrypoint if available
  --agent-url <url>             Override local agent base URL
  --no-health                   Skip workspace health heuristics
  --no-recents                  Skip updating recent workspace registry
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  if (($# == 0)); then
    usage
    exit 1
  fi

  TARGET_INPUT="$1"
  shift

  while (($# > 0)); do
    case "$1" in
      --git-required)
        ADJUTORIX_WORKSPACE_OPEN_REQUIRE_GIT_WORKTREE=true
        ;;
      --writable)
        ADJUTORIX_WORKSPACE_OPEN_REQUIRE_WRITABLE=true
        ;;
      --agent)
        ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_AGENT=true
        ;;
      --app)
        ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_APP=true
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_WORKSPACE_OPEN_AGENT_URL="$1"
        ;;
      --no-health)
        ADJUTORIX_WORKSPACE_OPEN_EVALUATE_HEALTH=false
        ;;
      --no-recents)
        ADJUTORIX_WORKSPACE_OPEN_REGISTER_RECENT=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_WORKSPACE_OPEN_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_WORKSPACE_OPEN_PHASE_FILE"
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
    if [[ "$ADJUTORIX_WORKSPACE_OPEN_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

json_escape() {
  python - <<'PY' "$1"
import json, sys
print(json.dumps(sys.argv[1]))
PY
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_WORKSPACE_OPEN_LOG_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_OPEN_REPORT_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_OPEN_STATE_DIR"
  ensure_dir "$(dirname "$ADJUTORIX_WORKSPACE_OPEN_RECENTS_FILE")"
  : >"$ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG"
  : >"$ADJUTORIX_WORKSPACE_OPEN_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_WORKSPACE_OPEN_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python
  require_command find
  require_command stat
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
  [[ -n "$TARGET_INPUT" ]] || die "Workspace target is required"
}

phase_resolve_target() {
  TARGET_CANONICAL="$(python - <<'PY' "$TARGET_INPUT"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  [[ -n "$TARGET_CANONICAL" ]] || die "Failed to canonicalize target: $TARGET_INPUT"
  [[ -d "$TARGET_CANONICAL" ]] || die "Workspace target is not a directory: $TARGET_CANONICAL"
  TARGET_NAME="$(basename "$TARGET_CANONICAL")"
  WORKSPACE_ID="$(printf '%s' "$TARGET_CANONICAL" | shasum -a 256 | awk '{print $1}')"
  WORKSPACE_STATE_DIR="${ADJUTORIX_WORKSPACE_OPEN_STATE_DIR}/${WORKSPACE_ID}"
}

phase_validate_access() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$TARGET_CANONICAL" ]] || die "Workspace target is not readable: $TARGET_CANONICAL"
  fi
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_REQUIRE_WRITABLE" == "true" ]]; then
    [[ -w "$TARGET_CANONICAL" ]] || die "Workspace target is not writable: $TARGET_CANONICAL"
  fi
}

phase_validate_git_if_required() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_REQUIRE_GIT_WORKTREE" != "true" ]]; then
    return 0
  fi
  git -C "$TARGET_CANONICAL" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

phase_evaluate_trust_hints() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_EVALUATE_TRUST_HINTS" != "true" ]]; then
    TRUST_HINT="unknown"
    return 0
  fi

  if [[ -d "$TARGET_CANONICAL/.git" ]]; then
    TRUST_HINT="git_repo"
  elif [[ -f "$TARGET_CANONICAL/package.json" || -f "$TARGET_CANONICAL/pyproject.toml" ]]; then
    TRUST_HINT="project_like"
  else
    TRUST_HINT="unclassified"
  fi
}

phase_evaluate_health() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_EVALUATE_HEALTH" != "true" ]]; then
    HEALTH_HINT="unknown"
    return 0
  fi

  read -r FILE_COUNT_HINT TOTAL_BYTES_HINT < <(python - <<'PY' "$TARGET_CANONICAL"
import os, sys
root = sys.argv[1]
count = 0
size = 0
for dirpath, dirnames, filenames in os.walk(root):
    dirnames[:] = [d for d in dirnames if d not in {'.git', 'node_modules', '.venv', '.tmp', '__pycache__'}]
    for name in filenames:
        count += 1
        path = os.path.join(dirpath, name)
        try:
            size += os.path.getsize(path)
        except OSError:
            pass
print(count, size)
PY
  )

  if (( FILE_COUNT_HINT > ADJUTORIX_WORKSPACE_OPEN_HEALTH_LARGE_FILE_COUNT )) || (( TOTAL_BYTES_HINT > ADJUTORIX_WORKSPACE_OPEN_HEALTH_LARGE_BYTES )); then
    HEALTH_HINT="degraded_large"
  else
    HEALTH_HINT="healthy_candidate"
  fi
}

phase_create_local_state() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_CREATE_LOCAL_STATE" != "true" ]]; then
    return 0
  fi
  ensure_dir "$WORKSPACE_STATE_DIR"
  printf '%s
' "$TARGET_CANONICAL" >"$WORKSPACE_STATE_DIR/path.txt"
  printf '%s
' "$WORKSPACE_ID" >"$WORKSPACE_STATE_DIR/workspace_id.txt"
  printf '%s
' "$START_TS" >"$WORKSPACE_STATE_DIR/opened_at.txt"
  printf '%s
' "$TRUST_HINT" >"$WORKSPACE_STATE_DIR/trust_hint.txt"
  printf '%s
' "$HEALTH_HINT" >"$WORKSPACE_STATE_DIR/health_hint.txt"
  printf '%s
' "$FILE_COUNT_HINT" >"$WORKSPACE_STATE_DIR/file_count_hint.txt"
  printf '%s
' "$TOTAL_BYTES_HINT" >"$WORKSPACE_STATE_DIR/total_bytes_hint.txt"

  if [[ "$ADJUTORIX_WORKSPACE_OPEN_TOUCH_SENTINELS" == "true" ]]; then
    : >"$WORKSPACE_STATE_DIR/.opened"
  fi
}

phase_register_recents() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_REGISTER_RECENT" != "true" ]]; then
    return 0
  fi

  python - <<'PY' \
    "$ADJUTORIX_WORKSPACE_OPEN_RECENTS_FILE" \
    "$WORKSPACE_ID" \
    "$TARGET_CANONICAL" \
    "$TARGET_NAME" \
    "$START_TS" \
    "$TRUST_HINT" \
    "$HEALTH_HINT" \
    "$ADJUTORIX_WORKSPACE_OPEN_MAX_RECENTS"
import json
import os
import sys
from pathlib import Path

path = Path(sys.argv[1])
workspace_id = sys.argv[2]
workspace_path = sys.argv[3]
workspace_name = sys.argv[4]
opened_at = sys.argv[5]
trust_hint = sys.argv[6]
health_hint = sys.argv[7]
max_recents = int(sys.argv[8])

payload = {"recent_workspaces": []}
if path.exists():
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        payload = {"recent_workspaces": []}

rows = [r for r in payload.get("recent_workspaces", []) if r.get("workspace_id") != workspace_id]
rows.insert(0, {
    "workspace_id": workspace_id,
    "name": workspace_name,
    "path": workspace_path,
    "opened_at": opened_at,
    "trust_hint": trust_hint,
    "health_hint": health_hint,
})
payload["recent_workspaces"] = rows[:max_recents]
path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

phase_handoff_to_agent() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_AGENT" != "true" ]]; then
    return 0
  fi

  [[ -f "$ADJUTORIX_WORKSPACE_OPEN_TOKEN_FILE" ]] || die "Agent handoff requested but token file missing: $ADJUTORIX_WORKSPACE_OPEN_TOKEN_FILE"
  local token
  token="$(tr -d '\n' < "$ADJUTORIX_WORKSPACE_OPEN_TOKEN_FILE")"
  [[ -n "$token" ]] || die "Agent handoff requested but token file is empty: $ADJUTORIX_WORKSPACE_OPEN_TOKEN_FILE"

  local payload
  payload="$(python - <<'PY' "$TARGET_CANONICAL" "$WORKSPACE_ID"
import json, sys
print(json.dumps({
    "jsonrpc": "2.0",
    "id": 1,
    "method": "workspace.open",
    "params": {
        "path": sys.argv[1],
        "workspace_id": sys.argv[2],
    }
}))
PY
)"

  curl -fsS \
    -H 'Content-Type: application/json' \
    -H "x-adjutorix-token: ${token}" \
    -d "$payload" \
    "${ADJUTORIX_WORKSPACE_OPEN_AGENT_URL}${ADJUTORIX_WORKSPACE_OPEN_AGENT_RPC_PATH}" \
    >>"$ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG" 2>&1
}

phase_handoff_to_app() {
  if [[ "$ADJUTORIX_WORKSPACE_OPEN_HANDOFF_TO_APP" != "true" ]]; then
    return 0
  fi

  local app_launcher="${REPO_ROOT}/scripts/dev.sh"
  [[ -x "$app_launcher" || -f "$app_launcher" ]] || die "App handoff requested but launcher missing: $app_launcher"

  ADJUTORIX_WORKSPACE_PATH="$TARGET_CANONICAL" \
  ADJUTORIX_WORKSPACE_ID="$WORKSPACE_ID" \
  ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_WORKSPACE_OPEN_RUNTIME_MODE" \
  VITE_APP_CHANNEL="$ADJUTORIX_WORKSPACE_OPEN_CHANNEL" \
  bash "$app_launcher" --no-wait >>"$ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG" 2>&1
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX workspace open summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "target_input: ${TARGET_INPUT}"
    echo "target_canonical: ${TARGET_CANONICAL}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "workspace_name: ${TARGET_NAME}"
    echo "trust_hint: ${TRUST_HINT}"
    echo "health_hint: ${HEALTH_HINT}"
    echo "file_count_hint: ${FILE_COUNT_HINT}"
    echo "total_bytes_hint: ${TOTAL_BYTES_HINT}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "state_dir: ${WORKSPACE_STATE_DIR}"
    echo "recents_file: ${ADJUTORIX_WORKSPACE_OPEN_RECENTS_FILE}"
    echo "boot_log: ${ADJUTORIX_WORKSPACE_OPEN_BOOT_LOG}"
  } >"$ADJUTORIX_WORKSPACE_OPEN_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX workspace open"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "target_input=${TARGET_INPUT}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_target phase_resolve_target
  run_phase validate_access phase_validate_access
  run_phase validate_git_if_required phase_validate_git_if_required
  run_phase evaluate_trust_hints phase_evaluate_trust_hints
  run_phase evaluate_health phase_evaluate_health
  run_phase create_local_state phase_create_local_state
  run_phase register_recents phase_register_recents
  run_phase handoff_to_agent phase_handoff_to_agent
  run_phase handoff_to_app phase_handoff_to_app

  write_summary

  section "Workspace open complete"
  log_info "summary=${ADJUTORIX_WORKSPACE_OPEN_SUMMARY_FILE}"
  log_info "workspace_id=${WORKSPACE_ID}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Workspace open failed with ${OVERALL_FAILURES} failed phas