#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
cat <<'LIST'
deny_reason=governed_target_without_confirmation
deny_reason=workspace_dirty_before_verify
deny_reason=snapshot_head_mismatch
deny_reason=patch_basis_mismatch
deny_reason=destructive_shell_pattern
deny_reason=secret_exposure_risk
deny_reason=unknown_command_surface
deny_reason=non_deterministic_replay_output
LIST
