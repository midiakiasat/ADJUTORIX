#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION CANCEL ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for governed transaction/job
#   cancellation requests into the ADJUTORIX runtime
# - resolve cancellation identity from explicit IDs or prior artifacts, validate
#   authority and current runtime reachability, derive deterministic request and
#   idempotency markers, perform authenticated RPC cancellation, and emit
#   auditable evidence plus post-cancel status confirmation
# - ensure "transaction cancelled" means one verified cancellation intent and
#   observed downstream state, not an ad hoc RPC attempt
#
# Scope
# - cancellation ingress orchestration only
# - does not mutate local workspace state beyond report artifacts
# - runtime mutation occurs only through the explicit agent RPC call
#
# Design constraints
# - no silent fallback between job, transaction, and request identifiers
# - no cancellation without explicit reason/authority surface
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

: "${ADJUTORIX_TX_CANCEL_STACK_NAME:=adjutorix-transaction-cancel}"
: "${ADJUTORIX_TX_CANCEL_USE_COLOR:=true}"
: "${ADJUTORIX_TX_CANCEL_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_CANCEL_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_CANCEL_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_CANCEL_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_CANCEL_HTTP_TIMEOUT_SECONDS:=15}"
: "${ADJUTORIX_TX_CANCEL_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_CANCEL_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_CANCEL_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_CANCEL_CANCEL_METHOD:=transaction.cancel}"
: "${ADJUTORIX_TX_CANCEL_STATUS_METHOD:=job.status}"
: "${ADJUTORIX_TX_CANCEL_DEFAULT_AUTHORITY:=operator}"
: "${ADJUTORIX_TX_CANCEL_WAIT_FOR_TERMINAL:=true}"
: "${ADJUTORIX_TX_CANCEL_WAIT_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_TX_CANCEL_WAIT_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_TX_CANCEL_REQUIRE_REASON:=true}"
: "${ADJUTORIX_TX_CANCEL_ALLOW_ALREADY_TERMINAL:=true}"
: "${ADJUTORIX_TX_CANCEL_ASSUME_ID_KIND:=auto}"
: "${ADJUTORIX_TX_CANCEL_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-cancel}"
: "${ADJUTORIX_TX_CANCEL_LOG_DIR:=${ADJUTORIX_TX_CANCEL_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_CANCEL_REPORT_DIR:=${ADJUTORIX_TX_CANCEL_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_CANCEL_ARTIFACT_DIR:=${ADJUTORIX_TX_CANCEL_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_TX_CANCEL_BOOT_LOG:=${ADJUTORIX_TX_CANCEL_LOG_DIR}/cancel.log}"
: "${ADJUTORIX_TX_CANCEL_SUMMARY_FILE:=${ADJUTORIX_TX_CANCEL_REPORT_DIR}/cancel-summary.txt}"
: "${ADJUTORIX_TX_CANCEL_PHASE_FILE:=${ADJUTORIX_TX_CANCEL_REPORT_DIR}/cancel-phases.tsv}"
: "${ADJUTORIX_TX_CANCEL_REQUEST_JSON:=${ADJUTORIX_TX_CANCEL_ARTIFACT_DIR}/request.json}"
: "${ADJUTORIX_TX_CANCEL_RESPONSE_JSON:=${ADJUTORIX_TX_CANCEL_ARTIFACT_DIR}/response.json}"
: "${ADJUTORIX_TX_CANCEL_STATUS_JSON:=${ADJUTORIX_TX_CANCEL_ARTIFACT_DIR}/status.json}"
: "${ADJUTORIX_TX_CANCEL_NORMALIZED_JSON:=${ADJUTORIX_TX_CANCEL_ARTIFACT_DIR}/normalized.json}"

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
STATUS_ID_KIND="$ADJUTORIX_TX_CANCEL_ASSUME_ID_KIND"
JOB_ID=""
TRANSACTION_ID=""
REQUEST_ID=""
SUBMISSION_ARTIFACT=""
STATUS_ARTIFACT=""
TOKEN_VALUE=""
AUTHORITY="$ADJUTORIX_TX_CANCEL_DEFAULT_AUTHORITY"
REASON_TEXT=""
CANCEL_REQUEST_ID=""
IDEMPOTENCY_KEY=""
HEALTH_URL="${ADJUTORIX_TX_CANCEL_AGENT_URL}${ADJUTORIX_TX_CANCEL_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_CANCEL_AGENT_URL}${ADJUTORIX_TX_CANCEL_RPC_PATH}"
PRE_STATE="unknown"
POST_STATE="unknown"
TERMINAL="no"
CANCEL_ACCEPTED="no"
RESOLVED_FROM_ARTIFACT="no"
METHOD_USED="$ADJUTORIX_TX_CANCEL_CANCEL_METHOD"
REQUEST_PARAM_KEY=""
ALLOW_NOOP_CANCEL="no"
STATE_REASON=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_CANCEL_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_CANCEL_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_CANCEL_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/cancel.sh --job-id <id> --reason <text> [options]
  scripts/transaction/cancel.sh --transaction-id <id> --reason <text> [options]
  scripts/transaction/cancel.sh --request-id <id> --reason <text> [options]
  scripts/transaction/cancel.sh --submission <submission-json> --reason <text> [options]
  scripts/transaction/cancel.sh --status-artifact <status-json> --reason <text> [options]

