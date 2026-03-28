#!/usr/bin/env bash
set -euo pipefail

adj_root() {
  if git rev-parse --show-toplevel >/dev/null 2>&1; then
    git rev-parse --show-toplevel
    return
  fi
  local script_dir
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
  printf "%s\n" "$script_dir"
}

ADJ_ROOT="${ADJ_ROOT:-$(adj_root)}"
export ADJ_ROOT

cd_root() {
  cd "$ADJ_ROOT"
}

timestamp_utc() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

die() {
  printf "error: %s\n" "$*" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing required command: $1"
}

maybe_cmd() {
  command -v "$1" >/dev/null 2>&1
}

run_logged() {
  printf "\n[%s] %s\n" "$(timestamp_utc)" "$*"
  "$@"
}

print_kv() {
  local key="$1"
  shift
  printf "%s=%s\n" "$key" "$*"
}

git_branch() {
  git -C "$ADJ_ROOT" rev-parse --abbrev-ref HEAD
}

git_head() {
  git -C "$ADJ_ROOT" rev-parse HEAD
}

workspace_clean() {
  [[ -z "$(git -C "$ADJ_ROOT" status --porcelain)" ]]
}

ensure_workspace_clean() {
  workspace_clean || die "workspace has pending changes"
}

default_python() {
  if [[ -x "$ADJ_ROOT/.venv/bin/python" ]]; then
    printf "%s\n" "$ADJ_ROOT/.venv/bin/python"
    return
  fi
  if maybe_cmd python3; then
    command -v python3
    return
  fi
  require_cmd python
  command -v python
}

node_package_manager() {
  if [[ -f "$ADJ_ROOT/pnpm-lock.yaml" ]] && maybe_cmd pnpm; then
    printf "pnpm\n"
    return
  fi
  if [[ -f "$ADJ_ROOT/package-lock.json" ]] && maybe_cmd npm; then
    printf "npm\n"
    return
  fi
  if maybe_cmd pnpm; then
    printf "pnpm\n"
    return
  fi
  require_cmd npm
  printf "npm\n"
}

run_node_task() {
  local pm
  pm="$(node_package_manager)"
  case "$pm" in
    pnpm) run_logged pnpm "$@" ;;
    npm)
      if [[ "${1:-}" == "run" ]]; then
        shift
        run_logged npm run "$@"
      else
        run_logged npm "$@"
      fi
      ;;
    *) die "unsupported package manager: $pm" ;;
  esac
}

list_repo_files() {
  if git -C "$ADJ_ROOT" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    git -C "$ADJ_ROOT" ls-files
  else
    find "$ADJ_ROOT" -type f | sed "s#^$ADJ_ROOT/##" | sort
  fi
}

find_governed_targets() {
  local policy_file="$ADJ_ROOT/configs/policy/governed_targets.yaml"
  [[ -f "$policy_file" ]] || return 0
  grep -nE "^[[:space:]]*-[[:space:]]|path:|pattern:" "$policy_file" || true
}

find_verify_policy() {
  local policy_file="$ADJ_ROOT/configs/policy/verify_policy.yaml"
  [[ -f "$policy_file" ]] || return 0
  cat "$policy_file"
}

find_mutation_policy() {
  local policy_file="$ADJ_ROOT/configs/policy/mutation_policy.yaml"
  [[ -f "$policy_file" ]] || return 0
  cat "$policy_file"
}

print_repo_identity() {
  print_kv ROOT "$ADJ_ROOT"
  print_kv BRANCH "$(git_branch)"
  print_kv HEAD "$(git_head)"
  if git -C "$ADJ_ROOT" remote get-url origin >/dev/null 2>&1; then
    print_kv ORIGIN "$(git -C "$ADJ_ROOT" remote get-url origin)"
  fi
}

ensure_dir() {
  mkdir -p "$1"
}

safe_rg() {
  if maybe_cmd rg; then
    rg "$@"
  else
    grep -R "$@"
  fi
}
