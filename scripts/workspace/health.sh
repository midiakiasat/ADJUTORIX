#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX WORKSPACE HEALTH ENTRYPOINT
#
# Purpose
# - provide one authoritative shell entrypoint for bounded workspace health
#   evaluation
# - assess a target workspace for accessibility, structural sanity, scale
#   pressure, cache/build residue, risky material hints, and project-manifest
#   coherence using deterministic thresholds and explicit evidence
# - emit a machine-readable health artifact and phase-by-phase report so
#   "workspace is healthy" is a reproducible verdict rather than an intuition
#
# Scope
# - read-only inspection of target workspace contents
# - writes only repo-local reports/artifacts under .tmp
# - no mutation of target workspace files
#
# Design constraints
# - every threshold explicit and overrideable
# - no hidden exclusions or silent health downgrades
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

: "${ADJUTORIX_WORKSPACE_HEALTH_STACK_NAME:=adjutorix-workspace-health}"
: "${ADJUTORIX_WORKSPACE_HEALTH_USE_COLOR:=true}"
: "${ADJUTORIX_WORKSPACE_HEALTH_FAIL_FAST:=true}"
: "${ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_GIT_WORKTREE:=false}"
: "${ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_READABLE:=true}"
: "${ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_WRITABLE:=false}"
: "${ADJUTORIX_WORKSPACE_HEALTH_INCLUDE_HIDDEN:=true}"
: "${ADJUTORIX_WORKSPACE_HEALTH_EXCLUDE_DIRS:=.git,node_modules,.venv,venv,.tmp,dist,build,out,__pycache__,.pytest_cache,.mypy_cache,.ruff_cache,.turbo,.next,.idea,.vscode}"
: "${ADJUTORIX_WORKSPACE_HEALTH_EXCLUDE_FILE_SUFFIXES:=.pyc,.pyo,.DS_Store,.swp,.tmp,.log}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_FILE_COUNT:=200000}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_TOTAL_BYTES:=2147483648}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_LARGE_FILES:=500}"
: "${ADJUTORIX_WORKSPACE_HEALTH_LARGE_FILE_THRESHOLD:=10485760}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_CACHE_BYTES:=1073741824}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_BUILD_OUTPUT_BYTES:=1073741824}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MAX_RISK_MARKERS:=50}"
: "${ADJUTORIX_WORKSPACE_HEALTH_ROOT_TMP:=${REPO_ROOT}/.tmp/workspace-health}"
: "${ADJUTORIX_WORKSPACE_HEALTH_LOG_DIR:=${ADJUTORIX_WORKSPACE_HEALTH_ROOT_TMP}/logs}"
: "${ADJUTORIX_WORKSPACE_HEALTH_REPORT_DIR:=${ADJUTORIX_WORKSPACE_HEALTH_ROOT_TMP}/reports}"
: "${ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR:=${ADJUTORIX_WORKSPACE_HEALTH_ROOT_TMP}/artifacts}"
: "${ADJUTORIX_WORKSPACE_HEALTH_BOOT_LOG:=${ADJUTORIX_WORKSPACE_HEALTH_LOG_DIR}/health.log}"
: "${ADJUTORIX_WORKSPACE_HEALTH_SUMMARY_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_WORKSPACE_HEALTH_PHASE_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_WORKSPACE_HEALTH_JSON_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR}/health.json}"
: "${ADJUTORIX_WORKSPACE_HEALTH_ISSUES_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR}/issues.tsv}"
: "${ADJUTORIX_WORKSPACE_HEALTH_METRICS_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR}/metrics.tsv}"
: "${ADJUTORIX_WORKSPACE_HEALTH_MANIFESTS_FILE:=${ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR}/manifests.tsv}"

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
HEALTH_ID=""
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
HEALTH_STATUS="unknown"
FILE_COUNT="0"
DIR_COUNT="0"
TOTAL_BYTES="0"
LARGE_FILE_COUNT="0"
CACHE_BYTES="0"
BUILD_OUTPUT_BYTES="0"
RISK_MARKER_COUNT="0"
MANIFEST_COUNT="0"
ISSUE_COUNT="0"
SEVERITY_SCORE="0"
GIT_HINT="no"
WRITABLE_HINT="no"

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_WORKSPACE_HEALTH_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_WORKSPACE_HEALTH_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_WORKSPACE_HEALTH_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/workspace/health.sh <workspace-path> [options]

