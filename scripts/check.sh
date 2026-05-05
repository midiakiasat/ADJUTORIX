#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# ADJUTORIX FAST CHECK ENTRYPOINT
#
# Purpose
# - provide a deterministic, low-latency repository integrity gate for local use
#   and CI preflight
# - catch the highest-value failures before full verify: repo shape, contracts,
#   policy/runtime/observability config parseability, core lint/typecheck, and
#   targeted package sanity
# - fail loudly on ambiguity, drift, or missing expected structure
#
# Design constraints
# - faster and narrower than scripts/verify.sh, but still authoritative within
#   its declared scope
# - no hidden mutation beyond deterministic temp/log/report files under .tmp
# - no placeholder phases; every phase either runs explicitly or is skipped by
#   explicit policy/flag
###############################################################################

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "${SCRIPT_DIR}/.." && pwd)"
PROGRAM_NAME="$(basename -- "$0")"
START_TS="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

readonly SCRIPT_DIR
readonly REPO_ROOT
readonly PROGRAM_NAME
readonly START_TS
export REPO_ROOT

###############################################################################
# DEFAULTS
###############################################################################

: "${ADJUTORIX_CHECK_STACK_NAME:=adjutorix-check}"
: "${ADJUTORIX_CHECK_RUNTIME_MODE:=test}"
: "${ADJUTORIX_CHECK_USE_COLOR:=true}"
: "${ADJUTORIX_CHECK_FAIL_FAST:=true}"
: "${ADJUTORIX_CHECK_REQUIRE_CLEAN_WORKTREE:=false}"
: "${ADJUTORIX_CHECK_RUN_INSTALL:=false}"
: "${ADJUTORIX_CHECK_RUN_ROOT_LINT:=true}"
: "${ADJUTORIX_CHECK_RUN_ROOT_TYPECHECK:=true}"
: "${ADJUTORIX_CHECK_RUN_ROOT_TESTS:=false}"
: "${ADJUTORIX_CHECK_RUN_APP_LINT:=true}"
: "${ADJUTORIX_CHECK_RUN_APP_TYPECHECK:=true}"
: "${ADJUTORIX_CHECK_RUN_AGENT_IMPORT_CHECK:=true}"
: "${ADJUTORIX_CHECK_RUN_CLI_IMPORT_CHECK:=true}"
: "${ADJUTORIX_CHECK_RUN_CONSTITUTION_GUARDS:=true}"
: "${ADJUTORIX_CHECK_RUN_CONTRACT_GUARDS:=true}"
: "${ADJUTORIX_CHECK_RUN_POLICY_GUARDS:=true}"
: "${ADJUTORIX_CHECK_RUN_RUNTIME_CONFIG_GUARDS:=true}"
: "${ADJUTORIX_CHECK_RUN_OBSERVABILITY_GUARDS:=true}"
: "${ADJUTORIX_CHECK_RUN_PACKAGE_MANIFEST_GUARDS:=true}"
: "${ADJUTORIX_CHECK_ROOT_TMP:=${REPO_ROOT}/.tmp/check}"
: "${ADJUTORIX_CHECK_LOG_DIR:=${ADJUTORIX_CHECK_ROOT_TMP}/logs}"
: "${ADJUTORIX_CHECK_REPORT_DIR:=${ADJUTORIX_CHECK_ROOT_TMP}/reports}"
: "${ADJUTORIX_CHECK_BOOT_LOG:=${ADJUTORIX_CHECK_LOG_DIR}/check.log}"
: "${ADJUTORIX_CHECK_SUMMARY_FILE:=${ADJUTORIX_CHECK_REPORT_DIR}/summary.txt}"
: "${ADJUTORIX_CHECK_PHASE_FILE:=${ADJUTORIX_CHECK_REPORT_DIR}/phases.tsv}"
: "${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER:=npm}"
: "${ADJUTORIX_CHECK_PYTHON_BIN:=$(command -v python3.13 || command -v python3.12 || command -v python3.11 || command -v python3 || command -v python)}"
export ADJUTORIX_CHECK_PYTHON_BIN
: "${ADJUTORIX_CHECK_CONSTITUTION_PATH:=${REPO_ROOT}/configs/adjutorix/constitution.json}"
: "${ADJUTORIX_CHECK_CONSTITUTION_CHECKER:=${REPO_ROOT}/scripts/adjutorix-constitution-check.mjs}"
: "${ADJUTORIX_CHECK_CONSTITUTION_REPORT:=${ADJUTORIX_CHECK_REPORT_DIR}/constitution-report.json}"
export ADJUTORIX_CHECK_CONSTITUTION_PATH
export ADJUTORIX_CHECK_CONSTITUTION_CHECKER
export ADJUTORIX_CHECK_CONSTITUTION_REPORT
: "${ADJUTORIX_CHECK_APP_DIR:=${REPO_ROOT}/packages/adjutorix-app}"
: "${ADJUTORIX_CHECK_AGENT_DIR:=${REPO_ROOT}/packages/adjutorix-agent}"
: "${ADJUTORIX_CHECK_CLI_DIR:=${REPO_ROOT}/packages/adjutorix-cli}"
: "${ADJUTORIX_CHECK_CONTRACTS_DIR:=${REPO_ROOT}/configs/contracts}"
: "${ADJUTORIX_CHECK_POLICY_DIR:=${REPO_ROOT}/configs/policy}"
: "${ADJUTORIX_CHECK_RUNTIME_DIR:=${REPO_ROOT}/configs/runtime}"
: "${ADJUTORIX_CHECK_OBSERVABILITY_DIR:=${REPO_ROOT}/configs/observability}"
export ADJUTORIX_CHECK_APP_DIR
export ADJUTORIX_CHECK_AGENT_DIR
export ADJUTORIX_CHECK_CLI_DIR
export ADJUTORIX_CHECK_CONTRACTS_DIR
export ADJUTORIX_CHECK_POLICY_DIR
export ADJUTORIX_CHECK_RUNTIME_DIR
export ADJUTORIX_CHECK_OBSERVABILITY_DIR

