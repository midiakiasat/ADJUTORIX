#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX direct-write discipline guard
#
# Purpose:
# - fail fast when source code introduces filesystem mutation paths that bypass governed apply/write gates
# - catch direct write primitives in renderer, CLI, CI scripts, tests, and shared libraries before they become normalized
# - enforce that consequential mutation flows through explicit, reviewable, policy-bearing surfaces
# - make exceptions rare, local, and auditable through a narrow allowlist

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/no-direct-write.allowlist}"
STRICT_MODE="${STRICT_MODE:-1}"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-no-direct-write]')" "$*"
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
  python3 - <<'PY'
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

RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "python-open-write",
        re.compile(r"\bopen\s*\([^\n#]*[,)]\s*[\"\'](?:w|a|x|wb|ab|xb|w\+|a\+|x\+|wb\+|ab\+)"),
    ),
    (
        "python-path-write_text",
        re.compile(r"\.write_text\s*\("),
    ),
    (
        "python-path-write_bytes",
        re.compile(r"\.write_bytes\s*\("),
    ),
    (
        "python-os-remove",
        re.compile(r"\bos\.(?:remove|unlink|rename|replace|makedirs)\s*\("),
    ),
    (
        "python-shutil-mutate",
        re.compile(r"\bshutil\.(?:move|copy|copy2|copytree|rmtree)\s*\("),
    ),
    (
        "python-path-mkdir",
        re.compile(r"\.mkdir\s*\("),
    ),
    (
        "python-path-unlink",
        re.compile(r"\.(?:unlink|rename|replace|touch)\s*\("),
    ),
    (
        "node-writefile-sync",
        re.compile(r"\b(?:fs|fsPromises|promises)\.(?:writeFile|appendFile|truncate|rm|rmdir|mkdir|rename|copyFile|unlink)\s*\("),
    ),
    (
        "node-writefile-imported",
        re.compile(r"\b(?:writeFile|appendFile|truncate|rm|rmdir|mkdir|rename|copyFile|unlink|writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync)\s*\("),
    ),
    (
        "shell-redirect-write",
        re.compile(r"(^|[^<])(?:>|>>|\d>|\d>>)")
    ),
    (
        "shell-rm-mkdir-mv-cp",
        re.compile(r"\b(?:rm|mv|cp|mkdir|install|ditto|touch)\b"),
    ),
]

SKIP_LINE_PATTERNS = [
    re.compile(r"adjutorix: allow-direct-write"),
    re.compile(r"no-direct-write: ignore"),
]

for path in ROOT.rglob("*"):
    if not path.is_file():
        continue
    if any(part in EXCLUDE_PARTS for part in path.parts):
        continue
    if path.suffix not in INCLUDE_SUFFIXES:
        continue
    rel = path.relative_to(ROOT).as_posix()
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        continue
    lines = text.splitlines()
    for idx, line in enumerate(lines, start=1):
        if any(p.search(line) for p in SKIP_LINE_PATTERNS):
            continue
        for rule_name, pattern in RULES:
            if pattern.search(line):
                print(f"{rule_name}\t{rel}\t{idx}\t{line.strip()}")
PY
}

main() {
  section "No direct write discipline"
  require_cmd git
  require_cmd python3
  require_repo_root

  mapfile -t allow_patterns < <(load_allow_patterns)
  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No no-direct-write allowlist entries loaded"
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
    ok "No direct-write violations detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Direct-write violations detected')"
  printf '  %-26s %-52s %-6s %s\n' 'rule' 'path' 'line' 'code'
  printf '  %-26s %-52s %-6s %s\n' '----' '----' '----' '----'

  for line in "${blocked[@]}"; do
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"
    printf '  %-26s %-52s %-6s %s\n' "$rule" "$path" "$lineno" "$code"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Direct filesystem mutation paths were detected outside governed allowlist boundaries."
  fi

  warn "Direct-write violations detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
