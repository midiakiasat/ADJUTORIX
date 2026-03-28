#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
git status --short --branch
echo "resume_hint=review staged state, rerun verify, then continue mutation flow"
