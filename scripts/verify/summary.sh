#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
echo "summary_head=$(git_head)"
echo "summary_branch=$(git_branch)"
echo "summary_workspace_clean=$(workspace_clean && echo yes || echo no)"
echo "summary_golden_files=$(find tests/golden -type f | wc -l | tr -d " ")"
echo "summary_fixture_files=$(find tests/fixtures -type f | wc -l | tr -d " ")"
