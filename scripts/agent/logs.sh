#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX AGENT LOGS ENTRYPOINT
#
# Purpose
# - provide one authoritative entrypoint for inspecting and exporting governed
#   ADJUTORIX agent logs
# - unify log source resolution, raw vs structured views, bounded filtering,
#   follow mode, redaction-safe presentation, and export artifact generation so
#   log inspection is reproducible and operationally trustworthy
# - ensure "agent logs" means a concrete observable surface with explicit scope,
#   not an ad hoc tail of whichever file happens to exist
#
# Scope
# - local log inspection and export only
# - no mutation of source logs except read access
# - report/export artifacts written only under repository .tmp paths
#
# Design constraints
# - no silent fallback between different source logs without recording it
# - no unbounded follow or export without explicit guardrails
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

: "${ADJUTORIX_AGENT_LOGS_STACK_NAME:=adjutorix-agent-logs}"
: "${ADJUTORIX_AGENT_LOGS_USE_COLOR:=true}"
: "${ADJUTORIX_AGENT_LOGS_FAIL_FAST:=true}"
: "${ADJUTORIX_AGENT_LOGS_ROOT_TMP:=${REPO_ROOT}/.tmp/agent}"
: "${ADJUTORIX_AGENT_LOGS_LOG_DIR:=${ADJUTORIX_AGENT_LOGS_ROOT_TMP}/logs}"
: "${ADJUTORIX_AGENT_LOGS_REPORT_DIR:=${ADJUTORIX_AGENT_LOGS_ROOT_TMP}/reports}"
: "${ADJUTORIX_AGENT_LOGS_EXPORT_DIR:=${ADJUTORIX_AGENT_LOGS_REPORT_DIR}/exports}"
: "${ADJUTORIX_AGENT_LOGS_BOOT_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/logs-command.log}"
: "${ADJUTORIX_AGENT_LOGS_SUMMARY_FILE:=${ADJUTORIX_AGENT_LOGS_REPORT_DIR}/logs-summary.txt}"
: "${ADJUTORIX_AGENT_LOGS_PHASE_FILE:=${ADJUTORIX_AGENT_LOGS_REPORT_DIR}/logs-phases.tsv}"
: "${ADJUTORIX_AGENT_LOGS_OUTPUT_FILE:=${ADJUTORIX_AGENT_LOGS_REPORT_DIR}/logs-output.txt}"
: "${ADJUTORIX_AGENT_LOGS_JSON_EXPORT:=${ADJUTORIX_AGENT_LOGS_EXPORT_DIR}/logs-export.json}"
: "${ADJUTORIX_AGENT_LOGS_AGENT_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/agent.log}"
: "${ADJUTORIX_AGENT_LOGS_BOOTSTRAP_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/start.log}"
: "${ADJUTORIX_AGENT_LOGS_STOP_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/stop.log}"
: "${ADJUTORIX_AGENT_LOGS_RESTART_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/restart.log}"
: "${ADJUTORIX_AGENT_LOGS_STATUS_LOG:=${ADJUTORIX_AGENT_LOGS_LOG_DIR}/status.log}"
: "${ADJUTORIX_AGENT_LOGS_DEFAULT_SOURCE:=agent}"
: "${ADJUTORIX_AGENT_LOGS_DEFAULT_VIEW:=auto}"
: "${ADJUTORIX_AGENT_LOGS_DEFAULT_LINES:=200}"
: "${ADJUTORIX_AGENT_LOGS_MAX_EXPORT_LINES:=50000}"
: "${ADJUTORIX_AGENT_LOGS_FOLLOW_POLL_SECONDS:=1}"
: "${ADJUTORIX_AGENT_LOGS_REDACT:=true}"
: "${ADJUTORIX_AGENT_LOGS_SHOW_PATHS:=true}"
: "${ADJUTORIX_AGENT_LOGS_INCLUDE_TIMESTAMPS:=true}"
: "${ADJUTORIX_AGENT_LOGS_ASSUME_JSONL:=auto}"
: "${ADJUTORIX_AGENT_LOGS_LEVEL_FILTER:=}"
: "${ADJUTORIX_AGENT_LOGS_GREP_FILTER:=}"
: "${ADJUTORIX_AGENT_LOGS_SINCE:=}"
: "${ADJUTORIX_AGENT_LOGS_UNTIL:=}"
: "${ADJUTORIX_AGENT_LOGS_SOURCE:=${ADJUTORIX_AGENT_LOGS_DEFAULT_SOURCE}}"
: "${ADJUTORIX_AGENT_LOGS_VIEW:=${ADJUTORIX_AGENT_LOGS_DEFAULT_VIEW}}"
: "${ADJUTORIX_AGENT_LOGS_LINES:=${ADJUTORIX_AGENT_LOGS_DEFAULT_LINES}}"
: "${ADJUTORIX_AGENT_LOGS_FOLLOW:=false}"
: "${ADJUTORIX_AGENT_LOGS_EXPORT:=false}"

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
OVERALL_FAILURES=0
PHASE_INDEX=0
PHASE_RESULTS=()
SELECTED_SOURCE=""
SELECTED_LOG_FILE=""
SELECTED_LOG_KIND=""
SOURCE_EXISTS="no"
SOURCE_SIZE_BYTES="0"
DETECTED_FORMAT="unknown"
FILTERED_LINE_COUNT="0"
OUTPUT_LINE_COUNT="0"
EXPORT_WRITTEN="no"
FOLLOW_MODE_ACTIVE="no"
LOG_PREVIEW_FILE=""

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_AGENT_LOGS_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_AGENT_LOGS_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_AGENT_LOGS_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/agent/logs.sh [options]

