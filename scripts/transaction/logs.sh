#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION LOGS ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for inspecting transaction/job
#   execution logs and related evidence in the ADJUTORIX runtime
# - resolve transaction identity from explicit IDs or prior artifacts, unify RPC
#   log retrieval with local evidence slicing, normalize structured vs raw log
#   views, support bounded pagination/follow mode, and emit auditable exports
# - ensure "transaction logs" means one coherent observable execution trace
#   rather than an ad hoc mix of job.logs calls and local greps
#
# Scope
# - read-only inspection of agent-side logs via RPC and local report artifacts
# - writes only repo-local report/export files under .tmp
# - does not mutate transaction state
#
# Design constraints
# - no silent fallback across incompatible identifiers or log streams
# - no unbounded export or follow without explicit ceilings
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

: "${ADJUTORIX_TX_LOGS_STACK_NAME:=adjutorix-transaction-logs}"
: "${ADJUTORIX_TX_LOGS_USE_COLOR:=true}"
: "${ADJUTORIX_TX_LOGS_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_LOGS_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_LOGS_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_LOGS_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_LOGS_HTTP_TIMEOUT_SECONDS:=15}"
: "${ADJUTORIX_TX_LOGS_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_LOGS_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_LOGS_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_LOGS_DEFAULT_METHOD:=job.logs}"
: "${ADJUTORIX_TX_LOGS_STATUS_METHOD:=job.status}"
: "${ADJUTORIX_TX_LOGS_WAIT_FOR_MORE:=false}"
: "${ADJUTORIX_TX_LOGS_FOLLOW:=false}"
: "${ADJUTORIX_TX_LOGS_FOLLOW_POLL_INTERVAL_SECONDS:=1}"
: "${ADJUTORIX_TX_LOGS_FOLLOW_TIMEOUT_SECONDS:=60}"
: "${ADJUTORIX_TX_LOGS_DEFAULT_SINCE_SEQ:=0}"
: "${ADJUTORIX_TX_LOGS_LIMIT:=500}"
: "${ADJUTORIX_TX_LOGS_MAX_EXPORT_ROWS:=50000}"
: "${ADJUTORIX_TX_LOGS_VIEW:=auto}"
: "${ADJUTORIX_TX_LOGS_REDACT:=true}"
: "${ADJUTORIX_TX_LOGS_LEVEL_FILTER:=}"
: "${ADJUTORIX_TX_LOGS_GREP_FILTER:=}"
: "${ADJUTORIX_TX_LOGS_SOURCE:=rpc}"
: "${ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON:=}"
: "${ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON:=}"
: "${ADJUTORIX_TX_LOGS_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-logs}"
: "${ADJUTORIX_TX_LOGS_LOG_DIR:=${ADJUTORIX_TX_LOGS_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_LOGS_REPORT_DIR:=${ADJUTORIX_TX_LOGS_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_LOGS_EXPORT_DIR:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/exports}"
: "${ADJUTORIX_TX_LOGS_BOOT_LOG:=${ADJUTORIX_TX_LOGS_LOG_DIR}/logs.log}"
: "${ADJUTORIX_TX_LOGS_SUMMARY_FILE:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/logs-summary.txt}"
: "${ADJUTORIX_TX_LOGS_PHASE_FILE:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/logs-phases.tsv}"
: "${ADJUTORIX_TX_LOGS_REQUEST_JSON:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/request.json}"
: "${ADJUTORIX_TX_LOGS_RESPONSE_JSON:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/response.json}"
: "${ADJUTORIX_TX_LOGS_RENDERED_TXT:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/rendered.txt}"
: "${ADJUTORIX_TX_LOGS_NORMALIZED_JSON:=${ADJUTORIX_TX_LOGS_REPORT_DIR}/normalized.json}"
: "${ADJUTORIX_TX_LOGS_EXPORT_JSON:=${ADJUTORIX_TX_LOGS_EXPORT_DIR}/logs-export.json}"

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
STATUS_ID_KIND="auto"
JOB_ID=""
REQUEST_ID=""
TRANSACTION_ID=""
TOKEN_VALUE=""
HEALTH_URL="${ADJUTORIX_TX_LOGS_AGENT_URL}${ADJUTORIX_TX_LOGS_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_LOGS_AGENT_URL}${ADJUTORIX_TX_LOGS_RPC_PATH}"
METHOD_USED="$ADJUTORIX_TX_LOGS_DEFAULT_METHOD"
SINCE_SEQ="$ADJUTORIX_TX_LOGS_DEFAULT_SINCE_SEQ"
LAST_SEQ="$ADJUTORIX_TX_LOGS_DEFAULT_SINCE_SEQ"
RESOLVED_FROM_ARTIFACT="no"
RAW_ROW_COUNT="0"
FILTERED_ROW_COUNT="0"
RENDERED_LINE_COUNT="0"
TERMINAL="no"
FINAL_STATE="unknown"
EXPORT_WRITTEN="no"
FOLLOW_ACTIVE="no"
SOURCE_KIND="rpc"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_LOGS_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_LOGS_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_LOGS_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/logs.sh --job-id <id> [options]
  scripts/transaction/logs.sh --submission <submission-json> [options]
  scripts/transaction/logs.sh --status-artifact <status-json> [options]

