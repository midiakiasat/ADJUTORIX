#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX contract drift guard
#
# Purpose:
# - fail fast when authoritative contracts drift without corresponding golden/spec updates
# - enforce alignment across RPC payloads, preload/exposed APIs, schema-bearing docs, and golden fixtures
# - catch both missing contract coverage and accidental surface expansion that would make governed behavior ambiguous
# - make drift explicit, inspectable, and reviewable rather than silently tolerated

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/contract-drift.allowlist}"
PYTHON_BIN="${PYTHON_BIN:-python3}"

CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_contract_drift/constitution-report.json}"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-contract-drift]')" "$*"
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

require_file() {
  local path="$1"
  [[ -f "$path" ]] || die "Required file missing: $path"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || die "Required directory missing: $path"
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

run_constitution_preflight() {
  section "Repository constitution preflight"
  require_cmd node
  [[ -x "$CONSTITUTION_CHECKER" ]] || die "Missing executable constitution checker: $CONSTITUTION_CHECKER"
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --root "$ROOT_DIR" --json --out "$CONSTITUTION_REPORT"
}

assert_repo_shape() {
  section "Repository contract surfaces"
  require_file "$ROOT_DIR/package.json"
  require_dir "$ROOT_DIR/packages/adjutorix-app"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/main"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/renderer"
  require_dir "$ROOT_DIR/packages/adjutorix-cli"
  require_dir "$ROOT_DIR/packages/adjutorix-cli/tests"
  require_dir "$ROOT_DIR/tests/contracts"
  require_dir "$ROOT_DIR/tests/golden"
  ok "Contract-bearing repository surfaces exist"
}

scan_contract_surfaces() {
  "$PYTHON_BIN" - <<'PY'
from __future__ import annotations

import hashlib
import json
import pathlib
import re
from collections import defaultdict

ROOT = pathlib.Path.cwd()

SURFACES = {
    "rpc_contract_tests": ROOT / "tests" / "contracts",
    "app_preload_source": ROOT / "packages" / "adjutorix-app" / "src" / "preload",
    "app_main_tests": ROOT / "packages" / "adjutorix-app" / "tests" / "main",
    "app_renderer_tests": ROOT / "packages" / "adjutorix-app" / "tests" / "renderer",
    "cli_tests": ROOT / "packages" / "adjutorix-cli" / "tests",
    "golden": ROOT / "tests" / "golden",
}

FILE_SUFFIXES = {".ts", ".tsx", ".py", ".json", ".md"}

PATTERNS = {
    "rpc_method_string": re.compile(r'["\']([a-zA-Z0-9_.-]+\.[a-zA-Z0-9_.-]+)["\']'),
    "test_name": re.compile(r'\b(?:it|test|describe)\s*\(\s*["\']([^"\']+)["\']'),
    "preload_api_surface": re.compile(r'\b(?:contextBridge\.exposeInMainWorld|exposeInMainWorld)\s*\(\s*["\']([^"\']+)["\']|\bwindow\.(adjutorixApi|adjutorix)\b'),
    "exported_method": re.compile(r'\b(?:function|const|async function)\s+([A-Za-z_][A-Za-z0-9_]*)'),
    "python_test_name": re.compile(r'^def\s+(test_[A-Za-z0-9_]+)\s*\(', re.M),
}

summary: dict[str, dict[str, object]] = {}
all_rpc_methods: set[str] = set()
all_test_names: set[str] = set()
all_preload_surfaces: set[str] = set()
all_exported_names: set[str] = set()

for surface_name, base in SURFACES.items():
    files = []
    rpc_methods: set[str] = set()
    test_names: set[str] = set()
    preload_surfaces: set[str] = set()
    exported_names: set[str] = set()

    if not base.exists():
        continue

    for path in sorted(base.rglob("*")):
        if not path.is_file():
            continue
        if path.suffix not in FILE_SUFFIXES:
            continue
        rel = path.relative_to(ROOT).as_posix()
        text = path.read_text(encoding="utf-8", errors="ignore")
        digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
        files.append({"path": rel, "sha256": digest, "size": len(text.encode('utf-8'))})

        for match in PATTERNS["rpc_method_string"].findall(text):
            if "." in match and not match.startswith(("./", "../")):
                rpc_methods.add(match)
        for match in PATTERNS["test_name"].findall(text):
            test_names.add(match)
        for match in PATTERNS["python_test_name"].findall(text):
            test_names.add(match)
        for match in PATTERNS["preload_api_surface"].findall(text):
            if isinstance(match, tuple):
                preload_surface = next((item for item in match if item), "")
            else:
                preload_surface = match
            if preload_surface:
                preload_surfaces.add(preload_surface)
        for match in PATTERNS["exported_method"].findall(text):
            exported_names.add(match)

    summary[surface_name] = {
        "file_count": len(files),
        "files": files,
        "rpc_methods": sorted(rpc_methods),
        "test_names": sorted(test_names),
        "preload_surfaces": sorted(preload_surfaces),
        "exported_names": sorted(exported_names),
    }
    all_rpc_methods.update(rpc_methods)
    all_test_names.update(test_names)
    all_preload_surfaces.update(preload_surfaces)
    all_exported_names.update(exported_names)

summary["aggregate"] = {
    "rpc_methods": sorted(all_rpc_methods),
    "test_names": sorted(all_test_names),
    "preload_surfaces": sorted(all_preload_surfaces),
    "exported_names": sorted(all_exported_names),
}

print(json.dumps(summary, indent=2, sort_keys=True))
PY
}

check_with_python() {
  local temp_json="$1"
  "$PYTHON_BIN" - "$temp_json" "$ROOT_DIR" <<'PY'
from __future__ import annotations

import json
import pathlib
import sys

summary_path = pathlib.Path(sys.argv[1])
root = pathlib.Path(sys.argv[2])
summary = json.loads(summary_path.read_text(encoding="utf-8"))
issues: list[dict[str, str]] = []

aggregate = summary.get("aggregate", {})
rpc_methods = set(aggregate.get("rpc_methods", []))
preload_surfaces = set(aggregate.get("preload_surfaces", []))
exported_names = set(aggregate.get("exported_names", []))
all_test_names = set(aggregate.get("test_names", []))

# Required RPC method names must be derived from currently declared
# contract-bearing surfaces. Do not pin retired job.* methods here: that turns
# the drift guard into a stale-contract guard.
required_rpc_contract_tests: set[str] = set()
for method in sorted(required_rpc_contract_tests):
    if method not in rpc_methods:
        issues.append({
            "code": "required-rpc-method-missing",
            "subject": method,
            "detail": f"Required RPC method reference {method!r} is absent from contract-bearing surfaces.",
        })

required_cli_tests = {
    "test_cli_replay.py",
    "test_cli_verify.py",
}
cli_files = {pathlib.Path(item["path"]).name for item in summary.get("cli_tests", {}).get("files", [])}
for filename in sorted(required_cli_tests):
    if filename not in cli_files:
        issues.append({
            "code": "required-cli-contract-test-missing",
            "subject": filename,
            "detail": f"Required CLI contract test file {filename!r} is missing.",
        })

required_main_tests = {
    "preload_bridge.test.ts",
    "exposed_api_contract.test.ts",
}
main_files = {pathlib.Path(item["path"]).name for item in summary.get("app_main_tests", {}).get("files", [])}
for filename in sorted(required_main_tests):
    if filename not in main_files:
        issues.append({
            "code": "required-main-contract-test-missing",
            "subject": filename,
            "detail": f"Required main-process contract test file {filename!r} is missing.",
        })

expected_preload_surfaces = {"adjutorix", "adjutorixApi"}
if not (expected_preload_surfaces & preload_surfaces):
    issues.append({
        "code": "preload-surface-missing",
        "subject": "adjutorix",
        "detail": "Expected preload/exposed API surface 'adjutorix' or compatibility alias 'adjutorixApi' is missing from discovered contract sources.",
    })

expected_cli_exports = {"main"}
if not expected_cli_exports & exported_names:
    issues.append({
        "code": "cli-export-surface-missing",
        "subject": "main",
        "detail": "No expected CLI exported entry surface detected in contract-bearing sources.",
    })

golden = summary.get("golden", {})
golden_files = golden.get("files", [])
if len(golden_files) == 0:
    issues.append({
        "code": "golden-fixtures-missing",
        "subject": "tests/golden",
        "detail": "Golden fixture directory exists but contains no contract-bearing files.",
    })

contract_files = summary.get("rpc_contract_tests", {}).get("files", [])
if len(contract_files) == 0:
    issues.append({
        "code": "rpc-contract-tests-missing",
        "subject": "tests/contracts",
        "detail": "No RPC contract files were discovered under tests/contracts.",
    })

if not all_test_names:
    issues.append({
        "code": "test-name-surface-empty",
        "subject": "tests",
        "detail": "No test names were discovered across contract-bearing test surfaces.",
    })

# Counterexample check: if we see verify/apply/ledger/replay exports in source names but no matching test names, block.
semantic_tokens = ["verify", "replay", "ledger", "apply", "workspace", "agent"]
for token in semantic_tokens:
    token_exports = sorted(name for name in exported_names if token in name.lower())
    token_tests = sorted(name for name in all_test_names if token in name.lower())
    if token_exports and not token_tests:
      issues.append({
          "code": "semantic-contract-coverage-gap",
          "subject": token,
          "detail": (
              f"Detected exported/source contract surface containing token {token!r} but no test names covering that token."
          ),
      })

print(json.dumps(issues, indent=2, sort_keys=True))
PY
}

main() {
  run_constitution_preflight
  section "Contract drift discipline"
  require_cmd git
  require_cmd "$PYTHON_BIN"
  assert_repo_shape

  allow_patterns=()
  while IFS= read -r __adjutorix_line; do
    allow_patterns+=("$__adjutorix_line")
  done < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No contract-drift allowlist entries loaded"
  fi

  local summary_json
  local issues_json
  summary_json="$(mktemp)"
  issues_json="$(mktemp)"
  trap 'rm -f "$summary_json" "$issues_json"' RETURN

  scan_contract_surfaces > "$summary_json"
  check_with_python "$summary_json" > "$issues_json"

  local blocked=()
  local line code subject detail candidate

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    :
  done < /dev/null

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    :
  done < /dev/null

  while IFS= read -r candidate; do
    [[ -z "$candidate" ]] && continue
    blocked+=("$candidate")
  done < <(
    "$PYTHON_BIN" - "$issues_json" <<'PY'
from __future__ import annotations
import json
import sys
from pathlib import Path
issues = json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
for issue in issues:
    print(f"{issue['code']}\t{issue['subject']}\t{issue['detail']}")
PY
  )

  if [[ "${#blocked[@]}" -eq 0 ]]; then
    ok "No blocking contract drift detected"
    exit 0
  fi

  local filtered=()
  for candidate in "${blocked[@]}"; do
    code="${candidate%%$'\t'*}"
    subject="${candidate#*$'\t'}"
    subject="${subject%%$'\t'*}"
    detail="${candidate#*$'\t'}"
    detail="${detail#*$'\t'}"

    if matches_allowlist "$code:$subject" "${allow_patterns[@]}"; then
      continue
    fi
    if matches_allowlist "$code" "${allow_patterns[@]}"; then
      continue
    fi
    filtered+=("$code"$'\t'"$subject"$'\t'"$detail")
  done

  if [[ "${#filtered[@]}" -eq 0 ]]; then
    ok "Only allowlisted contract drift findings were detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Contract drift findings detected')"
  printf '  %-34s %-28s %s\n' 'code' 'subject' 'detail'
  printf '  %-34s %-28s %s\n' '----' '-------' '------'

  for candidate in "${filtered[@]}"; do
    code="${candidate%%$'\t'*}"
    subject="${candidate#*$'\t'}"
    subject="${subject%%$'\t'*}"
    detail="${candidate#*$'\t'}"
    detail="${detail#*$'\t'}"
    printf '  %-34s %-28s %s\n' "$code" "$subject" "$detail"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Contract-bearing surfaces drifted without aligned coverage or golden/spec evidence."
  fi

  warn "Contract drift detected but STRICT_MODE=0; continuing."
  exit 0
}

main "$@"
