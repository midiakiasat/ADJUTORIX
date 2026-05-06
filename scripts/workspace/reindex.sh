#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX WORKSPACE REINDEX ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for deterministic workspace
#   reindexing
# - canonicalize and validate a target workspace, derive a bounded file corpus,
#   compute content digests, rebuild manifest/search/outline/diagnostics seed
#   indexes, and emit reproducible index artifacts plus metadata
# - ensure "workspace reindexed" means one coherent snapshot-derived state
#   rather than a partial cache refresh
#
# Scope
# - read-only inspection of workspace contents
# - writes only repo-local reindex artifacts under .tmp
# - no mutation of workspace files or editor state
#
# Design constraints
# - no hidden exclusions; all skip rules are explicit
# - no incremental magic without explicit manifest/digest evidence
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

: "${ADJUTORIX_WORKSPACE_REINDEX_STACK_NAME:=adjutorix-workspace-reindex}"
: "${ADJUTORIX_WORKSPACE_REINDEX_USE_COLOR:=true}"
: "${ADJUTORIX_WORKSPACE_REINDEX_FAIL_FAST:=true}"
: "${ADJUTORIX_WORKSPACE_REINDEX_REQUIRE_GIT_WORKTREE:=false}"
: "${ADJUTORIX_WORKSPACE_REINDEX_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HIDDEN:=true}"
: "${ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HASHES:=true}"
: "${ADJUTORIX_WORKSPACE_REINDEX_HASH_MAX_FILE_BYTES:=2097152}"
: "${ADJUTORIX_WORKSPACE_REINDEX_MAX_FILES:=100000}"
: "${ADJUTORIX_WORKSPACE_REINDEX_MAX_DIRS:=20000}"
: "${ADJUTORIX_WORKSPACE_REINDEX_MAX_OUTLINE_ENTRIES:=50000}"
: "${ADJUTORIX_WORKSPACE_REINDEX_MAX_SEARCH_TOKENS_PER_FILE:=2000}"
: "${ADJUTORIX_WORKSPACE_REINDEX_TEXT_FILE_MAX_BYTES:=1048576}"
: "${ADJUTORIX_WORKSPACE_REINDEX_EXCLUDE_DIRS:=.git,node_modules,.venv,venv,.tmp,dist,build,out,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache,.turbo,.next,.idea,.vscode,coverage,release,artifacts}"
: "${ADJUTORIX_WORKSPACE_REINDEX_EXCLUDE_FILE_SUFFIXES:=.pyc,.pyo,.DS_Store,.swp,.tmp,.log,.min.js,.map,.png,.jpg,.jpeg,.gif,.webp,.pdf,.zip,.tar,.gz,.sqlite,.db}"
: "${ADJUTORIX_WORKSPACE_REINDEX_ROOT_TMP:=${REPO_ROOT}/.tmp/workspace-reindex}"
: "${ADJUTORIX_WORKSPACE_REINDEX_LOG_DIR:=${ADJUTORIX_WORKSPACE_REINDEX_ROOT_TMP}/logs}"
: "${ADJUTORIX_WORKSPACE_REINDEX_REPORT_DIR:=${ADJUTORIX_WORKSPACE_REINDEX_ROOT_TMP}/reports}"
: "${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR:=${ADJUTORIX_WORKSPACE_REINDEX_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_WORKSPACE_REINDEX_BOOT_LOG:=${ADJUTORIX_WORKSPACE_REINDEX_LOG_DIR}/reindex.log}"
: "${ADJUTORIX_WORKSPACE_REINDEX_SUMMARY_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_WORKSPACE_REINDEX_PHASE_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_JSON_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/reindex.json}"
: "${ADJUTORIX_WORKSPACE_REINDEX_FILES_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/files.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_MANIFESTS_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/manifests.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_SEARCH_INDEX_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/search-index.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_OUTLINE_INDEX_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/outline-index.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_DIAGNOSTICS_SEED_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/diagnostics-seed.tsv}"
: "${ADJUTORIX_WORKSPACE_REINDEX_DIGESTS_FILE:=${ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR}/digests.tsv}"

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
REINDEX_ID=""
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
FILE_COUNT="0"
DIR_COUNT="0"
TEXT_FILE_COUNT="0"
HASHED_FILE_COUNT="0"
MANIFEST_COUNT="0"
SEARCH_TOKEN_COUNT="0"
OUTLINE_ENTRY_COUNT="0"
DIAGNOSTICS_SEED_COUNT="0"
TOTAL_BYTES="0"
GIT_HINT="no"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_WORKSPACE_REINDEX_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_WORKSPACE_REINDEX_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_WORKSPACE_REINDEX_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/workspace/reindex.sh <workspace-path> [options]

