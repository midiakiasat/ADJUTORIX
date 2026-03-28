#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
find . -type d \( -name ".pytest_cache" -o -name ".mypy_cache" -o -name ".ruff_cache" -o -name "dist" -o -name "build" \) -prune -print -exec rm -rf {} +
