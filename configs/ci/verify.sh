#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX CI verification gate
#
# Purpose:
# - provide one authoritative repo-wide verification entrypoint for local CI parity and GitHub Actions
# - enforce repository invariants before expensive build/test work
# - run JS/TS, Python CLI, Electron smoke, and packaging checks in a deterministic order
# - fail closed on missing tooling, missing packages, partial execution, or dirty generated artifacts
#
# Non-negotiables:
# - no hidden success on skipped stages
# - no continuing after failed prerequisites
# - no silent mutation without post-check cleanliness verification

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
cd "$ROOT_DIR"

readonly ROOT_DIR
readonly START_TS="$(date +%s)"

FORCE_COLOR="${FORCE_COLOR:-1}"
CI="${CI:-false}"
export FORCE_COLOR CI

NODE_BIN="${NODE_BIN:-node}"
NPM_BIN="${NPM_BIN:-npm}"
PYTHON_BIN="${PYTHON_BIN:-python3}"
PIP_BIN="${PIP_BIN:-$PYTHON_BIN -m pip}"
PYTEST_BIN="${PYTEST_BIN:-pytest}"
RUFF_BIN="${RUFF_BIN:-ruff}"
MYPY_BIN="${MYPY_BIN:-mypy}"
XVFB_RUN_BIN="${XVFB_RUN_BIN:-xvfb-run}"

RUN_REPO_GUARDS="${RUN_REPO_GUARDS:-1}"
RUN_JS="${RUN_JS:-1}"
RUN_PYTHON="${RUN_PYTHON:-1}"
RUN_ELECTRON="${RUN_ELECTRON:-1}"
RUN_INTEGRATION="${RUN_INTEGRATION:-1}"
RUN_PACKAGING="${RUN_PACKAGING:-1}"
RUN_PERFORMANCE="${RUN_PERFORMANCE:-1}"
STRICT_DIRTY_CHECK="${STRICT_DIRTY_CHECK:-1}"
INSTALL_DEPS="${INSTALL_DEPS:-1}"

ADJUTORIX_AGENT_URL="${ADJUTORIX_AGENT_URL:-http://127.0.0.1:8000/rpc}"
ADJUTORIX_TOKEN_FILE="${ADJUTORIX_TOKEN_FILE:-$HOME/.adjutorix/token}"
ADJUTORIX_TEST_TOKEN="${ADJUTORIX_TEST_TOKEN:-ci-test-token}"

STATUS_REPO_GUARDS="pending"
STATUS_JS="pending"
STATUS_PYTHON="pending"
STATUS_ELECTRON="pending"
STATUS_INTEGRATION="pending"
STATUS_PACKAGING="pending"
STATUS_PERFORMANCE="pending"

CURRENT_STAGE="bootstrap"
AGENT_PID=""
TMP_DIR=""

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
  printf '%s %s\n' "$(color '36' '[adjutorix]')" "$*"
}

log_ok() {
  printf '%s %s\n' "$(color '32' '[ok]')" "$*"
}

log_warn() {
  printf '%s %s\n' "$(color '33' '[warn]')" "$*"
}

log_err() {
  printf '%s %s\n' "$(color '31' '[error]')" "$*" >&2
}

section() {
  printf '\n%s\n' "$(color '1;37' "== $* ==")"
}

die() {
  log_err "$*"
  exit 1
}

have_cmd() {
  command -v "$1" >/dev/null 2>&1
}

require_cmd() {
  local cmd="$1"
  have_cmd "$cmd" || die "Required command not found: $cmd"
}

run() {
  log "$*"
  "$@"
}

mark_stage_success() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "success"
}

mark_stage_skipped() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "skipped"
}

mark_stage_failed() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "failed"
}

print_summary() {
  local end_ts elapsed
  end_ts="$(date +%s)"
  elapsed="$((end_ts - START_TS))"

  printf '\n%s\n' "$(color '1;37' '== Verification Summary ==')"
  printf '  %-20s %s\n' 'repo_guards' "$STATUS_REPO_GUARDS"
  printf '  %-20s %s\n' 'js' "$STATUS_JS"
  printf '  %-20s %s\n' 'python' "$STATUS_PYTHON"
  printf '  %-20s %s\n' 'electron' "$STATUS_ELECTRON"
  printf '  %-20s %s\n' 'integration' "$STATUS_INTEGRATION"
  printf '  %-20s %s\n' 'packaging' "$STATUS_PACKAGING"
  printf '  %-20s %s\n' 'performance' "$STATUS_PERFORMANCE"
  printf '  %-20s %ss\n' 'elapsed' "$elapsed"
}

