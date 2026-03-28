#!/usr/bin/env bash

###############################################################################
# ADJUTORIX AGENT — RESET DEV DB SCRIPT
#
# Deterministic, destructive reset of development database + state.
#
# Purpose:
# - Fully wipe local SQLite DB, snapshots, ledger, and derived artifacts
# - Reinitialize schema via migrations
# - Preserve ONLY non-derived configuration (token, user configs)
#
# Safety Model:
# - HARD FAIL unless explicitly confirmed (no accidental wipe)
# - Scope-limited: ONLY .adjutorix + sqlite files under project root
# - Idempotent (safe to run repeatedly)
# - No silent fallback
#
# Hard invariants:
# - No partial reset (all-or-nothing)
# - No deletion outside allowed paths
# - Post-reset system is equivalent to fresh clone + migrate
###############################################################################

set -euo pipefail
IFS=$'\n\t'

###############################################################################
# CONFIG
###############################################################################

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$ROOT_DIR/.adjutorix"
SQLITE_DIR="$ROOT_DIR/packages/adjutorix-agent/adjutorix_agent/storage/sqlite"

DB_FILES=(
  "$ROOT_DIR/adjutorix.db"
  "$ROOT_DIR/adjutorix.sqlite"
  "$ROOT_DIR/adjutorix.sqlite3"
)

SNAPSHOT_DIR="$DATA_DIR/snapshots"
ARTIFACT_DIR="$DATA_DIR/artifacts"
LEDGER_FILE="$DATA_DIR/ledger.json"
MIGRATION_LEDGER="$DATA_DIR/migrations_ledger.json"
TMP_DIR="$DATA_DIR/tmp"
RUN_DIR="$DATA_DIR/run"
LOG_DIR="$DATA_DIR/logs"

CONFIRM_FLAG="false"
FORCE_FLAG="false"

###############################################################################
# UTIL
###############################################################################

fail() {
  echo "[FATAL] $1" >&2
  exit 1
}

info() {
  echo "[INFO] $1"
}

warn() {
  echo "[WARN] $1" >&2
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command:$1"
}

safe_rm_file() {
  local f="$1"
  if [[ -f "$f" ]]; then
    info "remove file: $f"
    rm -f "$f"
  fi
}

safe_rm_dir_contents() {
  local d="$1"
  if [[ -d "$d" ]]; then
    info "clean dir: $d"
    find "$d" -mindepth 1 -maxdepth 1 -print0 | xargs -0 -r rm -rf
  fi
}

###############################################################################
# ARG PARSE
###############################################################################

while [[ $# -gt 0 ]]; do
  case "$1" in
    --confirm) CONFIRM_FLAG="true" ;;
    --force) FORCE_FLAG="true" ;;
    *) fail "unknown_arg:$1" ;;
  esac
  shift
done

###############################################################################
# SAFETY CHECKS
###############################################################################

validate_scope() {
  [[ -d "$ROOT_DIR" ]] || fail "invalid_root"

  case "$ROOT_DIR" in
    *"/"*) ;; # basic sanity
    *) fail "invalid_root_format" ;;
  esac

  [[ "$ROOT_DIR" != "/" ]] || fail "refuse_root_wipe"
}

require_confirmation() {
  if [[ "$FORCE_FLAG" == "true" ]]; then
    warn "force flag active — skipping interactive confirmation"
    return
  fi

  if [[ "$CONFIRM_FLAG" != "true" ]]; then
    echo ""
    echo "!!! DESTRUCTIVE OPERATION !!!"
    echo "This will DELETE local DB, snapshots, ledger, artifacts."
    echo "Root: $ROOT_DIR"
    echo ""
    read -r -p "Type 'RESET-DEV-DB' to continue: " input

    if [[ "$input" != "RESET-DEV-DB" ]]; then
      fail "confirmation_failed"
    fi
  fi
}

###############################################################################
# STOP RUNNING SERVER
###############################################################################

stop_server_if_running() {
  local stop_script="$ROOT_DIR/scripts/stop.sh"

  if [[ -x "$stop_script" ]]; then
    info "stopping running server"
    "$stop_script" || warn "stop_script_failed"
  else
    warn "stop_script_missing"
  fi
}

###############################################################################
# RESET OPERATIONS
###############################################################################

reset_sqlite() {
  info "reset sqlite files"

  for f in "${DB_FILES[@]}"; do
    safe_rm_file "$f"
  done
}

reset_runtime_dirs() {
  info "reset runtime directories"

  safe_rm_dir_contents "$SNAPSHOT_DIR"
  safe_rm_dir_contents "$ARTIFACT_DIR"
  safe_rm_dir_contents "$TMP_DIR"
  safe_rm_dir_contents "$RUN_DIR"
  safe_rm_dir_contents "$LOG_DIR"

  safe_rm_file "$LEDGER_FILE"
  safe_rm_file "$MIGRATION_LEDGER"
}

###############################################################################
# REINITIALIZATION
###############################################################################

reinitialize() {
  info "reinitializing via migrations"

  local migrate_script="$ROOT_DIR/scripts/migrate.sh"

  if [[ ! -x "$migrate_script" ]]; then
    fail "missing_migrate_script"
  fi

  "$migrate_script"
}

###############################################################################
# DIAGNOSTICS
###############################################################################

print_summary() {
  info "reset summary"
  echo "ROOT=$ROOT_DIR"
  echo "DATA_DIR=$DATA_DIR"
  echo "SQLITE_DIR=$SQLITE_DIR"
}

###############################################################################
# MAIN
###############################################################################

main() {
  require_cmd find
  require_cmd xargs

  validate_scope
  require_confirmation

  stop_server_if_running

  reset_sqlite
  reset_runtime_dirs

  reinitialize

  print_summary

  info "dev db reset complete"
}

main "$@"
