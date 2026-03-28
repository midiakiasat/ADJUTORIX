#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
commitish="${1:-HEAD}"
run_logged git show --name-status "$commitish"
