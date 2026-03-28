#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
patch_file="${1:-}"
[[ -n "$patch_file" ]] || die "usage: scripts/patch/validate.sh <patch-file>"
[[ -f "$patch_file" ]] || die "patch file not found: $patch_file"
run_logged git apply --check "$patch_file"
echo "patch=valid"
