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

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT_DIR"

readonly SCRIPT_DIR
readonly ROOT_DIR

CONSTITUTION_CHECKER="${ROOT_DIR}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT_DIR}/.tmp/ci/guard_apply_gate_bypass/constitution-report.json"
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
  "$PYTHON_BIN" - "$ROOT_DIR" "$ALLOWLIST_FILE" <<'PY_SCAN'
import fnmatch
import re
import os
import subprocess
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
allowlist_file = Path(sys.argv[2])

def load_allow_patterns():
    if not allowlist_file.exists():
        return []
    out = []
    for raw in allowlist_file.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line or line.startswith("#"):
            continue
        out.append(line)
    return out

allow_patterns = load_allow_patterns()


SCAN_SUFFIXES = (
    ".sh",
    ".py",
    ".js",
    ".jsx",
    ".cjs",
    ".mjs",
    ".ts",
    ".tsx",
)

CANONICAL_APPLY_SURFACES = {
    "configs/ci/guard_verify_gate_bypass.sh",
    "scripts/patch/apply.sh",
    "scripts/patch/validate.sh",
    "scripts/contracts/freeze.sh",
    "packages/adjutorix-app/src/main/index.ts",
    "packages/adjutorix-app/src/main/runtime/bootstrap.ts",
    "packages/adjutorix-app/src/main/ipc/patch_ipc.ts",
    "packages/adjutorix-app/src/preload/exposed_api.ts",
    "packages/adjutorix-app/src/renderer/bootstrap/createRendererRuntime.ts",
    "packages/adjutorix-cli/adjutorix_cli/main.py",
}

CANONICAL_APPLY_PREFIXES = (
    "packages/adjutorix-app/src/main/boundary/",
    "packages/adjutorix-app/src/main/governance/",
    "packages/adjutorix-app/src/main/workspace/",
    "packages/adjutorix-agent/adjutorix_agent/governance/",
    "packages/adjutorix-agent/adjutorix_agent/server/",
    "packages/adjutorix-agent/adjutorix_agent/tests/",
    "packages/adjutorix-agent/tests/",
    "packages/adjutorix-app/tests/",
    "packages/shared/src/observability/",
    "packages/shared/src/rpc/",
    "packages/shared/src/runtime/",
    "tests/invariants/",
)

RULES = (
    ("direct-git-apply", re.compile(r"\bgit\s+apply\b")),
    ("direct-apply-method-call", re.compile(r"\b(?:applyPatch|apply_patch|patch\.apply|workspace\.apply|applyChanges|apply_changes)\b")),
    ("confirmation-bypass-flag", re.compile(r"\b(?:autoApply|forceApply|skipConfirm|skipConfirmation|confirmed\s*=\s*True|confirmed:\s*true)\b")),
    ("ipc-apply-surface", re.compile(r"\b(?:ipcMain|ipcRenderer|contextBridge)\b[^\n]*(?:apply|mutate|delete)")),
    ("http-apply-surface", re.compile(r"\b(?:POST|post|fetch|axios\.)\b[^\n]*(?:/apply|applyReadiness|patch/apply|workspace/write)")),
)


CONSTITUTION_SCAN_SKIP_STRATA = {"authority/tests", "ephemeral/runtime", "derived/build", "release/distributable", "forbidden"}
CONSTITUTION_STRATUM_CACHE = {}
APPLY_GATE_GUARD_SELF = "configs/ci/guard_apply_gate_bypass.sh"

def constitution_root():
    env_root = os.environ.get("ROOT_DIR")
    if env_root:
        return env_root
    return subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()

def constitution_stratum_for_path(rel):
    normalized = rel.replace("\\", "/").lstrip("./")
    cached = CONSTITUTION_STRATUM_CACHE.get(normalized)
    if cached is not None:
        return cached

    root = constitution_root()
    classifier = str(Path(root) / "scripts/lib/constitution-classifier.mjs")
    try:
        value = subprocess.check_output(
            ["node", classifier, root, normalized],
            text=True,
            stderr=subprocess.DEVNULL,
        ).strip() or "unclassified"
    except Exception:
        value = "unclassified"

    CONSTITUTION_STRATUM_CACHE[normalized] = value
    return value

def is_skipped_path(rel):
    if rel == APPLY_GATE_GUARD_SELF:
        return True
    stratum = constitution_stratum_for_path(rel)
    return stratum in CONSTITUTION_SCAN_SKIP_STRATA


def is_canonical_apply_surface(rel):
    return rel in CANONICAL_APPLY_SURFACES or any(rel.startswith(prefix) for prefix in CANONICAL_APPLY_PREFIXES)

def is_allowed(candidate):
    return any(fnmatch.fnmatch(candidate, pattern) for pattern in allow_patterns)

def code_line_only(line):
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.startswith(("#", "//", "/*", "*", "*/")):
        return False
    return True

def git_ls_files():
    proc = subprocess.run(
        ["git", "-C", str(root), "ls-files"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return [line for line in proc.stdout.splitlines() if line]

for rel in git_ls_files():
    if is_skipped_path(rel):
        continue
    if is_canonical_apply_surface(rel):
        continue
    if not rel.endswith(SCAN_SUFFIXES):
        continue
    if is_allowed(rel):
        continue

    p = root / rel
    try:
        content = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        continue

    for idx, line in enumerate(content.splitlines(), start=1):
        if not code_line_only(line):
            continue
        for rule, pattern in RULES:
            if pattern.search(line):
                candidate = f"{rel}:{idx}:{rule}"
                if is_allowed(candidate):
                    continue
                print(f"{rule}\t{rel}\t{idx}\t{line.strip()[:240]}")
                break
PY_SCAN
}


main() {
  section "Repository constitution preflight"
  require_cmd node
  [[ -x "$CONSTITUTION_CHECKER" ]] || die "Missing executable constitution checker: $CONSTITUTION_CHECKER"
  run_constitution_output="$(node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT")"
  printf '%s\n' "$run_constitution_output"

  section "Apply-gate bypass discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_repo_root

  local allow_patterns=()
  local allow_pattern
  while IFS= read -r allow_pattern; do
    [[ -z "$allow_pattern" ]] && continue
    allow_patterns+=("$allow_pattern")
  done < <(load_allow_patterns)

  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No apply-gate-bypass allowlist entries loaded"
  fi

  local findings=()
  local blocked=()
  local line rule path lineno code candidate
  local scan_output

  scan_output="$(scan_with_python)"

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    findings+=("$line")
  done <<< "$scan_output"

  for line in "${findings[@]:-}"; do
    [[ -z "$line" ]] && continue
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"

    if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
      if matches_allowlist "$path:$lineno:$rule" "${allow_patterns[@]}"; then
        continue
      fi
      if matches_allowlist "$path:$rule" "${allow_patterns[@]}"; then
        continue
      fi
      if matches_allowlist "$path" "${allow_patterns[@]}"; then
        continue
      fi
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