cleanup() {
  local exit_code="$?"

  if [[ -n "$AGENT_PID" ]]; then
    kill "$AGENT_PID" >/dev/null 2>&1 || true
    wait "$AGENT_PID" >/dev/null 2>&1 || true
  fi

  if [[ -n "$TMP_DIR" && -d "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi

  if [[ "$exit_code" -ne 0 ]]; then
    log_err "Verification failed during stage: $CURRENT_STAGE"
    print_summary >&2 || true
  fi

  exit "$exit_code"
}
trap cleanup EXIT
trap 'log_err "Command failed at line $LINENO during stage: $CURRENT_STAGE"' ERR

assert_repo_root() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "package.json missing at repo root: $ROOT_DIR"
  [[ -d "$ROOT_DIR/packages/adjutorix-app" ]] || die "packages/adjutorix-app missing"
  [[ -d "$ROOT_DIR/packages/adjutorix-cli" ]] || die "packages/adjutorix-cli missing"
  [[ -d "$ROOT_DIR/configs/ci/scripts" ]] || die "configs/ci/scripts missing"
}

assert_toolchain() {
  section "Toolchain"
  require_cmd "$NODE_BIN"
  require_cmd "$NPM_BIN"
  require_cmd "$PYTHON_BIN"
  run "$NODE_BIN" --version
  run "$NPM_BIN" --version
  run "$PYTHON_BIN" --version
}

install_dependencies() {
  section "Dependency installation"
  if [[ "$INSTALL_DEPS" != "1" ]]; then
    log_warn "Skipping dependency installation because INSTALL_DEPS=$INSTALL_DEPS"
    return
  fi

  CURRENT_STAGE="install_js"
  run "$NPM_BIN" ci

  CURRENT_STAGE="install_python_cli"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    eval "$PIP_BIN install -e .[dev]"
  )

  log_ok "Dependencies installed"
}

assert_clean_git_state_before() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    log_warn "Skipping pre-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi

  CURRENT_STAGE="pre_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || die "Working tree is dirty before verification begins. Commit or stash changes first."
}

assert_clean_git_state_after() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    log_warn "Skipping post-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi

  CURRENT_STAGE="post_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || {
    printf '%s\n' "$status" >&2
    die "Verification mutated the working tree or generated artifacts unexpectedly."
  }
}

run_repo_guards() {
  if [[ "$RUN_REPO_GUARDS" != "1" ]]; then
    mark_stage_skipped REPO_GUARDS
    log_warn "Skipping repository guards"
    return
  fi

  section "Repository guards"
  CURRENT_STAGE="repo_guards"
  run bash "$ROOT_DIR/configs/ci/scripts/check.sh"
  run bash "$ROOT_DIR/configs/ci/scripts/guard_generated_artifacts.sh"
  run bash "$ROOT_DIR/configs/ci/scripts/ci_guard_only.sh"
  mark_stage_success REPO_GUARDS
  log_ok "Repository guards passed"
}

run_js_suite() {
  if [[ "$RUN_JS" != "1" ]]; then
    mark_stage_skipped JS
    log_warn "Skipping JS/TS suite"
    return
  fi

  section "JS / TS quality and tests"
  CURRENT_STAGE="js_lint"
  run "$NPM_BIN" run lint --workspaces --if-present

  CURRENT_STAGE="js_typecheck"
  run "$NPM_BIN" run typecheck --workspaces --if-present

  CURRENT_STAGE="js_tests_all"
  run "$NPM_BIN" test --workspaces --if-present -- --runInBand

  CURRENT_STAGE="app_verify_gate"
  run "$NPM_BIN" --prefix "$ROOT_DIR/packages/adjutorix-app" run verify

  CURRENT_STAGE="js_invariants"
  run "$NPM_BIN" test --workspaces --if-present -- tests/invariants

  CURRENT_STAGE="js_contracts"
  run "$NPM_BIN" test --workspaces --if-present -- tests/contracts

  CURRENT_STAGE="js_replay_recovery"
  run "$NPM_BIN" test --workspaces --if-present -- tests/replay tests/recovery

  mark_stage_success JS
  log_ok "JS / TS suite passed"
}

run_python_suite() {
  if [[ "$RUN_PYTHON" != "1" ]]; then
    mark_stage_skipped PYTHON
    log_warn "Skipping Python CLI suite"
    return
  fi

  section "Python CLI quality and tests"
  CURRENT_STAGE="python_ruff_check"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$RUFF_BIN" check src tests
  )

  CURRENT_STAGE="python_ruff_format"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$RUFF_BIN" format --check src tests
  )

  CURRENT_STAGE="python_mypy"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$MYPY_BIN" src
  )

  CURRENT_STAGE="python_pytest"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTEST_BIN" -q
  )

  mark_stage_success PYTHON
  log_ok "Python CLI suite passed"
}

need_xvfb() {
  [[ "$RUN_ELECTRON" == "1" ]]
}

assert_xvfb_if_needed() {
  if need_xvfb; then
    require_cmd "$XVFB_RUN_BIN"
  fi
}

