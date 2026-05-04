#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX verify-gate bypass discipline guard
#
# Purpose:
# - fail fast when code introduces success/readiness/mutation paths that bypass the governed verify gate
# - detect direct trust of test/shell/diagnostic outcomes without authoritative verify aggregation
# - enforce that replay/apply readiness and verification claims flow only through explicit verify surfaces
# - keep exceptions rare, explicit, and auditable through a narrow allowlist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/verify-gate-bypass.allowlist}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_verify_gate_bypass/constitution-report.json}"

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


run_constitution_preflight() {
  section "Repository constitution preflight"
  require_cmd node
  [[ -x "$CONSTITUTION_CHECKER" || -f "$CONSTITUTION_CHECKER" ]] || die "Missing constitution checker: $CONSTITUTION_CHECKER"
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT"
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
  "$PYTHON_BIN" - "$@" <<'PY_VERIFY_GATE_SCAN'
from __future__ import annotations

import fnmatch
import re
import subprocess
import sys
from pathlib import Path

allow_patterns = [p for p in sys.argv[1:] if p]

RULES = [
    (
        "skip-verify-or-force-ready-flag",
        re.compile(r"\b(?:skipVerify|skip_verify|forceReady|assumeVerified|trustWithoutVerify|noVerify)\b", re.IGNORECASE),
    ),
    (
        "rpc-or-ipc-verify-bypass-surface",
        re.compile(r"\b(?:ipcMain|ipcRenderer|contextBridge|fetch|axios\.|postMessage)\b[^\n]*(?:applyReady|verified|verifyPassed|skipVerify)", re.IGNORECASE),
    ),
    (
        "direct-test-command-success-trust",
        re.compile(r"\b(?:npm\s+test|pytest|vitest|jest|cargo\s+test|go\s+test)\b[^\n]*(?:&&|;|then)?[^\n]*(?:apply|ready|verified)", re.IGNORECASE),
    ),
    (
        "direct-diagnostics-success-trust",
        re.compile(r"\b(?:diagnostics|errors?|warnings?)\b[^\n]*(?:0|none)[^\n]*(?:verified|ready|apply)", re.IGNORECASE),
    ),
    (
        "direct-verify-object-construction",
        re.compile(r"\b(?:VerifyResult|verifyResult|verify_result)\b[^\n]*(?:passed|ready|ok)\b", re.IGNORECASE),
    ),
]

TEXT_SUFFIXES = {
    ".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".py", ".sh",
    ".ts", ".tsx", ".json", ".yaml", ".yml",
}

SELF = "configs/ci/guard_verify_gate_bypass.sh"

CANONICAL_PREFIXES = (
    "packages/adjutorix-app/src/main/boundary/",
    "packages/adjutorix-app/src/main/governance/",
    "packages/adjutorix-app/src/main/workspace/",
    "packages/adjutorix-app/src/main/ipc/verify_ipc.ts",
    "packages/adjutorix-app/src/renderer/state/",
    "packages/adjutorix-cli/adjutorix_cli/verify.py",
    "packages/adjutorix-cli/adjutorix_cli/governance.py",
    "packages/adjutorix-agent/adjutorix_agent/core/state_machine.py",
)

DERIVED_PREFIXES = (
    ".adjutorix-release/",
    ".tmp/",
    "release/",
    "dist/",
    "build/",
    "out/",
    "coverage/",
    "node_modules/",
)

DERIVED_SEGMENTS = (
    "/dist/",
    "/build/",
    "/out/",
    "/coverage/",
    "/node_modules/",
    "/surface/renderer/assets/",
)

TEST_SEGMENTS = (
    "/tests/",
    "/test/",
    "/fixtures/",
    "/fixture/",
    "/quarantine/",
)

def is_allowed(rule: str, rel: str, line_no: int, code: str) -> bool:
    candidates = [
        rel,
        f"{rule}:{rel}",
        f"{rule}:{rel}:{line_no}",
        f"{rel}:{line_no}",
        code.strip(),
    ]
    return any(fnmatch.fnmatch(candidate, pattern) for pattern in allow_patterns for candidate in candidates)

def is_skipped_path(rel: str) -> bool:
    if rel == SELF:
        return True
    if rel.startswith(DERIVED_PREFIXES):
        return True
    if any(seg in rel for seg in DERIVED_SEGMENTS):
        return True
    if any(seg in rel for seg in TEST_SEGMENTS):
        return True
    if rel.startswith("tests/"):
        return True
    if ".test." in rel or ".spec." in rel or ".pending." in rel:
        return True
    if rel.startswith(CANONICAL_PREFIXES):
        return True
    return False

def is_probably_text(rel: str) -> bool:
    return Path(rel).suffix in TEXT_SUFFIXES

def is_comment_only(line: str) -> bool:
    stripped = line.strip()
    return (
        not stripped
        or stripped.startswith("#")
        or stripped.startswith("//")
        or stripped.startswith("*")
        or stripped.startswith("/*")
        or stripped.startswith("<!--")
    )

def iter_git_files() -> list[str]:
    raw = subprocess.check_output(["git", "ls-files", "-z"])
    return [p.decode("utf-8", "replace") for p in raw.split(b"\0") if p]

violations: list[tuple[str, str, int, str]] = []

for rel in iter_git_files():
    if is_skipped_path(rel) or not is_probably_text(rel):
        continue

    path = Path(rel)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    except FileNotFoundError:
        continue

    for line_no, line in enumerate(text.splitlines(), start=1):
        if is_comment_only(line):
            continue

        for rule, pattern in RULES:
            if not pattern.search(line):
                continue
            code = line.strip()
            if is_allowed(rule, rel, line_no, code):
                continue
            violations.append((rule, rel, line_no, code))

for rule, rel, line_no, code in violations:
    print(f"{rule}\t{rel}\t{line_no}\t{code}")
PY_VERIFY_GATE_SCAN
}


main() {
  section "Verify-gate bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root
run_constitution_preflight

  allow_patterns=()
while IFS= read -r pattern; do
  [[ -z "$pattern" ]] && continue
  allow_patterns+=("$pattern")
done < <(load_allow_patterns)
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

    if matches_allowlist "$path:$lineno:$rule" "${allow_patterns[@]:-}"; then
      continue
    fi
    if matches_allowlist "$path:$rule" "${allow_patterns[@]:-}"; then
      continue
    fi
    if matches_allowlist "$path" "${allow_patterns[@]:-}"; then
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
