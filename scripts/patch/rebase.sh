#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
base="${1:-origin/main}"
run_logged git fetch origin
run_logged git rebase "$base"
