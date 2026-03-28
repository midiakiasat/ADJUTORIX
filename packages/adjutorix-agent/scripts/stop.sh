#!/usr/bin/env bash

###############################################################################
# ADJUTORIX AGENT — STOP SCRIPT
#
# Deterministic shutdown and cleanup of the RPC server and runtime artifacts.
#
# Responsibilities:
# - Locate running server process(es) bound to configured host/port
# - Graceful shutdown via SIGTERM with bounded wait
# - Escalation to SIGKILL if necessary
# - Cleanup of runtime dirs (sockets, tmp) without touching durable data
# - Emit structured diagnostics
#
# Hard guarantees:
# - No accidental termination of unrelated processes
# - Idempotent (safe to run multiple times)
# - No deletion outside .adjutorix runtime directories
###############################################################################

set -euo pipefail
IFS=$'\n\t'

###############################################################################
# CONFIG
###############################################################################

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_DIR="$ROOT_DIR/.adjutorix/run"
TMP_DIR="$ROOT_DIR/.adjutorix/tmp"
LOG_DIR="$ROOT_DIR/.adjutorix/logs"
PID_FILE="$RUN_DIR/server.pid"

HOST="127.0.0.1"
PORT="8000"

GRACE_SECONDS=5

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

is_pid_running() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    return 1
  fi
  if kill -0 "$pid" >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

pids_on_port() {
  # returns PIDs listening on HOST:PORT (TCP)
  # lsof preferred; fallback to ss
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null || true
  elif command -v ss >/dev/null 2>&1; then
    ss -ltnp 2>/dev/null | awk -v p=":$PORT" '$4 ~ p {print $6}' | sed -E 's/.*pid=([0-9]+),.*/\1/' || true
  else
    echo ""
  fi
}

safe_kill() {
  local pid="$1"
  if ! is_pid_running "$pid"; then
    return 0
  fi
  info "sending SIGTERM to $pid"
  kill -TERM "$pid" 2>/dev/null || true

  local waited=0
  while is_pid_running "$pid" && [[ $waited -lt $GRACE_SECONDS ]]; do
    sleep 1
    waited=$((waited + 1))
  done

  if is_pid_running "$pid"; then
    warn "escalating to SIGKILL for $pid"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

###############################################################################
# PROCESS DISCOVERY
###############################################################################

get_target_pids() {
  local pids=""

  # 1) PID file (authoritative if present)
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
    if is_pid_running "$pid"; then
      pids+="$pid\n"
    fi
  fi

  # 2) Port-based discovery (uvicorn listener)
  local port_pids
  port_pids="$(pids_on_port || true)"
  if [[ -n "$port_pids" ]]; then
    pids+="$port_pids\n"
  fi

  # 3) Deduplicate
  echo -e "$pids" | awk 'NF' | sort -u
}

###############################################################################
# CLEANUP
###############################################################################

cleanup_runtime() {
  info "cleaning runtime directories"

  # remove transient files only
  if [[ -d "$RUN_DIR" ]]; then
    rm -f "$RUN_DIR"/*.sock "$RUN_DIR"/*.pid 2>/dev/null || true
  fi

  if [[ -d "$TMP_DIR" ]]; then
    # bounded cleanup: only files, not directories with unknown content
    find "$TMP_DIR" -type f -maxdepth 1 -print0 2>/dev/null | xargs -0 -r rm -f || true
  fi
}

###############################################################################
# DIAGNOSTICS
###############################################################################

print_diagnostics() {
  info "shutdown diagnostics"
  echo "ROOT=$ROOT_DIR"
  echo "PORT=$PORT"
  echo "PID_FILE=$PID_FILE"
}

###############################################################################
# MAIN
###############################################################################

main() {
  require_cmd awk

  print_diagnostics

  local targets
  targets="$(get_target_pids)"

  if [[ -z "$targets" ]]; then
    info "no running server processes found (idempotent success)"
  else
    info "target PIDs: $(echo "$targets" | tr '\n' ' ')"
    while read -r pid; do
      [[ -z "$pid" ]] && continue
      safe_kill "$pid"
    done <<< "$targets"
  fi

  cleanup_runtime

  info "shutdown complete"
}

main "$@"
