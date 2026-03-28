#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX PATCH PREVIEW ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for pre-apply patch preview and
#   governed impact assessment
# - canonicalize workspace and patch inputs, validate patch payload shape,
#   resolve file targets, estimate mutation impact, detect obvious conflicts and
#   policy-sensitive surfaces, and emit reproducible preview artifacts in text,
#   JSON, and TSV form
# - ensure "preview patch" means one explicit, inspectable preflight view of
#   what would change rather than an ad hoc diff rendering
#
# Scope
# - read-only inspection of patch payload and current workspace contents
# - no mutation of target workspace files
# - writes only repo-local report/export artifacts under .tmp
#
# Design constraints
# - no silent fallback from structured patch to guessed edit intent
# - no unverifiable claims about apply success; only bounded preview evidence
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

: "${ADJUTORIX_PATCH_PREVIEW_STACK_NAME:=adjutorix-patch-preview}"
: "${ADJUTORIX_PATCH_PREVIEW_USE_COLOR:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_FAIL_FAST:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_REQUIRE_WORKSPACE:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_INCLUDE_UNIFIED_DIFF:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_INCLUDE_POLICY_HINTS:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_INCLUDE_CONFLICT_HEURISTICS:=true}"
: "${ADJUTORIX_PATCH_PREVIEW_MAX_FILE_PREVIEW_BYTES:=262144}"
: "${ADJUTORIX_PATCH_PREVIEW_MAX_RENDERED_HUNKS:=200}"
: "${ADJUTORIX_PATCH_PREVIEW_MAX_TEXT_LINES_PER_FILE:=4000}"
: "${ADJUTORIX_PATCH_PREVIEW_ROOT_TMP:=${REPO_ROOT}/.tmp/patch-preview}"
: "${ADJUTORIX_PATCH_PREVIEW_LOG_DIR:=${ADJUTORIX_PATCH_PREVIEW_ROOT_TMP}/logs}"
: "${ADJUTORIX_PATCH_PREVIEW_REPORT_DIR:=${ADJUTORIX_PATCH_PREVIEW_ROOT_TMP}/reports}"
: "${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR:=${ADJUTORIX_PATCH_PREVIEW_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_PATCH_PREVIEW_BOOT_LOG:=${ADJUTORIX_PATCH_PREVIEW_LOG_DIR}/preview.log}"
: "${ADJUTORIX_PATCH_PREVIEW_SUMMARY_FILE:=${ADJUTORIX_PATCH_PREVIEW_REPORT_DIR}/preview-summary.txt}"
: "${ADJUTORIX_PATCH_PREVIEW_PHASE_FILE:=${ADJUTORIX_PATCH_PREVIEW_REPORT_DIR}/preview-phases.tsv}"
: "${ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/request.json}"
: "${ADJUTORIX_PATCH_PREVIEW_NORMALIZED_JSON:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/normalized.json}"
: "${ADJUTORIX_PATCH_PREVIEW_DIFF_FILE:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/preview.diff}"
: "${ADJUTORIX_PATCH_PREVIEW_FILES_TSV:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/files.tsv}"
: "${ADJUTORIX_PATCH_PREVIEW_HUNKS_TSV:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/hunks.tsv}"
: "${ADJUTORIX_PATCH_PREVIEW_POLICY_TSV:=${ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR}/policy.tsv}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()

WORKSPACE_PATH=""
WORKSPACE_CANONICAL=""
WORKSPACE_ID=""
PATCH_FILE=""
PATCH_JSON_INLINE=""
PATCH_SHA256=""
PATCH_ID=""
PATCH_KIND="unknown"
TARGET_FILE_COUNT="0"
CREATED_COUNT="0"
UPDATED_COUNT="0"
DELETED_COUNT="0"
RENAMED_COUNT="0"
HUNK_COUNT="0"
CONFLICT_SUSPECT_COUNT="0"
POLICY_HINT_COUNT="0"
BINARY_TARGET_COUNT="0"
RENDERED_DIFF_LINES="0"
TOTAL_INSERTIONS="0"
TOTAL_DELETIONS="0"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_PATCH_PREVIEW_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_PATCH_PREVIEW_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_PATCH_PREVIEW_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage:
  scripts/patch/preview.sh --workspace <path> --patch-file <path> [options]
  scripts/patch/preview.sh --workspace <path> --patch-json '<json>' [options]

