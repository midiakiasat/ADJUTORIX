#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION STATUS ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for inspecting governed
#   transaction/job state in the ADJUTORIX runtime
# - resolve transaction identity from explicit IDs or prior submission artifacts,
#   verify agent reachability and auth context, query canonical status surfaces,
#   normalize terminal and non-terminal states, and emit auditable evidence
#   artifacts for operators and CI
# - ensure "transaction status" means one coherent observed state rather than an
#   ad hoc RPC poll with ambiguous identifiers
#
# Scope
# - inspection only; no mutation of runtime state
# - mutation limited to local report artifacts and explicit read-only RPC calls
# - may read local submission artifacts to bind status queries to prior intents
#
# Design constraints
# - no silent fallback across incompatible identifier types
# - no unverifiable claims about terminality or success
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

: "${ADJUTORIX_TX_STATUS_STACK_NAME:=adjutorix-transaction-status}"
: "${ADJUTORIX_TX_STATUS_USE_COLOR:=true}"
: "${ADJUTORIX_TX_STATUS_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_STATUS_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_STATUS_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_STATUS_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_STATUS_HTTP_TIMEOUT_SECONDS:=10}"
: "${ADJUTORIX_TX_STATUS_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_STATUS_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_STATUS_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_STATUS_DEFAULT_METHOD:=job.status}"
: "${ADJUTORIX_TX_STATUS_FALLBACK_METHOD:=transaction.status}"
: "${ADJUTORIX_TX_STATUS_WAIT:=false}"
: "${ADJUTORIX_TX_STATUS_WAIT_TIMEOUT_SECONDS:=30}"
: "${ADJUTORIX_TX_STATUS_WAIT_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_TX_STATUS_ASSUME_ID_KIND:=auto}"
: "${ADJUTORIX_TX_STATUS_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-status}"
: "${ADJUTORIX_TX_STATUS_LOG_DIR:=${ADJUTORIX_TX_STATUS_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_STATUS_REPORT_DIR:=${ADJUTORIX_TX_STATUS_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_STATUS_ARTIFACT_DIR:=${ADJUTORIX_TX_STATUS_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_TX_STATUS_BOOT_LOG:=${ADJUTORIX_TX_STATUS_LOG_DIR}/status.log}"
: "${ADJUTORIX_TX_STATUS_SUMMARY_FILE:=${ADJUTORIX_TX_STATUS_REPORT_DIR}/status-summary.txt}"
: "${ADJUTORIX_TX_STATUS_PHASE_FILE:=${ADJUTORIX_TX_STATUS_REPORT_DIR}/status-phases.tsv}"
: "${ADJUTORIX_TX_STATUS_REQUEST_JSON:=${ADJUTORIX_TX_STATUS_ARTIFACT_DIR}/request.json}"
: "${ADJUTORIX_TX_STATUS_RESPONSE_JSON:=${ADJUTORIX_TX_STATUS_ARTIFACT_DIR}/response.json}"
: "${ADJUTORIX_TX_STATUS_NORMALIZED_JSON:=${ADJUTORIX_TX_STATUS_ARTIFACT_DIR}/normalized.json}"
: "${ADJUTORIX_TX_STATUS_SUBMISSION_JSON:=}"
: "${ADJUTORIX_TX_STATUS_METHOD_OVERRIDE:=}"
: "${ADJUTORIX_TX_STATUS_INCLUDE_RESULT_BODY:=true}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()

