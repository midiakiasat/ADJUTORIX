#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION INSPECT ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for deep transaction/job
#   inspection across runtime and local evidence surfaces
# - resolve transaction identity from explicit IDs or prior artifacts, retrieve
#   canonical runtime status/log/topology data, correlate submission and local
#   evidence, normalize the combined record into one forensic inspection view,
#   and emit reproducible artifacts for operators, CI, and postmortem work
# - ensure "inspect transaction" means one coherent, cross-surface diagnostic
#   snapshot rather than a pile of unrelated status/log/graph commands
#
# Scope
# - read-only inspection of runtime state and local artifacts
# - writes only repo-local report/export files under .tmp
# - no mutation of runtime state, ledger state, or workspace contents
#
# Design constraints
# - no silent fallback across incompatible identifier kinds
# - no unverifiable synthesis; every derived field must be anchored to fetched
#   runtime responses or explicit local artifacts
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

: "${ADJUTORIX_TX_INSPECT_STACK_NAME:=adjutorix-transaction-inspect}"
: "${ADJUTORIX_TX_INSPECT_USE_COLOR:=true}"
: "${ADJUTORIX_TX_INSPECT_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_INSPECT_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_INSPECT_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_INSPECT_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_INSPECT_HTTP_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_TX_INSPECT_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_INSPECT_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_INSPECT_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_INSPECT_STATUS_METHOD:=job.status}"
: "${ADJUTORIX_TX_INSPECT_LOGS_METHOD:=job.logs}"
: "${ADJUTORIX_TX_INSPECT_GRAPH_METHOD:=transaction.graph}"
: "${ADJUTORIX_TX_INSPECT_ASSUME_ID_KIND:=auto}"
: "${ADJUTORIX_TX_INSPECT_LOG_LIMIT:=500}"
: "${ADJUTORIX_TX_INSPECT_LOG_SINCE_SEQ:=0}"
: "${ADJUTORIX_TX_INSPECT_INCLUDE_RESULT_BODY:=true}"
: "${ADJUTORIX_TX_INSPECT_INCLUDE_LOG_ROWS:=true}"
: "${ADJUTORIX_TX_INSPECT_INCLUDE_GRAPH:=true}"
: "${ADJUTORIX_TX_INSPECT_INCLUDE_LOCAL_ARTIFACTS:=true}"
: "${ADJUTORIX_TX_INSPECT_INCLUDE_RENDERED_SUMMARY:=true}"
: "${ADJUTORIX_TX_INSPECT_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-inspect}"
: "${ADJUTORIX_TX_INSPECT_LOG_DIR:=${ADJUTORIX_TX_INSPECT_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_INSPECT_REPORT_DIR:=${ADJUTORIX_TX_INSPECT_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR:=${ADJUTORIX_TX_INSPECT_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_TX_INSPECT_BOOT_LOG:=${ADJUTORIX_TX_INSPECT_LOG_DIR}/inspect.log}"
: "${ADJUTORIX_TX_INSPECT_SUMMARY_FILE:=${ADJUTORIX_TX_INSPECT_REPORT_DIR}/inspect-summary.txt}"
: "${ADJUTORIX_TX_INSPECT_PHASE_FILE:=${ADJUTORIX_TX_INSPECT_REPORT_DIR}/inspect-phases.tsv}"
: "${ADJUTORIX_TX_INSPECT_STATUS_REQUEST_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/status-request.json}"
: "${ADJUTORIX_TX_INSPECT_STATUS_RESPONSE_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/status-response.json}"
: "${ADJUTORIX_TX_INSPECT_LOGS_REQUEST_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/logs-request.json}"
: "${ADJUTORIX_TX_INSPECT_LOGS_RESPONSE_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/logs-response.json}"
: "${ADJUTORIX_TX_INSPECT_GRAPH_REQUEST_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/graph-request.json}"
: "${ADJUTORIX_TX_INSPECT_GRAPH_RESPONSE_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/graph-response.json}"
: "${ADJUTORIX_TX_INSPECT_NORMALIZED_JSON:=${ADJUTORIX_TX_INSPECT_ARTIFACT_DIR}/normalized.json}"
: "${ADJUTORIX_TX_INSPECT_RENDERED_TXT:=${ADJUTORIX_TX_INSPECT_REPORT_DIR}/rendered.txt}"

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
STATUS_ID_KIND="$ADJUTORIX_TX_INSPECT_ASSUME_ID_KIND"
JOB_ID=""
TRANSACTION_ID=""
REQUEST_ID=""
SUBMISSION_ARTIFACT=""
STATUS_ARTIFACT=""
LOG_ARTIFACT=""
GRAPH_ARTIFACT=""
TOKEN_VALUE=""
HEALTH_URL="${ADJUTORIX_TX_INSPECT_AGENT_URL}${ADJUTORIX_TX_INSPECT_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_INSPECT_AGENT_URL}${ADJUTORIX_TX_INSPECT_RPC_PATH}"
REQUEST_ID_LOCAL=""
RESOLVED_FROM_ARTIFACT="no"
RAW_STATE="unknown"
NORMALIZED_STATE="unknown"
TERMINAL="no"
SUCCESS="unknown"
STATE_REASON=""
LOG_ROW_COUNT="0"
GRAPH_NODE_COUNT="0"
GRAPH_EDGE_COUNT="0"
LOCAL_ARTIFACT_COUNT="0"
PAYLOAD_SHA256=""
AUTHORITY=""
PRIORITY=""
INTENT_LABEL=""
WORKSPACE_PATH=""
WORKSPACE_ID=""
TRUST_FILE=""
CANCEL_PRESENT="no"
CANCEL_REASON=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_INSPECT_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_INSPECT_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_INSPECT_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/inspect.sh --job-id <id> [options]
  scripts/transaction/inspect.sh --transaction-id <id> [options]
  scripts/transaction/inspect.sh --request-id <id> [options]
  scripts/transaction/inspect.sh --submission <submission-json> [options]
  scripts/transaction/inspect.sh --status-artifact <status-json> [options]

