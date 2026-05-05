#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX direct-write discipline guard
#
# Purpose:
# - fail fast when source code introduces filesystem mutation paths that bypass governed apply/write gates
# - catch direct write primitives in non-canonical runtime and renderer surfaces before they become normalized
# - enforce that consequential mutation flows through explicit, reviewable, policy-bearing surfaces
# - make exceptions rare, local, and auditable through a narrow allowlist

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$ROOT_DIR"

readonly SCRIPT_DIR
readonly ROOT_DIR

CONSTITUTION_CHECKER="${ROOT_DIR}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${ROOT_DIR}/.tmp/ci/guard_no_direct_write/constitution-report.json"
FORCE_COLOR="${FORCE_COLOR:-1}"
ALLOWLIST_FILE="${ALLOWLIST_FILE:-$ROOT_DIR/configs/ci/no-direct-write.allowlist}"
STRICT_MODE="${STRICT_MODE:-1}"
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
  "$PYTHON_BIN" - "$ROOT_DIR" "$ALLOWLIST_FILE" <<'PY_SCAN'
from __future__ import annotations

import fnmatch
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(sys.argv[1]).resolve()
ALLOWLIST_FILE = Path(sys.argv[2])

SCAN_SUFFIXES = (
    ".py",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    ".mjs",
    ".cjs",
    ".sh",
)


CANONICAL_WRITE_FILES = {
    "configs/ci/guard_no_direct_write.sh",
    "configs/ci/guard_apply_gate_bypass.sh",
    "configs/ci/guard_verify_gate_bypass.sh",
    "configs/ci/guard_renderer_authority.sh",
    "configs/ci/guard_replay_determinism.sh",
    "scripts/adjutorix-constitution-check.mjs",
    "scripts/contracts/freeze.sh",
    "scripts/patch/apply.sh",
    "scripts/patch/preview.sh",
    "scripts/patch/reject.sh",
    "scripts/patch/validate.sh",
    "packages/adjutorix-app/scripts/build-renderer.mjs",
    "packages/adjutorix-app/scripts/normalize-asset-manifest.cjs",
    "packages/adjutorix-app/scripts/persist-renderer-asset-manifest.cjs",
    "packages/adjutorix-app/scripts/prepare-renderer-assets.js",
    "packages/adjutorix-app/scripts/smoke.js",
}

CANONICAL_WRITE_PREFIXES = (
    "scripts/",
    "packages/adjutorix-app/src/main/",
    "packages/adjutorix-agent/adjutorix_agent/storage/",
    "packages/adjutorix-agent/adjutorix_agent/server/",
    "packages/adjutorix-agent/adjutorix_agent/core/",
    "packages/adjutorix-agent/scripts/",
    "packages/adjutorix-app/tests/",
    "packages/adjutorix-agent/tests/",
    "tests/",
)

GUARDED_TARGET_PREFIXES = (
    "packages/adjutorix-app/src/renderer/",
    "packages/shared/src/",
    "packages/adjutorix-cli/adjutorix_cli/",
)

PYTHON_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "python-open-write",
        re.compile(r"""\bopen\s*\([^\n#]*[,)]\s*["'](?:w|a|x|wb|ab|xb|w\+|a\+|x\+|wb\+|ab\+)"""),
    ),
    ("python-path-write_text", re.compile(r"\.write_text\s*\(")),
    ("python-path-write_bytes", re.compile(r"\.write_bytes\s*\(")),
    ("python-os-remove", re.compile(r"\bos\.(?:remove|unlink|rename|replace|makedirs)\s*\(")),
    ("python-shutil-mutate", re.compile(r"\bshutil\.(?:move|copy|copy2|copytree|rmtree)\s*\(")),
    ("python-path-mkdir", re.compile(r"\.mkdir\s*\(")),
    ("python-path-unlink", re.compile(r"\.(?:unlink|rename|replace|touch)\s*\(")),
)

JS_TS_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    (
        "node-fs-mutate",
        re.compile(
            r"\b(?:fs|fsPromises|promises)\."
            r"(?:writeFile|writeFileSync|appendFile|appendFileSync|truncate|rm|rmSync|rmdir|mkdir|mkdirSync|rename|renameSync|copyFile|copyFileSync|unlink|unlinkSync)\s*\("
        ),
    ),
    (
        "node-imported-fs-mutate",
        re.compile(
            r"\b(?:writeFile|appendFile|truncate|rm|rmdir|mkdir|rename|copyFile|unlink|"
            r"writeFileSync|appendFileSync|mkdirSync|rmSync|unlinkSync|renameSync|copyFileSync)\s*\("
        ),
    ),
    ("browser-storage-write", re.compile(r"\b(?:localStorage|sessionStorage)\.setItem\s*\(")),
    ("indexeddb-write-surface", re.compile(r"\bindexedDB\b|\bIDB(?:Database|ObjectStore|Transaction)\b")),
)

