#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
git reset
git restore --staged .
echo "patch_review=rejected"
