#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
patch_file="${1:-}"
[[ -n "$patch_file" ]] || die "usage: scripts/patch/apply.sh <patch-file>"
[[ -f "$patch_file" ]] || die "patch file not found: $patch_file"
run_logged git apply --index --whitespace=nowarn "$patch_file"
git diff --cached --stat