Identity options:
  --job-id <id>                 Explicit job identifier
  --transaction-id <id>         Explicit transaction identifier
  --request-id <id>             Explicit request identifier
  --submission <path>           Prior submission artifact to resolve identifiers
  --status-artifact <path>      Prior status artifact to resolve identifiers

Inspection options:
  --logs-artifact <path>        Optional prior logs artifact to correlate
  --graph-artifact <path>       Optional prior graph artifact to correlate
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-inspection health probe
  --no-logs                     Skip runtime log retrieval
  --no-graph                    Skip runtime graph retrieval
  --no-local-artifacts          Skip local artifact correlation
  --no-rendered-summary         Skip human-readable rendered summary emission
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
      --logs-artifact)
        shift
        [[ $# -gt 0 ]] || die "--logs-artifact requires a value"
        LOG_ARTIFACT="$1"
        ;;
      --graph-artifact)
        shift
        [[ $# -gt 0 ]] || die "--graph-artifact requires a value"
        GRAPH_ARTIFACT="$1"
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_INSPECT_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_INSPECT_AGENT_URL}${ADJUTORIX_TX_INSPECT_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_INSPECT_AGENT_URL}${ADJUTORIX_TX_INSPECT_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_INSPECT_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_INSPECT_VERIFY_AGENT_HEALTH=false
        ;;
      --no-logs)
        ADJUTORIX_TX_INSPECT_INCLUDE_LOG_ROWS=false
        ;;
      --no-graph)
        ADJUTORIX_TX_INSPECT_INCLUDE_GRAPH=false
        ;;
      --no-local-artifacts)
        ADJUTORIX_TX_INSPECT_INCLUDE_LOCAL_ARTIFACTS=false
        ;;
      --no-rendered-summary)
        ADJUTORIX_TX_INSPECT_INCLUDE_RENDERED_SUMMARY=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_INSPECT_USE_COLOR=false
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
    die "Provide exactly one inspection identity source"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_INSPECT_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_INSPECT_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_INSPECT_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_INSPECT_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_INSPECT_ARTIFACT_DIR"
  : >"$ADJUTORIX_TX_INSPECT_BOOT_LOG"
  : >"$ADJUTORIX_TX_INSPECT_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_INSPECT_PHASE_FILE"
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
    read -r JOB_ID TRANSACTION_ID REQUEST_ID PAYLOAD_SHA256 AUTHORITY PRIORITY INTENT_LABEL WORKSPACE_PATH WORKSPACE_ID TRUST_FILE < <(python - <<'PY' "$SUBMISSION_ARTIFACT"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
params = data.get('params', {})
print(
    params.get('job_id', ''),
    params.get('transaction_id', ''),
    params.get('request_id', ''),
    params.get('payload_sha256', ''),
    params.get('authority', ''),
    params.get('priority', ''),
    params.get('intent_label', ''),
    params.get('workspace_path', ''),
    params.get('workspace_id', ''),
    params.get('trust_file', ''),
)
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

  [[ -n "$STATUS_ID" ]] || die "Unable to resolve inspection target id"
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

  if [[ -z "$JOB_ID" && "$STATUS_ID_KIND" == "job" ]]; then
    JOB_ID="$STATUS_ID"
  fi
  if [[ -z "$REQUEST_ID" ]]; then
    REQUEST_ID="$STATUS_ID"
  fi

  REQUEST_ID_LOCAL="$(printf '%s|%s|inspect' "$STATUS_ID" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_resolve_token_and_health() {
  if [[ -f "$ADJUTORIX_TX_INSPECT_TOKEN_FILE" && -s "$ADJUTORIX_TX_INSPECT_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_INSPECT_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_INSPECT_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_INSPECT_TOKEN_FILE"
  fi
  if [[ "$ADJUTORIX_TX_INSPECT_VERIFY_AGENT_HEALTH" == "true" ]]; then
    curl -fsS --max-time "$ADJUTORIX_TX_INSPECT_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
  fi
}

phase_fetch_status() {
  local status_key status_value
  status_key="job_id"
  status_value="$STATUS_ID"
  if [[ "$STATUS_ID_KIND" == "transaction" ]]; then
    status_key="transaction_id"
  elif [[ "$STATUS_ID_KIND" == "request" ]]; then
    status_key="request_id"
  fi

  python - <<'PY' \
    "$ADJUTORIX_TX_INSPECT_STATUS_REQUEST_JSON" \
    "$ADJUTORIX_TX_INSPECT_STATUS_METHOD" \
    "$status_key" \
    "$status_value" \
    "$REQUEST_ID_LOCAL"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 1,
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
    --max-time "$ADJUTORIX_TX_INSPECT_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_INSPECT_STATUS_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_INSPECT_STATUS_RESPONSE_JSON"
}

phase_fetch_logs() {
  if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_LOG_ROWS" != "true" ]]; then
    return 0
  fi
  [[ -n "$JOB_ID" ]] || return 0

  python - <<'PY' \
    "$ADJUTORIX_TX_INSPECT_LOGS_REQUEST_JSON" \
    "$ADJUTORIX_TX_INSPECT_LOGS_METHOD" \
    "$JOB_ID" \
    "$ADJUTORIX_TX_INSPECT_LOG_SINCE_SEQ" \
    "$ADJUTORIX_TX_INSPECT_LOG_LIMIT"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 2,
    'method': sys.argv[2],
    'params': {
        'job_id': sys.argv[3],
        'since_seq': int(sys.argv[4]),
        'limit': int(sys.argv[5]),
    },
}
with open(sys.argv[1], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY

  curl -fsS \
    --max-time "$ADJUTORIX_TX_INSPECT_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_INSPECT_LOGS_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_INSPECT_LOGS_RESPONSE_JSON"
}

phase_fetch_graph() {
  if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_GRAPH" != "true" ]]; then
    return 0
  fi

  local graph_key graph_value
  graph_key="job_id"
  graph_value="$STATUS_ID"
  if [[ "$STATUS_ID_KIND" == "transaction" ]]; then
    graph_key="transaction_id"
  elif [[ "$STATUS_ID_KIND" == "request" ]]; then
    graph_key="request_id"
  fi

  python - <<'PY' \
    "$ADJUTORIX_TX_INSPECT_GRAPH_REQUEST_JSON" \
    "$ADJUTORIX_TX_INSPECT_GRAPH_METHOD" \
    "$graph_key" \
    "$graph_value" \
    "$REQUEST_ID_LOCAL"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 3,
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
    --max-time "$ADJUTORIX_TX_INSPECT_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_INSPECT_GRAPH_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_INSPECT_GRAPH_RESPONSE_JSON"
}

phase_correlate_local_artifacts() {
  if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_LOCAL_ARTIFACTS" != "true" ]]; then
    return 0
  fi
  LOCAL_ARTIFACT_COUNT=0
  [[ -n "$SUBMISSION_ARTIFACT" && -f "$SUBMISSION_ARTIFACT" ]] && LOCAL_ARTIFACT_COUNT=$((LOCAL_ARTIFACT_COUNT + 1))
  [[ -n "$STATUS_ARTIFACT" && -f "$STATUS_ARTIFACT" ]] && LOCAL_ARTIFACT_COUNT=$((LOCAL_ARTIFACT_COUNT + 1))
  [[ -n "$LOG_ARTIFACT" && -f "$LOG_ARTIFACT" ]] && LOCAL_ARTIFACT_COUNT=$((LOCAL_ARTIFACT_COUNT + 1))
  [[ -n "$GRAPH_ARTIFACT" && -f "$GRAPH_ARTIFACT" ]] && LOCAL_ARTIFACT_COUNT=$((LOCAL_ARTIFACT_COUNT + 1))

  if [[ -n "$LOG_ARTIFACT" && -f "$LOG_ARTIFACT" ]]; then
    if python - <<'PY' "$LOG_ARTIFACT" >/dev/null 2>&1
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('row_count', 0))
PY
    then
      :
    fi
  fi
}

phase_normalize_inspection() {
  python - <<'PY' \
    "$ADJUTORIX_TX_INSPECT_STATUS_RESPONSE_JSON" \
    "$ADJUTORIX_TX_INSPECT_LOGS_RESPONSE_JSON" \
    "$ADJUTORIX_TX_INSPECT_GRAPH_RESPONSE_JSON" \
    "$ADJUTORIX_TX_INSPECT_NORMALIZED_JSON" \
    "$STATUS_ID" \
    "$STATUS_ID_KIND" \
    "$REQUEST_ID" \
    "$JOB_ID" \
    "$TRANSACTION_ID" \
    "$PAYLOAD_SHA256" \
    "$AUTHORITY" \
    "$PRIORITY" \
    "$INTENT_LABEL" \
    "$WORKSPACE_PATH" \
    "$WORKSPACE_ID" \
    "$TRUST_FILE" \
    "$SUBMISSION_ARTIFACT" \
    "$STATUS_ARTIFACT" \
    "$LOG_ARTIFACT" \
    "$GRAPH_ARTIFACT" \
    "$ADJUTORIX_TX_INSPECT_INCLUDE_RESULT_BODY"
import json, sys
from pathlib import Path

status_path = Path(sys.argv[1])
logs_path = Path(sys.argv[2])
graph_path = Path(sys.argv[3])
out_path = Path(sys.argv[4])
status_id = sys.argv[5]
id_kind = sys.argv[6]
request_id = sys.argv[7]
job_id = sys.argv[8]
transaction_id = sys.argv[9]
payload_sha256 = sys.argv[10]
authority = sys.argv[11]
priority = sys.argv[12]
intent_label = sys.argv[13]
workspace_path = sys.argv[14]
workspace_id = sys.argv[15]
trust_file = sys.argv[16]
submission_artifact = sys.argv[17]
status_artifact = sys.argv[18]
log_artifact = sys.argv[19]
graph_artifact = sys.argv[20]
include_body = sys.argv[21].lower() == 'true'

with status_path.open('r', encoding='utf-8') as fh:
    status_data = json.load(fh)
status_result = status_data.get('result', {}) if 'error' not in status_data else {}
raw_state = status_result.get('state', status_result.get('status', 'rpc_error' if 'error' in status_data else 'unknown'))
reason = status_result.get('reason', status_result.get('message', json.dumps(status_data.get('error', {})) if 'error' in status_data else ''))
terminal_states = {'succeeded', 'completed', 'failed', 'rejected', 'cancelled'}
success_states = {'succeeded', 'completed'}
normalized_state = raw_state
if raw_state in {'queued', 'accepted', 'submitted'}:
    normalized_state = 'pending'
elif raw_state in {'running', 'applying', 'verifying'}:
    normalized_state = 'in_progress'
elif raw_state in success_states:
    normalized_state = 'succeeded'
elif raw_state in {'failed', 'rejected', 'cancelled', 'rpc_error'}:
    normalized_state = 'failed'

log_rows = []
if logs_path.exists():
    try:
        with logs_path.open('r', encoding='utf-8') as fh:
            logs_data = json.load(fh)
        result = logs_data.get('result', {}) if 'error' not in logs_data else {}
        rows = result.get('rows', result.get('logs', result.get('events', [])))
        if isinstance(rows, list):
            log_rows = rows
    except Exception:
        log_rows = []

graph_nodes = []
graph_edges = []
if graph_path.exists():
    try:
        with graph_path.open('r', encoding='utf-8') as fh:
            graph_data = json.load(fh)
        result = graph_data.get('result', {}) if 'error' not in graph_data else {}
        graph_nodes = result.get('nodes', result.get('states', [])) if isinstance(result, dict) else []
        graph_edges = result.get('edges', result.get('transitions', [])) if isinstance(result, dict) else []
    except Exception:
        graph_nodes = []
        graph_edges = []

cancel_present = raw_state == 'cancelled'
cancel_reason = reason if cancel_present else ''

payload = {
    'identity': {
        'status_id': status_id,
        'id_kind': id_kind,
        'request_id': request_id,
        'job_id': job_id,
        'transaction_id': transaction_id,
    },
    'provenance': {
        'payload_sha256': payload_sha256,
        'authority': authority,
        'priority': priority,
        'intent_label': intent_label,
        'workspace_path': workspace_path,
        'workspace_id': workspace_id,
        'trust_file': trust_file,
    },
    'runtime': {
        'raw_state': raw_state,
        'normalized_state': normalized_state,
        'terminal': raw_state in terminal_states,
        'success': raw_state in success_states,
        'reason': reason,
        'log_row_count': len(log_rows),
        'graph_node_count': len(graph_nodes) if isinstance(graph_nodes, list) else 0,
        'graph_edge_count': len(graph_edges) if isinstance(graph_edges, list) else 0,
    },
    'local_artifacts': {
        'submission_artifact': submission_artifact,
        'status_artifact': status_artifact,
        'logs_artifact': log_artifact,
        'graph_artifact': graph_artifact,
    },
    'cancellation': {
        'present': cancel_present,
        'reason': cancel_reason,
    },
}
if include_body:
    payload['runtime']['status_result'] = status_result
    payload['runtime']['log_rows'] = log_rows
    payload['runtime']['graph_nodes'] = graph_nodes
    payload['runtime']['graph_edges'] = graph_edges

out_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY

  read -r RAW_STATE NORMALIZED_STATE TERMINAL SUCCESS STATE_REASON LOG_ROW_COUNT GRAPH_NODE_COUNT GRAPH_EDGE_COUNT CANCEL_PRESENT CANCEL_REASON < <(python - <<'PY' "$ADJUTORIX_TX_INSPECT_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
runtime = data.get('runtime', {})
cancel = data.get('cancellation', {})
print(
    runtime.get('raw_state', 'unknown'),
    runtime.get('normalized_state', 'unknown'),
    'yes' if runtime.get('terminal') else 'no',
    'yes' if runtime.get('success') else 'no',
    (runtime.get('reason', '') or '').replace('\n', ' '),
    runtime.get('log_row_count', 0),
    runtime.get('graph_node_count', 0),
    runtime.get('graph_edge_count', 0),
    'yes' if cancel.get('present') else 'no',
    (cancel.get('reason', '') or '').replace('\n', ' '),
)
PY
)
}

phase_render_summary() {
  if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_RENDERED_SUMMARY" != "true" ]]; then
    return 0
  fi
  {
    echo "ADJUTORIX transaction inspection"
    echo "status_id: ${STATUS_ID}"
    echo "id_kind: ${STATUS_ID_KIND}"
    echo "request_id: ${REQUEST_ID}"
    echo "job_id: ${JOB_ID}"
    echo "transaction_id: ${TRANSACTION_ID}"
    echo "raw_state: ${RAW_STATE}"
    echo "normalized_state: ${NORMALIZED_STATE}"
    echo "terminal: ${TERMINAL}"
    echo "success: ${SUCCESS}"
    echo "reason: ${STATE_REASON}"
    echo "authority: ${AUTHORITY}"
    echo "priority: ${PRIORITY}"
    echo "intent_label: ${INTENT_LABEL}"
    echo "payload_sha256: ${PAYLOAD_SHA256}"
    echo "workspace_path: ${WORKSPACE_PATH}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "trust_file: ${TRUST_FILE}"
    echo "log_row_count: ${LOG_ROW_COUNT}"
    echo "graph_node_count: ${GRAPH_NODE_COUNT}"
    echo "graph_edge_count: ${GRAPH_EDGE_COUNT}"
    echo "cancel_present: ${CANCEL_PRESENT}"
    echo "cancel_reason: ${CANCEL_REASON}"
    echo "local_artifact_count: ${LOCAL_ARTIFACT_COUNT}"
  } >"$ADJUTORIX_TX_INSPECT_RENDERED_TXT"

  if [[ "$QUIET" != "true" ]]; then
    cat "$ADJUTORIX_TX_INSPECT_RENDERED_TXT"
  fi
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction inspect summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_INSPECT_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "status_id: ${STATUS_ID}"
    echo "status_id_kind: ${STATUS_ID_KIND}"
    echo "resolved_from_artifact: ${RESOLVED_FROM_ARTIFACT}"
    echo "request_id: ${REQUEST_ID}"
    echo "job_id: ${JOB_ID}"
    echo "transaction_id: ${TRANSACTION_ID}"
    echo "payload_sha256: ${PAYLOAD_SHA256}"
    echo "authority: ${AUTHORITY}"
    echo "priority: ${PRIORITY}"
    echo "intent_label: ${INTENT_LABEL}"
    echo "workspace_path: ${WORKSPACE_PATH}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "trust_file: ${TRUST_FILE}"
    echo "raw_state: ${RAW_STATE}"
    echo "normalized_state: ${NORMALIZED_STATE}"
    echo "terminal: ${TERMINAL}"
    echo "success: ${SUCCESS}"
    echo "state_reason: ${STATE_REASON}"
    echo "log_row_count: ${LOG_ROW_COUNT}"
    echo "graph_node_count: ${GRAPH_NODE_COUNT}"
    echo "graph_edge_count: ${GRAPH_EDGE_COUNT}"
    echo "local_artifact_count: ${LOCAL_ARTIFACT_COUNT}"
    echo "cancel_present: ${CANCEL_PRESENT}"
    echo "cancel_reason: ${CANCEL_REASON}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_INSPECT_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_INSPECT_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_INSPECT_PHASE_FILE}"
    echo "  - status_request: ${ADJUTORIX_TX_INSPECT_STATUS_REQUEST_JSON}"
    echo "  - status_response: ${ADJUTORIX_TX_INSPECT_STATUS_RESPONSE_JSON}"
    if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_LOG_ROWS" == "true" ]]; then
      echo "  - logs_request: ${ADJUTORIX_TX_INSPECT_LOGS_REQUEST_JSON}"
      echo "  - logs_response: ${ADJUTORIX_TX_INSPECT_LOGS_RESPONSE_JSON}"
    fi
    if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_GRAPH" == "true" ]]; then
      echo "  - graph_request: ${ADJUTORIX_TX_INSPECT_GRAPH_REQUEST_JSON}"
      echo "  - graph_response: ${ADJUTORIX_TX_INSPECT_GRAPH_RESPONSE_JSON}"
    fi
    echo "  - normalized: ${ADJUTORIX_TX_INSPECT_NORMALIZED_JSON}"
    if [[ "$ADJUTORIX_TX_INSPECT_INCLUDE_RENDERED_SUMMARY" == "true" ]]; then
      echo "  - rendered: ${ADJUTORIX_TX_INSPECT_RENDERED_TXT}"
    fi
  } >"$ADJUTORIX_TX_INSPECT_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction inspect"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_identity phase_resolve_identity
  run_phase resolve_token_and_health phase_resolve_token_and_health
  run_phase fetch_status phase_fetch_status
  run_phase fetch_logs phase_fetch_logs
  run_phase fetch_graph phase_fetch_graph
  run_phase correlate_local_artifacts phase_correlate_local_artifacts
  run_phase normalize_inspection phase_normalize_inspection
  run_phase render_summary phase_render_summary

  write_summary

  section "Transaction inspect complete"
  log_info "summary=${ADJUTORIX_TX_INSPECT_SUMMARY_FILE}"
  log_info "normalized_state=${NORMALIZED_STATE} terminal=${TERMINAL} success=${SUCCESS}"

  if (( OVERALL_FAILURES > 0 )); the