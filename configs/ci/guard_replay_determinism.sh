#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX replay determinism guard
#
# Purpose:
# - fail fast when replay/verify/ledger-bearing test surfaces produce non-deterministic outputs across identical runs
# - enforce that authoritative replay evidence is stable under repeated execution in the same environment
# - detect hidden time/order/randomness leakage in golden outputs, JSON payloads, and CLI/app replay surfaces
# - provide explicit diff artifacts for every determinism failure rather than vague flaky-test claims

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
NPM_BIN="${NPM_BIN:-npm}"
PYTEST_BIN="${PYTEST_BIN:-pytest}"
STRICT_MODE="${STRICT_MODE:-1}"
RUN_COUNT="${RUN_COUNT:-2}"
TMP_DIR="${TMP_DIR:-$ROOT_DIR/.tmp/guard-replay-determinism}"
INCLUDE_APP="${INCLUDE_APP:-1}"
INCLUDE_CLI="${INCLUDE_CLI:-1}"
INCLUDE_GOLDEN="${INCLUDE_GOLDEN:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/replay-determinism.allowlist}"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-replay-determinism]')" "$*"
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

cleanup() {
  local exit_code="$?"
  if [[ $exit_code -ne 0 ]]; then
    err "Replay determinism guard failed"
  fi
  exit "$exit_code"
}
trap cleanup EXIT

assert_repo_shape() {
  section "Repository replay surfaces"
  require_file "$ROOT_DIR/package.json"
  require_dir "$ROOT_DIR/tests/replay"
  require_dir "$ROOT_DIR/tests/golden"
  require_dir "$ROOT_DIR/packages/adjutorix-cli/tests"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/smoke"
  ok "Replay-bearing repository surfaces exist"
}

prepare_tmp() {
  section "Prepare temp workspace"
  rm -rf "$TMP_DIR"
  mkdir -p "$TMP_DIR"
  ok "Prepared temp workspace at $TMP_DIR"
}

normalize_text_file() {
  local in_file="$1"
  local out_file="$2"
  "$PYTHON_BIN" - "$in_file" "$out_file" <<'PY'
from __future__ import annotations
import pathlib
import re
import sys

src = pathlib.Path(sys.argv[1])
dst = pathlib.Path(sys.argv[2])
text = src.read_text(encoding='utf-8', errors='ignore')

# Remove common unstable values while preserving structure.
patterns = [
    (r'0x[0-9a-fA-F]+', '0xADDR'),
    (r'\b[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-Z]+\b', 'TIMESTAMP'),
    (r'\b[0-9]{10,}\b', 'INTSEQ'),
    (r'/private/var/folders/[^\s\"]+', '/private/var/folders/TMPPATH'),
    (r'\\\\\\?\\[^\s\"]+', 'WINDOWS_LONG_PATH'),
    (r'pid=[0-9]+', 'pid=PID'),
    (r'"started_at_monotonic":\s*[0-9.]+', '"started_at_monotonic": MONO'),
    (r'"finished_at_monotonic":\s*[0-9.]+', '"finished_at_monotonic": MONO'),
    (r'"elapsed_seconds":\s*[0-9.]+', '"elapsed_seconds": ELAPSED'),
]
for pattern, repl in patterns:
    text = re.sub(pattern, repl, text)

# Normalize whitespace and line endings.
text = text.replace('\r\n', '\n').replace('\r', '\n')
text = '\n'.join(line.rstrip() for line in text.split('\n'))
dst.write_text(text, encoding='utf-8')
PY
}

capture_cli_replay_run() {
  local run_id="$1"
  local out_dir="$TMP_DIR/cli-$run_id"
  mkdir -p "$out_dir"

  section "CLI replay determinism run $run_id"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    "$PYTEST_BIN" -q tests/test_cli_replay.py > "$out_dir/test_cli_replay.raw.txt" 2>&1
    "$PYTEST_BIN" -q tests/test_cli_verify.py > "$out_dir/test_cli_verify.raw.txt" 2>&1
  )

  normalize_text_file "$out_dir/test_cli_replay.raw.txt" "$out_dir/test_cli_replay.norm.txt"
  normalize_text_file "$out_dir/test_cli_verify.raw.txt" "$out_dir/test_cli_verify.norm.txt"

  cat "$out_dir/test_cli_replay.norm.txt" "$out_dir/test_cli_verify.norm.txt" > "$out_dir/combined.norm.txt"
  shasum -a 256 "$out_dir/combined.norm.txt" | awk '{print $1}' > "$out_dir/combined.sha256"
}

