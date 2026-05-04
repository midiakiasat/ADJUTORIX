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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_scheduler_bypass/constitution-report.json}"

run_constitution_preflight() {
  printf '\n== Repository constitution preflight ==\n'
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "[error] Required command not found: node" >&2
    return 1
  fi
  if [[ ! -x "$CONSTITUTION_CHECKER" ]]; then
    printf '%s\n' "[error] Missing executable constitution checker: $CONSTITUTION_CHECKER" >&2
    return 1
  fi
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --root "$ROOT_DIR" --json --out "$CONSTITUTION_REPORT"
}

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

import os
import pathlib
import re
import subprocess
import sys

ROOT = pathlib.Path(sys.argv[1]).resolve()

SCAN_SUFFIXES = {
    ".bash",
    ".cjs",
    ".js",
    ".mjs",
    ".py",
    ".sh",
    ".ts",
    ".tsx",
    ".zsh",
}

DERIVED_OR_TOOLCHAIN_PREFIXES = (
    ".adjutorix-release/",
    ".git/",
    ".tmp/",
    "coverage/",
    "dist/",
    "node_modules/",
    "packages/adjutorix-app/dist/",
    "packages/adjutorix-app/out/",
    "packages/adjutorix-app/release/",
)

TEST_PREFIX_PARTS = (
    "/tests/",
    "tests/",
)

AUTHORIZED_SCHEDULER_SURFACES = (
    "configs/ci/guard_scheduler_bypass.sh",
    "scripts/dev.sh",
    "scripts/smoke.sh",
    "scripts/package-macos.sh",
    "scripts/agent/start.sh",
    "scripts/agent/restart.sh",
    "scripts/adjutorix-constitution-check.mjs",
    "packages/adjutorix-app/scripts/",
    "packages/adjutorix-app/src/main/",
    "packages/adjutorix-agent/adjutorix_agent/core/scheduler.py",
    "packages/adjutorix-agent/adjutorix_agent/core/isolated_workspace.py",
    "packages/adjutorix-agent/adjutorix_agent/governance/command_guard.py",
    "packages/adjutorix-agent/adjutorix_agent/runtime/bootstrap.py",
    "packages/adjutorix-agent/adjutorix_agent/observability/",
)

PATTERNS_BY_FAMILY: list[tuple[str, tuple[str, ...], re.Pattern[str]]] = [
    (
        "shell-background-exec",
        (".bash", ".sh", ".zsh"),
        re.compile(r"(?:^|[;\s])(?:\)|\}|\w+)\s*(?:>>?|2>)?[^\n]*\s&\s*(?:#.*)?$"),
    ),
    (
        "shell-nohup-disown",
        (".bash", ".sh", ".zsh"),
        re.compile(r"\b(?:nohup|disown|setsid)\b"),
    ),
    (
        "shell-cron-at-bypass",
        (".bash", ".sh", ".zsh"),
        re.compile(r"(?:\b(?:cron|crontab)\b|(?:^|[;&|()]|\s)at\s+|\blaunchctl\s+submit\b)"),
    ),
    (
        "node-import-child-process",
        (".cjs", ".js", ".mjs", ".ts", ".tsx"),
        re.compile(r"from\s+['\"](?:node:)?child_process['\"]|require\(['\"](?:node:)?child_process['\"]\)"),
    ),
    (
        "node-child-process-direct",
        (".cjs", ".js", ".mjs", ".ts", ".tsx"),
        re.compile(r"\b(?:child_process\.)?(?:spawn|execFile|fork|spawnSync|execSync|execFileSync)\s*\("),
    ),
    (
        "node-worker-bypass",
        (".cjs", ".js", ".mjs", ".ts", ".tsx"),
        re.compile(r"\b(?:new\s+Worker|worker_threads|MessageChannel|BroadcastChannel)\b"),
    ),
    (
        "node-timer-bypass",
        (".cjs", ".js", ".mjs", ".ts", ".tsx"),
        re.compile(r"\b(?:setTimeout|setInterval)\s*\("),
    ),
    (
        "python-subprocess-direct",
        (".py",),
        re.compile(r"\bsubprocess\.(?:Popen|run|call|check_call|check_output)\s*\("),
    ),
    (
        "python-os-system",
        (".py",),
        re.compile(r"\bos\.system\s*\("),
    ),
    (
        "python-thread-executor",
        (".py",),
        re.compile(r"\b(?:ThreadPoolExecutor|ProcessPoolExecutor|threading\.Thread|multiprocessing\.)"),
    ),
    (
        "python-asyncio-task-bypass",
        (".py",),
        re.compile(r"\b(?:asyncio\.create_task|asyncio\.ensure_future|asyncio\.gather)\s*\("),
    ),
]


def rel(path: pathlib.Path) -> str:
    return path.relative_to(ROOT).as_posix()


def is_derived_or_toolchain(path: str) -> bool:
    return path.startswith(DERIVED_OR_TOOLCHAIN_PREFIXES)


def is_test_surface(path: str) -> bool:
    return path.startswith(TEST_PREFIX_PARTS) or any(part in path for part in TEST_PREFIX_PARTS)


def is_authorized_scheduler_surface(path: str) -> bool:
    if is_test_surface(path):
        return True
    return any(path == prefix or path.startswith(prefix) for prefix in AUTHORIZED_SCHEDULER_SURFACES)


def tracked_files() -> list[pathlib.Path]:
    try:
        raw = subprocess.check_output(
            ["git", "ls-files"],
            cwd=ROOT,
            text=True,
            stderr=subprocess.DEVNULL,
        )
        files = [ROOT / line for line in raw.splitlines() if line]
    except Exception:
        files = [p for p in ROOT.rglob("*") if p.is_file()]
    return sorted(files, key=lambda p: p.as_posix())


def should_scan(path: pathlib.Path) -> bool:
    if not path.is_file():
        return False
    r = rel(path)
    if is_derived_or_toolchain(r):
        return False
    if path.suffix not in SCAN_SUFFIXES:
        return False
    return True


findings: list[tuple[str, str, int, str]] = []

for path in tracked_files():
    if not should_scan(path):
        continue

    r = rel(path)
    try:
        text = path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        continue

    for lineno, line in enumerate(text.splitlines(), 1):
        stripped = line.strip()
        if not stripped:
            continue

        for rule, suffixes, pattern in PATTERNS_BY_FAMILY:
            if path.suffix not in suffixes:
                continue
            if not pattern.search(line):
                continue
            if is_authorized_scheduler_surface(r):
                continue

            findings.append((rule, r, lineno, stripped))

for rule, path, lineno, code in findings:
    print(f"{rule}\t{path}\t{lineno}\t{code}")

PY
}

main() {
  run_constitution_preflight
  section "Scheduler bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root

  allow_patterns=()
  while IFS= read -r __adjutorix_allow_patterns_line; do
    allow_patterns+=("$__adjutorix_allow_patterns_line")
  done < <(load_allow_patterns)
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
