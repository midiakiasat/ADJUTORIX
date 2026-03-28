#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX WORKSPACE TRUST ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for workspace trust lifecycle
#   management
# - canonicalize and bind a workspace identity, inspect current trust record,
#   apply explicit trust transitions (grant, elevate, quarantine, revoke,
#   inspect), persist deterministic trust state, and emit auditable artifacts
# - ensure "workspace trusted" or "workspace revoked" means one governed state
#   transition rather than an informal flag toggle
#
# Scope
# - trust metadata and local governance state only
# - no mutation of workspace source files
# - writes only repo-local and explicitly allowed user-local trust metadata
#
# Design constraints
# - no silent trust escalation
# - every consequential transition requires explicit mode and evidence context
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

: "${ADJUTORIX_WORKSPACE_TRUST_STACK_NAME:=adjutorix-workspace-trust}"
: "${ADJUTORIX_WORKSPACE_TRUST_USE_COLOR:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_FAIL_FAST:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_REQUIRE_GIT_FOR_ELEVATED:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_ALLOW_CREATE_RECORD:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_REGISTER_RECENT:=true}"
: "${ADJUTORIX_WORKSPACE_TRUST_AGENT_HANDOFF:=false}"
: "${ADJUTORIX_WORKSPACE_TRUST_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_WORKSPACE_TRUST_AGENT_RPC_PATH:=/rpc}"
: "${ADJUTORIX_WORKSPACE_TRUST_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_WORKSPACE_TRUST_ROOT_TMP:=${REPO_ROOT}/.tmp/workspace-trust}"
: "${ADJUTORIX_WORKSPACE_TRUST_LOG_DIR:=${ADJUTORIX_WORKSPACE_TRUST_ROOT_TMP}/logs}"
: "${ADJUTORIX_WORKSPACE_TRUST_REPORT_DIR:=${ADJUTORIX_WORKSPACE_TRUST_ROOT_TMP}/reports}"
: "${ADJUTORIX_WORKSPACE_TRUST_STATE_DIR:=${HOME}/.adjutorix/workspace-trust}"
: "${ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG:=${ADJUTORIX_WORKSPACE_TRUST_LOG_DIR}/trust.log}"
: "${ADJUTORIX_WORKSPACE_TRUST_SUMMARY_FILE:=${ADJUTORIX_WORKSPACE_TRUST_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_WORKSPACE_TRUST_PHASE_FILE:=${ADJUTORIX_WORKSPACE_TRUST_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_WORKSPACE_TRUST_EVENT_FILE:=${ADJUTORIX_WORKSPACE_TRUST_REPORT_DIR}/trust-event.json}"
: "${ADJUTORIX_WORKSPACE_TRUST_RECENTS_FILE:=${HOME}/.adjutorix/recent-workspaces.json}"
: "${ADJUTORIX_WORKSPACE_TRUST_MAX_RECENTS:=20}"
: "${ADJUTORIX_WORKSPACE_TRUST_DEFAULT_TTL_SECONDS:=2592000}"
: "${ADJUTORIX_WORKSPACE_TRUST_RUNTIME_MODE:=development}"

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
ACTION="inspect"
REQUESTED_LEVEL=""
REASON=""
CONFIRMED=false
TTL_SECONDS="${ADJUTORIX_WORKSPACE_TRUST_DEFAULT_TTL_SECONDS}"
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
STATE_FILE=""
CURRENT_LEVEL="none"
CURRENT_STATUS="absent"
CURRENT_EXPIRES_AT=""
NEXT_LEVEL=""
NEXT_STATUS=""
TRANSITION_ALLOWED="false"
TRANSITION_DECISION_REASON=""
GIT_HINT="no"
PATH_DIGEST=""
TRUST_EVENT_ID=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_WORKSPACE_TRUST_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/workspace/trust.sh <workspace-path> inspect [options]
  scripts/workspace/trust.sh <workspace-path> grant --level <level> --reason <text> --confirm [options]
  scripts/workspace/trust.sh <workspace-path> revoke --reason <text> --confirm [options]
  scripts/workspace/trust.sh <workspace-path> quarantine --reason <text> --confirm [options]
  scripts/workspace/trust.sh <workspace-path> elevate --level elevated --reason <text> --confirm [options]

Levels:
  observed | tentative | trusted | elevated | quarantined | revoked

Options:
  --level <level>              Target trust level where applicable
  --reason <text>              Required transition reason for consequential actions
  --ttl-seconds <n>            Expiry window for granted trust levels
  --confirm                    Explicitly authorize consequential transition
  --agent                      Handoff trust decision to local agent
  --no-recents                 Skip updating recent workspace registry
  --no-color                   Disable ANSI colors
  --quiet                      Reduce non-error terminal output
  --verbose                    Emit debug logs
  --help                       Show this help
