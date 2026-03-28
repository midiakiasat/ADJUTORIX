#!/usr/bin/env bash
set -Eeuo pipefail

# ADJUTORIX smoke gate
#
# Purpose:
# - provide one fast, end-to-end product smoke entrypoint for local and CI use
# - exercise the highest-risk boot and integration surfaces without running the full exhaustive suite
# - prove that the repository can install, boot, expose governed UI/API surfaces, and execute core CLI/app smokes
# - fail closed on missing prerequisites, partial stage success, hidden background failure, or dirty-tree mutation

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
PYTEST_BIN="${PYTEST_BIN:-pytest}"
XVFB_RUN_BIN="${XVFB_RUN_BIN:-xvfb-run}"

INSTALL_DEPS="${INSTALL_DEPS:-1}"
STRICT_DIRTY_CHECK="${STRICT_DIRTY_CHECK:-1}"
RUN_REPO_GUARDS="${RUN_REPO_GUARDS:-1}"
RUN_RENDERER_SMOKE="${RUN_RENDERER_SMOKE:-1}"
RUN_MAIN_SMOKE="${RUN_MAIN_SMOKE:-1}"
RUN_APP_SMOKE="${RUN_APP_SMOKE:-1}"
RUN_CLI_SMOKE="${RUN_CLI_SMOKE:-1}"
RUN_AGENT_INTEGRATION_SMOKE="${RUN_AGENT_INTEGRATION_SMOKE:-1}"
RUN_BUILD_SMOKE="${RUN_BUILD_SMOKE:-1}"

ADJUTORIX_AGENT_URL="${ADJUTORIX_AGENT_URL:-http://127.0.0.1:8000/rpc}"
ADJUTORIX_TOKEN_FILE="${ADJUTORIX_TOKEN_FILE:-$HOME/.adjutorix/token}"
ADJUTORIX_TEST_TOKEN="${ADJUTORIX_TEST_TOKEN:-ci-test-token}"

STATUS_REPO_GUARDS="pending"
STATUS_RENDERER_SMOKE="pending"
STATUS_MAIN_SMOKE="pending"
STATUS_APP_SMOKE="pending"
STATUS_CLI_SMOKE="pending"
STATUS_AGENT_INTEGRATION_SMOKE="pending"
STATUS_BUILD_SMOKE="pending"

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
  printf '%s %s\n' "$(color '36' '[adjutorix-smoke]')" "$*"
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

mark_success() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "success"
}

mark_skipped() {
  local name="$1"
  printf -v "STATUS_${name}" '%s' "skipped"
}

print_summary() {
  local end_ts elapsed
  end_ts="$(date +%s)"
  elapsed="$((end_ts - START_TS))"

  printf '\n%s\n' "$(color '1;37' '== Smoke Summary ==')"
  printf '  %-26s %s\n' 'repo_guards' "$STATUS_REPO_GUARDS"
  printf '  %-26s %s\n' 'renderer_smoke' "$STATUS_RENDERER_SMOKE"
  printf '  %-26s %s\n' 'main_smoke' "$STATUS_MAIN_SMOKE"
  printf '  %-26s %s\n' 'app_smoke' "$STATUS_APP_SMOKE"
  printf '  %-26s %s\n' 'cli_smoke' "$STATUS_CLI_SMOKE"
  printf '  %-26s %s\n' 'agent_integration_smoke' "$STATUS_AGENT_INTEGRATION_SMOKE"
  printf '  %-26s %s\n' 'build_smoke' "$STATUS_BUILD_SMOKE"
  printf '  %-26s %ss\n' 'elapsed' "$elapsed"
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
    err "Smoke failed during stage: $CURRENT_STAGE"
    print_summary >&2 || true
  fi

  exit "$exit_code"
}
trap cleanup EXIT
trap 'err "Command failed at line $LINENO during stage: $CURRENT_STAGE"' ERR

assert_repo_root() {
  [[ -f "$ROOT_DIR/package.json" ]] || die "Missing package.json at repo root"
  [[ -d "$ROOT_DIR/packages/adjutorix-app" ]] || die "Missing packages/adjutorix-app"
  [[ -d "$ROOT_DIR/packages/adjutorix-cli" ]] || die "Missing packages/adjutorix-cli"
}