STATUS_ID=""
STATUS_ID_KIND="$ADJUTORIX_TX_STATUS_ASSUME_ID_KIND"
METHOD_TO_CALL=""
TOKEN_VALUE=""
HEALTH_URL="${ADJUTORIX_TX_STATUS_AGENT_URL}${ADJUTORIX_TX_STATUS_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_STATUS_AGENT_URL}${ADJUTORIX_TX_STATUS_RPC_PATH}"
REQUEST_ID=""
PAYLOAD_SHA256=""
REQUEST_METHOD_USED=""
REQUEST_PARAM_KEY=""
RAW_STATE="unknown"
NORMALIZED_STATE="unknown"
TERMINAL="no"
SUCCESS="unknown"
STATE_REASON=""
RESOLVED_FROM_ARTIFACT="no"
FALLBACK_USED="no"
RESULT_OBJECT_PRESENT="no"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_STATUS_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_STATUS_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_STATUS_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/status.sh --id <value> [options]
  scripts/transaction/status.sh --submission <submission-json> [options]

Required input:
  --id <value>                  Transaction/job identifier to inspect
    or
  --submission <path>           Prior submission artifact to resolve identifiers

Options:
  --id-kind <kind>              auto | job | transaction | request
  --method <rpc-method>         Override RPC method used for status
  --wait                        Poll until terminal state or timeout
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-status health probe
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --id)
        shift
        [[ $# -gt 0 ]] || die "--id requires a value"
        STATUS_ID="$1"
        ;;
      --submission)
        shift
        [[ $# -gt 0 ]] || die "--submission requires a value"
        ADJUTORIX_TX_STATUS_SUBMISSION_JSON="$1"
        ;;
      --id-kind)
        shift
        [[ $# -gt 0 ]] || die "--id-kind requires a value"
        STATUS_ID_KIND="$1"
        ;;
      --method)
        shift
        [[ $# -gt 0 ]] || die "--method requires a value"
        ADJUTORIX_TX_STATUS_METHOD_OVERRIDE="$1"
        ;;
      --wait)
        ADJUTORIX_TX_STATUS_WAIT=true
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_STATUS_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_STATUS_AGENT_URL}${ADJUTORIX_TX_STATUS_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_STATUS_AGENT_URL}${ADJUTORIX_TX_STATUS_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_STATUS_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_STATUS_VERIFY_AGENT_HEALTH=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_STATUS_USE_COLOR=false
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

  if [[ -n "$STATUS_ID" && -n "$ADJUTORIX_TX_STATUS_SUBMISSION_JSON" ]]; then
    die "Provide either --id or --submission, not both"
  fi
  if [[ -z "$STATUS_ID" && -z "$ADJUTORIX_TX_STATUS_SUBMISSION_JSON" ]]; then
    die "A transaction identity is required via --id or --submission"
  fi
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_STATUS_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_STATUS_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

poll_until_terminal() {
  local started now elapsed
  started="$(date +%s)"
  while true; do
    phase_fetch_status_once
    phase_normalize_status
    if [[ "$TERMINAL" == "yes" ]]; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= ADJUTORIX_TX_STATUS_WAIT_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$ADJUTORIX_TX_STATUS_WAIT_POLL_INTERVAL_SECONDS"
  done
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_STATUS_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_STATUS_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_STATUS_ARTIFACT_DIR"
  : >"$ADJUTORIX_TX_STATUS_BOOT_LOG"
  : >"$ADJUTORIX_TX_STATUS_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_STATUS_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python
  require_command curl
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_identity() {
  if [[ -n "$ADJUTORIX_TX_STATUS_SUBMISSION_JSON" ]]; then
    [[ -f "$ADJUTORIX_TX_STATUS_SUBMISSION_JSON" ]] || die "Submission artifact not found: $ADJUTORIX_TX_STATUS_SUBMISSION_JSON"
    read -r STATUS_ID STATUS_ID_KIND REQUEST_ID PAYLOAD_SHA256 < <(python - <<'PY' "$ADJUTORIX_TX_STATUS_SUBMISSION_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
params = data.get('params', {})
method = data.get('method', '')
id_key = ''
id_kind = 'auto'
for key, kind in [('job_id', 'job'), ('transaction_id', 'transaction'), ('request_id', 'request')]:
    if params.get(key):
        id_key = params[key]
        id_kind = kind
        break
if not id_key and params.get('request_id'):
    id_key = params['request_id']
    id_kind = 'request'
print(id_key, id_kind, params.get('request_id', ''), params.get('payload_sha256', ''))
PY
)
    RESOLVED_FROM_ARTIFACT="yes"
  fi

  [[ -n "$STATUS_ID" ]] || die "Unable to resolve status identifier"

  case "$STATUS_ID_KIND" in
    auto)
      if [[ "$STATUS_ID" == job_* || "$STATUS_ID" == *-* ]]; then
        STATUS_ID_KIND="job"
      else
        STATUS_ID_KIND="request"
      fi
      ;;
    job|transaction|request)
      ;;
    *)
      die "Invalid id kind: $STATUS_ID_KIND"
      ;;
  esac

  REQUEST_ID="${REQUEST_ID:-$(printf '%s|%s' "$STATUS_ID" "$START_TS" | shasum -a 256 | awk '{print $1}') }"
}

phase_resolve_method_and_token() {
  if [[ -n "$ADJUTORIX_TX_STATUS_METHOD_OVERRIDE" ]]; then
    METHOD_TO_CALL="$ADJUTORIX_TX_STATUS_METHOD_OVERRIDE"
  else
    case "$STATUS_ID_KIND" in
      job|request)
        METHOD_TO_CALL="$ADJUTORIX_TX_STATUS_DEFAULT_METHOD"
        ;;
      transaction)
        METHOD_TO_CALL="$ADJUTORIX_TX_STATUS_FALLBACK_METHOD"
        ;;
    esac
  fi

  case "$METHOD_TO_CALL" in
    job.status)
      REQUEST_PARAM_KEY="job_id"
      ;;
    transaction.status)
      REQUEST_PARAM_KEY="transaction_id"
      ;;
    *)
      REQUEST_PARAM_KEY="id"
      ;;
  esac

  if [[ -f "$ADJUTORIX_TX_STATUS_TOKEN_FILE" && -s "$ADJUTORIX_TX_STATUS_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_STATUS_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_STATUS_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_STATUS_TOKEN_FILE"
  fi
}

phase_verify_agent_health() {
  if [[ "$ADJUTORIX_TX_STATUS_VERIFY_AGENT_HEALTH" != "true" ]]; then
    return 0
  fi
  curl -fsS --max-time "$ADJUTORIX_TX_STATUS_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
}

phase_fetch_status_once() {
  python - <<'PY' \
    "$ADJUTORIX_TX_STATUS_REQUEST_JSON" \
    "$METHOD_TO_CALL" \
    "$REQUEST_ID" \
    "$REQUEST_PARAM_KEY" \
    "$STATUS_ID"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': sys.argv[2],
    'params': {
        sys.argv[4]: sys.argv[5],
        'request_id': sys.argv[3],
    },
}
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY

  curl -fsS \
    --max-time "$ADJUTORIX_TX_STATUS_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_STATUS_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_STATUS_RESPONSE_JSON"

  REQUEST_METHOD_USED="$METHOD_TO_CALL"
}