EOF
}

parse_args() {
  if (($# < 2)); then
    usage
    exit 1
  fi

  TARGET_INPUT="$1"
  shift
  ACTION="$1"
  shift

  while (($# > 0)); do
    case "$1" in
      --level)
        shift
        [[ $# -gt 0 ]] || die "--level requires a value"
        REQUESTED_LEVEL="$1"
        ;;
      --reason)
        shift
        [[ $# -gt 0 ]] || die "--reason requires a value"
        REASON="$1"
        ;;
      --ttl-seconds)
        shift
        [[ $# -gt 0 ]] || die "--ttl-seconds requires a value"
        TTL_SECONDS="$1"
        ;;
      --confirm)
        CONFIRMED=true
        ;;
      --agent)
        ADJUTORIX_WORKSPACE_TRUST_AGENT_HANDOFF=true
        ;;
      --no-recents)
        ADJUTORIX_WORKSPACE_TRUST_REGISTER_RECENT=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_WORKSPACE_TRUST_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_WORKSPACE_TRUST_PHASE_FILE"
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
    if [[ "$ADJUTORIX_WORKSPACE_TRUST_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_WORKSPACE_TRUST_LOG_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_TRUST_REPORT_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_TRUST_STATE_DIR"
  ensure_dir "$(dirname "$ADJUTORIX_WORKSPACE_TRUST_RECENTS_FILE")"
  : >"$ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG"
  : >"$ADJUTORIX_WORKSPACE_TRUST_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_WORKSPACE_TRUST_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python
  require_command shasum
  require_command date
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
  [[ -n "$TARGET_INPUT" ]] || die "Workspace target is required"
}

phase_resolve_target() {
  TARGET_CANONICAL="$(python - <<'PY' "$TARGET_INPUT"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  [[ -n "$TARGET_CANONICAL" ]] || die "Failed to canonicalize target"
  [[ -d "$TARGET_CANONICAL" ]] || die "Target is not a directory: $TARGET_CANONICAL"
  TARGET_NAME="$(basename "$TARGET_CANONICAL")"
  WORKSPACE_ID="$(printf '%s' "$TARGET_CANONICAL" | shasum -a 256 | awk '{print $1}')"
  PATH_DIGEST="$WORKSPACE_ID"
  STATE_FILE="${ADJUTORIX_WORKSPACE_TRUST_STATE_DIR}/${WORKSPACE_ID}.json"
  TRUST_EVENT_ID="$(printf '%s|%s|%s' "$WORKSPACE_ID" "$ACTION" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_access() {
  if [[ "$ADJUTORIX_WORKSPACE_TRUST_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$TARGET_CANONICAL" ]] || die "Target is not readable: $TARGET_CANONICAL"
  fi
  if [[ -d "$TARGET_CANONICAL/.git" ]]; then
    GIT_HINT="yes"
  else
    GIT_HINT="no"
  fi
}

phase_load_current_state() {
  if [[ -f "$STATE_FILE" ]]; then
    read -r CURRENT_STATUS CURRENT_LEVEL CURRENT_EXPIRES_AT < <(python - <<'PY' "$STATE_FILE"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('status', 'present'), data.get('level', 'none'), data.get('expires_at', ''))
PY
    )
  else
    CURRENT_STATUS="absent"
    CURRENT_LEVEL="none"
    CURRENT_EXPIRES_AT=""
  fi
}

phase_validate_request() {
  case "$ACTION" in
    inspect)
      NEXT_LEVEL="$CURRENT_LEVEL"
      NEXT_STATUS="$CURRENT_STATUS"
      TRANSITION_ALLOWED="true"
      TRANSITION_DECISION_REASON="inspection_only"
      ;;
    grant)
      [[ -n "$REQUESTED_LEVEL" ]] || die "grant requires --level"
      [[ -n "$REASON" ]] || die "grant requires --reason"
      [[ "$CONFIRMED" == true ]] || die "grant requires --confirm"
      case "$REQUESTED_LEVEL" in
        observed|tentative|trusted)
          NEXT_LEVEL="$REQUESTED_LEVEL"
          NEXT_STATUS="active"
          TRANSITION_ALLOWED="true"
          TRANSITION_DECISION_REASON="explicit_grant"
          ;;
        elevated)
          if [[ "$ADJUTORIX_WORKSPACE_TRUST_REQUIRE_GIT_FOR_ELEVATED" == "true" && "$GIT_HINT" != "yes" ]]; then
            die "elevated trust requires git worktree"
          fi
          NEXT_LEVEL="elevated"
          NEXT_STATUS="active"
          TRANSITION_ALLOWED="true"
          TRANSITION_DECISION_REASON="explicit_elevated_grant"
          ;;
        *) die "invalid trust level for grant: $REQUESTED_LEVEL" ;;
      esac
      ;;
    elevate)
      [[ "$REQUESTED_LEVEL" == "elevated" ]] || die "elevate requires --level elevated"
      [[ -n "$REASON" ]] || die "elevate requires --reason"
      [[ "$CONFIRMED" == true ]] || die "elevate requires --confirm"
      if [[ "$ADJUTORIX_WORKSPACE_TRUST_REQUIRE_GIT_FOR_ELEVATED" == "true" && "$GIT_HINT" != "yes" ]]; then
        die "elevated trust requires git worktree"
      fi
      NEXT_LEVEL="elevated"
      NEXT_STATUS="active"
      TRANSITION_ALLOWED="true"
      TRANSITION_DECISION_REASON="explicit_elevation"
      ;;
    revoke)
      [[ -n "$REASON" ]] || die "revoke requires --reason"
      [[ "$CONFIRMED" == true ]] || die "revoke requires --confirm"
      NEXT_LEVEL="revoked"
      NEXT_STATUS="revoked"
      TRANSITION_ALLOWED="true"
      TRANSITION_DECISION_REASON="explicit_revocation"
      ;;
    quarantine)
      [[ -n "$REASON" ]] || die "quarantine requires --reason"
      [[ "$CONFIRMED" == true ]] || die "quarantine requires --confirm"
      NEXT_LEVEL="quarantined"
      NEXT_STATUS="quarantined"
      TRANSITION_ALLOWED="true"
      TRANSITION_DECISION_REASON="explicit_quarantine"
      ;;
    *)
      die "Unknown action: $ACTION"
      ;;
  esac
}