Identity options:
  --job-id <id>                 Explicit job identifier
  --transaction-id <id>         Explicit transaction identifier
  --request-id <id>             Explicit request identifier
  --submission <path>           Prior submission artifact to resolve identifiers
  --status-artifact <path>      Prior status artifact to resolve identifiers

Filtering/output options:
  --since-seq <n>               Start log retrieval from sequence number
  --limit <n>                   Maximum rows to request/render per fetch
  --view <mode>                 auto | raw | structured
  --level <name>                Filter normalized rows by level
  --grep <pattern>              Filter rendered rows by grep -E pattern
  --wait                        Wait for more rows once if none are returned
  --follow                      Poll until terminal state or timeout
  --export                      Write normalized/export JSON artifact
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-log health probe
  --no-redact                   Disable rendered-output redaction
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  local export_requested=false
  while (($# > 0)); do
    case "$1" in
      --job-id)
        shift
        [[ $# -gt 0 ]] || die "--job-id requires a value"
        JOB_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="job"
        ;;
      --transaction-id)
        shift
        [[ $# -gt 0 ]] || die "--transaction-id requires a value"
        TRANSACTION_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="transaction"
        ;;
      --request-id)
        shift
        [[ $# -gt 0 ]] || die "--request-id requires a value"
        REQUEST_ID="$1"
        STATUS_ID="$1"
        STATUS_ID_KIND="request"
        ;;
      --submission)
        shift
        [[ $# -gt 0 ]] || die "--submission requires a value"
        ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON="$1"
        ;;
      --status-artifact)
        shift
        [[ $# -gt 0 ]] || die "--status-artifact requires a value"
        ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON="$1"
        ;;
      --since-seq)
        shift
        [[ $# -gt 0 ]] || die "--since-seq requires a value"
        SINCE_SEQ="$1"
        ;;
      --limit)
        shift
        [[ $# -gt 0 ]] || die "--limit requires a value"
        ADJUTORIX_TX_LOGS_LIMIT="$1"
        ;;
      --view)
        shift
        [[ $# -gt 0 ]] || die "--view requires a value"
        ADJUTORIX_TX_LOGS_VIEW="$1"
        ;;
      --level)
        shift
        [[ $# -gt 0 ]] || die "--level requires a value"
        ADJUTORIX_TX_LOGS_LEVEL_FILTER="$1"
        ;;
      --grep)
        shift
        [[ $# -gt 0 ]] || die "--grep requires a value"
        ADJUTORIX_TX_LOGS_GREP_FILTER="$1"
        ;;
      --wait)
        ADJUTORIX_TX_LOGS_WAIT_FOR_MORE=true
        ;;
      --follow)
        ADJUTORIX_TX_LOGS_FOLLOW=true
        ;;
      --export)
        export_requested=true
        ;;
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_LOGS_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_LOGS_AGENT_URL}${ADJUTORIX_TX_LOGS_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_LOGS_AGENT_URL}${ADJUTORIX_TX_LOGS_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_LOGS_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_LOGS_VERIFY_AGENT_HEALTH=false
        ;;
      --no-redact)
        ADJUTORIX_TX_LOGS_REDACT=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_LOGS_USE_COLOR=false
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

  if [[ "$export_requested" == true ]]; then
    ADJUTORIX_TX_LOGS_EXPORT_JSON="$ADJUTORIX_TX_LOGS_EXPORT_JSON"
  fi

  local explicit_count=0
  [[ -n "$JOB_ID" ]] && explicit_count=$((explicit_count + 1))
  [[ -n "$TRANSACTION_ID" ]] && explicit_count=$((explicit_count + 1))
  [[ -n "$REQUEST_ID" ]] && explicit_count=$((explicit_count + 1))
  [[ -n "$ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON" ]] && explicit_count=$((explicit_count + 1))
  [[ -n "$ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON" ]] && explicit_count=$((explicit_count + 1))

  if (( explicit_count == 0 )); then
    die "A transaction identity source is required"
  fi
  if (( explicit_count > 1 )); then
    die "Provide exactly one identity source"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_LOGS_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_LOGS_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

redact_stream() {
  python3 - <<'PY'
import re, sys
patterns = [
    (re.compile(r'sk-[A-Za-z0-9]{20,}'), 'sk-****REDACTED****'),
    (re.compile(r'github_pat_[A-Za-z0-9_]{20,}'), 'github_pat_****REDACTED****'),
    (re.compile(r'AKIA[0-9A-Z]{16}'), 'AKIA****REDACTED****'),
    (re.compile(r'(?i)bearer\s+[A-Za-z0-9._\-]+'), 'Bearer ****REDACTED****'),
    (re.compile(r'(?i)(password|passphrase)\s*[:=]\s*\S+'), r'\1=****REDACTED****'),
]
for line in sys.stdin:
    for rx, repl in patterns:
        line = rx.sub(repl, line)
    sys.stdout.write(line)
PY
}

fetch_status_state() {
  local job_id="$1"
  local token="$2"
  local tmp_json
  tmp_json="${ADJUTORIX_TX_LOGS_REPORT_DIR}/_status_probe.json"
  curl -fsS \
    --max-time "$ADJUTORIX_TX_LOGS_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${token:+-H "x-adjutorix-token: ${token}"} \
    -d "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"${ADJUTORIX_TX_LOGS_STATUS_METHOD}\",\"params\":{\"job_id\":\"${job_id}\"}}" \
    "$RPC_URL" > "$tmp_json"
  read -r FINAL_STATE TERMINAL < <(python3 - <<'PY' "$tmp_json"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
result = data.get('result', {})
state = result.get('state', result.get('status', 'unknown'))
terminal = 'yes' if state in {'succeeded', 'completed', 'failed', 'rejected', 'cancelled'} else 'no'
print(state, terminal)
PY
)
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_LOGS_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_LOGS_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_LOGS_EXPORT_DIR"
  : >"$ADJUTORIX_TX_LOGS_BOOT_LOG"
  : >"$ADJUTORIX_TX_LOGS_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_LOGS_PHASE_FILE"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command curl
  require_command grep
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_identity() {
  if [[ -n "$ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON" ]]; then
    [[ -f "$ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON" ]] || die "Submission artifact not found"
    read -r JOB_ID TRANSACTION_ID REQUEST_ID < <(python3 - <<'PY' "$ADJUTORIX_TX_LOGS_LOCAL_SUBMISSION_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
params = data.get('params', {})
print(params.get('job_id', ''), params.get('transaction_id', ''), params.get('request_id', ''))
PY
)
    RESOLVED_FROM_ARTIFACT="yes"
  elif [[ -n "$ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON" ]]; then
    [[ -f "$ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON" ]] || die "Status artifact not found"
    read -r JOB_ID TRANSACTION_ID REQUEST_ID < <(python3 - <<'PY' "$ADJUTORIX_TX_LOGS_LOCAL_STATUS_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('status_id', ''), data.get('transaction_id', ''), data.get('request_id', ''))
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
  elif [[ -n "$REQUEST_ID" ]]; then
    STATUS_ID="$REQUEST_ID"
    STATUS_ID_KIND="request"
  fi

  [[ "$STATUS_ID_KIND" == "job" ]] || die "Transaction logs currently require a resolvable job identifier"
  [[ -n "$STATUS_ID" ]] || die "Unable to resolve job identifier for logs"
}

phase_resolve_token_and_health() {
  if [[ -f "$ADJUTORIX_TX_LOGS_TOKEN_FILE" && -s "$ADJUTORIX_TX_LOGS_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_LOGS_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_LOGS_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_LOGS_TOKEN_FILE"
  fi
  if [[ "$ADJUTORIX_TX_LOGS_VERIFY_AGENT_HEALTH" == "true" ]]; then
    curl -fsS --max-time "$ADJUTORIX_TX_LOGS_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
  fi
}

phase_fetch_logs_once() {
  python3 - <<'PY' \
    "$ADJUTORIX_TX_LOGS_REQUEST_JSON" \
    "$METHOD_USED" \
    "$STATUS_ID" \
    "$SINCE_SEQ" \
    "$ADJUTORIX_TX_LOGS_LIMIT"
import json, sys
payload = {
    'jsonrpc': '2.0',
    'id': 1,
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
    --max-time "$ADJUTORIX_TX_LOGS_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_LOGS_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_LOGS_RESPONSE_JSON"
}

phase_normalize_logs() {
  python3 - <<'PY' \
    "$ADJUTORIX_TX_LOGS_RESPONSE_JSON" \
    "$ADJUTORIX_TX_LOGS_NORMALIZED_JSON" \
    "$ADJUTORIX_TX_LOGS_LEVEL_FILTER" \
    "$ADJUTORIX_TX_LOGS_LIMIT"
import json, sys
from pathlib import Path

response_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
level_filter = sys.argv[3]
limit = int(sys.argv[4])

with response_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
if 'error' in data:
    raise SystemExit(json.dumps(data['error']))
result = data.get('result', {})
rows = result.get('rows', result.get('logs', result.get('events', [])))
if not isinstance(rows, list):
    rows = []
normalized = []
last_seq = 0
for row in rows:
    if isinstance(row, dict):
        seq = row.get('seq', row.get('sequence', 0))
        level = str(row.get('level', row.get('severity', 'info')))
        ts = str(row.get('timestamp', row.get('time', '')))
        msg = str(row.get('message', row.get('msg', '')))
        code = str(row.get('code', ''))
    else:
        seq = 0
        level = 'info'
        ts = ''
        msg = str(row)
        code = ''
    if level_filter and level.lower() != level_filter.lower():
        continue
    normalized.append({
        'seq': seq,
        'timestamp': ts,
        'level': level,
        'code': code,
        'message': msg,
    })
    try:
        last_seq = max(last_seq, int(seq))
    except Exception:
        pass
normalized = normalized[:limit]
payload = {
    'row_count': len(rows),
    'filtered_count': len(normalized),
    'last_seq': last_seq,
    'rows': normalized,
}
out_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY

  read -r RAW_ROW_COUNT FILTERED_ROW_COUNT LAST_SEQ < <(python3 - <<'PY' "$ADJUTORIX_TX_LOGS_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(data.get('row_count', 0), data.get('filtered_count', 0), data.get('last_seq', 0))
PY
)
}

phase_render_logs() {
  python3 - <<'PY' \
    "$ADJUTORIX_TX_LOGS_NORMALIZED_JSON" \
    "$ADJUTORIX_TX_LOGS_RENDERED_TXT" \
    "$ADJUTORIX_TX_LOGS_VIEW" \
    "$ADJUTORIX_TX_LOGS_GREP_FILTER"
import json, re, sys
from pathlib import Path

src = Path(sys.argv[1])
out = Path(sys.argv[2])
view = sys.argv[3]
grep_filter = sys.argv[4]
pattern = re.compile(grep_filter) if grep_filter else None
with src.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
lines = []
for row in data.get('rows', []):
    rendered = json.dumps(row) if view == 'raw' else f"[{row.get('seq')}] [{row.get('timestamp')}] [{row.get('level')}] {row.get('message')}"
    if pattern and not pattern.search(rendered):
        continue
    lines.append(rendered)
out.write_text('\n'.join(lines) + ('\n' if lines else ''), encoding='utf-8')
print(len(lines))
PY
  RENDERED_LINE_COUNT="$(wc -l < "$ADJUTORIX_TX_LOGS_RENDERED_TXT" | tr -d ' ')"
  if [[ "$ADJUTORIX_TX_LOGS_REDACT" == "true" ]]; then
    local tmp_redacted="${ADJUTORIX_TX_LOGS_RENDERED_TXT}.redacted"
    redact_stream < "$ADJUTORIX_TX_LOGS_RENDERED_TXT" > "$tmp_redacted"
    mv "$tmp_redacted" "$ADJUTORIX_TX_LOGS_RENDERED_TXT"
  fi
  if [[ "$QUIET" != "true" ]]; then
    cat "$ADJUTORIX_TX_LOGS_RENDERED_TXT"
  fi
}

phase_export_if_requested() {
  if [[ ! -d "$ADJUTORIX_TX_LOGS_EXPORT_DIR" ]]; then
    return 0
  fi
  if (( FILTERED_ROW_COUNT > ADJUTORIX_TX_LOGS_MAX_EXPORT_ROWS )); then
    die "Filtered row count exceeds export ceiling"
  fi
  python3 - <<'PY' \
    "$ADJUTORIX_TX_LOGS_NORMALIZED_JSON" \
    "$ADJUTORIX_TX_LOGS_EXPORT_JSON" \
    "$STATUS_ID" \
    "$SINCE_SEQ" \
    "$METHOD_USED"
import json, sys
from pathlib import Path
src = Path(sys.argv[1])
out = Path(sys.argv[2])
with src.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
payload = {
    'status_id': sys.argv[3],
    'since_seq': sys.argv[4],
    'method_used': sys.argv[5],
    **data,
}
out.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY
  EXPORT_WRITTEN="yes"
}

phase_follow_if_requested() {
  if [[ "$ADJUTORIX_TX_LOGS_FOLLOW" != "true" ]]; then
    return 0
  fi
  FOLLOW_ACTIVE="yes"
  local started now elapsed prev_seq
  started="$(date +%s)"
  prev_seq="$LAST_SEQ"
  while true; do
    SINCE_SEQ="$prev_seq"
    phase_fetch_logs_once
    phase_normalize_logs
    phase_render_logs
    prev_seq="$LAST_SEQ"
    fetch_status_state "$STATUS_ID" "$TOKEN_VALUE"
    if [[ "$TERMINAL" == "yes" ]]; then
      return 0
    fi
    now="$(date +%s)"
    elapsed=$((now - started))
    if (( elapsed >= ADJUTORIX_TX_LOGS_FOLLOW_TIMEOUT_SECONDS )); then
      return 0
    fi
    sleep "$ADJUTORIX_TX_LOGS_FOLLOW_POLL_INTERVAL_SECONDS"
  done
}

phase_wait_for_more_if_requested() {
  if [[ "$ADJUTORIX_TX_LOGS_WAIT_FOR_MORE" != "true" ]]; then
    return 0
  fi
  if (( FILTERED_ROW_COUNT > 0 )); then
    return 0
  fi
  sleep "$ADJUTORIX_TX_LOGS_FOLLOW_POLL_INTERVAL_SECONDS"
  phase_fetch_logs_once
  phase_normalize_logs
  phase_render_logs
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction logs summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_LOGS_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "status_id: ${STATUS_ID}"
    echo "status_id_kind: ${STATUS_ID_KIND}"
    echo "resolved_from_artifact: ${RESOLVED_FROM_ARTIFACT}"
    echo "method_used: ${METHOD_USED}"
    echo "since_seq: ${SINCE_SEQ}"
    echo "last_seq: ${LAST_SEQ}"
    echo "raw_row_count: ${RAW_ROW_COUNT}"
    echo "filtered_row_count: ${FILTERED_ROW_COUNT}"
    echo "rendered_line_count: ${RENDERED_LINE_COUNT}"
    echo "final_state: ${FINAL_STATE}"
    echo "terminal: ${TERMINAL}"
    echo "follow_active: ${FOLLOW_ACTIVE}"
    echo "export_written: ${EXPORT_WRITTEN}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_LOGS_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_LOGS_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_LOGS_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_TX_LOGS_REQUEST_JSON}"
    echo "  - response: ${ADJUTORIX_TX_LOGS_RESPONSE_JSON}"
    echo "  - normalized: ${ADJUTORIX_TX_LOGS_NORMALIZED_JSON}"
    echo "  - rendered: ${ADJUTORIX_TX_LOGS_RENDERED_TXT}"
    if [[ "$EXPORT_WRITTEN" == "yes" ]]; then
      echo "  - export: ${ADJUTORIX_TX_LOGS_EXPORT_JSON}"
    fi
  } >"$ADJUTORIX_TX_LOGS_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction logs"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL} source=${SOURCE_KIND}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_identity phase_resolve_identity
  run_phase resolve_token_and_health phase_resolve_token_and_health
  run_phase fetch_logs_once phase_fetch_logs_once
  run_phase normalize_logs phase_normalize_logs
  run_phase render_logs phase_render_logs
  run_phase wait_for_more_if_requested phase_wait_for_more_if_requested
  run_phase export_if_requested phase_export_if_requested

  if [[ "$ADJUTORIX_TX_LOGS_FOLLOW" == "true" ]]; then
    run_phase follow_if_requested phase_follow_if_requested
  fi

  write_summary

  section "Transaction logs complete"
  log_info "summary=${ADJUTORIX_TX_LOGS_SUMMARY_FILE}"
  log_info "rendered=${ADJUTORIX_TX_LOGS_RENDERED_TXT} rows=${FILTERED_ROW_COUNT}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Transaction logs failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
