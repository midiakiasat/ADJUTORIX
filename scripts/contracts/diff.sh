#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
left="${1:-HEAD~1}"
right="${2:-HEAD}"
run_logged git diff --stat "$left" "$right" -- configs/contracts packages/shared/src/rpc packages/shared/src/patch packages/shared/src/ledger
printf "\n=== CONTRACT FILE DIFF ===\n"
git diff "$left" "$right" -- configs/contracts packages/shared/src/rpc packages/shared/src/patch packages/shared/src/ledger