INSTALL_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" install)
ROOT_LINT_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" run lint)
ROOT_TYPECHECK_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" run typecheck)
ROOT_TEST_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" test)
APP_LINT_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" --prefix "$ADJUTORIX_CHECK_APP_DIR" run lint)
APP_TYPECHECK_CMD=("${ADJUTORIX_CHECK_NODE_PACKAGE_MANAGER}" --prefix "$ADJUTORIX_CHECK_APP_DIR" run typecheck)

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

if [[ "$NO_COLOR" == "true" || "${ADJUTORIX_CHECK_USE_COLOR}" != "true" || ! -t 1 ]]; then
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
  printf '[%s] [%s] %s\n' "$ts" "$level" "$msg" | tee -a "$ADJUTORIX_CHECK_BOOT_LOG" >&2
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
  printf '%s==> %s%s\n' "$C_BOLD$C_CYAN" "$title" "$C_RESET" | tee -a "$ADJUTORIX_CHECK_BOOT_LOG" >&2
}

###############################################################################
# ARGUMENTS
###############################################################################

usage() {
  cat <<'EOF'
Usage: scripts/check.sh [options]

Options:
  --install                     Run dependency installation before checks
  --require-clean-worktree      Fail if git worktree is dirty
  --fail-fast                   Stop at first failed phase
  --no-fail-fast                Continue after failed phases
  --with-tests                  Include root test command in fast check
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
  manifests
  contracts
  policy
  runtime_config
  observability
  root_lint
  root_typecheck
  root_tests
  app_lint
  app_typecheck
  agent_import
  cli_import
EOF
}