assert_toolchain() {
  section "Toolchain"
  require_cmd "$NODE_BIN"
  require_cmd "$NPM_BIN"
  require_cmd "$PYTHON_BIN"
  require_cmd "$XVFB_RUN_BIN"
  run "$NODE_BIN" --version
  run "$NPM_BIN" --version
  run "$PYTHON_BIN" --version
}

install_dependencies() {
  if [[ "$INSTALL_DEPS" != "1" ]]; then
    warn "Skipping dependency installation because INSTALL_DEPS=$INSTALL_DEPS"
    return
  fi

  section "Dependency installation"
  CURRENT_STAGE="install_js"
  run "$NPM_BIN" ci

  CURRENT_STAGE="install_python_cli"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTHON_BIN" -m pip install -e .[dev]
  )

  ok "Dependencies installed"
}

assert_clean_git_state_before() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    warn "Skipping pre-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi

  CURRENT_STAGE="pre_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || die "Working tree is dirty before smoke begins. Commit or stash changes first."
}

assert_clean_git_state_after() {
  if [[ "$STRICT_DIRTY_CHECK" != "1" ]]; then
    warn "Skipping post-run dirty tree check because STRICT_DIRTY_CHECK=$STRICT_DIRTY_CHECK"
    return
  fi

  CURRENT_STAGE="post_dirty_check"
  local status
  status="$(git status --porcelain=v1)"
  [[ -z "$status" ]] || {
    printf '%s\n' "$status" >&2
    die "Smoke mutated the working tree or generated artifacts unexpectedly."
  }
}

run_repo_guards() {
  if [[ "$RUN_REPO_GUARDS" != "1" ]]; then
    mark_skipped REPO_GUARDS
    warn "Skipping repository guards"
    return
  fi

  section "Repository guards"
  CURRENT_STAGE="repo_guards"
  run bash "$ROOT_DIR/configs/ci/check.sh"
  run bash "$ROOT_DIR/configs/ci/guard_generated_artifacts.sh"
  mark_success REPO_GUARDS
  ok "Repository guards passed"
}

run_renderer_smoke() {
  if [[ "$RUN_RENDERER_SMOKE" != "1" ]]; then
    mark_skipped RENDERER_SMOKE
    warn "Skipping renderer smoke"
    return
  fi

  section "Renderer smoke"
  CURRENT_STAGE="renderer_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$XVFB_RUN_BIN" -a "$NPM_BIN" test -- \
      tests/renderer/app_shell.test.tsx \
      tests/renderer/welcome_screen.test.tsx \
      tests/renderer/provider_status.test.tsx \
      tests/renderer/command_palette.test.tsx
  )
  mark_success RENDERER_SMOKE
  ok "Renderer smoke passed"
}

run_main_smoke() {
  if [[ "$RUN_MAIN_SMOKE" != "1" ]]; then
    mark_skipped MAIN_SMOKE
    warn "Skipping main-process smoke"
    return
  fi

  section "Main-process smoke"
  CURRENT_STAGE="main_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$NPM_BIN" test -- \
      tests/main/preload_bridge.test.ts \
      tests/main/exposed_api_contract.test.ts \
      tests/main/renderer_policy.test.ts \
      tests/main/invariant_enforcer.test.ts
  )
  mark_success MAIN_SMOKE
  ok "Main-process smoke passed"
}

run_app_smoke() {
  if [[ "$RUN_APP_SMOKE" != "1" ]]; then
    mark_skipped APP_SMOKE
    warn "Skipping app smoke"
    return
  fi

  section "App smoke"
  CURRENT_STAGE="app_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$XVFB_RUN_BIN" -a "$NPM_BIN" test -- \
      tests/smoke/app_boot.smoke.test.ts \
      tests/smoke/open_workspace.smoke.test.ts \
      tests/smoke/restore_workspace_session.smoke.test.ts \
      tests/smoke/agent_connect.smoke.test.ts \
      tests/smoke/agent_disconnect_reconnect.smoke.test.ts \
      tests/smoke/command_palette_open.smoke.test.ts \
      tests/smoke/editor_open_file.smoke.test.ts \
      tests/smoke/large_file_guard.smoke.test.ts \
      tests/smoke/diagnostics_roundtrip.smoke.test.ts \
      tests/smoke/patch_review_load.smoke.test.ts \
      tests/smoke/verify_flow.smoke.test.ts \
      tests/smoke/ledger_flow.smoke.test.ts \
      tests/smoke/terminal_run.smoke.test.ts \
      tests/smoke/settings_persist.smoke.test.ts \
      tests/smoke/about_panel_render.smoke.test.ts
  )
  mark_success APP_SMOKE
  ok "App smoke passed"
}