Options:
  --source <name>               agent | start | stop | restart | status | auto
  --view <mode>                 auto | raw | structured
  --lines <n>                   Number of trailing lines to include
  --level <name>                Filter structured logs by level value
  --grep <pattern>              Filter output by substring/regex via grep -E
  --since <iso8601>             Include only entries at/after timestamp hint
  --until <iso8601>             Include only entries at/before timestamp hint
  --follow                      Follow log output continuously
  --export                      Write filtered/export artifact JSON as well
  --no-redact                   Disable presentation redaction
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logs
  --help                        Show this help
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --source)
        shift
        [[ $# -gt 0 ]] || die "--source requires a value"
        ADJUTORIX_AGENT_LOGS_SOURCE="$1"
        ;;
      --view)
        shift
        [[ $# -gt 0 ]] || die "--view requires a value"
        ADJUTORIX_AGENT_LOGS_VIEW="$1"
        ;;
      --lines)
        shift
        [[ $# -gt 0 ]] || die "--lines requires a value"
        ADJUTORIX_AGENT_LOGS_LINES="$1"
        ;;
      --level)
        shift
        [[ $# -gt 0 ]] || die "--level requires a value"
        ADJUTORIX_AGENT_LOGS_LEVEL_FILTER="$1"
        ;;
      --grep)
        shift
        [[ $# -gt 0 ]] || die "--grep requires a value"
        ADJUTORIX_AGENT_LOGS_GREP_FILTER="$1"
        ;;
      --since)
        shift
        [[ $# -gt 0 ]] || die "--since requires a value"
        ADJUTORIX_AGENT_LOGS_SINCE="$1"
        ;;
      --until)
        shift
        [[ $# -gt 0 ]] || die "--until requires a value"
        ADJUTORIX_AGENT_LOGS_UNTIL="$1"
        ;;
      --follow)
        ADJUTORIX_AGENT_LOGS_FOLLOW=true
        ;;
      --export)
        ADJUTORIX_AGENT_LOGS_EXPORT=true
        ;;
      --no-redact)
        ADJUTORIX_AGENT_LOGS_REDACT=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_AGENT_LOGS_USE_COLOR=false
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
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_AGENT_LOGS_PHASE_FILE"
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
    if [[ "$ADJUTORIX_AGENT_LOGS_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

redact_stream() {
  python - <<'PY'
import re, sys
patterns = [
    (re.compile(r'sk-[A-Za-z0-9]{20,}'), 'sk-****REDACTED****'),
    (re.compile(r'github_pat_[A-Za-z0-9_]{20,}'), 'github_pat_****REDACTED****'),
    (re.compile(r'AKIA[0-9A-Z]{16}'), 'AKIA****REDACTED****'),
    (re.compile(r'(?i)bearer\s+[A-Za-z0-9._\-]+'), 'Bearer ****REDACTED****'),
    (re.compile(r'(?i)(password|passphrase)\s*[:=]\s*\S+'), r'\1=****REDACTED****'),
    (re.compile(r'-----BEGIN [A-Z ]+PRIVATE KEY-----'), '-----BEGIN PRIVATE KEY REDACTED-----'),
]
for line in sys.stdin:
    for rx, repl in patterns:
        line = rx.sub(repl, line)
    sys.stdout.write(line)
PY
}

###############################################################################
# PHASES
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_AGENT_LOGS_LOG_DIR"
  ensure_dir "$ADJUTORIX_AGENT_LOGS_REPORT_DIR"
  ensure_dir "$ADJUTORIX_AGENT_LOGS_EXPORT_DIR"
  : >"$ADJUTORIX_AGENT_LOGS_BOOT_LOG"
  : >"$ADJUTORIX_AGENT_LOGS_SUMMARY_FILE"
  : >"$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_AGENT_LOGS_PHASE_FILE"
  LOG_PREVIEW_FILE="${ADJUTORIX_AGENT_LOGS_REPORT_DIR}/preview.txt"
}

phase_repo_and_toolchain() {
  require_command python
  require_command grep
  require_command tail
  require_command sed
  [[ -d "$REPO_ROOT" ]] || die "Repository root not found: $REPO_ROOT"
}

phase_select_source() {
  case "$ADJUTORIX_AGENT_LOGS_SOURCE" in
    agent)
      SELECTED_SOURCE="agent"
      SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_AGENT_LOG"
      SELECTED_LOG_KIND="runtime"
      ;;
    start)
      SELECTED_SOURCE="start"
      SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_BOOTSTRAP_LOG"
      SELECTED_LOG_KIND="lifecycle"
      ;;
    stop)
      SELECTED_SOURCE="stop"
      SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_STOP_LOG"
      SELECTED_LOG_KIND="lifecycle"
      ;;
    restart)
      SELECTED_SOURCE="restart"
      SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_RESTART_LOG"
      SELECTED_LOG_KIND="lifecycle"
      ;;
    status)
      SELECTED_SOURCE="status"
      SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_STATUS_LOG"
      SELECTED_LOG_KIND="inspection"
      ;;
    auto)
      for candidate in "$ADJUTORIX_AGENT_LOGS_AGENT_LOG" "$ADJUTORIX_AGENT_LOGS_RESTART_LOG" "$ADJUTORIX_AGENT_LOGS_BOOTSTRAP_LOG"; do
        if [[ -f "$candidate" && -s "$candidate" ]]; then
          SELECTED_LOG_FILE="$candidate"
          break
        fi
      done
      [[ -n "$SELECTED_LOG_FILE" ]] || SELECTED_LOG_FILE="$ADJUTORIX_AGENT_LOGS_AGENT_LOG"
      case "$SELECTED_LOG_FILE" in
        "$ADJUTORIX_AGENT_LOGS_AGENT_LOG") SELECTED_SOURCE="agent"; SELECTED_LOG_KIND="runtime" ;;
        "$ADJUTORIX_AGENT_LOGS_RESTART_LOG") SELECTED_SOURCE="restart"; SELECTED_LOG_KIND="lifecycle" ;;
        "$ADJUTORIX_AGENT_LOGS_BOOTSTRAP_LOG") SELECTED_SOURCE="start"; SELECTED_LOG_KIND="lifecycle" ;;
        *) SELECTED_SOURCE="custom"; SELECTED_LOG_KIND="unknown" ;;
      esac
      ;;
    *)
      die "Unknown log source: ${ADJUTORIX_AGENT_LOGS_SOURCE}"
      ;;
  esac
}