phase_normalize_status() {
  python - <<'PY' \
    "$ADJUTORIX_TX_STATUS_RESPONSE_JSON" \
    "$ADJUTORIX_TX_STATUS_NORMALIZED_JSON" \
    "$STATUS_ID" \
    "$STATUS_ID_KIND" \
    "$REQUEST_METHOD_USED" \
    "$ADJUTORIX_TX_STATUS_INCLUDE_RESULT_BODY"
import json, sys
from pathlib import Path

response_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
status_id = sys.argv[3]
id_kind = sys.argv[4]
method_used = sys.argv[5]
include_body = sys.argv[6].lower() == 'true'

with response_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)

if 'error' in data:
    norm = {
        'status_id': status_id,
        'id_kind': id_kind,
        'method_used': method_used,
        'raw_state': 'rpc_error',
        'normalized_state': 'failed',
        'terminal': True,
        'success': False,
        'reason': json.dumps(data['error']),
        'result_present': False,
    }
else:
    result = data.get('result', {})
    raw_state = result.get('state', result.get('status', result.get('phase', 'unknown')))
    reason = result.get('reason', result.get('message', ''))
    terminal_states = {'succeeded', 'completed', 'failed', 'rejected', 'cancelled'}
    success_states = {'succeeded', 'completed'}
    normalized_state = raw_state
    if raw_state in {'queued', 'accepted', 'submitted'}:
        normalized_state = 'pending'
    elif raw_state in {'running', 'applying', 'verifying'}:
        normalized_state = 'in_progress'
    elif raw_state in success_states:
        normalized_state = 'succeeded'
    elif raw_state in {'failed', 'rejected', 'cancelled'}:
        normalized_state = 'failed'
    norm = {
        'status_id': status_id,
        'id_kind': id_kind,
        'method_used': method_used,
        'raw_state': raw_state,
        'normalized_state': normalized_state,
        'terminal': raw_state in terminal_states,
        'success': raw_state in success_states,
        'reason': reason,
        'result_present': isinstance(result, dict),
    }
    if include_body:
        norm['result'] = result