capture_app_replay_run() {
  local run_id="$1"
  local out_dir="$TMP_DIR/app-$run_id"
  mkdir -p "$out_dir"

  section "App replay determinism run $run_id"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    "$NPM_BIN" test -- \
      tests/smoke/verify_flow.smoke.test.ts \
      tests/smoke/ledger_flow.smoke.test.ts \
      tests/smoke/diagnostics_roundtrip.smoke.test.ts \
      > "$out_dir/app_smoke.raw.txt" 2>&1
  )

  normalize_text_file "$out_dir/app_smoke.raw.txt" "$out_dir/app_smoke.norm.txt"
  shasum -a 256 "$out_dir/app_smoke.norm.txt" | awk '{print $1}' > "$out_dir/app_smoke.sha256"
}

capture_golden_snapshot() {
  local run_id="$1"
  local out_dir="$TMP_DIR/golden-$run_id"
  mkdir -p "$out_dir"

  section "Golden replay fixture snapshot $run_id"
  "$PYTHON_BIN" - "$ROOT_DIR" "$out_dir/manifest.json" <<'PY'
from __future__ import annotations
import hashlib
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])
out = pathlib.Path(sys.argv[2])
base = root / 'tests' / 'golden'
manifest = []
for path in sorted(base.rglob('*')):
    if not path.is_file():
        continue
    rel = path.relative_to(root).as_posix()
    data = path.read_bytes()
    manifest.append({
        'path': rel,
        'sha256': hashlib.sha256(data).hexdigest(),
        'size': len(data),
    })
out.write_text(json.dumps(manifest, indent=2, sort_keys=True), encoding='utf-8')
PY
  shasum -a 256 "$out_dir/manifest.json" | awk '{print $1}' > "$out_dir/manifest.sha256"
}

compare_pair() {
  local label="$1"
  local file_a="$2"
  local file_b="$3"
  local diff_out="$4"
  if ! diff -u "$file_a" "$file_b" > "$diff_out"; then
    return 1
  fi
  return 0
}

main() {
  require_cmd git
  require_cmd "$PYTHON_BIN"
  require_cmd "$PYTEST_BIN"
  require_cmd "$NPM_BIN"
  require_cmd shasum
  require_cmd diff

  assert_repo_shape
  prepare_tmp

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No replay determinism allowlist entries loaded"
  fi

  local i
  for ((i=1; i<=RUN_COUNT; i++)); do
    if [[ "$INCLUDE_CLI" == "1" ]]; then
      capture_cli_replay_run "$i"
    fi
    if [[ "$INCLUDE_APP" == "1" ]]; then
      capture_app_replay_run "$i"
    fi
    if [[ "$INCLUDE_GOLDEN" == "1" ]]; then
      capture_golden_snapshot "$i"
    fi
  done

  local findings=()
  local diff_file candidate

  if [[ "$INCLUDE_CLI" == "1" ]]; then
    diff_file="$TMP_DIR/cli.diff"
    if ! compare_pair "cli" "$TMP_DIR/cli-1/combined.norm.txt" "$TMP_DIR/cli-2/combined.norm.txt" "$diff_file"; then
      findings+=("cli-replay-output\t$diff_file")
    fi
  fi

  if [[ "$INCLUDE_APP" == "1" ]]; then
    diff_file="$TMP_DIR/app.diff"
    if ! compare_pair "app" "$TMP_DIR/app-1/app_smoke.norm.txt" "$TMP_DIR/app-2/app_smoke.norm.txt" "$diff_file"; then
      findings+=("app-replay-output\t$diff_file")
    fi
  fi

  if [[ "$INCLUDE_GOLDEN" == "1" ]]; then
    diff_file="$TMP_DIR/golden.diff"
    if ! compare_pair "golden" "$TMP_DIR/golden-1/manifest.json" "$TMP_DIR/golden-2/manifest.json" "$diff_file"; then
      findings+=("golden-manifest\t$diff_file")
    fi
  fi

  local blocked=()
  for candidate in "${findings[@]:-}"; do
    [[ -z "$candidate" ]] && continue
    if matches_allowlist "$candidate" "${allow_patterns[@]}"; then
      continue
    fi
    blocked+=("$candidate")
  done

  if [[ "${#blocked[@]}" -eq 0 ]]; then
    ok "Replay-bearing surfaces are deterministic across repeated runs"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Replay determinism violations detected')"
  printf '  %-28s %s\n' 'surface' 'diff-artifact'
  printf '  %-28s %s\n' '-------' '-------------'
  local surface path
  for candidate in "${blocked[@]}"; do
    surface="${candidate%%$'\t'*}"
    path="${candidate#*$'\t'}"
    printf '  %-28s %s\n' "$surface" "$path"
    printf '%s\n' "$(color '33' "--- diff for $surface ---")"
    sed -n '1,200p' "$path"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Replay-bearing outputs drift across identical runs; determinism is not authoritative."
  fi

  warn "Replay determinism drift detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
