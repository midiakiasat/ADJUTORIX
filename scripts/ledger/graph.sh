#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
count="${1:-20}"
run_logged git log --graph --decorate --oneline -n "$count"