out_path.write_text(json.dumps(norm, indent=2), encoding='utf-8')
print(json.dumps(norm))
PY

  read -r RAW_STATE NORMALIZED_STATE TERMINAL SUCCESS STATE_REASON RESULT_OBJECT_PRESENT < <(python - <<'PY' "$ADJUTORIX_TX_STATUS_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(
    data.get('raw_state', 'unknown'),
    data.get('normalized_state', 'unknown'),
    'yes' if data.get('terminal') else 'no',
    'yes' if data.get('success') else 'no',
    (data.get('reason') or '').replace('\n', ' '),
    'yes' if data.get('result_present') else 'no',
)
PY
  )
}

phase_wait_if_requested() {
  if [[ "$ADJUTORIX_TX_STATUS_WAIT" != "true" ]]; then
    return 0
  fi
  poll_until_terminal
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction status summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_STATUS_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "status_id: ${STATUS_ID}"
    echo "status_id_kind: ${STATUS_ID_KIND}"
    echo "resolved_from_artifact: ${RESOLVED_FROM_ARTIFACT}"
    echo "request_id: ${REQUEST_ID}"
    echo "payload_sha256: ${PAYLOAD_SHA256}"
    echo "method_used: ${REQUEST_METHOD_USED}"
    echo "request_param_key: ${REQUEST_PARAM_KEY}"
    echo "fallback_used: ${FALLBACK_USED}"
    echo "raw_state: ${RAW_STATE}"
    echo "normalized_state: ${NORMALIZED_STATE}"
    echo "terminal: ${TERMINAL}"
    echo "success: ${SUCCESS}"
    echo "state_reason: ${STATE_REASON}"
    echo "result_object_present: ${RESULT_OBJECT_PRESENT}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_STATUS_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_STATUS_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_STATUS_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_TX_STATUS_REQUEST_JSON}"
    echo "  - response: ${ADJUTORIX_TX_STATUS_RESPONSE_JSON}"
    echo "  - normalized: ${ADJUTORIX_TX_STATUS_NORMALIZED_JSON}"
  } >"$ADJUTORIX_TX_STATUS_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction status"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_identity phase_resolve_identity
  run_phase resolve_method_and_token phase_resolve_method_and_token
  run_phase verify_agent_health phase_verify_agent_health
  run_phase fetch_status_once phase_fetch_status_once
  run_phase normalize_status phase_normalize_status
  run_phase wait_if_requested phase_wait_if_requested

  write_summary

  section "Transaction status complete"
  log_info "summary=${ADJUTORIX_TX_STATUS_SUMMARY_FILE}"
  log_info "normalized_state=${NORMALIZED_STATE} terminal=${TERMINAL} success=${SUCCESS}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Transaction status failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
