#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
tmp="$(mktemp)"
trap "rm -f \"$tmp\"" EXIT
if [[ $# -gt 0 ]]; then
  "$ADJ_ROOT/scripts/diagnostics/parse.sh" "$1" > "$tmp"
else
  "$ADJ_ROOT/scripts/diagnostics/parse.sh" > "$tmp"
fi
python3 - "$tmp" <<'PY'
import json
import sys
items = json.load(open(sys.argv[1], encoding="utf-8"))
print(f"problem_count={len(items)}")
for item in items:
    print(f"{item[severity].upper()} {item[path]}:{item[line]}:{item[column]} {item[message]}")
PY
