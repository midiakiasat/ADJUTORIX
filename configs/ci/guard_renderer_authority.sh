#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX renderer-authority discipline guard
#
# Purpose:
# - fail fast when renderer code acquires authority that belongs only to preload/main/governed services
# - detect direct filesystem/process/network/IPC/electron authority usage from renderer surfaces
# - enforce the trust boundary: renderer may present state and request actions, but must not hold mutation authority itself
# - keep exceptions explicit and auditable through a narrow allowlist rather than convention

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT_DIR"

readonly SCRIPT_DIR
readonly ROOT_DIR

CONSTITUTION_CHECKER="${ROOT_DIR}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT_DIR}/.tmp/ci/guard_renderer_authority/constitution-report.json"
FORCE_COLOR="${FORCE_COLOR:-1}"
STRICT_MODE="${STRICT_MODE:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/renderer-authority.allowlist}"
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
  printf '%s %s\n' "$(color '36' '[adjutorix-renderer-authority]')" "$*"
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
  [[ -d "$ROOT_DIR/packages/adjutorix-app" ]] || die "Missing packages/adjutorix-app"
  [[ -d "$ROOT_DIR/packages/adjutorix-app/src/renderer" ]] || die "Missing renderer source directory"
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
RENDERER = ROOT / "packages" / "adjutorix-app" / "src" / "renderer"

INCLUDE_SUFFIXES = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".html"}
EXCLUDE_PARTS = {
    ".git",
    "node_modules",
    "dist",
    "build",
    "out",
    "coverage",
    ".nyc_output",
}

RULES: list[tuple[str, re.Pattern[str]]] = [
    (
        "renderer-import-electron",
        re.compile(r"(?:from|require\()\s*[\"\']electron[\"\']"),
    ),
    (
        "renderer-import-node-fs",
        re.compile(r"(?:from|require\()\s*[\"\'](?:node:)?fs(?:/promises)?[\"\']"),
    ),
    (
        "renderer-import-node-path-os-process",
        re.compile(r"(?:from|require\()\s*[\"\'](?:node:)?(?:path|os|process|child_process|worker_threads|net|tls|http|https|dgram)[\"\']"),
    ),
    (
        "renderer-import-node-crypto",
        re.compile(r"(?:from|require\()\s*[\"\'](?:node:)?crypto[\"\']"),
    ),
    (
        "renderer-direct-window-require",
        re.compile(r"\bwindow\.require\s*\("),
    ),
    (
        "renderer-direct-ipc",
        re.compile(r"\b(?:ipcRenderer|ipcMain|remote)\b"),
    ),
    (
        "renderer-direct-fetch-authority",
        re.compile(r"\b(?:fetch|axios\.|XMLHttpRequest|WebSocket)\b[^\n]*(?:127\.0\.0\.1|localhost|/rpc|adjutorix|agent)"),
    ),
    (
        "renderer-direct-localstorage-authority",
        re.compile(r"\b(?:localStorage|sessionStorage|indexedDB)\b"),
    ),
    (
        "renderer-direct-mutation-verb",
        re.compile(r"\b(?:writeFile|appendFile|unlink|rmSync|mkdirSync|spawn|exec|openExternal|shell\.openPath|shell\.showItemInFolder)\b"),
    ),
    (
        "renderer-direct-window-adjutorix-overwrite",
        re.compile(r"\bwindow\.adjutorix\s*="),
    ),
    (
        "renderer-unsafe-context-bridge-knowledge",
        re.compile(r"\bcontextBridge\b|\bexposeInMainWorld\b"),
    ),
]

SAFE_LINE_PATTERNS = [
    re.compile(r"renderer-authority:\s*ignore"),
    re.compile(r"adjutorix:\s*allow-renderer-authority"),
    re.compile(r"describe\(|test\(|it\("),
]

for path in RENDERER.rglob("*"):
    if not path.is_file():
        continue
    if any(part in EXCLUDE_PARTS for part in path.parts):
        continue
    if path.suffix not in INCLUDE_SUFFIXES:
        continue
    rel = path.relative_to(ROOT).as_posix()
    text = path.read_text(encoding="utf-8", errors="ignore")
    for idx, line in enumerate(text.splitlines(), start=1):
        stripped = line.strip()
        if not stripped:
            continue
        if stripped.startswith(("//", "/*", "*", "*/")):
            continue
        if any(p.search(line) for p in SAFE_LINE_PATTERNS):
            continue
        for rule_name, pattern in RULES:
            if pattern.search(line):
                print(f"{rule_name}\t{rel}\t{idx}\t{line.strip()}")
PY
}

main() {
  section "Renderer authority discipline"
  require_cmd git
  require_cmd node
  require_cmd "$PYTHON_BIN"
  require_repo_root

  section "Repository constitution preflight"
  [[ -x "$CONSTITUTION_CHECKER" ]] || die "Missing executable constitution checker: $CONSTITUTION_CHECKER"
  run_constitution_output="$(node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT")"
  printf '%s\n' "$run_constitution_output"

  local allow_patterns=()
  local allow_pattern
  while IFS= read -r allow_pattern; do
    [[ -z "$allow_pattern" ]] && continue
    allow_patterns+=("$allow_pattern")
  done < <(load_allow_patterns)

  if [[ "${#allow_patterns[@]}" -gt 0 ]]; then
    log "Loaded ${#allow_patterns[@]} allowlist pattern(s) from $ALLOWLIST_FILE"
  else
    log "No renderer-authority allowlist entries loaded"
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
    ok "No renderer-authority violations detected"
    exit 0
  fi

  printf '%s\n' "$(color '1;31' 'Renderer-authority violations detected')"
  printf '  %-34s %-58s %-6s %s\n' 'rule' 'path' 'line' 'code'
  printf '  %-34s %-58s %-6s %s\n' '----' '----' '----' '----'

  for line in "${blocked[@]}"; do
    rule="${line%%$'\t'*}"
    candidate="${line#*$'\t'}"
    path="${candidate%%$'\t'*}"
    candidate="${candidate#*$'\t'}"
    lineno="${candidate%%$'\t'*}"
    code="${candidate#*$'\t'}"
    printf '  %-34s %-58s %-6s %s\n' "$rule" "$path" "$lineno" "$code"
  done

  if [[ "$STRICT_MODE" == "1" ]]; then
    die "Renderer code appears to hold authority that belongs only to preload/main/governed services."
  fi

  warn "Renderer-authority violations detected but STRICT_MODE=$STRICT_MODE"
}

main "$@"