parse_args() {
  while (($# > 0)); do
    case "$1" in
      --install)
        ADJUTORIX_CHECK_RUN_INSTALL=true
        ;;
      --require-clean-worktree)
        ADJUTORIX_CHECK_REQUIRE_CLEAN_WORKTREE=true
        ;;
      --fail-fast)
        ADJUTORIX_CHECK_FAIL_FAST=true
        ;;
      --no-fail-fast)
        ADJUTORIX_CHECK_FAIL_FAST=false
        ;;
      --with-tests)
        ADJUTORIX_CHECK_RUN_ROOT_TESTS=true
        ;;
      --no-color)
        NO_COLOR=true
        ADJUTORIX_CHECK_USE_COLOR=false
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
  "$@" >>"$ADJUTORIX_CHECK_BOOT_LOG" 2>&1
}

record_phase() {
  local phase="$1"
  local status="$2"
  local started="$3"
  local finished="$4"
  local duration_ms="$5"
  printf '%s\t%s\t%s\t%s\t%s\n' "$phase" "$status" "$started" "$finished" "$duration_ms" >>"$ADJUTORIX_CHECK_PHASE_FILE"
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
  local started finished duration_ms started_epoch_ms
  started="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
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
    if [[ "$ADJUTORIX_CHECK_FAIL_FAST" == "true" ]]; then
      exit 1
    fi
  fi
}

###############################################################################
# PHASE IMPLEMENTATIONS
###############################################################################

phase_repo_layout() {
  require_dir "$REPO_ROOT"
  require_dir "$ADJUTORIX_CHECK_APP_DIR"
  require_dir "$ADJUTORIX_CHECK_AGENT_DIR"
  require_dir "$ADJUTORIX_CHECK_CLI_DIR"
  require_dir "$ADJUTORIX_CHECK_CONTRACTS_DIR"
  require_dir "$ADJUTORIX_CHECK_POLICY_DIR"
  require_dir "$ADJUTORIX_CHECK_RUNTIME_DIR"
  require_dir "$ADJUTORIX_CHECK_OBSERVABILITY_DIR"
  require_file "$REPO_ROOT/package.json"
  require_file "$ADJUTORIX_CHECK_CONSTITUTION_PATH"
  require_file "$ADJUTORIX_CHECK_CONSTITUTION_CHECKER"
  require_file "$ADJUTORIX_CHECK_APP_DIR/package.json"
  require_file "$ADJUTORIX_CHECK_AGENT_DIR/pyproject.toml"
  require_file "$ADJUTORIX_CHECK_CLI_DIR/pyproject.toml"
}

phase_toolchain() {
  require_command git
  require_command "$ADJUTORIX_CHECK_PYTHON_BIN"
  require_command node
  require_command npm
  require_command bash
}

phase_git_state() {
  git -C "$REPO_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1
  if [[ "$ADJUTORIX_CHECK_REQUIRE_CLEAN_WORKTREE" == "true" ]]; then
    local status
    status="$(git -C "$REPO_ROOT" status --porcelain)"
    [[ -z "$status" ]]
  fi
}

phase_install() {
  run_cmd_logged install bash -lc "cd '$REPO_ROOT' && ${INSTALL_CMD[*]}"
}

phase_constitution() {
  run_cmd_logged constitution node "$ADJUTORIX_CHECK_CONSTITUTION_CHECKER" --report "$ADJUTORIX_CHECK_CONSTITUTION_REPORT"
}

phase_manifests() {
  python3 - <<'PY'
import json
from pathlib import Path
import os
root = Path(os.environ["REPO_ROOT"])
package_files = [
    root / "package.json",
    root / "packages/adjutorix-app/package.json",
]
for path in package_files:
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if "name" not in data or not data["name"]:
        raise SystemExit(f"missing package name in {path}")
    if "scripts" not in data or not isinstance(data["scripts"], dict):
        raise SystemExit(f"missing scripts block in {path}")
for path in [root / "packages/adjutorix-agent/pyproject.toml", root / "packages/adjutorix-cli/pyproject.toml"]:
    text = path.read_text(encoding="utf-8")
    if "[project]" not in text:
        raise SystemExit(f"missing [project] table in {path}")
print("manifest-check-ok")
PY
}