run_electron_suite() {
  if [[ "$RUN_ELECTRON" != "1" ]]; then
    mark_stage_skipped ELECTRON
    log_warn "Skipping Electron suite"
    return
  fi

  section "Electron renderer / main / smoke"
  CURRENT_STAGE="electron_renderer_tests"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$XVFB_RUN_BIN" -a "$NPM_BIN" test -- tests/renderer
  )

  CURRENT_STAGE="electron_main_tests"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$XVFB_RUN_BIN" -a "$NPM_BIN" test -- tests/main
  )

  CURRENT_STAGE="electron_smoke_tests"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$XVFB_RUN_BIN" -a "$NPM_BIN" test -- tests/smoke
  )

  CURRENT_STAGE="electron_build"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$NPM_BIN" run build
  )

  mark_stage_success ELECTRON
  log_ok "Electron suite passed"
}

bootstrap_token() {
  mkdir -p "$(dirname "$ADJUTORIX_TOKEN_FILE")"
  printf '%s\n' "$ADJUTORIX_TEST_TOKEN" > "$ADJUTORIX_TOKEN_FILE"
}

start_agent() {
  CURRENT_STAGE="integration_agent_start"
  TMP_DIR="$(mktemp -d)"
  bootstrap_token

  python - <<'PY' >/dev/null 2>&1 || true
import importlib.util
mods = [
    'packages.adjutorix_agent.adjutorix_agent.server.main',
    'adjutorix_agent.server.main',
]
for mod in mods:
    try:
        __import__(mod)
        raise SystemExit(0)
    except Exception:
        pass
raise SystemExit(0)
PY

  local log_file="$TMP_DIR/agent.log"
  if "$PYTHON_BIN" -m packages.adjutorix_agent.adjutorix_agent.server.main >"$log_file" 2>&1 & then
    AGENT_PID="$!"
  else
    die "Failed to start agent process"
  fi
}

wait_for_agent() {
  CURRENT_STAGE="integration_agent_wait"
  local deadline shell_ok
  deadline=$((SECONDS + 40))
  shell_ok=0
  while (( SECONDS < deadline )); do
    if "$PYTHON_BIN" - <<PY
import json
import urllib.request
req = urllib.request.Request(
    '$ADJUTORIX_AGENT_URL',
    data=json.dumps({'jsonrpc':'2.0','id':1,'method':'system.ping','params':{}}).encode(),
    headers={
        'Content-Type': 'application/json',
        'x-adjutorix-token': '$ADJUTORIX_TEST_TOKEN',
    },
    method='POST',
)
with urllib.request.urlopen(req, timeout=3) as resp:
    body = json.loads(resp.read().decode())
    assert body.get('jsonrpc') == '2.0'
print('ready')
PY
    then
      shell_ok=1
      break
    fi
    sleep 1
  done

  [[ "$shell_ok" == "1" ]] || {
    [[ -f "$TMP_DIR/agent.log" ]] && cat "$TMP_DIR/agent.log" >&2 || true
    die "Agent did not become ready in time"
  }
}

run_integration_suite() {
  if [[ "$RUN_INTEGRATION" != "1" ]]; then
    mark_stage_skipped INTEGRATION
    log_warn "Skipping agent/CLI integration suite"
    return
  fi

  section "Agent / CLI integration"
  start_agent
  wait_for_agent

  CURRENT_STAGE="integration_cli_ping"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run adjutorix ping --agent-url "$ADJUTORIX_AGENT_URL" --output json
  )

  CURRENT_STAGE="integration_cli_pytest"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTEST_BIN" -q
  )

  mark_stage_success INTEGRATION
  log_ok "Integration suite passed"
}

run_packaging_suite() {
  if [[ "$RUN_PACKAGING" != "1" ]]; then
    mark_stage_skipped PACKAGING
    log_warn "Skipping packaging suite"
    return
  fi

  section "Packaging / distributables"
  CURRENT_STAGE="package_cli_build"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTHON_BIN" -m build
  )

  CURRENT_STAGE="package_app_build"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$NPM_BIN" run build
  )

  mark_stage_success PACKAGING
  log_ok "Packaging suite passed"
}

run_performance_suite() {
  if [[ "$RUN_PERFORMANCE" != "1" ]]; then
    mark_stage_skipped PERFORMANCE
    log_warn "Skipping performance suite"
    return
  fi

  section "Performance constraints"
  CURRENT_STAGE="performance_tests"
  run "$NPM_BIN" test --workspaces --if-present -- tests/performance
  mark_stage_success PERFORMANCE
  log_ok "Performance suite passed"
}

main() {
  assert_repo_root
  assert_toolchain
  assert_xvfb_if_needed
  assert_clean_git_state_before
  install_dependencies

  run_repo_guards
  run_js_suite
  run_python_suite
  run_electron_suite
  run_integration_suite
  run_packaging_suite
  run_performance_suite

  assert_clean_git_state_after
  print_summary
  log_ok "ADJUTORIX verification completed successfully"
}

main "$@"
