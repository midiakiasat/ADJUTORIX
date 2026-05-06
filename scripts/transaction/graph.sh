#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX TRANSACTION GRAPH ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for rendering and exporting
#   governed transaction/job topology views from the ADJUTORIX runtime
# - resolve transaction identity from explicit IDs or prior artifacts, retrieve
#   canonical ledger/edge/state data over RPC, normalize nodes and transitions,
#   classify topology properties, and emit reproducible graph artifacts in JSON,
#   DOT, Mermaid, and TSV forms
# - ensure "transaction graph" means one coherent observed execution topology
#   rather than an ad hoc visualization assembled from partial logs or guesses
#
# Scope
# - read-only inspection and local graph artifact generation only
# - no mutation of runtime state or workspace contents
# - mutation limited to repo-local reports and exported graph artifacts
#
# Design constraints
# - no silent fallback across incompatible identifier kinds
# - no graph emission without explicit edge evidence or a declared empty graph
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

: "${ADJUTORIX_TX_GRAPH_STACK_NAME:=adjutorix-transaction-graph}"
: "${ADJUTORIX_TX_GRAPH_USE_COLOR:=true}"
: "${ADJUTORIX_TX_GRAPH_FAIL_FAST:=true}"
: "${ADJUTORIX_TX_GRAPH_AGENT_URL:=http://127.0.0.1:8000}"
: "${ADJUTORIX_TX_GRAPH_RPC_PATH:=/rpc}"
: "${ADJUTORIX_TX_GRAPH_HEALTH_PATH:=/health}"
: "${ADJUTORIX_TX_GRAPH_HTTP_TIMEOUT_SECONDS:=20}"
: "${ADJUTORIX_TX_GRAPH_VERIFY_AGENT_HEALTH:=true}"
: "${ADJUTORIX_TX_GRAPH_REQUIRE_TOKEN:=true}"
: "${ADJUTORIX_TX_GRAPH_TOKEN_FILE:=${HOME}/.adjutorix/token}"
: "${ADJUTORIX_TX_GRAPH_DEFAULT_GRAPH_METHOD:=transaction.graph}"
: "${ADJUTORIX_TX_GRAPH_FALLBACK_STATUS_METHOD:=job.status}"
: "${ADJUTORIX_TX_GRAPH_ASSUME_ID_KIND:=auto}"
: "${ADJUTORIX_TX_GRAPH_INCLUDE_RESULT_BODY:=true}"
: "${ADJUTORIX_TX_GRAPH_EXPORT_JSON:=true}"
: "${ADJUTORIX_TX_GRAPH_EXPORT_DOT:=true}"
: "${ADJUTORIX_TX_GRAPH_EXPORT_MERMAID:=true}"
: "${ADJUTORIX_TX_GRAPH_EXPORT_TSV:=true}"
: "${ADJUTORIX_TX_GRAPH_ROOT_TMP:=${REPO_ROOT}/.tmp/transaction-graph}"
: "${ADJUTORIX_TX_GRAPH_LOG_DIR:=${ADJUTORIX_TX_GRAPH_ROOT_TMP}/logs}"
: "${ADJUTORIX_TX_GRAPH_REPORT_DIR:=${ADJUTORIX_TX_GRAPH_ROOT_TMP}/reports}"
: "${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR:=${ADJUTORIX_TX_GRAPH_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_TX_GRAPH_BOOT_LOG:=${ADJUTORIX_TX_GRAPH_LOG_DIR}/graph.log}"
: "${ADJUTORIX_TX_GRAPH_SUMMARY_FILE:=${ADJUTORIX_TX_GRAPH_REPORT_DIR}/graph-summary.txt}"
: "${ADJUTORIX_TX_GRAPH_PHASE_FILE:=${ADJUTORIX_TX_GRAPH_REPORT_DIR}/graph-phases.tsv}"
: "${ADJUTORIX_TX_GRAPH_REQUEST_JSON:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/request.json}"
: "${ADJUTORIX_TX_GRAPH_RESPONSE_JSON:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/response.json}"
: "${ADJUTORIX_TX_GRAPH_NORMALIZED_JSON:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/normalized.json}"
: "${ADJUTORIX_TX_GRAPH_DOT_FILE:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/graph.dot}"
: "${ADJUTORIX_TX_GRAPH_MERMAID_FILE:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/graph.mmd}"
: "${ADJUTORIX_TX_GRAPH_NODES_TSV:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/nodes.tsv}"
: "${ADJUTORIX_TX_GRAPH_EDGES_TSV:=${ADJUTORIX_TX_GRAPH_ARTIFACT_DIR}/edges.tsv}"

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
STATUS_ID_KIND="$ADJUTORIX_TX_GRAPH_ASSUME_ID_KIND"
JOB_ID=""
TRANSACTION_ID=""
REQUEST_ID=""
SUBMISSION_ARTIFACT=""
STATUS_ARTIFACT=""
TOKEN_VALUE=""
HEALTH_URL="${ADJUTORIX_TX_GRAPH_AGENT_URL}${ADJUTORIX_TX_GRAPH_HEALTH_PATH}"
RPC_URL="${ADJUTORIX_TX_GRAPH_AGENT_URL}${ADJUTORIX_TX_GRAPH_RPC_PATH}"
REQUEST_ID_LOCAL=""
METHOD_USED="$ADJUTORIX_TX_GRAPH_DEFAULT_GRAPH_METHOD"
REQUEST_PARAM_KEY=""
RESOLVED_FROM_ARTIFACT="no"
NODE_COUNT="0"
EDGE_COUNT="0"
ROOT_NODE_COUNT="0"
LEAF_NODE_COUNT="0"
TERMINAL_NODE_COUNT="0"
CYCLE_SUSPECTED="no"
HAS_TERMINAL_PATH="no"
GRAPH_EMPTY="yes"
STATE_REASON=""
FALLBACK_USED="no"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_TX_GRAPH_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_TX_GRAPH_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_TX_GRAPH_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/transaction/graph.sh --job-id <id> [options]
  scripts/transaction/graph.sh --transaction-id <id> [options]
  scripts/transaction/graph.sh --request-id <id> [options]
  scripts/transaction/graph.sh --submission <submission-json> [options]
  scripts/transaction/graph.sh --status-artifact <status-json> [options]

