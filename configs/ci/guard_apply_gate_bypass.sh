#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX apply-gate bypass discipline guard
#
# Purpose:
# - fail fast when code introduces mutation/apply paths that bypass the governed apply gate
# - detect direct patch application, file mutation, workspace mutation, or implicit confirmation flows
#   outside the explicit apply-review-confirm boundary
# - enforce that every consequential apply-like action remains visible, confirmable, and policy-bearing
# - keep exceptions rare and auditable through a narrow allowlist rather than implicit convention

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/apply-gate-bypass.allowlist}"
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
  printf '%s %s\n' "$(color '36' '[adjutorix-apply-gate]')" "$*"
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

# Bias toward catching suspicious mutation/apply vocabulary and direct patch execution.
# The bigger failure mode is bypass, so false positives are preferable to silent drift.
RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "direct-apply-method-call",
        re.compile(r"\b(?:applyPatch|apply_patch|patch\.apply|workspace\.apply|applyChanges|apply_changes)\s*\("),
    ),
    (
        "direct-git-apply",
        re.compile(r"\bgit\s+(?:apply|am|checkout|restore)\b|\b(?:exec|spawn|run)\s*\([^\n]*git\s+(?:apply|am|checkout|restore)"),
    ),
    (
        "direct-diff-write",
        re.compile(r"\b(?:writeFile|write_text|write_bytes|open\([^\n]*["\']w|patch_text|replace\()"),
    ),
    (
        "workspace-mutation-without-confirm",
        re.compile(r"\b(?:mutateWorkspace|writeWorkspace|deleteFile|removeFile|renameFile|replaceFile)\s*\("),
    ),
    (
        "confirmation-bypass-flag",
        re.compile(r"\b(?:autoApply|forceApply|skipConfirm|skipConfirmation|confirmed\s*=\s*True|confirmed:\s*true)\b"),
    ),
    (
        "shell-apply-command",
        re.compile(r"\b(?:patch\s+-p[0-9]|sed\s+-i|perl\s+-pi|ed\s+|tee\s+[^|]*$)"),
    ),
    (
        "ipc-apply-surface",
        re.compile(r"\b(?:ipcMain|ipcRenderer|contextBridge)[^\n]*(?:apply|write|mutate|delete)"),
    ),
    (
        "http-apply-surface",
        re.compile(r"\b(?:POST|post|get|fetch|axios\.)[^\n]*(?:/apply|applyReadiness|patch/apply|workspace/write)"),
    ),
]

SAFE_LINE_PATTERNS = [
    re.compile(r"adjutorix:\s*allow-apply-bypass"),
    re.compile(r"apply-gate-bypass:\s*ignore"),
    re.compile(r"describe\(|test\(|it\("),
    re.compile(r"guard_apply_gate_bypass"),
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
  section "Apply-gate bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No apply-gate-bypass allowlist entries loaded"
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
    ok "No apply-gate bypass violations detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Apply-gate bypass violations detected')"
  printf '  %-30s %-54s %-6s %s\n' 'rule' 'path' 'line' 'code'
  printf '  %-30s %-54s %-6s %s\n' '----' '----' '----' '----'

  for line in "${blocked[@]}"; do
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"
    printf '  %-30s %-54s %-6s %s\n' "$rule" "$path" "$lineno" "$code"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Mutation/apply paths were detected that may bypass the governed apply gate."
  fi

  warn "Apply-gate bypass violations detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