phase_inspect_source() {
  if [[ -f "$SELECTED_LOG_FILE" ]]; then
    SOURCE_EXISTS="yes"
    SOURCE_SIZE_BYTES="$(wc -c < "$SELECTED_LOG_FILE" | tr -d ' ')"
  else
    SOURCE_EXISTS="no"
    SOURCE_SIZE_BYTES="0"
    die "Selected log source does not exist: $SELECTED_LOG_FILE"
  fi

  DETECTED_FORMAT="$(python - <<'PY' "$SELECTED_LOG_FILE" "$ADJUTORIX_AGENT_LOGS_ASSUME_JSONL"
import json, sys
path = sys.argv[1]
mode = sys.argv[2]
if mode not in {'auto', 'true', 'false'}:
    mode = 'auto'
with open(path, 'r', encoding='utf-8', errors='replace') as fh:
    lines = [fh.readline().strip() for _ in range(5)]
lines = [x for x in lines if x]
fmt = 'raw'
if mode == 'true':
    fmt = 'jsonl'
elif mode == 'false':
    fmt = 'raw'
else:
    ok = 0
    for line in lines:
        try:
            obj = json.loads(line)
            if isinstance(obj, dict):
                ok += 1
        except Exception:
            pass
    if lines and ok == len(lines):
        fmt = 'jsonl'
print(fmt)
PY
)"
}

