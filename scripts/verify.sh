#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX REPOSITORY VERIFICATION ENTRYPOINT
#
# Purpose
# - provide one authoritative, reproducible verification entrypoint for the repo
# - validate toolchain, repository shape, configuration contracts, policies,
#   runtime files, package manifests, and test/lint/typecheck/build surfaces
# - fail fast on ambiguous state, missing artifacts, drift, or bypass attempts
# - emit an explicit phase-by-phase record suitable for local use and CI
#
# Design constraints
# - no silent fallback to partial verification
# - no hidden mutation beyond deterministic temp/log files under .tmp
# - every enabled phase is explicit, ordered, and auditable
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROGRAM_NAME="$(basename -- "$0")"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

readonly SCRIPT_DIR
readonly REPO_ROOT
readonly PROGRAM_NAME
readonly START_TS

###############################################################################
# DEFAULTS (override via env or flags)
###############################################################################

: "${ADJUTORIX_VERIFY_STACK_NAME:=adjutorix-verify}"
: "${ADJUTORIX_VERIFY_RUNTIME_MODE:=test}"
: "${ADJUTORIX_VERIFY_USE_COLOR:=true}"
: "${ADJUTORIX_VERIFY_FAIL_FAST:=true}"
: "${ADJUTORIX_VERIFY_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_VERIFY_RUN_INSTALL:=false}"
: "${ADJUTORIX_VERIFY_RUN_ROOT_LINT:=true}"
: "${ADJUTORIX_VERIFY_RUN_ROOT_TYPECHECK:=true}"
: "${ADJUTORIX_VERIFY_RUN_ROOT_TESTS:=true}"
: "${ADJUTORIX_VERIFY_RUN_APP_CHECKS:=true}"
: "${ADJUTORIX_VERIFY_RUN_AGENT_CHECKS:=true}"
: "${ADJUTORIX_VERIFY_RUN_CLI_CHECKS:=true}"
: "${ADJUTORIX_VERIFY_RUN_CONTRACT_GUARDS:=true}"
: "${ADJUTORIX_VERIFY_RUN_CONSTITUTION_GUARDS:=true}"
: "${ADJUTORIX_VERIFY_RUN_POLICY_GUARDS:=true}"
: "${ADJUTORIX_VERIFY_RUN_RUNTIME_CONFIG_GUARDS:=true}"
: "${ADJUTORIX_VERIFY_RUN_OBSERVABILITY_GUARDS:=true}"
: "${ADJUTORIX_VERIFY_RUN_INVARIANT_TESTS:=true}"
: "${ADJUTORIX_VERIFY_RUN_SMOKE_TESTS:=true}"
: "${ADJUTORIX_VERIFY_RUN_BUILD_CHECKS:=false}"
: "${ADJUTORIX_VERIFY_RUN_RELEASE_CHECKS:=false}"
: "${ADJUTORIX_VERIFY_ALLOW_MISSING_OPTIONAL_TOOLS:=true}"
: "${ADJUTORIX_VERIFY_ROOT_TMP:=${REPO_ROOT}/.tmp/verify}"
: "${ADJUTORIX_VERIFY_LOG_DIR:=${ADJUTORIX_VERIFY_ROOT_TMP}/logs}"
: "${ADJUTORIX_VERIFY_REPORT_DIR:=${ADJUTORIX_VERIFY_ROOT_TMP}/reports}"
: "${ADJUTORIX_VERIFY_BOOT_LOG:=${ADJUTORIX_VERIFY_LOG_DIR}/verify.log}"
: "${ADJUTORIX_VERIFY_SUMMARY_FILE:=${ADJUTORIX_VERIFY_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_VERIFY_PHASE_FILE:=${ADJUTORIX_VERIFY_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER:=npm}"
: "${ADJUTORIX_VERIFY_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_VERIFY_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_VERIFY_CLI_DIR:=${REPO_ROOT}/packages/adjutorix-cli}"
: "${ADJUTORIX_VERIFY_CONTRACTS_DIR:=${REPO_ROOT}/configs/contracts}"
export ADJUTORIX_VERIFY_CONTRACTS_DIR
: "${ADJUTORIX_VERIFY_CONSTITUTION_PATH:=${REPO_ROOT}/configs/adjutorix/constitution.json}"
: "${ADJUTORIX_VERIFY_CONSTITUTION_CHECKER:=${REPO_ROOT}/scripts/adjutorix-constitution-check.mjs}"
: "${ADJUTORIX_VERIFY_CONSTITUTION_REPORT:=${ADJUTORIX_VERIFY_REPORT_DIR}/constitution-report.json}"
export ADJUTORIX_VERIFY_CONSTITUTION_PATH
export ADJUTORIX_VERIFY_CONSTITUTION_CHECKER
export ADJUTORIX_VERIFY_CONSTITUTION_REPORT
: "${ADJUTORIX_VERIFY_POLICY_DIR:=${REPO_ROOT}/configs/policy}"
export ADJUTORIX_VERIFY_POLICY_DIR
: "${ADJUTORIX_VERIFY_RUNTIME_DIR:=${REPO_ROOT}/configs/runtime}"
export ADJUTORIX_VERIFY_RUNTIME_DIR
: "${ADJUTORIX_VERIFY_OBSERVABILITY_DIR:=${REPO_ROOT}/configs/observability}"
export ADJUTORIX_VERIFY_OBSERVABILITY_DIR