Options:
  --git-required                Require target to be a git worktree
  --no-hidden                   Exclude hidden entries from traversal
  --no-hashes                   Disable content hashing
  --max-files <n>               Override maximum indexed file count
  --max-outline <n>             Override maximum outline entries
  --text-max-bytes <n>          Override per-file text indexing byte ceiling
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
        ADJUTORIX_WORKSPACE_REINDEX_REQUIRE_GIT_WORKTREE=true
        ;;
      --no-hidden)
        ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HIDDEN=false
        ;;
      --no-hashes)
        ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HASHES=false
        ;;
      --max-files)
        shift
        [[ $# -gt 0 ]] || die "--max-files requires a value"
        ADJUTORIX_WORKSPACE_REINDEX_MAX_FILES="$1"
        ;;
      --max-outline)
        shift
        [[ $# -gt 0 ]] || die "--max-outline requires a value"
        ADJUTORIX_WORKSPACE_REINDEX_MAX_OUTLINE_ENTRIES="$1"
        ;;
      --text-max-bytes)
        shift
        [[ $# -gt 0 ]] || die "--text-max-bytes requires a value"
        ADJUTORIX_WORKSPACE_REINDEX_TEXT_FILE_MAX_BYTES="$1"
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_WORKSPACE_REINDEX_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_WORKSPACE_REINDEX_PHASE_FILE"
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
    if [[ "$ADJUTORIX_WORKSPACE_REINDEX_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_WORKSPACE_REINDEX_LOG_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_REINDEX_REPORT_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_REINDEX_ARTIFACT_DIR"
  : >"$ADJUTORIX_WORKSPACE_REINDEX_BOOT_LOG"
  : >"$ADJUTORIX_WORKSPACE_REINDEX_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_WORKSPACE_REINDEX_PHASE_FILE"
  printf 'path\tsize_bytes\tlang_hint\ttext_indexed\n' >"$ADJUTORIX_WORKSPACE_REINDEX_FILES_FILE"
  printf 'kind\tpath\n' >"$ADJUTORIX_WORKSPACE_REINDEX_MANIFESTS_FILE"
  printf 'path\ttoken\n' >"$ADJUTORIX_WORKSPACE_REINDEX_SEARCH_INDEX_FILE"
  printf 'path\tsymbol_kind\tsymbol_name\tline\n' >"$ADJUTORIX_WORKSPACE_REINDEX_OUTLINE_INDEX_FILE"
  printf 'path\tseed_kind\tseed_value\n' >"$ADJUTORIX_WORKSPACE_REINDEX_DIAGNOSTICS_SEED_FILE"
  printf 'path\tsha256\n' >"$ADJUTORIX_WORKSPACE_REINDEX_DIGESTS_FILE"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command find
  require_command shasum
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
  [[ -n "$TARGET_INPUT" ]] || die "Workspace target is required"
}

phase_resolve_target() {
  TARGET_CANONICAL="$(python3 - <<'PY' "$TARGET_INPUT"
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"
  [[ -n "$TARGET_CANONICAL" ]] || die "Failed to canonicalize target"
  [[ -d "$TARGET_CANONICAL" ]] || die "Target is not a directory: $TARGET_CANONICAL"
  TARGET_NAME="$(basename "$TARGET_CANONICAL")"
  WORKSPACE_ID="$(printf '%s' "$TARGET_CANONICAL" | shasum -a 256 | awk '{print $1}')"
  REINDEX_ID="$(printf '%s|%s' "$TARGET_CANONICAL" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_access() {
  if [[ "$ADJUTORIX_WORKSPACE_REINDEX_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$TARGET_CANONICAL" ]] || die "Target is not readable: $TARGET_CANONICAL"
  fi
}

phase_validate_git_if_required() {
  if [[ -d "$TARGET_CANONICAL/.git" ]]; then
    GIT_HINT="yes"
  else
    GIT_HINT="no"
  fi
  if [[ "$ADJUTORIX_WORKSPACE_REINDEX_REQUIRE_GIT_WORKTREE" == "true" ]]; then
    git -C "$TARGET_CANONICAL" rev-parse --is-inside-work-tree >/dev/null 2>&1
  fi
}

phase_reindex_workspace() {
  python3 - <<'PY' \
    "$TARGET_CANONICAL" \
    "$ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HIDDEN" \
    "$ADJUTORIX_WORKSPACE_REINDEX_EXCLUDE_DIRS" \
    "$ADJUTORIX_WORKSPACE_REINDEX_EXCLUDE_FILE_SUFFIXES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_INCLUDE_HASHES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_HASH_MAX_FILE_BYTES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_MAX_FILES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_MAX_DIRS" \
    "$ADJUTORIX_WORKSPACE_REINDEX_MAX_OUTLINE_ENTRIES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_MAX_SEARCH_TOKENS_PER_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_TEXT_FILE_MAX_BYTES" \
    "$ADJUTORIX_WORKSPACE_REINDEX_FILES_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_MANIFESTS_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_SEARCH_INDEX_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_OUTLINE_INDEX_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_DIAGNOSTICS_SEED_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_DIGESTS_FILE" \
    "$ADJUTORIX_WORKSPACE_REINDEX_JSON_FILE"
import csv
import hashlib
import json
import os
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
include_hidden = sys.argv[2].lower() == 'true'
exclude_dirs = {x for x in sys.argv[3].split(',') if x}
exclude_suffixes = {x for x in sys.argv[4].split(',') if x}
include_hashes = sys.argv[5].lower() == 'true'
hash_max_file_bytes = int(sys.argv[6])
max_files = int(sys.argv[7])
max_dirs = int(sys.argv[8])
max_outline_entries = int(sys.argv[9])
max_search_tokens_per_file = int(sys.argv[10])
text_file_max_bytes = int(sys.argv[11])
files_file = Path(sys.argv[12])
manifests_file = Path(sys.argv[13])
search_file = Path(sys.argv[14])
outline_file = Path(sys.argv[15])
diagnostics_file = Path(sys.argv[16])
digests_file = Path(sys.argv[17])
json_file = Path(sys.argv[18])

manifest_names = {
    'package.json': 'node_package',
    'pyproject.toml': 'python_project',
    'Cargo.toml': 'rust_project',
    'go.mod': 'go_module',
    'requirements.txt': 'python_requirements',
    'tsconfig.json': 'typescript_config',
    'vite.config.ts': 'vite_config',
    'vite.config.js': 'vite_config',
    'Dockerfile': 'dockerfile',
}
lang_by_suffix = {
    '.py': 'python3',
    '.ts': 'typescript',
    '.tsx': 'typescriptreact',
    '.js': 'javascript',
    '.jsx': 'javascriptreact',
    '.json': 'json',
    '.yaml': 'yaml',
    '.yml': 'yaml',
    '.toml': 'toml',
    '.sh': 'shell',
    '.md': 'markdown',
    '.go': 'go',
    '.rs': 'rust',
    '.java': 'java',
    '.css': 'css',
    '.html': 'html',
}

def lang_hint(path: Path) -> str:
    if path.name == 'Dockerfile':
        return 'dockerfile'
    return lang_by_suffix.get(path.suffix.lower(), 'unknown')

def tokenize(text: str):
    return re.findall(r'[A-Za-z_][A-Za-z0-9_]{2,}', text)

outline_patterns = [
    ('python_function', re.compile(r'^\s*def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', re.M)),
    ('python_class', re.compile(r'^\s*class\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(:]', re.M)),
    ('ts_function', re.compile(r'^\s*(?:export\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(', re.M)),
    ('ts_class', re.compile(r'^\s*(?:export\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)\s*', re.M)),
    ('heading', re.compile(r'^\s*#{1,6}\s+(.+)$', re.M)),
]

def line_of_offset(text: str, offset: int) -> int:
    return text.count('\n', 0, offset) + 1

file_rows = []
manifest_rows = []
search_rows = []
outline_rows = []
diagnostics_rows = []
digest_rows = []
file_count = 0
dir_count = 0
text_file_count = 0
hashed_file_count = 0
manifest_count = 0
search_token_count = 0
outline_entry_count = 0
diagnostics_seed_count = 0
total_bytes = 0

for dirpath, dirnames, filenames in os.walk(root):
    filtered_dirs = []
    for d in dirnames:
        if d in exclude_dirs:
            continue
        if not include_hidden and d.startswith('.'):
            continue
        filtered_dirs.append(d)
    dirnames[:] = filtered_dirs
    dir_count += 1
    if dir_count > max_dirs:
        break

    for name in filenames:
        if any(name.endswith(sfx) for sfx in exclude_suffixes):
            continue
        if not include_hidden and name.startswith('.'):
            continue
        if file_count >= max_files:
            break

        full = Path(dirpath) / name
        rel = os.path.relpath(full, root)
        try:
            size = full.stat().st_size
        except OSError:
            size = 0
        total_bytes += size
        file_count += 1
        lhint = lang_hint(full)
        indexed_text = 'no'
        file_rows.append((rel, str(size), lhint, indexed_text))

        if name in manifest_names:
          manifest_rows.append((manifest_names[name], rel))
          manifest_count += 1

        text = None
        if size <= text_file_max_bytes:
            try:
                text = full.read_text(encoding='utf-8')
                indexed_text = 'yes'
                text_file_count += 1
            except Exception:
                text = None

        file_rows[-1] = (rel, str(size), lhint, indexed_text)

        if include_hashes and size <= hash_max_file_bytes and full.is_file():
            try:
                digest_rows.append((rel, hashlib.sha256(full.read_bytes()).hexdigest()))
                hashed_file_count += 1
            except OSError:
                pass

        if text is not None:
            tokens = tokenize(text)
            seen_tokens = set()
            per_file = 0
            for token in tokens:
                if token in seen_tokens:
                    continue
                seen_tokens.add(token)
                search_rows.append((rel, token))
                per_file += 1
                search_token_count += 1
                if per_file >= max_search_tokens_per_file:
                    break

            for seed_kind, seed_value in [
                ('line_count', str(text.count('\n') + 1)),
                ('todo_count', str(len(re.findall(r'\bTODO\b', text)))),
                ('fixme_count', str(len(re.findall(r'\bFIXME\b', text)))),
            ]:
                diagnostics_rows.append((rel, seed_kind, seed_value))
                diagnostics_seed_count += 1

            for symbol_kind, pattern in outline_patterns:
                for match in pattern.finditer(text):
                    if outline_entry_count >= max_outline_entries:
                        break
                    symbol_name = match.group(1).strip()
                    outline_rows.append((rel, symbol_kind, symbol_name, str(line_of_offset(text, match.start()))))
                    outline_entry_count += 1
                if outline_entry_count >= max_outline_entries:
                    break

with files_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(file_rows)
with manifests_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(manifest_rows)
with search_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(search_rows)
with outline_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(outline_rows)
with diagnostics_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(diagnostics_rows)
with digests_file.open('a', encoding='utf-8', newline='') as fh:
    csv.writer(fh, delimiter='\t').writerows(digest_rows)

payload = {
    'file_count': file_count,
    'dir_count': dir_count,
    'text_file_count': text_file_count,
    'hashed_file_count': hashed_file_count,
    'manifest_count': manifest_count,
    'search_token_count': search_token_count,
    'outline_entry_count': outline_entry_count,
    'diagnostics_seed_count': diagnostics_seed_count,
    'total_bytes': total_bytes,
}
json_file.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY
}

phase_load_results() {
  read -r FILE_COUNT DIR_COUNT TEXT_FILE_COUNT HASHED_FILE_COUNT MANIFEST_COUNT SEARCH_TOKEN_COUNT OUTLINE_ENTRY_COUNT DIAGNOSTICS_SEED_COUNT TOTAL_BYTES < <(python3 - <<'PY' "$ADJUTORIX_WORKSPACE_REINDEX_JSON_FILE"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(
    data['file_count'],
    data['dir_count'],
    data['text_file_count'],
    data['hashed_file_count'],
    data['manifest_count'],
    data['search_token_count'],
    data['outline_entry_count'],
    data['diagnostics_seed_count'],
    data['total_bytes'],
)
PY
  )
}

phase_validate_artifacts() {
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_JSON_FILE" ]] || die "Missing JSON reindex artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_FILES_FILE" ]] || die "Missing files artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_MANIFESTS_FILE" ]] || die "Missing manifests artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_SEARCH_INDEX_FILE" ]] || die "Missing search index artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_OUTLINE_INDEX_FILE" ]] || die "Missing outline index artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_DIAGNOSTICS_SEED_FILE" ]] || die "Missing diagnostics seed artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_REINDEX_DIGESTS_FILE" ]] || die "Missing digests artifact"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX workspace reindex summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "target_input: ${TARGET_INPUT}"
    echo "target_canonical: ${TARGET_CANONICAL}"
    echo "target_name: ${TARGET_NAME}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "reindex_id: ${REINDEX_ID}"
    echo "git_hint: ${GIT_HINT}"
    echo "file_count: ${FILE_COUNT}"
    echo "dir_count: ${DIR_COUNT}"
    echo "text_file_count: ${TEXT_FILE_COUNT}"
    echo "hashed_file_count: ${HASHED_FILE_COUNT}"
    echo "manifest_count: ${MANIFEST_COUNT}"
    echo "search_token_count: ${SEARCH_TOKEN_COUNT}"
    echo "outline_entry_count: ${OUTLINE_ENTRY_COUNT}"
    echo "diagnostics_seed_count: ${DIAGNOSTICS_SEED_COUNT}"
    echo "total_bytes: ${TOTAL_BYTES}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - json: ${ADJUTORIX_WORKSPACE_REINDEX_JSON_FILE}"
    echo "  - files: ${ADJUTORIX_WORKSPACE_REINDEX_FILES_FILE}"
    echo "  - manifests: ${ADJUTORIX_WORKSPACE_REINDEX_MANIFESTS_FILE}"
    echo "  - search: ${ADJUTORIX_WORKSPACE_REINDEX_SEARCH_INDEX_FILE}"
    echo "  - outline: ${ADJUTORIX_WORKSPACE_REINDEX_OUTLINE_INDEX_FILE}"
    echo "  - diagnostics: ${ADJUTORIX_WORKSPACE_REINDEX_DIAGNOSTICS_SEED_FILE}"
    echo "  - digests: ${ADJUTORIX_WORKSPACE_REINDEX_DIGESTS_FILE}"
    echo "  - boot_log: ${ADJUTORIX_WORKSPACE_REINDEX_BOOT_LOG}"
  } >"$ADJUTORIX_WORKSPACE_REINDEX_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX workspace reindex"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "target_input=${TARGET_INPUT}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_target phase_resolve_target
  run_phase validate_access phase_validate_access
  run_phase validate_git_if_required phase_validate_git_if_required
  run_phase reindex_workspace phase_reindex_workspace
  run_phase load_results phase_load_results
  run_phase validate_artifacts phase_validate_artifacts

  write_summary

  section "Workspace reindex complete"
  log_info "summary=${ADJUTORIX_WORKSPACE_REINDEX_SUMMARY_FILE}"
  log_info "workspace_id=${WORKSPACE_ID} reindex_id=${REINDEX_ID}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Workspace reindex failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
