#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
reason="${1:-}"
[[ -n "$reason" ]] || die "usage: scripts/governance/explain.sh <deny-reason>"
case "$reason" in
  governed_target_without_confirmation) echo "Mutation target intersects governed policy and requires explicit operator confirmation." ;;
  workspace_dirty_before_verify) echo "Verification must execute against a clean, explicit repository state." ;;
  snapshot_head_mismatch) echo "Active snapshot head diverges from transaction basis and replay cannot be trusted." ;;
  patch_basis_mismatch) echo "Patch basis does not match repository head or selected transaction anchor." ;;
  destructive_shell_pattern) echo "Shell command matches destructive policy and is refused automatically." ;;
  secret_exposure_risk) echo "Command or artifact risks exposing secrets, tokens, or local credentials." ;;
  unknown_command_surface) echo "Command is outside known allowlist patterns and requires confirmation." ;;
  non_deterministic_replay_output) echo "Replay output diverged across executions and invariants cannot be asserted." ;;
  *) die "unknown deny reason: $reason" ;;
esac