phase_contracts() {
  python3 - <<'PY'
import json
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_CHECK_CONTRACTS_DIR"])
required = [
    "rpc_capabilities.json",
    "protocol_versions.json",
    "patch_artifact.schema.json",
    "transaction_states.json",
    "ledger_edges.json",
    "verify_summary.schema.json",
    "governance_decision.schema.json",
]
for name in required:
    path = root / name
    with path.open("r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict):
        raise SystemExit(f"contract root must be an object: {name}")
print("contracts-ok")
PY
}

phase_policy() {
  python3 - <<'PY'
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_CHECK_POLICY_DIR"])
required = [
    "mutation_policy.yaml",
    "governed_targets.yaml",
    "command_policy.yaml",
    "secrets_policy.yaml",
    "workspace_policy.yaml",
    "release_policy.yaml",
    "verify_policy.yaml",
    "trust_policy.yaml",
]
for name in required:
    path = root / name
    text = path.read_text(encoding="utf-8")
    if "policy" not in text and "policy_id:" not in text:
        raise SystemExit(f"policy marker missing in {name}")
print("policy-ok")
PY
}

phase_runtime_config() {
  python3 - <<'PY'
import json
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_CHECK_RUNTIME_DIR"])
json_files = ["feature_flags.json", "logging.json", "limits.json", "timeouts.json", "scheduling.json"]
for name in json_files:
    with (root / name).open("r", encoding="utf-8") as fh:
        json.load(fh)
for name in ["app.env.example", "agent.env.example"]:
    text = (root / name).read_text(encoding="utf-8")
    if "ADJUTORIX_" not in text and "VITE_" not in text:
        raise SystemExit(f"expected env variable prefixes not found in {name}")
print("runtime-config-ok")
PY
}

phase_observability() {
  python3 - <<'PY'
from pathlib import Path
import os
root = Path(os.environ["ADJUTORIX_CHECK_OBSERVABILITY_DIR"])
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
    if "title:" not in text:
        raise SystemExit(f"missing title in {name}")
print("observability-ok")
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

phase_app_lint() {
  run_cmd_logged app_lint bash -lc "cd '$REPO_ROOT' && ${APP_LINT_CMD[*]}"
}

phase_app_typecheck() {
  run_cmd_logged app_typecheck bash -lc "cd '$REPO_ROOT' && ${APP_TYPECHECK_CMD[*]}"
}

phase_agent_import() {
  run_cmd_logged agent_import env \
    PYTHONPATH="${ADJUTORIX_CHECK_AGENT_DIR}${PYTHONPATH:+:${PYTHONPATH}}" \
    "$ADJUTORIX_CHECK_PYTHON_BIN" - <<'PY'
import importlib
import sys
if sys.version_info < (3, 11):
    raise SystemExit(f"python>=3.11 required for adjutorix_agent import, got {sys.version.split()[0]}")
importlib.import_module("adjutorix_agent")
print("agent-import-ok")
PY
}


phase_cli_import() {
  run_cmd_logged cli_import env \
    PYTHONPATH="${ADJUTORIX_CHECK_CLI_DIR}${PYTHONPATH:+:${PYTHONPATH}}" \
    "$ADJUTORIX_CHECK_PYTHON_BIN" - <<'PY'
import importlib
import sys
if sys.version_info < (3, 11):
    raise SystemExit(f"python>=3.11 required for adjutorix_cli import, got {sys.version.split()[0]}")
importlib.import_module("adjutorix_cli")
print("cli-import-ok")
PY
}



###############################################################################
# SUMMARY
###############################################################################

prepare_runtime_dirs() {
  ensure_dir "$ADJUTORIX_CHECK_ROOT_TMP"
  ensure_dir "$ADJUTORIX_CHECK_LOG_DIR"
  ensure_dir "$ADJUTORIX_CHECK_REPORT_DIR"
  : >"$ADJUTORIX_CHECK_BOOT_LOG"
  : >"$ADJUTORIX_CHECK_SUMMARY_FILE"
  : >"$ADJUTORIX_CHECK_PHASE_FILE"
  printf 'phase\tstatus\tstarted\tfinished\tduration_ms\n' >"$ADJUTORIX_CHECK_PHASE_FILE"
}

print_summary() {
  {
    echo "ADJUTORIX fast check summary"
    echo "program: ${PROGRAM_NAME}"
    echo "started_at: ${START_TS}"
    echo "repo_root: ${REPO_ROOT}"
    echo "stack_name: ${ADJUTORIX_CHECK_STACK_NAME}"
    echo "runtime_mode: ${ADJUTORIX_CHECK_RUNTIME_MODE}"
    echo "fail_fast: ${ADJUTORIX_CHECK_FAIL_FAST}"
    echo "overall_failures: ${OVERALL_FAILURES}"
    echo ""
    echo "phase results:"
    local row
    for row in "${PHASE_RESULTS[@]}"; do
      echo "  - ${row}"
    done
  } | tee "$ADJUTORIX_CHECK_SUMMARY_FILE" >&2
}

###############################################################################
# MAIN
###############################################################################

main() {
  parse_args "$@"
  prepare_runtime_dirs

  section "ADJUTORIX fast check"
  log_info "program=${PROGRAM_NAME} started_at=${START_TS} repo_root=${REPO_ROOT}"
  log_info "boot_log=${ADJUTORIX_CHECK_BOOT_LOG} summary_file=${ADJUTORIX_CHECK_SUMMARY_FILE}"

  export ADJUTORIX_RUNTIME_MODE="$ADJUTORIX_CHECK_RUNTIME_MODE"
  export ADJUTORIX_UNDER_TEST="true"
  export ADJUTORIX_TEST_MODE="true"
  export CI="${CI:-true}"

  run_phase repo_layout phase_repo_layout
  run_phase toolchain phase_toolchain
  run_phase git_state phase_git_state

  if [[ "$ADJUTORIX_CHECK_RUN_INSTALL" == "true" ]]; then
    run_phase install phase_install
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_CONSTITUTION_GUARDS" == "true" ]]; then
    run_phase constitution phase_constitution
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_PACKAGE_MANIFEST_GUARDS" == "true" ]]; then
    run_phase manifests phase_manifests
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_CONTRACT_GUARDS" == "true" ]]; then
    run_phase contracts phase_contracts
    run_phase "ipc_channel_registry" check_ipc_channel_registry
    run_phase "ipc_channel_registry_selftest" check_ipc_channel_registry_selftest

  fi
  if [[ "$ADJUTORIX_CHECK_RUN_POLICY_GUARDS" == "true" ]]; then
    run_phase policy phase_policy
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_RUNTIME_CONFIG_GUARDS" == "true" ]]; then
    run_phase runtime_config phase_runtime_config
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_OBSERVABILITY_GUARDS" == "true" ]]; then
    run_phase observability phase_observability
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_ROOT_LINT" == "true" ]]; then
    run_phase root_lint phase_root_lint
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_ROOT_TYPECHECK" == "true" ]]; then
    run_phase root_typecheck phase_root_typecheck
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_ROOT_TESTS" == "true" ]]; then
    run_phase root_tests phase_root_tests
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_APP_LINT" == "true" ]]; then
    run_phase app_lint phase_app_lint
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_APP_TYPECHECK" == "true" ]]; then
    run_phase app_typecheck phase_app_typecheck
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_AGENT_IMPORT_CHECK" == "true" ]]; then
    run_phase agent_import phase_agent_import
  fi
  if [[ "$ADJUTORIX_CHECK_RUN_CLI_IMPORT_CHECK" == "true" ]]; then
    run_phase cli_import phase_cli_import
  fi

  section "Fast check complete"
  print_summary

  if (( OVERALL_FAILURES > 0 )); then
    die "Fast check failed with ${OVERALL_FAILURES} failed phase(s)"
  fi

  log_info "Fast check succeeded"
}


check_ipc_channel_registry() {
  bash "$REPO_ROOT/configs/ci/guard_ipc_channel_registry.sh"
}

check_ipc_channel_registry_selftest() {
  bash "$REPO_ROOT/configs/ci/guard_ipc_channel_registry_selftest.sh"
}

main "$@"
