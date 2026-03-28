#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
from="${1:-HEAD~5}"
to="${2:-HEAD}"
run_logged git log --oneline --decorate "${from}..${to}"
printf "\n=== FILE DELTA ===\n"
git diff --stat "$from" "$to"
