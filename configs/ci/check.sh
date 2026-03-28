#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX repository structural check gate
#
# Purpose:
# - fail fast on repository topology drift before expensive CI/test/build stages
# - validate the presence and basic integrity of required packages, configs, scripts, tests, and docs
# - enforce executable-bit discipline for operational scripts
# - detect obvious package/manifest mismatches that would make later stages misleading

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
FORCE_COLOR="${FORCE_COLOR:-1}"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-check]')" "$*"
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

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  local cmd="$1"
  have_cmd "$cmd" || die "Required command not found: $cmd"
}

require_file() {
  local path="$1"
  [[ -f "$path" ]] || die "Required file missing: $path"
}

require_dir() {
  local path="$1"
  [[ -d "$path" ]] || die "Required directory missing: $path"
}

require_executable() {
  local path="$1"
  [[ -x "$path" ]] || die "Required executable bit missing: $path"
}

section() {
  printf '\n%s\n' "$(color '1;37' "== $* ==")"
}

assert_repo_root() {
  section "Repository root"
  require_file "$ROOT_DIR/package.json"
  require_dir "$ROOT_DIR/packages"
  require_dir "$ROOT_DIR/configs"
  require_dir "$ROOT_DIR/docs"
  require_file "$ROOT_DIR/README.md"
  require_file "$ROOT_DIR/LICENSE"
  ok "Repository root shape is present"
}

assert_core_package_layout() {
  section "Core package layout"

  require_dir "$ROOT_DIR/packages/adjutorix-app"
  require_file "$ROOT_DIR/packages/adjutorix-app/package.json"
  require_dir "$ROOT_DIR/packages/adjutorix-app/src"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests"

  require_dir "$ROOT_DIR/packages/adjutorix-cli"
  require_file "$ROOT_DIR/packages/adjutorix-cli/pyproject.toml"
  require_dir "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli"
  require_dir "$ROOT_DIR/packages/adjutorix-cli/tests"

  ok "Core package layout is present"
}

assert_ci_layout() {
  section "CI layout"

  require_dir "$ROOT_DIR/configs/ci"
  require_dir "$ROOT_DIR/configs/ci/scripts"
  require_file "$ROOT_DIR/configs/ci/github-actions.yml"
  require_file "$ROOT_DIR/configs/ci/check.sh"
  require_file "$ROOT_DIR/configs/ci/verify.sh"
  require_file "$ROOT_DIR/configs/ci/fix.sh"
  require_file "$ROOT_DIR/configs/ci/guard_generated_artifacts.sh"
  require_file "$ROOT_DIR/configs/ci/ci_guard_only.sh"

  require_executable "$ROOT_DIR/configs/ci/check.sh"
  require_executable "$ROOT_DIR/configs/ci/verify.sh"
  require_executable "$ROOT_DIR/configs/ci/fix.sh"
  require_executable "$ROOT_DIR/configs/ci/guard_generated_artifacts.sh"
  require_executable "$ROOT_DIR/configs/ci/ci_guard_only.sh"

  ok "CI layout and executability are valid"
}

assert_docs_layout() {
  section "Documentation layout"
  require_file "$ROOT_DIR/docs/ARCHITECTURE.md"
  require_file "$ROOT_DIR/docs/LEDGER_AND_REPLAY.md"
  require_file "$ROOT_DIR/docs/NO_MERCY_CHECKLIST.md"
  ok "Documentation baseline is present"
}

assert_app_test_domains() {
  section "App test domains"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/renderer"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/main"
  require_dir "$ROOT_DIR/packages/adjutorix-app/tests/smoke"
  ok "Renderer/main/smoke app test domains exist"
}

assert_cli_test_files() {
  section "CLI test files"
  require_file "$ROOT_DIR/packages/adjutorix-cli/tests/test_cli_replay.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/tests/test_cli_verify.py"
  ok "CLI baseline tests exist"
}

assert_cli_module_files() {
  section "CLI module files"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/main.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/rpc_client.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/transaction_graph.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/replay.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/verify.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/ledger.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/governance.py"
  require_file "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/formatting.py"
  ok "CLI module baseline exists"
}

assert_root_package_json_sanity() {
  section "Root package.json sanity"
  require_cmd python3

  python3 - <<'PY'
import json
from pathlib import Path

root = Path.cwd()
p = root / 'package.json'
data = json.loads(p.read_text(encoding='utf-8'))

if 'workspaces' not in data:
    raise SystemExit('package.json missing workspaces')
workspaces = data['workspaces']
if not isinstance(workspaces, list) or not workspaces:
    raise SystemExit('package.json workspaces must be a non-empty list')

scripts = data.get('scripts', {})
required = ['lint', 'typecheck', 'test']
missing = [name for name in required if name not in scripts]
if missing:
    raise SystemExit(f'package.json missing required scripts: {missing}')

print('root package.json sanity ok')
PY

  ok "Root package.json sanity passed"
}