Required:
  --workspace <path>            Target workspace root
  --patch-file <path>           Structured patch payload JSON
    or
  --patch-json '<json>'         Inline structured patch payload JSON

Options:
  --no-diff                     Skip unified diff rendering
  --no-policy                   Skip policy hint analysis
  --no-conflict-heuristics      Skip conflict suspicion heuristics
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --workspace)
        shift
        [[ $# -gt 0 ]] || die "--workspace requires a value"
        WORKSPACE_PATH="$1"
        ;;
      --patch-file)
        shift
        [[ $# -gt 0 ]] || die "--patch-file requires a value"
        PATCH_FILE="$1"
        ;;
      --patch-json)
        shift
        [[ $# -gt 0 ]] || die "--patch-json requires a value"
        PATCH_JSON_INLINE="$1"
        ;;
      --no-diff)
        ADJUTORIX_PATCH_PREVIEW_INCLUDE_UNIFIED_DIFF=false
        ;;
      --no-policy)
        ADJUTORIX_PATCH_PREVIEW_INCLUDE_POLICY_HINTS=false
        ;;
      --no-conflict-heuristics)
        ADJUTORIX_PATCH_PREVIEW_INCLUDE_CONFLICT_HEURISTICS=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_PATCH_PREVIEW_USE_COLOR=false
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

  [[ -n "$WORKSPACE_PATH" ]] || die "--workspace is required"
  if [[ -n "$PATCH_FILE" && -n "$PATCH_JSON_INLINE" ]]; then
    die "Provide either --patch-file or --patch-json, not both"
  fi
  if [[ -z "$PATCH_FILE" && -z "$PATCH_JSON_INLINE" ]]; then
    die "A patch payload is required"
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_PATCH_PREVIEW_PHASE_FILE"
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
    if [[ "$ADJUTORIX_PATCH_PREVIEW_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_PATCH_PREVIEW_LOG_DIR"
  ensure_dir "$ADJUTORIX_PATCH_PREVIEW_REPORT_DIR"
  ensure_dir "$ADJUTORIX_PATCH_PREVIEW_ARTIFACT_DIR"
  : >"$ADJUTORIX_PATCH_PREVIEW_BOOT_LOG"
  : >"$ADJUTORIX_PATCH_PREVIEW_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_PATCH_PREVIEW_PHASE_FILE"
  printf 'path\taction\texists_before\tbinary\tline_count_before\tline_count_after\tinsertions\tdeletions\n' >"$ADJUTORIX_PATCH_PREVIEW_FILES_TSV"
  printf 'path\thunk_index\tstart_before\tcount_before\tstart_after\tcount_after\tconflict_suspected\n' >"$ADJUTORIX_PATCH_PREVIEW_HUNKS_TSV"
  printf 'path\thint_code\tseverity\tdetail\n' >"$ADJUTORIX_PATCH_PREVIEW_POLICY_TSV"
}

phase_repo_and_toolchain() {
  require_command python
  require_command shasum
  require_command diff
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_resolve_workspace() {
  WORKSPACE_CANONICAL="$(python - <<'PY' "$WORKSPACE_PATH"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  [[ -d "$WORKSPACE_CANONICAL" ]] || die "Workspace path is not a directory: $WORKSPACE_CANONICAL"
  if [[ "$ADJUTORIX_PATCH_PREVIEW_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$WORKSPACE_CANONICAL" ]] || die "Workspace is not readable: $WORKSPACE_CANONICAL"
  fi
  WORKSPACE_ID="$(printf '%s' "$WORKSPACE_CANONICAL" | shasum -a 256 | awk '{print $1}')"
}

phase_resolve_patch_payload() {
  if [[ -n "$PATCH_FILE" ]]; then
    [[ -f "$PATCH_FILE" ]] || die "Patch file not found: $PATCH_FILE"
    python - <<'PY' "$PATCH_FILE" "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(data, fh, indent=2)
PY
  else
    python - <<'PY' "$PATCH_JSON_INLINE" "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON"
import json, sys
payload = json.loads(sys.argv[1])
with open(sys.argv[2], 'w', encoding='utf-8') as fh:
    json.dump(payload, fh, indent=2)
PY
  fi

  PATCH_SHA256="$(shasum -a 256 "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON" | awk '{print $1}')"
  PATCH_ID="$(printf '%s|%s' "$PATCH_SHA256" "$WORKSPACE_ID" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_patch_shape() {
  python - <<'PY' "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
if not isinstance(data, dict):
    raise SystemExit('patch root must be an object')
ops = data.get('operations', data.get('ops', data.get('patch', [])))
if not isinstance(ops, list) or not ops:
    raise SystemExit('patch must contain a non-empty operations list')
print('patch-shape-ok')
PY
}

phase_normalize_preview() {
  python - <<'PY' \
    "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON" \
    "$WORKSPACE_CANONICAL" \
    "$ADJUTORIX_PATCH_PREVIEW_NORMALIZED_JSON" \
    "$ADJUTORIX_PATCH_PREVIEW_FILES_TSV" \
    "$ADJUTORIX_PATCH_PREVIEW_HUNKS_TSV" \
    "$ADJUTORIX_PATCH_PREVIEW_POLICY_TSV" \
    "$ADJUTORIX_PATCH_PREVIEW_INCLUDE_POLICY_HINTS" \
    "$ADJUTORIX_PATCH_PREVIEW_INCLUDE_CONFLICT_HEURISTICS" \
    "$ADJUTORIX_PATCH_PREVIEW_MAX_TEXT_LINES_PER_FILE"
import csv
import json
import os
import sys
from pathlib import Path

request_path = Path(sys.argv[1])
workspace = Path(sys.argv[2])
out_path = Path(sys.argv[3])
files_tsv = Path(sys.argv[4])
hunks_tsv = Path(sys.argv[5])
policy_tsv = Path(sys.argv[6])
include_policy = sys.argv[7].lower() == 'true'
include_conflict = sys.argv[8].lower() == 'true'
max_lines = int(sys.argv[9])

with request_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
ops = data.get('operations', data.get('ops', data.get('patch', [])))
patch_kind = str(data.get('kind', data.get('patch_kind', 'structured_patch')))

files_rows = []
hunk_rows = []
policy_rows = []
normalized_ops = []
counts = {
    'created': 0,
    'updated': 0,
    'deleted': 0,
    'renamed': 0,
    'binary': 0,
    'conflict_suspect': 0,
    'policy_hints': 0,
    'hunks': 0,
    'insertions': 0,
    'deletions': 0,
}

for idx, op in enumerate(ops):
    if not isinstance(op, dict):
        continue
    path = str(op.get('path', op.get('file', '')))
    action = str(op.get('action', op.get('op', 'update')))
    new_path = str(op.get('new_path', ''))
    content = op.get('content', op.get('text', ''))
    hunks = op.get('hunks', []) if isinstance(op.get('hunks', []), list) else []
    target = workspace / path if path else workspace
    exists_before = target.exists()
    binary = False
    before_text = ''
    before_lines = []
    if exists_before and target.is_file():
        try:
            raw = target.read_bytes()
            binary = b'\x00' in raw
            if not binary:
                before_text = raw.decode('utf-8')
                before_lines = before_text.splitlines()
        except Exception:
            binary = True
    if binary:
        counts['binary'] += 1

    after_text = before_text
    insertions = 0
    deletions = 0
    conflict_suspected = False

    if action in {'create', 'add'}:
        counts['created'] += 1
        after_text = str(content)
        insertions = len(after_text.splitlines())
    elif action in {'delete', 'remove'}:
        counts['deleted'] += 1
        deletions = len(before_lines)
        after_text = ''
    elif action in {'rename', 'move'}:
        counts['renamed'] += 1
    else:
        counts['updated'] += 1
        if content:
            after_text = str(content)
            insertions = max(0, len(after_text.splitlines()) - len(before_lines))
            deletions = max(0, len(before_lines) - len(after_text.splitlines()))
        if hunks:
            counts['hunks'] += len(hunks)
            for hidx, h in enumerate(hunks, start=1):
                start_before = int(h.get('start_before', h.get('old_start', 1)))
                count_before = int(h.get('count_before', h.get('old_count', 0)))
                start_after = int(h.get('start_after', h.get('new_start', start_before)))
                count_after = int(h.get('count_after', h.get('new_count', 0)))
                if include_conflict and before_lines and start_before > len(before_lines) + 1:
                    conflict_suspected = True
                hunk_rows.append((path, hidx, start_before, count_before, start_after, count_after, 'yes' if conflict_suspected else 'no'))

    counts['insertions'] += insertions
    counts['deletions'] += deletions
    if conflict_suspected:
        counts['conflict_suspect'] += 1

    if include_policy:
      lowered = path.lower()
      if lowered.startswith('.github/') or lowered.startswith('configs/ci/') or lowered.endswith('package.json') or lowered.endswith('pyproject.toml'):
          policy_rows.append((path, 'GOVERNED_SURFACE', 'warn', 'Touches governance or build-critical surface'))
      if '/secrets' in lowered or lowered.endswith('.pem') or lowered.endswith('.key') or lowered.endswith('.env'):
          policy_rows.append((path, 'SECRET_ADJACENT', 'warn', 'Touches secret-adjacent surface'))
      if lowered.startswith('scripts/'):
          policy_rows.append((path, 'EXECUTION_SURFACE', 'info', 'Touches executable script surface'))

    file_row = (
        path,
        action,
        'yes' if exists_before else 'no',
        'yes' if binary else 'no',
        len(before_lines),
        len(after_text.splitlines()) if after_text else 0,
        insertions,
        deletions,
    )
    files_rows.append(file_row)
    normalized_ops.append({
        'path': path,
        'action': action,
        'new_path': new_path,
        'exists_before': exists_before,
        'binary': binary,
        'line_count_before': len(before_lines),
        'line_count_after': len(after_text.splitlines()) if after_text else 0,
        'insertions': insertions,
        'deletions': deletions,
        'conflict_suspected': conflict_suspected,
    })

counts['policy_hints'] = len(policy_rows)

with files_tsv.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(files_rows)
with hunks_tsv.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(hunk_rows)
with policy_tsv.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(policy_rows)

payload = {
    'patch_kind': patch_kind,
    'file_count': len(files_rows),
    'counts': counts,
    'operations': normalized_ops,
}
out_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY

  read -r PATCH_KIND TARGET_FILE_COUNT CREATED_COUNT UPDATED_COUNT DELETED_COUNT RENAMED_COUNT HUNK_COUNT CONFLICT_SUSPECT_COUNT POLICY_HINT_COUNT BINARY_TARGET_COUNT TOTAL_INSERTIONS TOTAL_DELETIONS < <(python - <<'PY' "$ADJUTORIX_PATCH_PREVIEW_NORMALIZED_JSON"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
counts = data.get('counts', {})
print(
    data.get('patch_kind', 'unknown'),
    data.get('file_count', 0),
    counts.get('created', 0),
    counts.get('updated', 0),
    counts.get('deleted', 0),
    counts.get('renamed', 0),
    counts.get('hunks', 0),
    counts.get('conflict_suspect', 0),
    counts.get('policy_hints', 0),
    counts.get('binary', 0),
    counts.get('insertions', 0),
    counts.get('deletions', 0),
)
PY
)
}

phase_render_diff() {
  if [[ "$ADJUTORIX_PATCH_PREVIEW_INCLUDE_UNIFIED_DIFF" != "true" ]]; then
    return 0
  fi

  python - <<'PY' \
    "$ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON" \
    "$WORKSPACE_CANONICAL" \
    "$ADJUTORIX_PATCH_PREVIEW_DIFF_FILE" \
    "$ADJUTORIX_PATCH_PREVIEW_MAX_FILE_PREVIEW_BYTES"
import difflib
import json
import sys
from pathlib import Path

request_path = Path(sys.argv[1])
workspace = Path(sys.argv[2])
out_path = Path(sys.argv[3])
max_bytes = int(sys.argv[4])
with request_path.open('r', encoding='utf-8') as fh:
    data = json.load(fh)
ops = data.get('operations', data.get('ops', data.get('patch', [])))
chunks = []
for op in ops:
    if not isinstance(op, dict):
        continue
    path = str(op.get('path', op.get('file', '')))
    action = str(op.get('action', op.get('op', 'update')))
    content = op.get('content', op.get('text', ''))
    target = workspace / path if path else workspace
    before = ''
    if target.exists() and target.is_file():
        try:
            raw = target.read_bytes()
            if b'\x00' in raw or len(raw) > max_bytes:
                chunks.append(f'--- {path}\n+++ {path}\n@@ binary_or_large_file @@\n')
                continue
            before = raw.decode('utf-8')
        except Exception:
            chunks.append(f'--- {path}\n+++ {path}\n@@ unreadable_or_binary @@\n')
            continue
    if action in {'delete', 'remove'}:
        after = ''
    elif action in {'rename', 'move'}:
        after = before
    else:
        after = str(content) if content else before
    diff = difflib.unified_diff(
        before.splitlines(True),
        after.splitlines(True),
        fromfile=f'a/{path}',
        tofile=f'b/{path}',
        lineterm=''
    )
    chunks.append(''.join(diff) + ('\n' if before or after else ''))
out_path.write_text(''.join(chunks), encoding='utf-8')
PY

  RENDERED_DIFF_LINES="$(wc -l < "$ADJUTORIX_PATCH_PREVIEW_DIFF_FILE" | tr -d ' ')"
}

phase_validate_artifacts() {
  [[ -f "$ADJUTORIX_PATCH_PREVIEW_NORMALIZED_JSON" ]] || die "Normalized preview JSON missing"
  [[ -f "$ADJUTORIX_PATCH_PREVIEW_FILES_TSV" ]] || die "Files TSV missing"
  [[ -f "$ADJUTORIX_PATCH_PREVIEW_HUNKS_TSV" ]] || die "Hunks TSV missing"
  [[ -f "$ADJUTORIX_PATCH_PREVIEW_POLICY_TSV" ]] || die "Policy TSV missing"
  if [[ "$ADJUTORIX_PATCH_PREVIEW_INCLUDE_UNIFIED_DIFF" == "true" ]]; then
    [[ -f "$ADJUTORIX_PATCH_PREVIEW_DIFF_FILE" ]] || die "Diff artifact missing"
  fi
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX patch preview summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "workspace_canonical: ${WORKSPACE_CANONICAL}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "patch_id: ${PATCH_ID}"
    echo "patch_sha256: ${PATCH_SHA256}"
    echo "patch_kind: ${PATCH_KIND}"
    echo "target_file_count: ${TARGET_FILE_COUNT}"
    echo "created_count: ${CREATED_COUNT}"
    echo "updated_count: ${UPDATED_COUNT}"
    echo "deleted_count: ${DELETED_COUNT}"
    echo "renamed_count: ${RENAMED_COUNT}"
    echo "hunk_count: ${HUNK_COUNT}"
    echo "conflict_suspect_count: ${CONFLICT_SUSPECT_COUNT}"
    echo "policy_hint_count: ${POLICY_HINT_COUNT}"
    echo "binary_target_count: ${BINARY_TARGET_COUNT}"
    echo "total_insertions: ${TOTAL_INSERTIONS}"
    echo "total_deletions: ${TOTAL_DELETIONS}"
    echo "rendered_diff_lines: ${RENDERED_DIFF_LINES}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_PATCH_PREVIEW_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_PATCH_PREVIEW_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_PATCH_PREVIEW_PHASE_FILE}"
    echo "  - request: ${ADJUTORIX_PATCH_PREVIEW_REQUEST_JSON}"
    echo "  - normalized: ${ADJUTORIX_PATCH_PREVIEW_NORMALIZED_JSON}"
    echo "  - files_tsv: ${ADJUTORIX_PATCH_PREVIEW_FILES_TSV}"
    echo "  - hunks_tsv: ${ADJUTORIX_PATCH_PREVIEW_HUNKS_TSV}"
    echo "  - policy_tsv: ${ADJUTORIX_PATCH_PREVIEW_POLICY_TSV}"
    if [[ "$ADJUTORIX_PATCH_PREVIEW_INCLUDE_UNIFIED_DIFF" == "true" ]]; then
      echo "  - diff: ${ADJUTORIX_PATCH_PREVIEW_DIFF_FILE}"
    fi
  } >"$ADJUTORIX_PATCH_PREVIEW_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX patch preview"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "workspace=${WORKSPACE_PATH}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_workspace phase_resolve_workspace
  run_phase resolve_patch_payload phase_resolve_patch_payload
  run_phase validate_patch_shape phase_validate_patch_shape
  run_phase normalize_preview phase_normalize_preview
  run_phase render_diff phase_render_diff
  run_phase validate_artifacts phase_validate_artifacts

  write_summary

  section "Patch preview complete"
  log_info "summary=${ADJUTORIX_PATCH_PREVIEW_SUMMARY_FILE}"
  log_info "patch_id=${PATCH_ID} target_file_count=${TARGET_FILE_COUNT}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Patch preview failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
