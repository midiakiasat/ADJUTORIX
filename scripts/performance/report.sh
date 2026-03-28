#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
echo "tracked_files=$(list_repo_files | wc -l | tr -d " ")"
echo "typescript_files=$(find packages tests -type f \( -name "*.ts" -o -name "*.tsx" \) | wc -l | tr -d " ")"
echo "python_files=$(find packages -type f -name "*.py" | wc -l | tr -d " ")"
echo "shell_files=$(find scripts packages -type f -name "*.sh" | wc -l | tr -d " ")"