INSTALL_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" install)
ROOT_LINT_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" run lint)
ROOT_TYPECHECK_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" run typecheck)
ROOT_TEST_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" test)
ROOT_BUILD_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" run build)
APP_VERIFY_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" --prefix "$ADJUTORIX_VERIFY_APP_DIR" run verify)
APP_TEST_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" --prefix "$ADJUTORIX_VERIFY_APP_DIR" test)
AGENT_TEST_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" test)
CLI_TEST_CMD=("${ADJUTORIX_VERIFY_NODE_PACKAGE_MANAGER}" test)

###############################################################################
# GLOBAL STATE
###############################################################################

NO_COLOR=false
QUIET=false
VERBOSE=false
ONLY_PHASES=()
SKIP_PHASES=()
PHASE_RESULTS=()
OVERALL_FAILURES=0
PHASE_INDEX=0

###############################################################################
# LOGGING
###############################################################################

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_VERIFY_USE_COLOR}" != "true" || ! -t 1 ]]; then
  C_RESET=""
  C_RED=""
  C_GREEN=""
  C_YELLOW=""
  C_BLUE=""
  C_CYAN=""
  C_BOLD=""
else
  C_RESET=$'\033[0m'
  C_RED=$'\033[31m'
  C_GREEN=$'\033[32m'
  C_YELLOW=$'\033[33m'
  C_BLUE=$'\033[34m'
  C_CYAN=$'\033[36m'
  C_BOLD=$'\033[1m'
fi

ensure_dir() { mkdir -p "$1"; }

log_raw() {
  local level="$1"
  shift
  local msg="$*"
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_VERIFY_BOOT_LOG" >&2
}

log_info() { [[ "$QUIET" == "true" ]] || log_raw INFO "$@"; }
log_warn() { log_raw WARN "$@"; }
log_error() { log_raw ERROR "$@"; }
log_debug() { [[ "$VERBOSE" == "true" ]] && log_raw DEBUG "$@" || true; }

die() {
  log_error "$*"
  exit 1
}

