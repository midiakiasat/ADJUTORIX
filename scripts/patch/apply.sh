#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
patch_file="${1:-}"

if [[ "${ADJUTORIX_PATCH_APPLY_CONFIRMED:-}" != "true" ]]; then
  printf '%s\n' "Refusing to apply patch without ADJUTORIX_PATCH_APPLY_CONFIRMED=true" >&2
  printf '%s\n' "Use the governed apply-review-confirm path before invoking this low-level entrypoint." >&2
  exit 64
fi
[[ -n "$patch_file" ]] || die "usage: scripts/patch/apply.sh <patch-file>"
[[ -f "$patch_file" ]] || die "patch file not found: $patch_file"
run_logged git apply --index --whitespace=nowarn "$patch_file"
git diff --cached --stat