Options:
  --git-required                Require target to be a git worktree
  --writable                    Require target to be writable
  --no-hidden                   Exclude hidden entries from traversal
  --max-file-count <n>          Override file-count threshold
  --max-total-bytes <n>         Override total-bytes threshold
  --max-large-files <n>         Override large-file threshold count
  --large-file-threshold <n>    Bytes threshold for classifying large files
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
        ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_GIT_WORKTREE=true
        ;;
      --writable)
        ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_WRITABLE=true
        ;;
      --no-hidden)
        ADJUTORIX_WORKSPACE_HEALTH_INCLUDE_HIDDEN=false
        ;;
      --max-file-count)
        shift
        [[ $# -gt 0 ]] || die "--max-file-count requires a value"
        ADJUTORIX_WORKSPACE_HEALTH_MAX_FILE_COUNT="$1"
        ;;
      --max-total-bytes)
        shift
        [[ $# -gt 0 ]] || die "--max-total-bytes requires a value"
        ADJUTORIX_WORKSPACE_HEALTH_MAX_TOTAL_BYTES="$1"
        ;;
      --max-large-files)
        shift
        [[ $# -gt 0 ]] || die "--max-large-files requires a value"
        ADJUTORIX_WORKSPACE_HEALTH_MAX_LARGE_FILES="$1"
        ;;
      --large-file-threshold)
        shift
        [[ $# -gt 0 ]] || die "--large-file-threshold requires a value"
        ADJUTORIX_WORKSPACE_HEALTH_LARGE_FILE_THRESHOLD="$1"
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_WORKSPACE_HEALTH_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_WORKSPACE_HEALTH_PHASE_FILE"
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
    if [[ "$ADJUTORIX_WORKSPACE_HEALTH_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_WORKSPACE_HEALTH_LOG_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_HEALTH_REPORT_DIR"
  ensure_dir "$ADJUTORIX_WORKSPACE_HEALTH_ARTIFACT_DIR"
  : >"$ADJUTORIX_WORKSPACE_HEALTH_BOOT_LOG"
  : >"$ADJUTORIX_WORKSPACE_HEALTH_SUMMARY_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_WORKSPACE_HEALTH_PHASE_FILE"
  printf 'issue_code\tseverity\tdetail\tpath\n' >"$ADJUTORIX_WORKSPACE_HEALTH_ISSUES_FILE"
  printf 'metric\tvalue\n' >"$ADJUTORIX_WORKSPACE_HEALTH_METRICS_FILE"
  printf 'kind\tpath\n' >"$ADJUTORIX_WORKSPACE_HEALTH_MANIFESTS_FILE"
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
  HEALTH_ID="$(printf '%s|%s' "$TARGET_CANONICAL" "$START_TS" | shasum -a 256 | awk '{print $1}')"
}

phase_validate_access() {
  if [[ "$ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_READABLE" == "true" ]]; then
    [[ -r "$TARGET_CANONICAL" ]] || die "Target is not readable: $TARGET_CANONICAL"
  fi
  if [[ -w "$TARGET_CANONICAL" ]]; then
    WRITABLE_HINT="yes"
  else
    WRITABLE_HINT="no"
  fi
  if [[ "$ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_WRITABLE" == "true" ]]; then
    [[ "$WRITABLE_HINT" == "yes" ]] || die "Target is not writable: $TARGET_CANONICAL"
  fi
}

phase_validate_git_if_required() {
  if [[ -d "$TARGET_CANONICAL/.git" ]]; then
    GIT_HINT="yes"
  else
    GIT_HINT="no"
  fi
  if [[ "$ADJUTORIX_WORKSPACE_HEALTH_REQUIRE_GIT_WORKTREE" == "true" ]]; then
    git -C "$TARGET_CANONICAL" rev-parse --is-inside-work-tree >/dev/null 2>&1
  fi
}

phase_evaluate_health() {
  python3 - <<'PY' \
    "$TARGET_CANONICAL" \
    "$ADJUTORIX_WORKSPACE_HEALTH_INCLUDE_HIDDEN" \
    "$ADJUTORIX_WORKSPACE_HEALTH_EXCLUDE_DIRS" \
    "$ADJUTORIX_WORKSPACE_HEALTH_EXCLUDE_FILE_SUFFIXES" \
    "$ADJUTORIX_WORKSPACE_HEALTH_LARGE_FILE_THRESHOLD" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_FILE_COUNT" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_TOTAL_BYTES" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_LARGE_FILES" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_CACHE_BYTES" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_BUILD_OUTPUT_BYTES" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MAX_RISK_MARKERS" \
    "$ADJUTORIX_WORKSPACE_HEALTH_ISSUES_FILE" \
    "$ADJUTORIX_WORKSPACE_HEALTH_METRICS_FILE" \
    "$ADJUTORIX_WORKSPACE_HEALTH_MANIFESTS_FILE" \
    "$ADJUTORIX_WORKSPACE_HEALTH_JSON_FILE"
import csv
import json
import os
import sys
from pathlib import Path

root = Path(sys.argv[1])
include_hidden = sys.argv[2].lower() == 'true'
exclude_dirs = {x for x in sys.argv[3].split(',') if x}
exclude_suffixes = {x for x in sys.argv[4].split(',') if x}
large_file_threshold = int(sys.argv[5])
max_file_count = int(sys.argv[6])
max_total_bytes = int(sys.argv[7])
max_large_files = int(sys.argv[8])
max_cache_bytes = int(sys.argv[9])
max_build_output_bytes = int(sys.argv[10])
max_risk_markers = int(sys.argv[11])
issues_file = Path(sys.argv[12])
metrics_file = Path(sys.argv[13])
manifests_file = Path(sys.argv[14])
json_file = Path(sys.argv[15])

manifest_names = {
    'package.json': 'node_package',
    'pyproject.toml': 'python_project',
    'Cargo.toml': 'rust_project',
    'go.mod': 'go_module',
    'requirements.txt': 'python_requirements',
    'Dockerfile': 'dockerfile',
    '.env': 'dotenv',
}
cache_dir_names = {'.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo', '.cache'}
build_dir_names = {'dist', 'build', 'out', '.next'}
risk_suffixes = {'.pem': 'private_material_extension', '.key': 'private_material_extension', '.p12': 'certificate_bundle_extension'}
risk_names = {
    '.env': 'dotenv_present',
    'id_rsa': 'private_ssh_key_name',
    'id_ed25519': 'private_ssh_key_name',
    'secrets.yaml': 'secret_named_file',
    'secrets.yml': 'secret_named_file',
}

file_count = 0
dir_count = 0
total_bytes = 0
large_file_count = 0
cache_bytes = 0
build_output_bytes = 0
manifest_rows = []
risk_rows = []
issues = []
severity_score = 0

for dirpath, dirnames, filenames in os.walk(root):
    rel_dir = os.path.relpath(dirpath, root)
    if rel_dir == '.':
        rel_dir = ''

    original_dirs = list(dirnames)
    filtered_dirs = []
    for d in original_dirs:
        if d in exclude_dirs:
            continue
        if not include_hidden and d.startswith('.'):
            continue
        filtered_dirs.append(d)
    dirnames[:] = filtered_dirs
    dir_count += 1

    current_dir_name = os.path.basename(dirpath)

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
        if current_dir_name in cache_dir_names:
            cache_bytes += size
        if current_dir_name in build_dir_names:
            build_output_bytes += size

        if name in manifest_names:
            manifest_rows.append((manifest_names[name], rel))
        for suffix, risk in risk_suffixes.items():
            if name.endswith(suffix):
                risk_rows.append((risk, rel, f'name_matches:{suffix}'))
        if name in risk_names:
            risk_rows.append((risk_names[name], rel, 'name_match'))

if file_count > max_file_count:
    issues.append(('FILE_COUNT_EXCEEDED', 'error', f'file_count={file_count} max={max_file_count}', '.'))
    severity_score += 3
if total_bytes > max_total_bytes:
    issues.append(('TOTAL_BYTES_EXCEEDED', 'error', f'total_bytes={total_bytes} max={max_total_bytes}', '.'))
    severity_score += 3
if large_file_count > max_large_files:
    issues.append(('LARGE_FILE_COUNT_EXCEEDED', 'warn', f'large_file_count={large_file_count} max={max_large_files}', '.'))
    severity_score += 2
if cache_bytes > max_cache_bytes:
    issues.append(('CACHE_BYTES_EXCEEDED', 'warn', f'cache_bytes={cache_bytes} max={max_cache_bytes}', '.'))
    severity_score += 2
if build_output_bytes > max_build_output_bytes:
    issues.append(('BUILD_OUTPUT_BYTES_EXCEEDED', 'warn', f'build_output_bytes={build_output_bytes} max={max_build_output_bytes}', '.'))
    severity_score += 2
if len(risk_rows) > max_risk_markers:
    issues.append(('RISK_MARKERS_EXCEEDED', 'warn', f'risk_markers={len(risk_rows)} max={max_risk_markers}', '.'))
    severity_score += 2
if len(manifest_rows) == 0:
    issues.append(('NO_PROJECT_MANIFESTS', 'warn', 'no known project manifests discovered', '.'))
    severity_score += 1

if severity_score >= 6:
    health_status = 'unhealthy'
elif severity_score >= 2:
    health_status = 'degraded'
else:
    health_status = 'healthy'

with issues_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows(issues)
with metrics_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows([
        ('file_count', file_count),
        ('dir_count', dir_count),
        ('total_bytes', total_bytes),
        ('large_file_count', large_file_count),
        ('cache_bytes', cache_bytes),
        ('build_output_bytes', build_output_bytes),
        ('risk_marker_count', len(risk_rows)),
        ('manifest_count', len(manifest_rows)),
        ('issue_count', len(issues)),
        ('severity_score', severity_score),
    ])
with manifests_file.open('a', encoding='utf-8', newline='') as fh:
    writer = csv.writer(fh, delimiter='\t')
    writer.writerows(manifest_rows)

payload = {
    'health_status': health_status,
    'file_count': file_count,
    'dir_count': dir_count,
    'total_bytes': total_bytes,
    'large_file_count': large_file_count,
    'cache_bytes': cache_bytes,
    'build_output_bytes': build_output_bytes,
    'risk_marker_count': len(risk_rows),
    'manifest_count': len(manifest_rows),
    'issue_count': len(issues),
    'severity_score': severity_score,
}
json_file.write_text(json.dumps(payload, indent=2), encoding='utf-8')
print(json.dumps(payload))
PY
}

phase_load_health_results() {
  read -r HEALTH_STATUS FILE_COUNT DIR_COUNT TOTAL_BYTES LARGE_FILE_COUNT CACHE_BYTES BUILD_OUTPUT_BYTES RISK_MARKER_COUNT MANIFEST_COUNT ISSUE_COUNT SEVERITY_SCORE < <(python3 - <<'PY' "$ADJUTORIX_WORKSPACE_HEALTH_JSON_FILE"
import json, sys
with open(sys.argv[1], 'r', encoding='utf-8') as fh:
    data = json.load(fh)
print(
    data['health_status'],
    data['file_count'],
    data['dir_count'],
    data['total_bytes'],
    data['large_file_count'],
    data['cache_bytes'],
    data['build_output_bytes'],
    data['risk_marker_count'],
    data['manifest_count'],
    data['issue_count'],
    data['severity_score'],
)
PY
  )
}

phase_validate_artifacts() {
  [[ -f "$ADJUTORIX_WORKSPACE_HEALTH_JSON_FILE" ]] || die "Missing health JSON artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_HEALTH_ISSUES_FILE" ]] || die "Missing issues TSV artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_HEALTH_METRICS_FILE" ]] || die "Missing metrics TSV artifact"
  [[ -f "$ADJUTORIX_WORKSPACE_HEALTH_MANIFESTS_FILE" ]] || die "Missing manifests TSV artifact"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX workspace health summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "target_input: ${TARGET_INPUT}"
    echo "target_canonical: ${TARGET_CANONICAL}"
    echo "target_name: ${TARGET_NAME}"
    echo "workspace_id: ${WORKSPACE_ID}"
    echo "health_id: ${HEALTH_ID}"
    echo "health_status: ${HEALTH_STATUS}"
    echo "git_hint: ${GIT_HINT}"
    echo "writable_hint: ${WRITABLE_HINT}"
    echo "file_count: ${FILE_COUNT}"
    echo "dir_count: ${DIR_COUNT}"
    echo "total_bytes: ${TOTAL_BYTES}"
    echo "large_file_count: ${LARGE_FILE_COUNT}"
    echo "cache_bytes: ${CACHE_BYTES}"
    echo "build_output_bytes: ${BUILD_OUTPUT_BYTES}"
    echo "risk_marker_count: ${RISK_MARKER_COUNT}"
    echo "manifest_count: ${MANIFEST_COUNT}"
    echo "issue_count: ${ISSUE_COUNT}"
    echo "severity_score: ${SEVERITY_SCORE}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - json: ${ADJUTORIX_WORKSPACE_HEALTH_JSON_FILE}"
    echo "  - issues: ${ADJUTORIX_WORKSPACE_HEALTH_ISSUES_FILE}"
    echo "  - metrics: ${ADJUTORIX_WORKSPACE_HEALTH_METRICS_FILE}"
    echo "  - manifests: ${ADJUTORIX_WORKSPACE_HEALTH_MANIFESTS_FILE}"
    echo "  - boot_log: ${ADJUTORIX_WORKSPACE_HEALTH_BOOT_LOG}"
  } >"$ADJUTORIX_WORKSPACE_HEALTH_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX workspace health"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "target_input=${TARGET_INPUT}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase resolve_target phase_resolve_target
  run_phase validate_access phase_validate_access
  run_phase validate_git_if_required phase_validate_git_if_required
  run_phase evaluate_health phase_evaluate_health
  run_phase load_health_results phase_load_health_results
  run_phase validate_artifacts phase_validate_artifacts

  write_summary

  section "Workspace health complete"
  log_info "summary=${ADJUTORIX_WORKSPACE_HEALTH_SUMMARY_FILE}"
  log_info "workspace_id=${WORKSPACE_ID} health_id=${HEALTH_ID} status=${HEALTH_STATUS}"

  if (( OVERALL_FAILURES > 0 )); then
    die "Workspace health failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

main "$@"
