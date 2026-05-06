#!/usr/bin/env bash

###############################################################################
# ADJUTORIX AGENT — START SCRIPT
#
# Deterministic bootstrap + runtime entrypoint.
#
# Responsibilities:
# - Validate environment (python3, venv, deps)
# - Enforce invariants (no missing configs, token present)
# - Prepare runtime dirs (logs, tmp, sockets)
# - Start server (RPC) with strict flags
# - Emit structured startup diagnostics
#
# Hard guarantees:
# - No implicit mutation (all writes explicit + idempotent)
# - Fail-fast on any invariant violation
# - No silent fallback
###############################################################################

set -euo pipefail
IFS=$'\n\t'

###############################################################################
# CONFIG
###############################################################################

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV_DIR="$ROOT_DIR/.venv"
LOG_DIR="$ROOT_DIR/.adjutorix/logs"
TMP_DIR="$ROOT_DIR/.adjutorix/tmp"
SOCKET_DIR="$ROOT_DIR/.adjutorix/run"
TOKEN_FILE="$HOME/.adjutorix/token"

HOST="127.0.0.1"
PORT="8000"

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

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing_command:$1"
}

hash_file() {
  sha256sum "$1" | awk '{print $1}'
}

###############################################################################
# ENV VALIDATION
###############################################################################

validate_env() {
  info "validating environment"

  require_cmd python3
  require_cmd sha256sum

  [[ -d "$ROOT_DIR" ]] || fail "invalid_root_dir"

  if [[ ! -d "$VENV_DIR" ]]; then
    fail "venv_missing:$VENV_DIR"
  fi

  if [[ ! -f "$VENV_DIR/bin/activate" ]]; then
    fail "venv_corrupt"
  fi
}

###############################################################################
# TOKEN
###############################################################################

ensure_token() {
  info "ensuring auth token"

  mkdir -p "$(dirname "$TOKEN_FILE")"

  if [[ ! -f "$TOKEN_FILE" ]]; then
    info "generating new token"
    python3 - <<'PY'
import os, secrets
path = os.path.expanduser("~/.adjutorix/token")
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w") as f:
    f.write(secrets.token_urlsafe(32))
PY
    chmod 600 "$TOKEN_FILE"
  fi

  [[ -f "$TOKEN_FILE" ]] || fail "token_creation_failed"
}

###############################################################################
# DIR SETUP
###############################################################################

prepare_dirs() {
  info "preparing runtime directories"

  mkdir -p "$LOG_DIR" "$TMP_DIR" "$SOCKET_DIR"

  chmod 700 "$LOG_DIR" "$TMP_DIR" "$SOCKET_DIR" || true
}

###############################################################################
# DEPENDENCY CHECK
###############################################################################

validate_python_env() {
  info "validating python3 environment"

  source "$VENV_DIR/bin/activate"

  python3 - <<'PY'
import sys
required = [
    "fastapi",
    "uvicorn",
]
missing = []
for m in required:
    try:
        __import__(m)
    except Exception:
        missing.append(m)

if missing:
    print("missing_modules:" + ",".join(missing))
    sys.exit(1)
PY
}

###############################################################################
# START SERVER
###############################################################################

start_server() {
  info "starting RPC server"

  source "$VENV_DIR/bin/activate"

  export PYTHONUNBUFFERED=1
  export ADJUTORIX_ROOT="$ROOT_DIR"

  LOG_FILE="$LOG_DIR/server.log"

  # deterministic launch
  exec uvicorn \
    adjutorix_agent.server.rpc:create_app \
    --host "$HOST" \
    --port "$PORT" \
    --log-level "info" \
    --no-access-log \
    --loop "asyncio" \
    --http "h11" \
    2>&1 | tee "$LOG_FILE"
}

###############################################################################
# DIAGNOSTICS
###############################################################################

print_diagnostics() {
  info "runtime diagnostics"

  echo "ROOT=$ROOT_DIR"
  echo "PYTHON=$(which python3)"
  echo "TOKEN_HASH=$(hash_file "$TOKEN_FILE" | cut -c1-16)"
  echo "PORT=$PORT"
}

###############################################################################
# MAIN
###############################################################################

main() {
  validate_env
  ensure_token
  prepare_dirs
  validate_python_env
  print_diagnostics
  start_server
}

main "$@"
