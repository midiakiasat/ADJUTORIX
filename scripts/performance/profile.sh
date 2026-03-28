#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
python_bin="$(default_python)"
run_logged "$python_bin" -m compileall packages >/dev/null
echo "profile=compileall_complete"
