#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX verify-gate bypass discipline guard
#
# Purpose:
# - fail fast when code introduces success/readiness/mutation paths that bypass the governed verify gate
# - detect direct trust of test/shell/diagnostic outcomes without authoritative verify aggregation
# - enforce that replay/apply readiness and verification claims flow only through explicit verify surfaces
# - keep exceptions rare, explicit, and auditable through a narrow allowlist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/verify-gate-bypass.allowlist}"
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
  printf '%s %s\n' "$(color '36' '[adjutorix-verify-gate]')" "$*"
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

# The bias here is deliberate: claiming verify success outside the verify gate is higher risk
# than reviewing a few false positives through the allowlist.
RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "direct-verify-success-flag",
        re.compile(r"\b(?:verifyPassed|verify_passed|isVerified|verified\s*=\s*true|status\s*[:=]\s*[\"\']passed[\"\'])", re.IGNORECASE),
    ),
    (
        "direct-apply-readiness-inference",
        re.compile(r"\b(?:applyReadiness|apply_ready|readyToApply|canApply)\b[^\n]*(?:true|ready|passed)", re.IGNORECASE),
    ),
    (
        "direct-test-command-success-trust",
        re.compile(r"\b(?:npm\s+test|pytest|vitest|jest|cargo\s+test|go\s+test)\b[^\n]*(?:&&|;|then)?[^\n]*(?:apply|ready|verified)", re.IGNORECASE),
    ),
    (
        "direct-shell-exitcode-trust",
        re.compile(r"\b(?:exitCode|returncode|status_code)\b[^\n]*(?:==|===|<=?)\s*0[^\n]*(?:verified|ready|apply)", re.IGNORECASE),
    ),
    (
        "direct-diagnostics-success-trust",
        re.compile(r"\b(?:diagnostics|errors?|warnings?)\b[^\n]*(?:0|none)[^\n]*(?:verified|ready|apply)", re.IGNORECASE),
    ),
    (
        "direct-replay-success-trust",
        re.compile(r"\b(?:replay(?:able)?|lineage|ledger)\b[^\n]*(?:passed|ready|verified)", re.IGNORECASE),
    ),
    (
        "rpc-or-ipc-verify-bypass-surface",
        re.compile(r"\b(?:ipcMain|ipcRenderer|contextBridge|fetch|axios\.|postMessage)\b[^\n]*(?:applyReady|verified|verifyPassed|skipVerify)", re.IGNORECASE),
    ),
    (
        "skip-verify-or-force-ready-flag",
        re.compile(r"\b(?:skipVerify|skip_verify|forceReady|assumeVerified|trustWithoutVerify|noVerify)\b", re.IGNORECASE),
    ),
    (
        "direct-verify-object-construction",
        re.compile(r"\b(?:VerifyResult|verifyResult|verify_result)\b[^\n]*(?:passed|ready|ok)\b", re.IGNORECASE),
    ),
]

SAFE_LINE_PATTERNS = [
    re.compile(r"adjutorix:\s*allow-verify-bypass"),
    re.compile(r"verify-gate-bypass:\s*ignore"),
    re.compile(r"describe\(|test\(|it\("),
    re.compile(r"guard_verify_gate_bypass"),
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
  section "Verify-gate bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No verify-gate-bypass allowlist entries loaded"
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
    ok "No verify-gate bypass violations detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Verify-gate bypass violations detected')"
  printf '  %-32s %-54s %-6s %s\n' 'rule' 'path' 'line' 'code'
  printf '  %-32s %-54s %-6s %s\n' '----' '----' '----' '----'

  for line in "${blocked[@]}"; do
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"
    printf '  %-32s %-54s %-6s %s\n' "$rule" "$path" "$lineno" "$code"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Success/readiness paths were detected that may bypass the governed verify gate."
  fi

  warn "Verify-gate bypass violations detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