section() {
  local title="$1"
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_VERIFY_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/verify.sh [options]

Options:
  --install                     Run dependency installation before verification
  --require-clean-worktree      Fail if git worktree is dirty
  --fail-fast                   Stop at first failed phase
  --no-fail-fast                Continue after failed phases
  --build                       Include build checks
  --release                     Include release-oriented checks
  --no-smoke                    Skip smoke tests
  --no-color                    Disable ANSI colors
  --quiet                       Reduce non-error terminal output
  --verbose                     Emit debug logging
  --only <phase>                Run only the named phase (repeatable)
  --skip <phase>                Skip the named phase (repeatable)
  --help                        Show this help

Named phases:
  repo_layout
  toolchain
  git_state
  install
  constitution
  contracts
  policy
  runtime_config
  observability
  root_lint
  root_typecheck
  root_tests
  app_checks
  agent_checks
  cli_checks
  invariants
  smoke
  build
  release
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --install)
        ADJUTORIX_VERIFY_RUN_INSTALL=true
        ;;
      --require-clean-worktree)
        ADJUTORIX_VERIFY_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --fail-fast)
        ADJUTORIX_VERIFY_FAIL_FAST=true
        ;;
      --no-fail-fast)
        ADJUTORIX_VERIFY_FAIL_FAST=false
        ;;
      --build)
        ADJUTORIX_VERIFY_RUN_BUILD_CHECKS=true
        ;;
      --release)
        ADJUTORIX_VERIFY_RUN_RELEASE_CHECKS=true
        ;;
      --no-smoke)
        ADJUTORIX_VERIFY_RUN_SMOKE_TESTS=false
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_VERIFY_USE_COLOR=false
        ;;
      --quiet)
        QUIET=true
        ;;
      --verbose)
        VERBOSE=true
        ;;
      --only)
        shift
        [[ $# -gt 0 ]] || die "--only requires a phase name"
        ONLY_PHASES+=("$1")
        ;;
      --skip)
        shift
        [[ $# -gt 0 ]] || die "--skip requires a phase name"
        SKIP_PHASES+=("$1")
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        die "Unknown argument: $1"
        ;;
    esac
    shift
  done
}

###############################################################################
# HELPERS
###############################################################################

contains_value() {
  local needle="$1"
  shift || true
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

should_run_phase() {
  local phase="$1"
  if ((${#ONLY_PHASES[@]} > 0)); then
    contains_value "$phase" "${ONLY_PHASES[@]}" || return 1
  fi
  if ((${#SKIP_PHASES[@]} > 0)); then
    contains_value "$phase" "${SKIP_PHASES[@]}" && return 1
  fi
  return 0
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

require_dir() {
  [[ -d "$1" ]] || die "Required directory not found: $1"
}

require_file() {
  [[ -f "$1" ]] || die "Required file not found: $1"
}

run_cmd_logged() {
  local phase="$1"
  shift
  log_debug "Running command for phase=${phase}: $*"
  "$@" >>"$ADJUTORIX_VERIFY_BOOT_LOG" 2>&1
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_VERIFY_PHASE_FILE"
  PHASE_RESULTS+=("${phase}:${status}:${duration_ms}")
}

run_phase() {
  local phase="$1"
  shift
  if ! should_run_phase "$phase"; then
    log_debug "Skipping phase=${phase} due to phase selection"
    return 0
  fi

  PHASE_INDEX=$((PHASE_INDEX + 1))
  local started finished duration_ms
  started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
  local started_epoch_ms
  started_epoch_ms="$(python3 - <<'PY'
import time
print(int(time.time() * 1000))
PY
)"

  section "[${PHASE_INDEX}] ${phase}"
  if "$@"; then
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python3 - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" "PASS" "$started" "$finished" "$duration_ms"
    log_info "Phase passed: ${phase} (${duration_ms} ms)"
  else
    finished="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    duration_ms="$(python3 - <<PY
import time
print(int(time.time() * 1000) - int(${started_epoch_ms}))
PY
)"
    record_phase "$phase" "FAIL" "$started" "$finished" "$duration_ms"
    OVERALL_FAILURES=$((OVERALL_FAILURES + 1))
    log_error "Phase failed: ${phase} (${duration_ms} ms)"
    if [[ "$ADJUTORIX_VERIFY_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASE IMPLEMENTATIONS
###############################################################################

phase_repo_layout() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_VERIFY_APP_DIR"
  require_dir "$ADJUTORIX_VERIFY_AGENT_DIR"
  require_dir "$ADJUTORIX_VERIFY_CLI_DIR"
  require_dir "$ADJUTORIX_VERIFY_CONTRACTS_DIR"
  require_dir "$ADJUTORIX_VERIFY_POLICY_DIR"
  require_dir "$ADJUTORIX_VERIFY_RUNTIME_DIR"
  require_dir "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_VERIFY_CONSTITUTION_PATH"
  require_file "$ADJUTORIX_VERIFY_CONSTITUTION_CHECKER"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/rpc_capabilities.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/protocol_versions.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/patch_artifact.schema.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/transaction_states.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/ledger_edges.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/verify_summary.schema.json"
  require_file "$ADJUTORIX_VERIFY_CONTRACTS_DIR/governance_decision.schema.json"
  require_file "$ADJUTORIX_VERIFY_POLICY_DIR/verify_policy.yaml"
  require_file "$ADJUTORIX_VERIFY_POLICY_DIR/trust_policy.yaml"
  require_file "$ADJUTORIX_VERIFY_RUNTIME_DIR/feature_flags.json"
  require_file "$ADJUTORIX_VERIFY_RUNTIME_DIR/logging.json"
  require_file "$ADJUTORIX_VERIFY_RUNTIME_DIR/limits.json"
  require_file "$ADJUTORIX_VERIFY_RUNTIME_DIR/timeouts.json"
  require_file "$ADJUTORIX_VERIFY_RUNTIME_DIR/scheduling.json"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/metrics.yaml"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/event_catalog.yaml"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/error_codes.yaml"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/log_redaction.yaml"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/tracing.yaml"
  require_file "$ADJUTORIX_VERIFY_OBSERVABILITY_DIR/dashboards.yaml"
}

phase_toolchain() {
  require_command git
  require_command python3
  require_command node
  require_command npm
  require_command bash
  require_command grep
  require_command find
}

phase_git_state() {
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
  if [[ "$ADJUTORIX_VERIFY_REQUIRE_CLEAN_WORKTREE" == "true" ]]; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]]
  fi
}

phase_install() {
  run_cmd_logged install bash -lc "cd '$REPO_ROOT' && ${INSTALL_CMD[*]}"
}

phase_constitution() {
  run_cmd_logged constitution node "$ADJUTORIX_VERIFY_CONSTITUTION_CHECKER" --report "$ADJUTORIX_VERIFY_CONSTITUTION_REPORT"
}

phase_contracts() {
  python3 - <<'PY'
import json
import os
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_VERIFY_CONTRACTS_DIR"])
for path in sorted(root.glob("*.json")):
    with path.open("r", encoding="utf-8") as fh:
        json.load(fh)
print("contract-json-parse-ok")
PY
}

phase_policy() {
  python3 - <<'PY'
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_VERIFY_POLICY_DIR"])
required = ["verify_policy.yaml", "trust_policy.yaml"]
for name in required:
    text = (root / name).read_text(encoding="utf-8")
    if "policy_id:" not in text and "policy_id:" not in text.replace("\r\n", "\n"):
        raise SystemExit(f"missing policy_id in {name}")
    if "default_decision:" not in text:
        raise SystemExit(f"missing default_decision in {name}")
print("policy-shape-ok")
PY
}

phase_runtime_config() {
  python3 - <<'PY'
import json
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_VERIFY_RUNTIME_DIR"])
json_files = ["feature_flags.json", "logging.json", "limits.json", "timeouts.json", "scheduling.json"]
for name in json_files:
    with (root / name).open("r", encoding="utf-8") as fh:
        json.load(fh)
for name in ["app.env.example", "agent.env.example"]:
    text = (root / name).read_text(encoding="utf-8")
    if "ADJUTORIX_" not in text and "VITE_" not in text:
        raise SystemExit(f"runtime env example lacks expected variable prefixes: {name}")
print("runtime-config-ok")
PY
}

phase_observability() {
  python3 - <<'PY'
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_VERIFY_OBSERVABILITY_DIR"])
required = [
    "metrics.yaml",
    "event_catalog.yaml",
    "error_codes.yaml",
    "log_redaction.yaml",
    "tracing.yaml",
    "dashboards.yaml",
]
for name in required:
    text = (root / name).read_text(encoding="utf-8")
    if "title:" not in text and "registry_id:" not in text and "policy_id:" not in text:
        raise SystemExit(f"observability file missing identifying structure: {name}")
print("observability-shape-ok")
PY
}

phase_root_lint() {
  run_cmd_logged root_lint bash -lc "cd '$REPO_ROOT' && ${ROOT_LINT_CMD[*]}"
}

phase_root_typecheck() {
  run_cmd_logged root_typecheck bash -lc "cd '$REPO_ROOT' && ${ROOT_TYPECHECK_CMD[*]}"
}

phase_root_tests() {
  run_cmd_logged root_tests bash -lc "cd '$REPO_ROOT' && ${ROOT_TEST_CMD[*]}"
}

phase_app_checks() {
  run_cmd_logged app_checks bash -lc "cd '$REPO_ROOT' && ${APP_VERIFY_CMD[*]}"
}

phase_agent_checks() {
  run_cmd_logged agent_checks bash -lc "cd '$ADJUTORIX_VERIFY_AGENT_DIR' && ${AGENT_TEST_CMD[*]}"
}

phase_cli_checks() {
  run_cmd_logged cli_checks bash -lc "cd '$ADJUTORIX_VERIFY_CLI_DIR' && ${CLI_TEST_CMD[*]}"
}

phase_invariants() {
  if [[ ! -d "$REPO_ROOT/tests/invariants" ]]; then
    log_warn "Invariant test directory missing; treating as failure"
    return 1
  fi
  run_cmd_logged invariants bash -lc "cd '$REPO_ROOT' && node --loader ./scripts/node-ts-extension-loader.mjs --test tests/invariants/*.test.ts"
}

phase_smoke() {
  if [[ ! -d "$ADJUTORIX_VERIFY_APP_DIR/tests/smoke" ]]; then
    log_warn "Smoke test directory missing; treating as failure"
    return 1
  fi
  run_cmd_logged smoke bash -lc "cd '$ADJUTORIX_VERIFY_APP_DIR' && pnpm exec vitest run --config vitest.smoke.config.ts"
}

phase_build() {
  run_cmd_logged build bash -lc "cd '$REPO_ROOT' && ${ROOT_BUILD_CMD[*]}"
}

phase_release() {
  if [[ -x "$REPO_ROOT/configs/ci/package-macos.sh" ]]; then
    run_cmd_logged release bash -lc "cd '$REPO_ROOT' && configs/ci/package-macos.sh"
  else
    log_warn "Release packaging script not executable or missing: configs/ci/package-macos.sh"
    return 1
  fi
}

###############################################################################
# SUMMARY
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_VERIFY_ROOT_TMP"
  ensure_dir "$ADJUTORIX_VERIFY_LOG_DIR"
  ensure_dir "$ADJUTORIX_VERIFY_REPORT_DIR"
  : >"$ADJUTORIX_VERIFY_BOOT_LOG"
  : >"$ADJUTORIX_VERIFY_SUMMARY_FILE"
  : >"$ADJUTORIX_VERIFY_PHASE_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_VERIFY_PHASE_FILE"
}

print_summary() {
  {
    echo "ADJUTORIX verification summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "stack_name: ${ADJUTORIX_VERIFY_STACK_NAME}"
    echo "runtime_mode: ${ADJUTORIX_VERIFY_RUNTIME_MODE}"
    echo "fail_fast: ${ADJUTORIX_VERIFY_FAIL_FAST}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo ""
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
  } | tee "$ADJUTORIX_VERIFY_SUMMARY_FILE" >&2
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX repository verification"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "boot_log=${ADJUTORIX_VERIFY_BOOT_LOG} summary_file=${ADJUTORIX_VERIFY_SUMMARY_FILE}"

  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_VERIFY_RUNTIME_MODE"
  export ADJUTORIX_UNDER_TEST="true"
  export ADJUTORIX_TEST_MODE="true"
  export CI="${CI:-true}"

  run_phase repo_layout phase_repo_layout
  run_phase toolchain phase_toolchain
  run_phase git_state phase_git_state

  if [[ "$ADJUTORIX_VERIFY_RUN_INSTALL" == "true" ]]; then
    run_phase install phase_install
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_CONSTITUTION_GUARDS" == "true" ]]; then
    run_phase constitution phase_constitution
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_CONTRACT_GUARDS" == "true" ]]; then
    run_phase contracts phase_contracts
    run_phase "ipc_channel_registry" check_ipc_channel_registry
    run_phase "ipc_channel_registry_selftest" check_ipc_channel_registry_selftest

  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_POLICY_GUARDS" == "true" ]]; then
    run_phase policy phase_policy
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_RUNTIME_CONFIG_GUARDS" == "true" ]]; then
    run_phase runtime_config phase_runtime_config
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_OBSERVABILITY_GUARDS" == "true" ]]; then
    run_phase observability phase_observability
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_ROOT_LINT" == "true" ]]; then
    run_phase root_lint phase_root_lint
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_ROOT_TYPECHECK" == "true" ]]; then
    run_phase root_typecheck phase_root_typecheck
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_ROOT_TESTS" == "true" ]]; then
    run_phase root_tests phase_root_tests
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_APP_CHECKS" == "true" ]]; then
    run_phase app_checks phase_app_checks
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_AGENT_CHECKS" == "true" ]]; then
    run_phase agent_checks phase_agent_checks
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_CLI_CHECKS" == "true" ]]; then
    run_phase cli_checks phase_cli_checks
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_INVARIANT_TESTS" == "true" ]]; then
    run_phase invariants phase_invariants
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_SMOKE_TESTS" == "true" ]]; then
    run_phase smoke phase_smoke
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_BUILD_CHECKS" == "true" ]]; then
    run_phase build phase_build
  fi
  if [[ "$ADJUTORIX_VERIFY_RUN_RELEASE_CHECKS" == "true" ]]; then
    run_phase release phase_release
  fi

  section "Verification complete"
  print_summary

  if (( OVERALL_FAILURES > 0 )); then
    die "Verification failed with ${OVERALL_FAILURES} failed phase(s)"
  fi

  log_info "Verification succeeded"
}


check_ipc_channel_registry() {
  bash "$REPO_ROOT/configs/ci/guard_ipc_channel_registry.sh"
}

check_ipc_channel_registry_selftest() {
  bash "$REPO_ROOT/configs/ci/guard_ipc_channel_registry_selftest.sh"
}

main "$@"
