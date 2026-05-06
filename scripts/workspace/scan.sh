#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX WORKSPACE SCAN ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for deterministic workspace scans
# - canonicalize and validate a target workspace, walk it under explicit
#   exclusion policy, compute scale/profile statistics, discover key manifests,
#   detect trust and risk hints, and emit reproducible scan artifacts
# - ensure "workspace scanned" means a concrete observed state rather than an
#   informal directory listing
#
# Scope
# - read-only inspection of workspace contents
# - writes only to repo-local .tmp scan artifacts and reports
# - does not mutate target workspace contents
#
# Design constraints
# - no hidden exclusions; every skip rule is declared
# - no silent fallback from unreadable or invalid targets
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

: "${ADJUTORIX_WORKSPACE_SCAN_STACK_NAME:=adjutorix-workspace-scan}"
: "${ADJUTORIX_WORKSPACE_SCAN_USE_COLOR:=true}"
: "${ADJUTORIX_WORKSPACE_SCAN_FAIL_FAST:=true}"
: "${ADJUTORIX_WORKSPACE_SCAN_REQUIRE_GIT_WORKTREE:=false}"
: "${ADJUTORIX_WORKSPACE_SCAN_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HIDDEN:=true}"
: "${ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HASHES:=false}"
: "${ADJUTORIX_WORKSPACE_SCAN_MAX_HASH_FILES:=2000}"
: "${ADJUTORIX_WORKSPACE_SCAN_MAX_FILE_SIZE_FOR_HASH:=1048576}"
: "${ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_FILES:=50000}"
: "${ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_DIRS:=10000}"
: "${ADJUTORIX_WORKSPACE_SCAN_LARGE_FILE_THRESHOLD:=10485760}"
: "${ADJUTORIX_WORKSPACE_SCAN_LARGE_WORKSPACE_FILE_COUNT:=200000}"
: "${ADJUTORIX_WORKSPACE_SCAN_LARGE_WORKSPACE_BYTES:=2147483648}"
: "${ADJUTORIX_WORKSPACE_SCAN_EXCLUDE_DIRS:=.git,node_modules,.venv,venv,.tmp,dist,build,out,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache,.turbo,.next,.idea,.vscode}"
: "${ADJUTORIX_WORKSPACE_SCAN_EXCLUDE_FILE_SUFFIXES:=.pyc,.pyo,.DS_Store,.swp,.tmp,.log}"
: "${ADJUTORIX_WORKSPACE_SCAN_ROOT_TMP:=${REPO_ROOT}/.tmp/workspace-scan}"
: "${ADJUTORIX_WORKSPACE_SCAN_LOG_DIR:=${ADJUTORIX_WORKSPACE_SCAN_ROOT_TMP}/logs}"
: "${ADJUTORIX_WORKSPACE_SCAN_REPORT_DIR:=${ADJUTORIX_WORKSPACE_SCAN_ROOT_TMP}/reports}"
: "${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR:=${ADJUTORIX_WORKSPACE_SCAN_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_WORKSPACE_SCAN_BOOT_LOG:=${ADJUTORIX_WORKSPACE_SCAN_LOG_DIR}/scan.log}"
: "${ADJUTORIX_WORKSPACE_SCAN_SUMMARY_FILE:=${ADJUTORIX_WORKSPACE_SCAN_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_WORKSPACE_SCAN_PHASE_FILE:=${ADJUTORIX_WORKSPACE_SCAN_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_WORKSPACE_SCAN_JSON_FILE:=${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR}/scan.json}"
: "${ADJUTORIX_WORKSPACE_SCAN_FILES_FILE:=${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR}/files.tsv}"
: "${ADJUTORIX_WORKSPACE_SCAN_DIRS_FILE:=${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR}/dirs.tsv}"
: "${ADJUTORIX_WORKSPACE_SCAN_MANIFESTS_FILE:=${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR}/manifests.tsv}"
: "${ADJUTORIX_WORKSPACE_SCAN_RISKS_FILE:=${ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR}/risks.tsv}"

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
SCAN_ID=""
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
FILE_COUNT="0"
DIR_COUNT="0"
TOTAL_BYTES="0"
LARGE_FILE_COUNT="0"
HASHED_FILE_COUNT="0"
TRUST_HINT="unknown"
HEALTH_HINT="unknown"
GIT_HINT="no"
MANIFEST_COUNT="0"
RISK_COUNT="0"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_WORKSPACE_SCAN_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_WORKSPACE_SCAN_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_WORKSPACE_SCAN_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/workspace/scan.sh <workspace-path> [options]