assert_app_package_json_sanity() {
  section "adjutorix-app package.json sanity"
  require_cmd python3

  python3 - <<'PY'
import json
from pathlib import Path

p = Path('packages/adjutorix-app/package.json')
data = json.loads(p.read_text(encoding='utf-8'))

scripts = data.get('scripts', {})
required = ['build', 'test', 'verify']
missing = [name for name in required if name not in scripts]
if missing:
    raise SystemExit(f'adjutorix-app/package.json missing required scripts: {missing}')

name = data.get('name')
if not isinstance(name, str) or not name.strip():
    raise SystemExit('adjutorix-app/package.json missing valid name')

print('adjutorix-app package.json sanity ok')
PY

  ok "adjutorix-app package.json sanity passed"
}

assert_cli_pyproject_sanity() {
  section "adjutorix-cli pyproject.toml sanity"
  require_cmd python3

  python3 - <<'PY'
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # type: ignore

p = Path('packages/adjutorix-cli/pyproject.toml')
data = tomllib.loads(p.read_text(encoding='utf-8'))

project = data.get('project')
if not isinstance(project, dict):
    raise SystemExit('pyproject.toml missing [project] table')

name = project.get('name')
if not isinstance(name, str) or not name.strip():
    raise SystemExit('pyproject.toml project.name missing/invalid')

scripts = project.get('scripts', {})
if 'adjutorix' not in scripts:
    raise SystemExit('pyproject.toml missing project.scripts.adjutorix')

build_system = data.get('build-system')
if not isinstance(build_system, dict):
    raise SystemExit('pyproject.toml missing [build-system] table')

print('adjutorix-cli pyproject sanity ok')
PY

  ok "adjutorix-cli pyproject.toml sanity passed"
}

assert_no_empty_critical_files() {
  section "Critical file non-emptiness"
  local critical_files=(
    "$ROOT_DIR/configs/ci/github-actions.yml"
    "$ROOT_DIR/configs/ci/check.sh"
    "$ROOT_DIR/configs/ci/verify.sh"
    "$ROOT_DIR/packages/adjutorix-cli/pyproject.toml"
    "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/main.py"
    "$ROOT_DIR/packages/adjutorix-app/package.json"
  )

  local file size
  for file in "${critical_files[@]}"; do
    size="$(wc -c < "$file")"
    [[ "$size" -gt 0 ]] || die "Critical file is empty: $file"
  done
  ok "Critical files are non-empty"
}

assert_shell_shebangs() {
  section "Shell shebang discipline"
  local shell_files=(
    "$ROOT_DIR/configs/ci/check.sh"
    "$ROOT_DIR/configs/ci/verify.sh"
    "$ROOT_DIR/configs/ci/fix.sh"
    "$ROOT_DIR/configs/ci/guard_generated_artifacts.sh"
    "$ROOT_DIR/configs/ci/ci_guard_only.sh"
  )

  local file first_line
  for file in "${shell_files[@]}"; do
    first_line="$(head -n 1 "$file")"
    [[ "$first_line" == '#!/usr/bin/env bash' ]] || die "Shell file has wrong shebang: $file"
  done
  ok "Shell shebang discipline is valid"
}

assert_python_init_or_namespace_intent() {
  section "Python package intent"
  if [[ -f "$ROOT_DIR/packages/adjutorix-cli/adjutorix_cli/__init__.py" ]]; then
    ok "adjutorix_cli uses explicit package init"
  else
    warn "adjutorix_cli/__init__.py is absent; relying on namespace-package semantics"
  fi
}

assert_no_conflicting_ci_filenames() {
  section "CI filename conflicts"
  local gh_yaml gh_yml
  gh_yaml="$ROOT_DIR/.github/workflows"
  if [[ -d "$gh_yaml" ]]; then
    warn ".github/workflows exists; ensure configs/ci/github-actions.yml is the authoritative generated source"
  fi
  ok "No blocking CI filename conflicts detected"
}

main() {
  assert_repo_root
  assert_core_package_layout
  assert_ci_layout
  assert_docs_layout
  assert_app_test_domains
  assert_cli_test_files
  assert_cli_module_files
  assert_root_package_json_sanity
  assert_app_package_json_sanity
  assert_cli_pyproject_sanity
  assert_no_empty_critical_files
  assert_shell_shebangs
  assert_python_init_or_namespace_intent
  assert_no_conflicting_ci_filenames

  printf '\n%s\n' "$(color '1;32' 'Repository structural checks passed.')"
}

main "$@"
