#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION SUBMIT ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for submitting governed
#   transactions into the ADJUTORIX runtime
# - canonicalize submission inputs, validate payload/schema/authority context,
#   bind workspace and trust metadata, derive deterministic idempotency and
#   payload digests, perform authenticated RPC submission, and emit auditable
#   local evidence artifacts
# - ensure "transaction submitted" means one verified intent ingress event
#   rather than an ad hoc RPC call
#
# Scope
# - transaction ingress orchestration only
# - does not apply or verify the transaction itself; those remain downstream
# - mutation limited to local report artifacts and the explicit agent RPC call
#
# Design constraints
# - no silent fallback from structured payload to guessed intent
# - no submission without explicit authority surface and reproducible digest
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

: "${ADJUTORIX_TX_SUBMIT_STACK_NAME:=adjutorix-transaction-submit}"
: "${ADJUTORIX_TX_SUBMIT_USE_COLOR:=true}"
: "${ADJUTORIX_TX_SUBMIT_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_SUBMIT_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_SUBMIT_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_SUBMIT_HTTP_TIMEOUT_SECONDS:=15}"
: "${ADJUTORIX_TX_SUBMIT_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_SUBMIT_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_SUBMIT_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_SUBMIT_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_SUBMIT_RUNTIME_MODE:=development}"
: "${ADJUTORIX_TX_SUBMIT_DEFAULT_METHOD:=transaction.submit}"
: "${ADJUTORIX_TX_SUBMIT_DEFAULT_AUTHORITY:=operator}"
: "${ADJUTORIX_TX_SUBMIT_DEFAULT_PRIORITY:=normal}"
: "${ADJUTORIX_TX_SUBMIT_DEFAULT_WAIT_STATUS:=false}"
: "${ADJUTORIX_TX_SUBMIT_WAIT_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_TX_SUBMIT_WAIT_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_TX_SUBMIT_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-submit}"
: "${ADJUTORIX_TX_SUBMIT_LOG_DIR:=${ADJUTORIX_TX_SUBMIT_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_SUBMIT_REPORT_DIR:=${ADJUTORIX_TX_SUBMIT_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR:=${ADJUTORIX_TX_SUBMIT_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_TX_SUBMIT_BOOT_LOG:=${ADJUTORIX_TX_SUBMIT_LOG_DIR}/submit.log}"
: "${ADJUTORIX_TX_SUBMIT_SUMMARY_FILE:=${ADJUTORIX_TX_SUBMIT_REPORT_DIR}/submit-summary.txt}"
: "${ADJUTORIX_TX_SUBMIT_PHASE_FILE:=${ADJUTORIX_TX_SUBMIT_REPORT_DIR}/submit-phases.tsv}"
: "${ADJUTORIX_TX_SUBMIT_REQUEST_JSON:=${ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR}/request.json}"
: "${ADJUTORIX_TX_SUBMIT_RESPONSE_JSON:=${ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR}/response.json}"
: "${ADJUTORIX_TX_SUBMIT_SUBMISSION_JSON:=${ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR}/submission.json}"
: "${ADJUTORIX_TX_SUBMIT_STATUS_JSON:=${ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR}/status.json}"
: "${ADJUTORIX_TX_SUBMIT_REQUIRE_WORKSPACE:=false}"
: "${ADJUTORIX_TX_SUBMIT_REQUIRE_TRUST_RECORD:=false}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()

PAYLOAD_FILE=""
PAYLOAD_JSON_INLINE=""
WORKSPACE_PATH=""
WORKSPACE_CANONICAL=""
WORKSPACE_ID=""
TRUST_FILE=""
TRANSACTION_KIND=""
TRANSACTION_METHOD="$ADJUTORIX_TX_SUBMIT_DEFAULT_METHOD"
AUTHORITY="$ADJUTORIX_TX_SUBMIT_DEFAULT_AUTHORITY"
PRIORITY="$ADJUTORIX_TX_SUBMIT_DEFAULT_PRIORITY"
INTENT_LABEL=""
REASON_TEXT=""
WAIT_STATUS="$ADJUTORIX_TX_SUBMIT_DEFAULT_WAIT_STATUS"
REQUEST_ID=""
IDEMPOTENCY_KEY=""
PAYLOAD_SHA256=""
TOKEN_VALUE=""
HEALTH_URL="${ADJUTORIX_TX_SUBMIT_AGENT_URL}${ADJUTORIX_TX_SUBMIT_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_SUBMIT_AGENT_URL}${ADJUTORIX_TX_SUBMIT_RPC_PATH}"
JOB_ID=""
SUBMISSION_OK="no"
FINAL_STATUS="unknown"
FINAL_STATE_REASON=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_SUBMIT_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_SUBMIT_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_SUBMIT_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/submit.sh --payload-file <path> [options]
  scripts/transaction/submit.sh --payload-json '<json>' [options]