bootstrap_token() {
  mkdir -p "$(dirname "$ADJUTORIX_TOKEN_FILE")"
  printf '%s\n' "$ADJUTORIX_TEST_TOKEN" > "$ADJUTORIX_TOKEN_FILE"
}

start_agent() {
  CURRENT_STAGE="start_agent"
  TMP_DIR="$(mktemp -d)"
  bootstrap_token

  local log_file="$TMP_DIR/agent.log"

  if "$PYTHON_BIN" -m packages.adjutorix_agent.adjutorix_agent.server.main >"$log_file" 2>&1 & then
    AGENT_PID="$!"
  else
    die "Failed to start ADJUTORIX agent process"
  fi
}

wait_for_agent() {
  CURRENT_STAGE="wait_for_agent"
  local deadline ready
  deadline=$((SECONDS + 40))
  ready=0

  while (( SECONDS < deadline )); do
    if "$PYTHON_BIN" - <<PY
import json
import urllib.request
req = urllib.request.Request(
    '$ADJUTORIX_AGENT_URL',
    data=json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'system.ping', 'params': {}}).encode(),
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
      ready=1
      break
    fi
    sleep 1
  done

  [[ "$ready" == "1" ]] || {
    [[ -f "$TMP_DIR/agent.log" ]] && cat "$TMP_DIR/agent.log" >&2 || true
    die "Agent did not become ready in time"
  }
}

run_cli_smoke() {
  if [[ "$RUN_CLI_SMOKE" != "1" ]]; then
    mark_skipped CLI_SMOKE
    warn "Skipping CLI smoke"
    return
  fi

  section "CLI smoke"
  CURRENT_STAGE="cli_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTEST_BIN" -q tests/test_cli_replay.py tests/test_cli_verify.py
  )
  mark_success CLI_SMOKE
  ok "CLI smoke passed"
}

run_agent_integration_smoke() {
  if [[ "$RUN_AGENT_INTEGRATION_SMOKE" != "1" ]]; then
    mark_skipped AGENT_INTEGRATION_SMOKE
    warn "Skipping agent integration smoke"
    return
  fi

  section "Agent integration smoke"
  start_agent
  wait_for_agent

  CURRENT_STAGE="agent_cli_ping"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run adjutorix ping --agent-url "$ADJUTORIX_AGENT_URL" --output json
  )

  CURRENT_STAGE="agent_cli_connect"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run adjutorix agent connect --agent-url "$ADJUTORIX_AGENT_URL" --output json
  )

  mark_success AGENT_INTEGRATION_SMOKE
  ok "Agent integration smoke passed"
}

run_build_smoke() {
  if [[ "$RUN_BUILD_SMOKE" != "1" ]]; then
    mark_skipped BUILD_SMOKE
    warn "Skipping build smoke"
    return
  fi

  section "Build smoke"
  CURRENT_STAGE="cli_build_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-cli"
    run "$PYTHON_BIN" -m build
  )

  CURRENT_STAGE="app_build_smoke"
  (
    cd "$ROOT_DIR/packages/adjutorix-app"
    run "$NPM_BIN" run build
  )

  mark_success BUILD_SMOKE
  ok "Build smoke passed"
}

main() {
  assert_repo_root
  assert_toolchain
  assert_clean_git_state_before
  install_dependencies

  run_repo_guards
  run_renderer_smoke
  run_main_smoke
  run_app_smoke
  run_cli_smoke
  run_agent_integration_smoke
  run_build_smoke

  assert_clean_git_state_after
  print_summary
  ok "ADJUTORIX smoke completed successfully"
}

main "$@"