Options:
  --git-required                Require target to be a git worktree
  --hashes                      Include SHA-256 for bounded subset of files
  --no-hidden                   Exclude hidden files/directories from traversal
  --max-files <n>               Maximum file rows to persist in artifact list
  --max-dirs <n>                Maximum directory rows to persist in artifact list
  --large-file-threshold <n>    Bytes threshold that classifies a file as large
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
        ADJUTORIX_WORKSPACE_SCAN_REQUIRE_GIT_WORKTREE=true
        ;;
      --hashes)
        ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HASHES=true
        ;;
      --no-hidden)
        ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HIDDEN=false
        ;;
      --max-files)
        shift
        [[ $# -gt 0 ]] || die "--max-files requires a value"
        ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_FILES="$1"
        ;;
      --max-dirs)
        shift
        [[ $# -gt 0 ]] || die "--max-dirs requires a value"
        ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_DIRS="$1"
        ;;
      --large-file-threshold)
        shift
        [[ $# -gt 0 ]] || die "--large-file-threshold requires a value"
        ADJUTORIX_WORKSPACE_SCAN_LARGE_FILE_THRESHOLD="$1"
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_WORKSPACE_SCAN_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_WORKSPACE_SCAN_PHASE_FILE"
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
    if [[ "$ADJUTORIX_WORKSPACE_SCAN_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_WORKSPACE_SCAN_LOG_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_SCAN_REPORT_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_SCAN_ARTIFACT_DIR"
  : >"$ADJUTORIX_WORKSPACE_SCAN_BOOT_LOG"
  : >"$ADJUTORIX_WORKSPACE_SCAN_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_WORKSPACE_SCAN_PHASE_FILE"
  printf 'path\tsize_bytes\tmime_guess\tsha256\n' >"$ADJUTORIX_WORKSPACE_SCAN_FILES_FILE"
  printf 'path\n' >"$ADJUTORIX_WORKSPACE_SCAN_DIRS_FILE"
  printf 'kind\tpath\n' >"$ADJUTORIX_WORKSPACE_SCAN_MANIFESTS_FILE"
  printf 'risk_kind\tpath\tdetail\n' >"$ADJUTORIX_WORKSPACE_SCAN_RISKS_FILE"
}

phase_repo_and_toolchain() {
  require_command python3
  require_command find
  require_command shasum
  require_command file
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
  SCAN_ID="$(printf '%s|%s' "$TARGET_CANONICAL" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_access() {
  if [[ "$ADJUTORIX_WORKSPACE_SCAN_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$TARGET_CANONICAL" ]] || die "Target is not readable: $TARGET_CANONICAL"
  fi
}

phase_validate_git_if_required() {
  if [[ "$ADJUTORIX_WORKSPACE_SCAN_REQUIRE_GIT_WORKTREE" != "true" ]]; then
    return 0
  fi
  git -C "$TARGET_CANONICAL" rev-parse --is-inside-work-tree >/dev/null 2>&1
}

phase_scan_workspace() {
  python3 - <<'PY' \
    "$TARGET_CANONICAL" \
    "$ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HIDDEN" \
    "$ADJUTORIX_WORKSPACE_SCAN_EXCLUDE_DIRS" \
    "$ADJUTORIX_WORKSPACE_SCAN_EXCLUDE_FILE_SUFFIXES" \
    "$ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_FILES" \
    "$ADJUTORIX_WORKSPACE_SCAN_MAX_LISTED_DIRS" \
    "$ADJUTORIX_WORKSPACE_SCAN_LARGE_FILE_THRESHOLD" \
    "$ADJUTORIX_WORKSPACE_SCAN_INCLUDE_HASHES" \
    "$ADJUTORIX_WORKSPACE_SCAN_MAX_HASH_FILES" \
    "$ADJUTORIX_WORKSPACE_SCAN_MAX_FILE_SIZE_FOR_HASH" \
    "$ADJUTORIX_WORKSPACE_SCAN_FILES_FILE" \
    "$ADJUTORIX_WORKSPACE_SCAN_DIRS_FILE" \
    "$ADJUTORIX_WORKSPACE_SCAN_MANIFESTS_FILE" \
    "$ADJUTORIX_WORKSPACE_SCAN_RISKS_FILE" \
    "$ADJUTORIX_WORKSPACE_SCAN_JSON_FILE"
import csv
import hashlib
import json
import mimetypes
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
include_hidden = sys.argv[2].lower() == 'true'
exclude_dirs = {x for x in sys.argv[3].split(',') if x}
exclude_suffixes = {x for x in sys.argv[4].split(',') if x}
max_listed_files = int(sys.argv[5])
max_listed_dirs = int(sys.argv[6])
large_file_threshold = int(sys.argv[7])
include_hashes = sys.argv[8].lower() == 'true'
max_hash_files = int(sys.argv[9])
max_hash_size = int(sys.argv[10])
files_file = Path(sys.argv[11])
dirs_file = Path(sys.argv[12])
manifests_file = Path(sys.argv[13])
risks_file = Path(sys.argv[14])
json_file = Path(sys.argv[15])

manifest_names = {
    'package.json': 'node_package',
    'pyproject.toml': 'python_project',
    'Cargo.toml': 'rust_project',
    'go.mod': 'go_module',
    'requirements.txt': 'python_requirements',
    'docker-compose.yml': 'docker_compose',
    'docker-compose.yaml': 'docker_compose',
    'Dockerfile': 'dockerfile',
    '.env': 'dotenv',
}

risk_markers = {
    '.env': 'dotenv_present',
    '.pem': 'private_material_extension',
    '.key': 'private_material_extension',
    '.p12': 'certificate_bundle_extension',
    '.mobileprovision': 'apple_profile_extension',
}

file_rows = []
dir_rows = []
manifest_rows = []
risk_rows = []
file_count = 0
dir_count = 0
total_bytes = 0
large_file_count = 0
hashed_file_count = 0
git_hint = root.joinpath('.git').exists()

for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == '.':
        rel_dir = ''

    filtered_dirs = []
    for d in dirnames:
        if d in exclude_dirs:
            continue
        if not include_hidden and d.startswith('.'):
            continue
        filtered_dirs.append(d)
    dirnames[:] = filtered_dirs

    dir_count += 1
    if len(dir_rows) < max_listed_dirs:
        dir_rows.append(rel_dir or '.')

    for name in filenames:
        if any(name.endswith(sfx) for sfx in exclude_suffixes):
            continue
        if not include_hidden and name.startswith('.'):
            continue

        full = Path(dirpath) / name
        rel = os.path.relpath(full, root)
        try:
            size = full.stat().st_size
        except OSError:
            size = 0
        total_bytes += size
        file_count += 1
        if size >= large_file_threshold:
            large_file_count += 1

        sha256 = ''
        if include_hashes and hashed_file_count < max_hash_files and size <= max_hash_size and full.is_file():
            try:
                sha256 = hashlib.sha256(full.read_bytes()).hexdigest()
                hashed_file_count += 1
            except OSError:
                sha256 = ''

        mime_guess = mimetypes.guess_type(str(full))[0] or 'application/octet-stream'
        if len(file_rows) < max_listed_files:
            file_rows.append((rel, str(size), mime_guess, sha256))

        if name in manifest_names:
            manifest_rows.append((manifest_names[name], rel))
        for suffix, risk in risk_markers.items():
            if name == suffix or name.endswith(suffix):
                risk_rows.append((risk, rel, f'name_matches:{suffix}'))
        if name in {'id_rsa', 'id_ed25519'}:
            risk_rows.append(('private_ssh_key_name', rel, 'ssh_private_key_candidate'))
        if name.lower() in {'secrets.yaml', 'secrets.yml'}:
            risk_rows.append(('secret_named_file', rel, 'secret_named_candidate'))

trust_hint = 'git_repo' if git_hint else ('project_like' if manifest_rows else 'unclassified')
health_hint = 'degraded_large' if (file_count > 200000 or total_bytes > 2147483648) else 'healthy_candidate'

with files_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows(file_rows)
with dirs_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    for row in dir_rows:
        writer.writerow([row])
with manifests_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows(manifest_rows)
with risks_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows(risk_rows)

payload = {
    'file_count': file_count,
    'dir_count': dir_count,
    'total_bytes': total_bytes,
    'large_file_count': large_file_count,
    'hashed_file_count': hashed_file_count,
    'trust_hint': trust_hint,
    'health_hint': health_hint,
    'git_hint': git_hint,
    'manifest_count': len(manifest_rows),
    'risk_count': len(risk_rows),
}
json_file.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY
}

phase_load_scan_results() {
  read -r FILE_COUNT DIR_COUNT TOTAL_BYTES LARGE_FILE_COUNT HASHED_FILE_COUNT TRUST_HINT HEALTH_HINT GIT_HINT MANIFEST_COUNT RISK_COUNT < <(python3 - <<'PY' "$ADJUTORIX_WORKSPACE_SCAN_JSON_FILE"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(
    data['file_count'],
    data['dir_count'],
    data['total_bytes'],
    data['large_file_count'],
    data['hashed_file_count'],
    data['trust_hint'],
    data['health_hint'],
    'yes' if data['git_hint'] else 'no',
    data['manifest_count'],
    data['risk_count'],
)
PY
  )
}

phase_validate_scan_artifacts() {
  [[ -f "$ADJUTORIX_WORKSPACE_SCAN_JSON_FILE" ]] || die "Missing JSON scan artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_SCAN_FILES_FILE" ]] || die "Missing files scan artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_SCAN_DIRS_FILE" ]] || die "Missing dirs scan artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_SCAN_MANIFESTS_FILE" ]] || die "Missing manifests scan artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_SCAN_RISKS_FILE" ]] || die "Missing risks scan artifact"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX workspace scan summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "target_input: ${TARGET_INPUT}"
    echo "target_canonical: ${TARGET_CANONICAL}"
    echo "target_name: ${TARGET_NAME}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "scan_id: ${SCAN_ID}"
    echo "trust_hint: ${TRUST_HINT}"
    echo "health_hint: ${HEALTH_HINT}"
    echo "git_hint: ${GIT_HINT}"
    echo "file_count: ${FILE_COUNT}"
    echo "dir_count: ${DIR_COUNT}"
    echo "total_bytes: ${TOTAL_BYTES}"
    echo "large_file_count: ${LARGE_FILE_COUNT}"
    echo "hashed_file_count: ${HASHED_FILE_COUNT}"
    echo "manifest_count: ${MANIFEST_COUNT}"
    echo "risk_count: ${RISK_COUNT}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - json: ${ADJUTORIX_WORKSPACE_SCAN_JSON_FILE}"
    echo "  - files: ${ADJUTORIX_WORKSPACE_SCAN_FILES_FILE}"
    echo "  - dirs: ${ADJUTORIX_WORKSPACE_SCAN_DIRS_FILE}"
    echo "  - manifests: ${ADJUTORIX_WORKSPACE_SCAN_MANIFESTS_FILE}"
    echo "  - risks: ${ADJUTORIX_WORKSPACE_SCAN_RISKS_FILE}"
    echo "  - boot_log: ${ADJUTORIX_WORKSPACE_SCAN_BOOT_LOG}"
  } >"$ADJUTORIX_WORKSPACE_SCAN_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX workspace scan"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "target_input=${TARGET_INPUT}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_target phase_resolve_target
  run_phase validate_access phase_validate_access
  run_phase validate_git_if_required phase_validate_git_if_required
  run_phase scan_workspace phase_scan_workspace
  run_phase load_scan_results phase_load_scan_results
  run_phase validate_scan_artifacts phase_validate_scan_artifacts

  write_summary

  section "Workspace scan complete"
  log_info "summary=${ADJUTORIX_WORKSPACE_SCAN_SUMMARY_FILE}"
  log_info "workspace_id=${WORKSPACE_ID} scan_id=${SCAN_ID}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Workspace scan failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