Required input:
  --payload-file <path>         Path to structured transaction payload JSON
    or
  --payload-json '<json>'       Inline structured transaction payload JSON

Options:
  --kind <name>                 Transaction kind label
  --method <rpc-method>         RPC method to invoke (default: transaction.submit)
  --authority <name>            Authority surface label
  --priority <name>             Submission priority hint
  --intent <label>              Human-readable intent label
  --reason <text>               Submission reason / justification
  --workspace <path>            Bind submission to a workspace path
  --trust-file <path>           Explicit workspace trust record path
  --wait                        Poll for submitted job status after submission
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-submit health probe
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --payload-file)
        shift
        [[ $# -gt 0 ]] || die "--payload-file requires a value"
        PAYLOAD_FILE="$1"
        ;;
      --payload-json)
        shift
        [[ $# -gt 0 ]] || die "--payload-json requires a value"
        PAYLOAD_JSON_INLINE="$1"
        ;;
      --kind)
        shift
        [[ $# -gt 0 ]] || die "--kind requires a value"
        TRANSACTION_KIND="$1"
        ;;
      --method)
        shift
        [[ $# -gt 0 ]] || die "--method requires a value"
        TRANSACTION_METHOD="$1"
        ;;
      --authority)
        shift
        [[ $# -gt 0 ]] || die "--authority requires a value"
        AUTHORITY="$1"
        ;;
      --priority)
        shift
        [[ $# -gt 0 ]] || die "--priority requires a value"
        PRIORITY="$1"
        ;;
      --intent)
        shift
        [[ $# -gt 0 ]] || die "--intent requires a value"
        INTENT_LABEL="$1"
        ;;
      --reason)
        shift
        [[ $# -gt 0 ]] || die "--reason requires a value"
        REASON_TEXT="$1"
        ;;
      --workspace)
        shift
        [[ $# -gt 0 ]] || die "--workspace requires a value"
        WORKSPACE_PATH="$1"
        ;;
      --trust-file)
        shift
        [[ $# -gt 0 ]] || die "--trust-file requires a value"
        TRUST_FILE="$1"
        ;;
      --wait)
        WAIT_STATUS=true
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_SUBMIT_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_SUBMIT_AGENT_URL}${ADJUTORIX_TX_SUBMIT_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_SUBMIT_AGENT_URL}${ADJUTORIX_TX_SUBMIT_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_SUBMIT_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_SUBMIT_VERIFY_AGENT_HEALTH=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_SUBMIT_USE_COLOR=false
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

  if [[ -n "$PAYLOAD_FILE" && -n "$PAYLOAD_JSON_INLINE" ]]; then
    die "Provide either --payload-file or --payload-json, not both"
  fi
  if [[ -z "$PAYLOAD_FILE" && -z "$PAYLOAD_JSON_INLINE" ]]; then
    die "A structured payload is required via --payload-file or --payload-json"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_SUBMIT_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_SUBMIT_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

wait_for_job_state() {
  local job_id="$1"
  local token="$2"
  local started now elapsed
  started="$(date +%s)"
  while true; do
    curl -fsS \
      --max-time "$ADJUTORIX_TX_SUBMIT_HTTP_TIMEOUT_SECONDS" \
      -H 'Content-Type: application/json' \
      -H "x-adjutorix-token: ${token}" \
      -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"job.status\",\"params\":{\"job_id\":\"${job_id}\"}}" \
      "$RPC_URL" > "$ADJUTORIX_TX_SUBMIT_STATUS_JSON"

    FINAL_STATUS="$(python - <<'PY' "$ADJUTORIX_TX_SUBMIT_STATUS_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
result = data.get('result', {})
print(result.get('state', result.get('status', 'unknown')))
PY
)"
    FINAL_STATE_REASON="$(python - <<'PY' "$ADJUTORIX_TX_SUBMIT_STATUS_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
result = data.get('result', {})
print(result.get('reason', ''))
PY
)"

    case "$FINAL_STATUS" in
      succeeded|completed|failed|rejected|cancelled)
        return 0
        ;;
    esac

    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= ADJUTORIX_TX_SUBMIT_WAIT_TIMEOUT_SECONDS )); then
      return 1
    fi
    sleep "$ADJUTORIX_TX_SUBMIT_WAIT_POLL_INTERVAL_SECONDS"
  done
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_SUBMIT_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_SUBMIT_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_SUBMIT_ARTIFACT_DIR"
  : >"$ADJUTORIX_TX_SUBMIT_BOOT_LOG"
  : >"$ADJUTORIX_TX_SUBMIT_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_SUBMIT_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python
  require_command curl
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_payload() {
  if [[ -n "$PAYLOAD_FILE" ]]; then
    [[ -f "$PAYLOAD_FILE" ]] || die "Payload file not found: $PAYLOAD_FILE"
    python - <<'PY' "$PAYLOAD_FILE" "$ADJUTORIX_TX_SUBMIT_REQUEST_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(data, fh, indent=2)
PY
  else
    python - <<'PY' "$PAYLOAD_JSON_INLINE" "$ADJUTORIX_TX_SUBMIT_REQUEST_JSON"
import json, sys
payload = json.loads(sys.argv[1])
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY
  fi

  PAYLOAD_SHA256="$(shasum -a 256 "$ADJUTORIX_TX_SUBMIT_REQUEST_JSON" | awk '{print $1}')"
  REQUEST_ID="$(printf '%s|%s' "$PAYLOAD_SHA256" "$START_TS" | shasum -a 256 | awk '{print $1}')"
  IDEMPOTENCY_KEY="$(printf '%s|%s|%s' "$TRANSACTION_METHOD" "$PAYLOAD_SHA256" "$AUTHORITY" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_payload_shape() {
  python - <<'PY' "$ADJUTORIX_TX_SUBMIT_REQUEST_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    raise SystemExit('payload root must be an object')
if 'intent' not in data and 'transaction' not in data and 'patch' not in data:
    raise SystemExit('payload missing one of: intent, transaction, patch')
print('payload-shape-ok')
PY
}

phase_resolve_workspace_context() {
  if [[ -z "$WORKSPACE_PATH" ]]; then
    if [[ "$ADJUTORIX_TX_SUBMIT_REQUIRE_WORKSPACE" == "true" ]]; then
      die "Workspace binding is required for this submission"
    fi
    return 0
  fi

  WORKSPACE_CANONICAL="$(python - <<'PY' "$WORKSPACE_PATH"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  [[ -d "$WORKSPACE_CANONICAL" ]] || die "Workspace path is not a directory: $WORKSPACE_CANONICAL"
  WORKSPACE_ID="$(printf '%s' "$WORKSPACE_CANONICAL" | shasum -a 256 | awk '{print $1}')"

  if [[ -z "$TRUST_FILE" ]]; then
    TRUST_FILE="${HOME}/.adjutorix/workspace-trust/${WORKSPACE_ID}.json"
  fi

  if [[ "$ADJUTORIX_TX_SUBMIT_REQUIRE_TRUST_RECORD" == "true" ]]; then
    [[ -f "$TRUST_FILE" ]] || die "Required trust record not found: $TRUST_FILE"
  fi
}

phase_resolve_token() {
  if [[ -f "$ADJUTORIX_TX_SUBMIT_TOKEN_FILE" && -s "$ADJUTORIX_TX_SUBMIT_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_SUBMIT_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_SUBMIT_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_SUBMIT_TOKEN_FILE"
  fi
}

phase_verify_agent_health() {
  if [[ "$ADJUTORIX_TX_SUBMIT_VERIFY_AGENT_HEALTH" != "true" ]]; then
    return 0
  fi
  curl -fsS --max-time "$ADJUTORIX_TX_SUBMIT_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
}

phase_submit_transaction() {
  python - <<'PY' \
    "$ADJUTORIX_TX_SUBMIT_REQUEST_JSON" \
    "$ADJUTORIX_TX_SUBMIT_SUBMISSION_JSON" \
    "$TRANSACTION_METHOD" \
    "$TRANSACTION_KIND" \
    "$AUTHORITY" \
    "$PRIORITY" \
    "$INTENT_LABEL" \
    "$REASON_TEXT" \
    "$WORKSPACE_CANONICAL" \
    "$WORKSPACE_ID" \
    "$TRUST_FILE" \
    "$REQUEST_ID" \
    "$IDEMPOTENCY_KEY" \
    "$PAYLOAD_SHA256"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    payload = json.load(fh)
params = {
    'request_id': sys.argv[11],
    'idempotency_key': sys.argv[12],
    'authority': sys.argv[4],
    'priority': sys.argv[5],
    'payload_sha256': sys.argv[13],
    'payload': payload,
}
if sys.argv[3]:
    params['kind'] = sys.argv[3]
if sys.argv[6]:
    params['intent_label'] = sys.argv[6]
if sys.argv[7]:
    params['reason'] = sys.argv[7]
if sys.argv[8]:
    params['workspace_path'] = sys.argv[8]
if sys.argv[9]:
    params['workspace_id'] = sys.argv[9]
if sys.argv[10]:
    params['trust_file'] = sys.argv[10]
request = {
    'jsonrpc': '2.0',
    'id': 1,
    'method': sys.argv[2],
    'params': params,
}
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(request, fh, indent=2)
PY

  curl -fsS \
    --max-time "$ADJUTORIX_TX_SUBMIT_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_SUBMIT_SUBMISSION_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_SUBMIT_RESPONSE_JSON"

  JOB_ID="$(python - <<'PY' "$ADJUTORIX_TX_SUBMIT_RESPONSE_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
if 'error' in data:
    raise SystemExit(json.dumps(data['error']))
result = data.get('result', {})
print(result.get('job_id', result.get('transaction_id', '')))
PY
)"
  SUBMISSION_OK="yes"
}

phase_wait_for_status_if_requested() {
  if [[ "$WAIT_STATUS" != "true" ]]; then
    return 0
  fi
  [[ -n "$JOB_ID" ]] || die "Cannot wait for status without a returned job_id"
  wait_for_job_state "$JOB_ID" "$TOKEN_VALUE"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction submit summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_SUBMIT_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "transaction_method: ${TRANSACTION_METHOD}"
    echo "transaction_kind: ${TRANSACTION_KIND}"
    echo "authority: ${AUTHORITY}"
    echo "priority: ${PRIORITY}"
    echo "intent_label: ${INTENT_LABEL}"
    echo "reason: ${REASON_TEXT}"
    echo "workspace_canonical: ${WORKSPACE_CANONICAL}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "trust_file: ${TRUST_FILE}"
    echo "request_id: ${REQUEST_ID}"
    echo "idempotency_key: ${IDEMPOTENCY_KEY}"
    echo "payload_sha256: ${PAYLOAD_SHA256}"
    echo "submission_ok: ${SUBMISSION_OK}"
    echo "job_id: ${JOB_ID}"
    echo "final_status: ${FINAL_STATUS}"
    echo "final_state_reason: ${FINAL_STATE_REASON}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_SUBMIT_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_SUBMIT_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_SUBMIT_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_TX_SUBMIT_REQUEST_JSON}"
    echo "  - submission: ${ADJUTORIX_TX_SUBMIT_SUBMISSION_JSON}"
    echo "  - response: ${ADJUTORIX_TX_SUBMIT_RESPONSE_JSON}"
    if [[ "$WAIT_STATUS" == "true" ]]; then
      echo "  - status: ${ADJUTORIX_TX_SUBMIT_STATUS_JSON}"
    fi
  } >"$ADJUTORIX_TX_SUBMIT_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction submit"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL} method=${TRANSACTION_METHOD} authority=${AUTHORITY}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_payload phase_resolve_payload
  run_phase validate_payload_shape phase_validate_payload_shape
  run_phase resolve_workspace_context phase_resolve_workspace_context
  run_phase resolve_token phase_resolve_token
  run_phase verify_agent_health phase_verify_agent_health
  run_phase submit_transaction phase_submit_transaction
  run_phase wait_for_status_if_requested phase_wait_for_status_if_requested

  write_summary

  section "Transaction submission complete"
  log_info "summary=${ADJUTORIX_TX_SUBMIT_SUMMARY_FILE}"
  log_info "job_id=${JOB_ID} submission_ok=${SUBMISSION_OK}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Transaction submission failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