phase_persist_state() {
  if [[ "$ACTION" == "inspect" ]]; then
    return 0
  fi
  if [[ "$ADJUTORIX_WORKSPACE_TRUST_ALLOW_CREATE_RECORD" != "true" && ! -f "$STATE_FILE" ]]; then
    die "Trust record creation disabled and record does not already exist"
  fi

  python - <<'PY' \
    "$STATE_FILE" \
    "$WORKSPACE_ID" \
    "$TARGET_CANONICAL" \
    "$TARGET_NAME" \
    "$PATH_DIGEST" \
    "$CURRENT_LEVEL" \
    "$CURRENT_STATUS" \
    "$NEXT_LEVEL" \
    "$NEXT_STATUS" \
    "$ACTION" \
    "$REASON" \
    "$START_TS" \
    "$TTL_SECONDS" \
    "$GIT_HINT" \
    "$TRANSITION_DECISION_REASON"
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

state_file = Path(sys.argv[1])
workspace_id = sys.argv[2]
workspace_path = sys.argv[3]
workspace_name = sys.argv[4]
path_digest = sys.argv[5]
current_level = sys.argv[6]
current_status = sys.argv[7]
next_level = sys.argv[8]
next_status = sys.argv[9]
action = sys.argv[10]
reason = sys.argv[11]
started_at = sys.argv[12]
ttl_seconds = int(sys.argv[13])
git_hint = sys.argv[14]
transition_reason = sys.argv[15]

started_dt = datetime.fromisoformat(started_at.replace('Z', '+00:00'))
expires_at = ''
if next_status == 'active' and next_level not in {'quarantined', 'revoked'}:
    expires_at = (started_dt + timedelta(seconds=ttl_seconds)).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')

payload = {
    'version': 1,
    'workspace_id': workspace_id,
    'workspace_path': workspace_path,
    'workspace_name': workspace_name,
    'path_digest': path_digest,
    'status': next_status,
    'level': next_level,
    'previous_status': current_status,
    'previous_level': current_level,
    'action': action,
    'reason': reason,
    'decision_reason': transition_reason,
    'updated_at': started_at,
    'expires_at': expires_at,
    'git_hint': git_hint,
}
state_file.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

phase_register_recents() {
  if [[ "$ADJUTORIX_WORKSPACE_TRUST_REGISTER_RECENT" != "true" ]]; then
    return 0
  fi
  python - <<'PY' \
    "$ADJUTORIX_WORKSPACE_TRUST_RECENTS_FILE" \
    "$WORKSPACE_ID" \
    "$TARGET_CANONICAL" \
    "$TARGET_NAME" \
    "$START_TS" \
    "$NEXT_LEVEL" \
    "$NEXT_STATUS" \
    "$ADJUTORIX_WORKSPACE_TRUST_MAX_RECENTS"
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
workspace_id = sys.argv[2]
workspace_path = sys.argv[3]
workspace_name = sys.argv[4]
updated_at = sys.argv[5]
trust_level = sys.argv[6]
trust_status = sys.argv[7]
max_recents = int(sys.argv[8])

payload = {'recent_workspaces': []}
if path.exists():
    try:
        payload = json.loads(path.read_text(encoding='utf-8'))
    except Exception:
        payload = {'recent_workspaces': []}

rows = [r for r in payload.get('recent_workspaces', []) if r.get('workspace_id') != workspace_id]
rows.insert(0, {
    'workspace_id': workspace_id,
    'name': workspace_name,
    'path': workspace_path,
    'updated_at': updated_at,
    'trust_level': trust_level,
    'trust_status': trust_status,
})
payload['recent_workspaces'] = rows[:max_recents]
path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

phase_write_event() {
  python - <<'PY' \
    "$ADJUTORIX_WORKSPACE_TRUST_EVENT_FILE" \
    "$TRUST_EVENT_ID" \
    "$WORKSPACE_ID" \
    "$TARGET_CANONICAL" \
    "$ACTION" \
    "$CURRENT_LEVEL" \
    "$CURRENT_STATUS" \
    "$NEXT_LEVEL" \
    "$NEXT_STATUS" \
    "$REASON" \
    "$START_TS" \
    "$TRANSITION_DECISION_REASON"
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
payload = {
    'event_id': sys.argv[2],
    'workspace_id': sys.argv[3],
    'workspace_path': sys.argv[4],
    'action': sys.argv[5],
    'previous_level': sys.argv[6],
    'previous_status': sys.argv[7],
    'next_level': sys.argv[8],
    'next_status': sys.argv[9],
    'reason': sys.argv[10],
    'occurred_at': sys.argv[11],
    'decision_reason': sys.argv[12],
}
path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
}

phase_handoff_to_agent() {
  if [[ "$ADJUTORIX_WORKSPACE_TRUST_AGENT_HANDOFF" != "true" ]]; then
    return 0
  fi
  [[ -f "$ADJUTORIX_WORKSPACE_TRUST_TOKEN_FILE" ]] || die "Agent handoff requested but token file missing"
  local token
  token="$(tr -d '\n' < "$ADJUTORIX_WORKSPACE_TRUST_TOKEN_FILE")"
  [[ -n "$token" ]] || die "Agent handoff requested but token file is empty"

  local payload
  payload="$(python - <<'PY' "$WORKSPACE_ID" "$TARGET_CANONICAL" "$NEXT_LEVEL" "$NEXT_STATUS" "$REASON"
import json, sys
print(json.dumps({
    'jsonrpc': '2.0',
    'id': 1,
    'method': 'workspace.trust.set',
    'params': {
        'workspace_id': sys.argv[1],
        'path': sys.argv[2],
        'level': sys.argv[3],
        'status': sys.argv[4],
        'reason': sys.argv[5],
    }
}))
PY
)"

  curl -fsS \
    -H 'Content-Type: application/json' \
    -H "x-adjutorix-token: ${token}" \
    -d "$payload" \
    "${ADJUTORIX_WORKSPACE_TRUST_AGENT_URL}${ADJUTORIX_WORKSPACE_TRUST_AGENT_RPC_PATH}" \
    >>"$ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG" 2>&1
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX workspace trust summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "target_input: ${TARGET_INPUT}"
    echo "target_canonical: ${TARGET_CANONICAL}"
    echo "target_name: ${TARGET_NAME}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "action: ${ACTION}"
    echo "current_status: ${CURRENT_STATUS}"
    echo "current_level: ${CURRENT_LEVEL}"
    echo "next_status: ${NEXT_STATUS}"
    echo "next_level: ${NEXT_LEVEL}"
    echo "git_hint: ${GIT_HINT}"
    echo "reason: ${REASON}"
    echo "decision_reason: ${TRANSITION_DECISION_REASON}"
    echo "ttl_seconds: ${TTL_SECONDS}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "state_file: ${STATE_FILE}"
    echo "event_file: ${ADJUTORIX_WORKSPACE_TRUST_EVENT_FILE}"
    echo "recents_file: ${ADJUTORIX_WORKSPACE_TRUST_RECENTS_FILE}"
    echo "boot_log: ${ADJUTORIX_WORKSPACE_TRUST_BOOT_LOG}"
  } >"$ADJUTORIX_WORKSPACE_TRUST_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX workspace trust"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "target_input=${TARGET_INPUT} action=${ACTION}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_target phase_resolve_target
  run_phase validate_access phase_validate_access
  run_phase load_current_state phase_load_current_state
  run_phase validate_request phase_validate_request
  run_phase persist_state phase_persist_state
  run_phase register_recents phase_register_recents
  run_phase write_event phase_write_event
  run_phase handoff_to_agent phase_handoff_to_agent

  write_summary

  section "Workspace trust complete"
  log_info "summary=${ADJUTORIX_WORKSPACE_TRUST_SUMMARY_FILE}"
  log_info "workspace_id=${WORKSPACE_ID} action=${ACTION} next=${NEXT_STATUS}/${NEXT_LEVEL}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Workspace trust failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
