#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
left="${1:-HEAD~1}"
right="${2:-HEAD}"
echo "left=$left"
echo "right=$right"
git diff --stat "$left" "$right"