SHELL_RULES: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("shell-redirect-write", re.compile(r"(^|[^<])(?:>|>>|\d>|\d>>)")),
    ("shell-rm-mkdir-mv-cp", re.compile(r"\b(?:rm|mv|cp|mkdir|install|ditto|touch)\b")),
)

SKIP_LINE_PATTERNS = (
    re.compile(r"adjutorix: allow-direct-write"),
    re.compile(r"no-direct-write: ignore"),
)

def load_allow_patterns() -> list[str]:
    if not ALLOWLIST_FILE.exists():
        return []
    out: list[str] = []
    for raw in ALLOWLIST_FILE.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if line and not line.startswith("#"):
            out.append(line)
    return out

ALLOW_PATTERNS = load_allow_patterns()

def git_ls_files() -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(ROOT), "ls-files"],
        check=True,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    return [line for line in proc.stdout.splitlines() if line]

def is_allowed(candidate: str) -> bool:
    return any(fnmatch.fnmatch(candidate, pattern) for pattern in ALLOW_PATTERNS)

CONSTITUTION_SCAN_SKIP_STRATA = {"authority/tests", "ephemeral/runtime", "derived/build", "release/distributable", "forbidden"}
CONSTITUTION_STRATUM_CACHE: dict[str, str] = {}
NO_DIRECT_WRITE_GUARD_SELF = "configs/ci/guard_no_direct_write.sh"

def constitution_root() -> str:
    env_root = os.environ.get("ROOT_DIR")
    if env_root:
        return env_root
    return subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip()

def constitution_stratum_for_path(rel: str) -> str:
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

def is_skipped_path(rel: str) -> bool:
    if rel == NO_DIRECT_WRITE_GUARD_SELF:
        return True
    stratum = constitution_stratum_for_path(rel)
    return stratum in CONSTITUTION_SCAN_SKIP_STRATA

def is_canonical_write_surface(rel: str) -> bool:
    return rel in CANONICAL_WRITE_FILES or any(rel.startswith(prefix) for prefix in CANONICAL_WRITE_PREFIXES)

def is_guarded_target_path(rel: str) -> bool:
    return any(rel.startswith(prefix) for prefix in GUARDED_TARGET_PREFIXES)

def code_line_only(line: str) -> bool:
    stripped = line.strip()
    if not stripped:
        return False
    if stripped.startswith(("#", "//", "/*", "*", "*/")):
        return False
    return not any(p.search(line) for p in SKIP_LINE_PATTERNS)

def rules_for_suffix(suffix: str) -> tuple[tuple[str, re.Pattern[str]], ...]:
    if suffix == ".py":
        return PYTHON_RULES
    if suffix in {".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"}:
        return JS_TS_RULES
    if suffix == ".sh":
        return SHELL_RULES
    return ()

for rel in git_ls_files():
    if is_skipped_path(rel):
        continue
    if is_canonical_write_surface(rel):
        continue
    if not is_guarded_target_path(rel):
        continue
    if not rel.endswith(SCAN_SUFFIXES):
        continue
    if is_allowed(rel):
        continue

    path = ROOT / rel
    rules = rules_for_suffix(path.suffix)
    if not rules:
        continue

    try:
        content = path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        continue

    for idx, line in enumerate(content.splitlines(), start=1):
        if not code_line_only(line):
            continue
        for rule_name, pattern in rules:
            if pattern.search(line):
                candidate = f"{rel}:{idx}:{rule_name}"
                if is_allowed(candidate) or is_allowed(f"{rel}:{rule_name}"):
                    continue
                print(f"{rule_name}\t{rel}\t{idx}\t{line.strip()[:240]}")
                break
PY_SCAN
}

main() {
  section "Repository constitution preflight"
  require_cmd node
  [[ -x "$CONSTITUTION_CHECKER" ]] || die "Missing executable constitution checker: $CONSTITUTION_CHECKER"
  run_constitution_output="$(node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT")"
  printf '%s\n' "$run_constitution_output"

  section "No direct write discipline"
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
    log "No no-direct-write allowlist entries loaded"
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