phase_render_output() {
  python - <<'PY' \
    "$SELECTED_LOG_FILE" \
    "$DETECTED_FORMAT" \
    "$ADJUTORIX_AGENT_LOGS_VIEW" \
    "$ADJUTORIX_AGENT_LOGS_LINES" \
    "$ADJUTORIX_AGENT_LOGS_LEVEL_FILTER" \
    "$ADJUTORIX_AGENT_LOGS_GREP_FILTER" \
    "$ADJUTORIX_AGENT_LOGS_SINCE" \
    "$ADJUTORIX_AGENT_LOGS_UNTIL" \
    "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE"
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
detected = sys.argv[2]
view = sys.argv[3]
max_lines = int(sys.argv[4])
level_filter = sys.argv[5]
grep_filter = sys.argv[6]
since = sys.argv[7]
until = sys.argv[8]
out_path = Path(sys.argv[9])

pattern = re.compile(grep_filter) if grep_filter else None
rows = []

with path.open('r', encoding='utf-8', errors='replace') as fh:
    raw_lines = fh.readlines()

for raw in raw_lines:
    line = raw.rstrip('\n')
    if detected == 'jsonl':
        try:
            obj = json.loads(line)
        except Exception:
            obj = None
        if isinstance(obj, dict):
            ts = str(obj.get('timestamp', obj.get('time', '')))
            lvl = str(obj.get('level', ''))
            msg = str(obj.get('message', obj.get('msg', line)))
            if level_filter and lvl.lower() != level_filter.lower():
                continue
            if since and ts and ts < since:
                continue
            if until and ts and ts > until:
                continue
            rendered = line
            if view in {'auto', 'structured'}:
                rendered = f"[{ts}] [{lvl}] {msg}".strip()
            if pattern and not pattern.search(rendered):
                continue
            rows.append(rendered)
            continue
    if pattern and not pattern.search(line):
        continue
    rows.append(line)

rows = rows[-max_lines:]
out_path.write_text('\n'.join(rows) + ('\n' if rows else ''), encoding='utf-8')
print(len(rows))
PY
  FILTERED_LINE_COUNT="$(wc -l < "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE" | tr -d ' ')"
  OUTPUT_LINE_COUNT="$FILTERED_LINE_COUNT"

  if [[ "$ADJUTORIX_AGENT_LOGS_REDACT" == "true" ]]; then
    local tmp_redacted="${ADJUTORIX_AGENT_LOGS_OUTPUT_FILE}.redacted"
    redact_stream < "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE" > "$tmp_redacted"
    mv "$tmp_redacted" "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE"
  fi

  cp "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE" "$LOG_PREVIEW_FILE"
}

phase_export_if_requested() {
  if [[ "$ADJUTORIX_AGENT_LOGS_EXPORT" != "true" ]]; then
    EXPORT_WRITTEN="no"
    return 0
  fi

  local current_lines
  current_lines="$(wc -l < "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE" | tr -d ' ')"
  if (( current_lines > ADJUTORIX_AGENT_LOGS_MAX_EXPORT_LINES )); then
    die "Filtered output exceeds export safety ceiling: ${current_lines} > ${ADJUTORIX_AGENT_LOGS_MAX_EXPORT_LINES}"
  fi

  python - <<'PY' \
    "$ADJUTORIX_AGENT_LOGS_JSON_EXPORT" \
    "$SELECTED_SOURCE" \
    "$SELECTED_LOG_FILE" \
    "$SELECTED_LOG_KIND" \
    "$DETECTED_FORMAT" \
    "$ADJUTORIX_AGENT_LOGS_VIEW" \
    "$ADJUTORIX_AGENT_LOGS_LEVEL_FILTER" \
    "$ADJUTORIX_AGENT_LOGS_GREP_FILTER" \
    "$ADJUTORIX_AGENT_LOGS_SINCE" \
    "$ADJUTORIX_AGENT_LOGS_UNTIL" \
    "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE"
import json
import sys
from pathlib import Path

export_path = Path(sys.argv[1])
output_file = Path(sys.argv[11])
lines = output_file.read_text(encoding='utf-8', errors='replace').splitlines()
payload = {
    'source': sys.argv[2],
    'log_file': sys.argv[3],
    'log_kind': sys.argv[4],
    'detected_format': sys.argv[5],
    'view': sys.argv[6],
    'level_filter': sys.argv[7],
    'grep_filter': sys.argv[8],
    'since': sys.argv[9],
    'until': sys.argv[10],
    'line_count': len(lines),
    'lines': lines,
}
export_path.write_text(json.dumps(payload, indent=2), encoding='utf-8')
PY

  EXPORT_WRITTEN="yes"
}