Identity options:
  --job-id <id>                 Explicit job identifier
  --transaction-id <id>         Explicit transaction identifier
  --request-id <id>             Explicit request identifier
  --submission <path>           Prior submission artifact to resolve identifiers
  --status-artifact <path>      Prior status artifact to resolve identifiers

Cancellation options:
  --reason <text>               Cancellation reason / justification
  --authority <name>            Authority surface label
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-cancel health probe
  --no-wait                     Do not poll post-cancel terminal state
  --allow-terminal-noop         Allow success when target is already terminal
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  local identity_count=0
  while (($# > 0)); do
    case "$1" in
      --job-id)
        shift
        [[ $# -gt 0 ]] || die "--job-id requires a value"
        JOB_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="job"
        identity_count=$((identity_count + 1))
        ;;
      --transaction-id)
        shift
        [[ $# -gt 0 ]] || die "--transaction-id requires a value"
        TRANSACTION_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="transaction"
        identity_count=$((identity_count + 1))
        ;;
      --request-id)
        shift
        [[ $# -gt 0 ]] || die "--request-id requires a value"
        REQUEST_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="request"
        identity_count=$((identity_count + 1))
        ;;
      --submission)
        shift
        [[ $# -gt 0 ]] || die "--submission requires a value"
        SUBMISSION_ARTIFACT="$1"
        identity_count=$((identity_count + 1))
        ;;
      --status-artifact)
        shift
        [[ $# -gt 0 ]] || die "--status-artifact requires a value"
        STATUS_ARTIFACT="$1"
        identity_count=$((identity_count + 1))
        ;;
      --reason)
        shift
        [[ $# -gt 0 ]] || die "--reason requires a value"
        REASON_TEXT="$1"
        ;;
      --authority)
        shift
        [[ $# -gt 0 ]] || die "--authority requires a value"
        AUTHORITY="$1"
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_CANCEL_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_CANCEL_AGENT_URL}${ADJUTORIX_TX_CANCEL_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_CANCEL_AGENT_URL}${ADJUTORIX_TX_CANCEL_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_CANCEL_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_CANCEL_VERIFY_AGENT_HEALTH=false
        ;;
      --no-wait)
        ADJUTORIX_TX_CANCEL_WAIT_FOR_TERMINAL=false
        ;;
      --allow-terminal-noop)
        ADJUTORIX_TX_CANCEL_ALLOW_ALREADY_TERMINAL=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_CANCEL_USE_COLOR=false
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

  if (( identity_count != 1 )); then
    die "Provide exactly one cancellation identity source"
  fi
  if [[ "$ADJUTORIX_TX_CANCEL_REQUIRE_REASON" == "true" && -z "$REASON_TEXT" ]]; then
    die "Cancellation reason is required"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_CANCEL_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_CANCEL_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

poll_until_terminal() {
  local started now elapsed
  started="$(date +%s)"
  while true; do
    phase_fetch_status
    phase_normalize_status
    if [[ "$TERMINAL" == "yes" ]]; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= ADJUTORIX_TX_CANCEL_WAIT_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$ADJUTORIX_TX_CANCEL_WAIT_POLL_INTERVAL_SECONDS"
  done
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_CANCEL_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_CANCEL_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_CANCEL_ARTIFACT_DIR"
  : >"$ADJUTORIX_TX_CANCEL_BOOT_LOG"
  : >"$ADJUTORIX_TX_CANCEL_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_CANCEL_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python
  require_command curl
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_identity() {
  if [[ -n "$SUBMISSION_ARTIFACT" ]]; then
    [[ -f "$SUBMISSION_ARTIFACT" ]] || die "Submission artifact not found: $SUBMISSION_ARTIFACT"
    read -r JOB_ID TRANSACTION_ID REQUEST_ID < <(python - <<'PY' "$SUBMISSION_ARTIFACT"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
params = data.get('params', {})
print(params.get('job_id', ''), params.get('transaction_id', ''), params.get('request_id', ''))
PY
)
    RESOLVED_FROM_ARTIFACT="yes"
  elif [[ -n "$STATUS_ARTIFACT" ]]; then
    [[ -f "$STATUS_ARTIFACT" ]] || die "Status artifact not found: $STATUS_ARTIFACT"
    read -r STATUS_ID STATUS_ID_KIND REQUEST_ID < <(python - <<'PY' "$STATUS_ARTIFACT"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('status_id', ''), data.get('status_id_kind', 'auto'), data.get('request_id', ''))
PY
)
    RESOLVED_FROM_ARTIFACT="yes"
  fi

  if [[ -n "$JOB_ID" ]]; then
    STATUS_ID="$JOB_ID"
    STATUS_ID_KIND="job"
  elif [[ -n "$TRANSACTION_ID" ]]; then
    STATUS_ID="$TRANSACTION_ID"
    STATUS_ID_KIND="transaction"
  elif [[ -n "$REQUEST_ID" && "$STATUS_ID_KIND" == "auto" ]]; then
    STATUS_ID="$REQUEST_ID"
    STATUS_ID_KIND="request"
  fi

  [[ -n "$STATUS_ID" ]] || die "Unable to resolve cancellation target id"
  case "$STATUS_ID_KIND" in
    auto)
      STATUS_ID_KIND="job"
      ;;
    job|transaction|request)
      ;;
    *)
      die "Invalid id kind: $STATUS_ID_KIND"
      ;;
  esac

  case "$STATUS_ID_KIND" in
    job) REQUEST_PARAM_KEY="job_id" ;;
    transaction) REQUEST_PARAM_KEY="transaction_id" ;;
    request) REQUEST_PARAM_KEY="request_id" ;;
  esac

  CANCEL_REQUEST_ID="$(printf '%s|%s|%s' "$STATUS_ID" "$AUTHORITY" "$START_TS" | shasum -a 256 | awk '{print $1}')"
  IDEMPOTENCY_KEY="$(printf '%s|%s|%s' "$METHOD_USED" "$STATUS_ID" "$REASON_TEXT" | shasum -a 256 | awk '{print $1}')"
}

phase_resolve_token_and_health() {
  if [[ -f "$ADJUTORIX_TX_CANCEL_TOKEN_FILE" && -s "$ADJUTORIX_TX_CANCEL_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_CANCEL_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_CANCEL_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_CANCEL_TOKEN_FILE"
  fi
  if [[ "$ADJUTORIX_TX_CANCEL_VERIFY_AGENT_HEALTH" == "true" ]]; then
    curl -fsS --max-time "$ADJUTORIX_TX_CANCEL_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
  fi
}

phase_fetch_status() {
  local status_key status_value
  status_key="job_id"
  status_value="$STATUS_ID"
  if [[ "$STATUS_ID_KIND" == "request" ]]; then
    status_key="request_id"
  elif [[ "$STATUS_ID_KIND" == "transaction" ]]; then
    status_key="transaction_id"
  fi

  python - <<'PY' \
    "$ADJUTORIX_TX_CANCEL_STATUS_JSON" \
    "$ADJUTORIX_TX_CANCEL_STATUS_METHOD" \
    "$status_key" \
    "$status_value" \
    "$CANCEL_REQUEST_ID"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 2,
    'method': sys.argv[2],
    'params': {
        sys.argv[3]: sys.argv[4],
        'request_id': sys.argv[5],
    },
}
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY

  curl -fsS \
    --max-time "$ADJUTORIX_TX_CANCEL_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_CANCEL_STATUS_JSON" \
    "$RPC_URL" > "${ADJUTORIX_TX_CANCEL_STATUS_JSON}.response"
}

phase_normalize_status() {
  python - <<'PY' \
    "${ADJUTORIX_TX_CANCEL_STATUS_JSON}.response" \
    "$ADJUTORIX_TX_CANCEL_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
if 'error' in data:
    norm = {
        'state': 'rpc_error',
        'terminal': True,
        'reason': json.dumps(data['error']),
    }
else:
    result = data.get('result', {})
    state = result.get('state', result.get('status', 'unknown'))
    norm = {
        'state': state,
        'terminal': state in {'succeeded', 'completed', 'failed', 'rejected', 'cancelled'},
        'reason': result.get('reason', result.get('message', '')),
        'result': result,
    }
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(norm, fh, indent=2)
print(json.dumps(norm))
PY

  read -r POST_STATE TERMINAL STATE_REASON < <(python - <<'PY' "$ADJUTORIX_TX_CANCEL_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('state', 'unknown'), 'yes' if data.get('terminal') else 'no', (data.get('reason', '') or '').replace('\n', ' '))
PY
)
}

phase_precheck_cancellable() {
  PRE_STATE="$POST_STATE"
  if [[ "$TERMINAL" == "yes" ]]; then
    if [[ "$ADJUTORIX_TX_CANCEL_ALLOW_ALREADY_TERMINAL" == "true" ]]; then
      ALLOW_NOOP_CANCEL="yes"
      return 0
    fi
    die "Target is already terminal and terminal no-op cancellation is disabled"
  fi
}

phase_submit_cancel() {
  if [[ "$ALLOW_NOOP_CANCEL" == "yes" ]]; then
    CANCEL_ACCEPTED="yes"
    return 0
  fi

  python - <<'PY' \
    "$ADJUTORIX_TX_CANCEL_REQUEST_JSON" \
    "$METHOD_USED" \
    "$REQUEST_PARAM_KEY" \
    "$STATUS_ID" \
    "$AUTHORITY" \
    "$REASON_TEXT" \
    "$CANCEL_REQUEST_ID" \
    "$IDEMPOTENCY_KEY"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': sys.argv[2],
    'params': {
        sys.argv[3]: sys.argv[4],
        'authority': sys.argv[5],
        'reason': sys.argv[6],
        'request_id': sys.argv[7],
        'idempotency_key': sys.argv[8],
    },
}
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY

  curl -fsS \
    --max-time "$ADJUTORIX_TX_CANCEL_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_CANCEL_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_CANCEL_RESPONSE_JSON"

  python - <<'PY' "$ADJUTORIX_TX_CANCEL_RESPONSE_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
if 'error' in data:
    raise SystemExit(json.dumps(data['error']))
print('cancel-ok')
PY

  CANCEL_ACCEPTED="yes"
}

phase_wait_for_terminal_if_requested() {
  if [[ "$ADJUTORIX_TX_CANCEL_WAIT_FOR_TERMINAL" != "true" ]]; then
    return 0
  fi
  poll_until_terminal
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction cancel summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_CANCEL_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "status_id: ${STATUS_ID}"
    echo "status_id_kind: ${STATUS_ID_KIND}"
    echo "resolved_from_artifact: ${RESOLVED_FROM_ARTIFACT}"
    echo "authority: ${AUTHORITY}"
    echo "reason: ${REASON_TEXT}"
    echo "cancel_request_id: ${CANCEL_REQUEST_ID}"
    echo "idempotency_key: ${IDEMPOTENCY_KEY}"
    echo "method_used: ${METHOD_USED}"
    echo "request_param_key: ${REQUEST_PARAM_KEY}"
    echo "pre_state: ${PRE_STATE}"
    echo "post_state: ${POST_STATE}"
    echo "terminal: ${TERMINAL}"
    echo "cancel_accepted: ${CANCEL_ACCEPTED}"
    echo "allow_noop_cancel: ${ALLOW_NOOP_CANCEL}"
    echo "state_reason: ${STATE_REASON}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_CANCEL_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_CANCEL_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_CANCEL_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_TX_CANCEL_REQUEST_JSON}"
    echo "  - response: ${ADJUTORIX_TX_CANCEL_RESPONSE_JSON}"
    echo "  - status: ${ADJUTORIX_TX_CANCEL_STATUS_JSON}.response"
    echo "  - normalized: ${ADJUTORIX_TX_CANCEL_NORMALIZED_JSON}"
  } >"$ADJUTORIX_TX_CANCEL_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction cancel"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL} authority=${AUTHORITY}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_identity phase_resolve_identity
  run_phase resolve_token_and_health phase_resolve_token_and_health
  run_phase fetch_status phase_fetch_status
  run_phase normalize_status phase_normalize_status
  run_phase precheck_cancellable phase_precheck_cancellable
  run_phase submit_cancel phase_submit_cancel
  run_phase wait_for_terminal_if_requested phase_wait_for_terminal_if_requested

  write_summary

  section "Transaction cancel complete"
  log_info "summary=${ADJUTORIX_TX_CANCEL_SUMMARY_FILE}"
  log_info "status_id=${STATUS_ID} cancel_accepted=${CANCEL_ACCEPTED} post_state=${POST_STATE}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Transaction cancel failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
