#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX scheduler-bypass discipline guard
#
# Purpose:
# - fail fast when code introduces execution paths that bypass the governed scheduler/job system
# - detect direct process spawning, timers, background execution, and ad-hoc async orchestration that can escape
#   authoritative ordering, logging, replay, or cancellation semantics
# - enforce that consequential execution enters through explicit scheduler, queue, job, or policy-bearing surfaces
# - keep exceptions narrow, local, and auditable through an explicit allowlist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/scheduler-bypass.allowlist}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

color() {
  local code="$1"
  shift
  if [[ "$FORCE_COLOR" == "0" ]]; then
    printf '%s' "$*"
  else
    printf '\033[%sm%s\033[0m' "$code" "$*"
  fi
}

log() {
  printf '%s %s\n' "$(color '36' '[adjutorix-scheduler-bypass]')" "$*"
}

ok() {
  printf '%s %s\n' "$(color '32' '[ok]')" "$*"
}

warn() {
  printf '%s %s\n' "$(color '33' '[warn]')" "$*"
}

err() {
  printf '%s %s\n' "$(color '31' '[error]')" "$*" >&2
}

die() {
  err "$*"
  exit 1
}

section() {
  printf '\n%s\n' "$(color '1;37' "== $* ==")"
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_repo_root() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "Missing package.json at repo root"
  [[ -d "$ROOT_DIR/packages" ]] || die "Missing packages/ directory"
}

load_allow_patterns() {
  local patterns=()
  if [[ -f "$ALLOWLIST_FILE" ]]; then
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      [[ "$line" =~ ^[[:space:]]*# ]] && continue
      patterns+=("$line")
    done < "$ALLOWLIST_FILE"
  fi
  printf '%s\n' "${patterns[@]:-}"
}

matches_allowlist() {
  local candidate="$1"
  shift || true
  local pattern
  for pattern in "$@"; do
    [[ -z "$pattern" ]] && continue
    if [[ "$candidate" == $pattern ]]; then
      return 0
    fi
  done
  return 1
}

scan_with_python() {
  "$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import pathlib
import re

ROOT = pathlib.Path.cwd()

INCLUDE_SUFFIXES = {
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".sh",
}

EXCLUDE_PARTS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    ".venv",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "coverage",
    ".nyc_output",
}

# These patterns intentionally bias toward false positives at the edge of process/timer execution.
# The allowlist is the narrow escape hatch; bypassing the scheduler is the larger failure mode.
RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "python-subprocess-direct",
        re.compile(r"\bsubprocess\.(?:run|Popen|call|check_call|check_output)\s*\("),
    ),
    (
        "python-os-system",
        re.compile(r"\bos\.system\s*\("),
    ),
    (
        "python-asyncio-task-bypass",
        re.compile(r"\basyncio\.(?:create_task|ensure_future|gather|wait_for)\s*\("),
    ),
    (
        "python-thread-executor",
        re.compile(r"\b(?:ThreadPoolExecutor|ProcessPoolExecutor|threading\.Thread|multiprocessing\.)"),
    ),
    (
        "python-timer-bypass",
        re.compile(r"\b(?:threading\.Timer|sched\.scheduler|signal\.alarm)\b"),
    ),
    (
        "node-child-process-direct",
        re.compile(r"\b(?:child_process|spawn|exec|execFile|fork|spawnSync|execSync|execFileSync)\s*\("),
    ),
    (
        "node-import-child-process",
        re.compile(r"from\s+["\'](?:node:)?child_process["\']|require\(["\'](?:node:)?child_process["\']\)"),
    ),
    (
        "node-timer-bypass",
        re.compile(r"\b(?:setTimeout|setInterval|queueMicrotask|requestIdleCallback)\s*\("),
    ),
    (
        "node-worker-bypass",
        re.compile(r"\b(?:new\s+Worker|worker_threads|MessageChannel|BroadcastChannel)\b"),
    ),
    (
        "shell-background-exec",
        re.compile(r"(^|[^\w])[^#\n]*\s&\s*(?:$|#)"),
    ),
    (
        "shell-nohup-disown",
        re.compile(r"\b(?:nohup|disown|setsid)\b"),
    ),
    (
        "shell-cron-at-bypass",
        re.compile(r"\b(?:cron|crontab|at|launchctl\s+submit)\b"),
    ),
]

SAFE_LINE_PATTERNS = [
    re.compile(r"adjutorix:\s*allow-scheduler-bypass"),
    re.compile(r"scheduler-bypass:\s*ignore"),
    re.compile(r"describe\(|test\(|it\("),
]

for path in ROOT.rglob("*"):
    if not path.is_file():
        continue
    if any(part in EXCLUDE_PARTS for part in path.parts):
        continue
    if path.suffix not in INCLUDE_SUFFIXES:
        continue
    rel = path.relative_to(ROOT).as_posix()
    text = path.read_text(encoding="utf-8", errors="ignore")
    lines = text.splitlines()
    for idx, line in enumerate(lines, start=1):
        if any(p.search(line) for p in SAFE_LINE_PATTERNS):
            continue
        for rule_name, pattern in RULES:
            if pattern.search(line):
                print(f"{rule_name}\t{rel}\t{idx}\t{line.strip()}")
PY
}

main() {
  section "Scheduler bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No scheduler-bypass allowlist entries loaded"
  fi

  local findings=()
  local blocked=()
  local line rule path lineno code candidate

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    findings+=("$line")
  done < <(scan_with_python)

  for line in "${findings[@]:-}"; do
    [[ -z "$line" ]] && continue
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"

    if matches_allowlist "$path:$lineno:$rule" "${allow_patterns[@]}"; then
      continue
    fi
    if matches_allowlist "$path:$rule" "${allow_patterns[@]}"; then
      continue
    fi
    if matches_allowlist "$path" "${allow_patterns[@]}"; then
      continue
    fi

    blocked+=("$rule"$'\t'"$path"$'\t'"$lineno"$'\t'"$code")
  done

  if [[ "${#blocked[@]}" -eq 0 ]]; then
    ok "No scheduler-bypass violations detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Scheduler-bypass violations detected')"
  printf '  %-28s %-56s %-6s %s\n' 'rule' 'path' 'line' 'code'
  printf '  %-28s %-56s %-6s %s\n' '----' '----' '----' '----'

  for line in "${blocked[@]}"; do
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"
    printf '  %-28s %-56s %-6s %s\n' "$rule" "$path" "$lineno" "$code"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Execution paths were detected that may bypass the governed scheduler/job boundary."
  fi

  warn "Scheduler-bypass violations detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