phase_emit_output() {
  if [[ "$QUIET" != "true" ]]; then
    cat "$ADJUTORIX_AGENT_LOGS_OUTPUT_FILE"
  fi
}

phase_follow_if_requested() {
  if [[ "$ADJUTORIX_AGENT_LOGS_FOLLOW" != "true" ]]; then
    return 0
  fi
  FOLLOW_MODE_ACTIVE="yes"
  tail -n 0 -f "$SELECTED_LOG_FILE"
}

###############################################################################
# SUMMARY
###############################################################################

write_summary() {
  {
    echo "ADJUTORIX agent logs summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "selected_source: ${SELECTED_SOURCE}"
    echo "selected_log_file: ${SELECTED_LOG_FILE}"
    echo "selected_log_kind: ${SELECTED_LOG_KIND}"
    echo "source_exists: ${SOURCE_EXISTS}"
    echo "source_size_bytes: ${SOURCE_SIZE_BYTES}"
    echo "detected_format: ${DETECTED_FORMAT}"
    echo "view: ${ADJUTORIX_AGENT_LOGS_VIEW}"
    echo "level_filter: ${ADJUTORIX_AGENT_LOGS_LEVEL_FILTER}"
    echo "grep_filter: ${ADJUTORIX_AGENT_LOGS_GREP_FILTER}"
    echo "since: ${ADJUTORIX_AGENT_LOGS_SINCE}"
    echo "until: ${ADJUTORIX_AGENT_LOGS_UNTIL}"
    echo "filtered_line_count: ${FILTERED_LINE_COUNT}"
    echo "export_written: ${EXPORT_WRITTEN}"
    echo "follow_mode_active: ${FOLLOW_MODE_ACTIVE}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
    echo
    echo "artifacts:"
    echo "  - boot_log: ${ADJUTORIX_AGENT_LOGS_BOOT_LOG}"
    echo "  - summary: ${ADJUTORIX_AGENT_LOGS_SUMMARY_FILE}"
    echo "  - phases: ${ADJUTORIX_AGENT_LOGS_PHASE_FILE}"
    echo "  - output: ${ADJUTORIX_AGENT_LOGS_OUTPUT_FILE}"
    echo "  - preview: ${LOG_PREVIEW_FILE}"
    if [[ "$EXPORT_WRITTEN" == "yes" ]]; then
      echo "  - json_export: ${ADJUTORIX_AGENT_LOGS_JSON_EXPORT}"
    fi
  } >"$ADJUTORIX_AGENT_LOGS_SUMMARY_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX agent logs"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "requested_source=${ADJUTORIX_AGENT_LOGS_SOURCE} view=${ADJUTORIX_AGENT_LOGS_VIEW}"

  run_phase repo_and_toolchain phase_repo_and_toolchain
  run_phase select_source phase_select_source
  run_phase inspect_source phase_inspect_source
  run_phase render_output phase_render_output
  run_phase export_if_requested phase_export_if_requested
  run_phase emit_output phase_emit_output

  write_summary

  section "Agent logs ready"
  log_info "summary=${ADJUTORIX_AGENT_LOGS_SUMMARY_FILE}"
  log_info "output=${ADJUTORIX_AGENT_LOGS_OUTPUT_FILE}"

  if [[ "$ADJUTORIX_AGENT_LOGS_FOLLOW" == "true" ]]; then
    run_phase follow_if_requested phase_follow_if_requested
  fi

  if (( OVERALL_FAILURES > 0 )); then
    die "Agent logs command failed with ${OVERALL_FAILURES} failed phase(s)"
  fi
}

mai