Identity options:
  --job-id <id>                 Explicit job identifier
  --transaction-id <id>         Explicit transaction identifier
  --request-id <id>             Explicit request identifier
  --submission <path>           Prior submission artifact to resolve identifiers
  --status-artifact <path>      Prior status artifact to resolve identifiers

Graph options:
  --agent-url <url>             Override agent base URL
  --token-file <path>           Override token file path
  --no-health-check             Skip pre-graph health probe
  --no-dot                      Skip DOT export
  --no-mermaid                  Skip Mermaid export
  --no-tsv                      Skip TSV export
  --no-json                     Skip normalized JSON export
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
      --agent-url)
        shift
        [[ $# -gt 0 ]] || die "--agent-url requires a value"
        ADJUTORIX_TX_GRAPH_AGENT_URL="$1"
        HEALTH_URL="${ADJUTORIX_TX_GRAPH_AGENT_URL}${ADJUTORIX_TX_GRAPH_HEALTH_PATH}"
        RPC_URL="${ADJUTORIX_TX_GRAPH_AGENT_URL}${ADJUTORIX_TX_GRAPH_RPC_PATH}"
        ;;
      --token-file)
        shift
        [[ $# -gt 0 ]] || die "--token-file requires a value"
        ADJUTORIX_TX_GRAPH_TOKEN_FILE="$1"
        ;;
      --no-health-check)
        ADJUTORIX_TX_GRAPH_VERIFY_AGENT_HEALTH=false
        ;;
      --no-dot)
        ADJUTORIX_TX_GRAPH_EXPORT_DOT=false
        ;;
      --no-mermaid)
        ADJUTORIX_TX_GRAPH_EXPORT_MERMAID=false
        ;;
      --no-tsv)
        ADJUTORIX_TX_GRAPH_EXPORT_TSV=false
        ;;
      --no-json)
        ADJUTORIX_TX_GRAPH_EXPORT_JSON=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_TX_GRAPH_USE_COLOR=false
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
    die "Provide exactly one graph identity source"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_TX_GRAPH_PHASE_FILE"
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
    if [[ "$ADJUTORIX_TX_GRAPH_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_TX_GRAPH_LOG_DIR"
  ensure_dir "$ADJUTORIX_TX_GRAPH_REPORT_DIR"
  ensure_dir "$ADJUTORIX_TX_GRAPH_ARTIFACT_DIR"
  : >"$ADJUTORIX_TX_GRAPH_BOOT_LOG"
  : >"$ADJUTORIX_TX_GRAPH_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_TX_GRAPH_PHASE_FILE"
  printf 'node_id\tlabel\tstate\tterminal\n' >"$ADJUTORIX_TX_GRAPH_NODES_TSV"
  printf 'from_id\tto_id\tedge_kind\tlabel\n' >"$ADJUTORIX_TX_GRAPH_EDGES_TSV"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command curl
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_identity() {
  if [[ -n "$SUBMISSION_ARTIFACT" ]]; then
    [[ -f "$SUBMISSION_ARTIFACT" ]] || die "Submission artifact not found: $SUBMISSION_ARTIFACT"
    read -r JOB_ID TRANSACTION_ID REQUEST_ID < <(python3 - <<'PY' "$SUBMISSION_ARTIFACT"
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
    read -r STATUS_ID STATUS_ID_KIND REQUEST_ID < <(python3 - <<'PY' "$STATUS_ARTIFACT"
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

  [[ -n "$STATUS_ID" ]] || die "Unable to resolve graph target id"
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

  REQUEST_ID_LOCAL="$(printf '%s|%s|graph' "$STATUS_ID" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_resolve_token_and_health() {
  if [[ -f "$ADJUTORIX_TX_GRAPH_TOKEN_FILE" && -s "$ADJUTORIX_TX_GRAPH_TOKEN_FILE" ]]; then
    TOKEN_VALUE="$(tr -d '\n' < "$ADJUTORIX_TX_GRAPH_TOKEN_FILE")"
  fi
  if [[ "$ADJUTORIX_TX_GRAPH_REQUIRE_TOKEN" == "true" && -z "$TOKEN_VALUE" ]]; then
    die "Token file missing or empty: $ADJUTORIX_TX_GRAPH_TOKEN_FILE"
  fi
  if [[ "$ADJUTORIX_TX_GRAPH_VERIFY_AGENT_HEALTH" == "true" ]]; then
    curl -fsS --max-time "$ADJUTORIX_TX_GRAPH_HTTP_TIMEOUT_SECONDS" "$HEALTH_URL" >/dev/null
  fi
}

phase_fetch_graph() {
  python3 - <<'PY' \
    "$ADJUTORIX_TX_GRAPH_REQUEST_JSON" \
    "$METHOD_USED" \
    "$REQUEST_PARAM_KEY" \
    "$STATUS_ID" \
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
    --max-time "$ADJUTORIX_TX_GRAPH_HTTP_TIMEOUT_SECONDS" \
    -H 'Content-Type: application/json' \
    ${TOKEN_VALUE:+-H "x-adjutorix-token: ${TOKEN_VALUE}"} \
    -d @"$ADJUTORIX_TX_GRAPH_REQUEST_JSON" \
    "$RPC_URL" > "$ADJUTORIX_TX_GRAPH_RESPONSE_JSON"
}

phase_normalize_graph() {
  python3 - <<'PY' \
    "$ADJUTORIX_TX_GRAPH_RESPONSE_JSON" \
    "$ADJUTORIX_TX_GRAPH_NORMALIZED_JSON" \
    "$ADJUTORIX_TX_GRAPH_NODES_TSV" \
    "$ADJUTORIX_TX_GRAPH_EDGES_TSV" \
    "$ADJUTORIX_TX_GRAPH_DOT_FILE" \
    "$ADJUTORIX_TX_GRAPH_MERMAID_FILE" \
    "$ADJUTORIX_TX_GRAPH_EXPORT_DOT" \
    "$ADJUTORIX_TX_GRAPH_EXPORT_MERMAID"
import csv
import json
import sys
from collections import defaultdict, deque
from pathlib import Path

response_path = Path(sys.argv[1])
out_path = Path(sys.argv[2])
nodes_tsv = Path(sys.argv[3])
edges_tsv = Path(sys.argv[4])
dot_file = Path(sys.argv[5])
mermaid_file = Path(sys.argv[6])
export_dot = sys.argv[7].lower() == 'true'
export_mermaid = sys.argv[8].lower() == 'true'

with response_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
if 'error' in data:
    raise SystemExit(json.dumps(data['error']))
result = data.get('result', {})

nodes = result.get('nodes', result.get('states', []))
edges = result.get('edges', result.get('transitions', []))
if not isinstance(nodes, list):
    nodes = []
if not isinstance(edges, list):
    edges = []

normalized_nodes = []
normalized_edges = []
node_ids = set()
in_deg = defaultdict(int)
out_deg = defaultdict(int)
terminal_nodes = set()

for idx, row in enumerate(nodes):
    if isinstance(row, dict):
        node_id = str(row.get('id', row.get('node_id', f'n{idx}')))
        label = str(row.get('label', row.get('state', node_id)))
        state = str(row.get('state', row.get('status', label)))
        terminal = bool(row.get('terminal', state in {'succeeded', 'completed', 'failed', 'rejected', 'cancelled'}))
    else:
        node_id = f'n{idx}'
        label = str(row)
        state = str(row)
        terminal = False
    normalized_nodes.append({'id': node_id, 'label': label, 'state': state, 'terminal': terminal})
    node_ids.add(node_id)
    if terminal:
      terminal_nodes.add(node_id)

for idx, row in enumerate(edges):
    if isinstance(row, dict):
        src = str(row.get('from', row.get('source', row.get('src', ''))))
        dst = str(row.get('to', row.get('target', row.get('dst', ''))))
        edge_kind = str(row.get('kind', row.get('type', 'transition')))
        label = str(row.get('label', edge_kind))
    else:
        continue
    if not src or not dst:
        continue
    normalized_edges.append({'from': src, 'to': dst, 'kind': edge_kind, 'label': label})
    out_deg[src] += 1
    in_deg[dst] += 1
    node_ids.add(src)
    node_ids.add(dst)

for node_id in sorted(node_ids):
    if not any(n['id'] == node_id for n in normalized_nodes):
        normalized_nodes.append({'id': node_id, 'label': node_id, 'state': 'unknown', 'terminal': False})

roots = [n['id'] for n in normalized_nodes if in_deg[n['id']] == 0]
leaves = [n['id'] for n in normalized_nodes if out_deg[n['id']] == 0]

adj = defaultdict(list)
for e in normalized_edges:
    adj[e['from']].append(e['to'])

cycle_suspected = False
color = {}

def dfs(v):
    global cycle_suspected
    color[v] = 1
    for nxt in adj[v]:
        if color.get(nxt) == 1:
            return True
        if color.get(nxt, 0) == 0 and dfs(nxt):
            return True
    color[v] = 2
    return False

for node in node_ids:
    if color.get(node, 0) == 0 and dfs(node):
        cycle_suspected = True
        break

has_terminal_path = False
if roots and terminal_nodes:
    seen = set(roots)
    q = deque(roots)
    while q:
        cur = q.popleft()
        if cur in terminal_nodes:
            has_terminal_path = True
            break
        for nxt in adj[cur]:
            if nxt not in seen:
                seen.add(nxt)
                q.append(nxt)

with nodes_tsv.open('a', encoding='utf-8', newline='') as fh:
    w = csv.writer(fh, delimiter='\t')
    for n in normalized_nodes:
        w.writerow([n['id'], n['label'], n['state'], 'yes' if n['terminal'] else 'no'])
with edges_tsv.open('a', encoding='utf-8', newline='') as fh:
    w = csv.writer(fh, delimiter='\t')
    for e in normalized_edges:
        w.writerow([e['from'], e['to'], e['kind'], e['label']])

if export_dot:
    dot_lines = ['digraph transaction_graph {']
    for n in normalized_nodes:
        attrs = [f'label="{n["label"].replace(chr(34), chr(39))}"']
        if n['terminal']:
            attrs.append('shape=doublecircle')
        dot_lines.append(f'  "{n["id"]}" [{", ".join(attrs)}];')
    for e in normalized_edges:
        dot_lines.append(f'  "{e["from"]}" -> "{e["to"]}" [label="{e["label"].replace(chr(34), chr(39))}"];')
    dot_lines.append('}')
    dot_file.write_text('\n'.join(dot_lines) + '\n', encoding='utf-8')

if export_mermaid:
    lines = ['flowchart TD']
    for n in normalized_nodes:
        label = n['label'].replace('"', "'")
        if n['terminal']:
            lines.append(f'  {n["id"]}(("{label}"))')
        else:
            lines.append(f'  {n["id"]}["{label}"]')
    for e in normalized_edges:
        lbl = e['label'].replace('"', "'")
        lines.append(f'  {e["from"]} -->|"{lbl}"| {e["to"]}')
    mermaid_file.write_text('\n'.join(lines) + '\n', encoding='utf-8')

payload = {
    'node_count': len(normalized_nodes),
    'edge_count': len(normalized_edges),
    'root_node_count': len(roots),
    'leaf_node_count': len(leaves),
    'terminal_node_count': len(terminal_nodes),
    'cycle_suspected': cycle_suspected,
    'has_terminal_path': has_terminal_path,
    'graph_empty': len(normalized_nodes) == 0 and len(normalized_edges) == 0,
    'nodes': normalized_nodes,
    'edges': normalized_edges,
}
out_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY

  read -r NODE_COUNT EDGE_COUNT ROOT_NODE_COUNT LEAF_NODE_COUNT TERMINAL_NODE_COUNT CYCLE_SUSPECTED HAS_TERMINAL_PATH GRAPH_EMPTY < <(python3 - <<'PY' "$ADJUTORIX_TX_GRAPH_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(
    data.get('node_count', 0),
    data.get('edge_count', 0),
    data.get('root_node_count', 0),
    data.get('leaf_node_count', 0),
    data.get('terminal_node_count', 0),
    'yes' if data.get('cycle_suspected') else 'no',
    'yes' if data.get('has_terminal_path') else 'no',
    'yes' if data.get('graph_empty') else 'no',
)
PY
)
}

phase_validate_exports() {
  if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_JSON" == "true" ]]; then
    [[ -f "$ADJUTORIX_TX_GRAPH_NORMALIZED_JSON" ]] || die "Normalized graph JSON missing"
  fi
  if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_DOT" == "true" ]]; then
    [[ -f "$ADJUTORIX_TX_GRAPH_DOT_FILE" ]] || die "DOT export missing"
  fi
  if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_MERMAID" == "true" ]]; then
    [[ -f "$ADJUTORIX_TX_GRAPH_MERMAID_FILE" ]] || die "Mermaid export missing"
  fi
  if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_TSV" == "true" ]]; then
    [[ -f "$ADJUTORIX_TX_GRAPH_NODES_TSV" ]] || die "Nodes TSV missing"
    [[ -f "$ADJUTORIX_TX_GRAPH_EDGES_TSV" ]] || die "Edges TSV missing"
  fi
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX transaction graph summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "agent_url: ${ADJUTORIX_TX_GRAPH_AGENT_URL}"
    echo "rpc_url: ${RPC_URL}"
    echo "health_url: ${HEALTH_URL}"
    echo "status_id: ${STATUS_ID}"
    echo "status_id_kind: ${STATUS_ID_KIND}"
    echo "resolved_from_artifact: ${RESOLVED_FROM_ARTIFACT}"
    echo "request_id: ${REQUEST_ID_LOCAL}"
    echo "method_used: ${METHOD_USED}"
    echo "request_param_key: ${REQUEST_PARAM_KEY}"
    echo "node_count: ${NODE_COUNT}"
    echo "edge_count: ${EDGE_COUNT}"
    echo "root_node_count: ${ROOT_NODE_COUNT}"
    echo "leaf_node_count: ${LEAF_NODE_COUNT}"
    echo "terminal_node_count: ${TERMINAL_NODE_COUNT}"
    echo "cycle_suspected: ${CYCLE_SUSPECTED}"
    echo "has_terminal_path: ${HAS_TERMINAL_PATH}"
    echo "graph_empty: ${GRAPH_EMPTY}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_TX_GRAPH_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_TX_GRAPH_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_TX_GRAPH_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_TX_GRAPH_REQUEST_JSON}"
    echo "  - response: ${ADJUTORIX_TX_GRAPH_RESPONSE_JSON}"
    if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_JSON" == "true" ]]; then
      echo "  - normalized: ${ADJUTORIX_TX_GRAPH_NORMALIZED_JSON}"
    fi
    if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_DOT" == "true" ]]; then
      echo "  - dot: ${ADJUTORIX_TX_GRAPH_DOT_FILE}"
    fi
    if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_MERMAID" == "true" ]]; then
      echo "  - mermaid: ${ADJUTORIX_TX_GRAPH_MERMAID_FILE}"
    fi
    if [[ "$ADJUTORIX_TX_GRAPH_EXPORT_TSV" == "true" ]]; then
      echo "  - nodes_tsv: ${ADJUTORIX_TX_GRAPH_NODES_TSV}"
      echo "  - edges_tsv: ${ADJUTORIX_TX_GRAPH_EDGES_TSV}"
    fi
  } >"$ADJUTORIX_TX_GRAPH_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX transaction graph"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "rpc_url=${RPC_URL} method=${METHOD_USED}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_identity phase_resolve_identity
  run_phase resolve_token_and_health phase_resolve_token_and_health
  run_phase fetch_graph phase_fetch_graph
  run_phase normalize_graph phase_normalize_graph
  run_phase validate_exports phase_validate_exports

  write_summary

  section "Transaction graph complete"
  log_info "summary=${ADJUTORIX_TX_GRAPH_SUMMARY_FILE}"
  log_info "nodes=${NODE_COUNT} edges=${EDGE_COUNT} cycle_suspected=${CYCLE_SUSPECTED}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Transaction graph failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
