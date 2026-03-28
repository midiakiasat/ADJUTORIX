#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
source_file="${1:-}"
if [[ -n "$source_file" ]]; then
  [[ -f "$source_file" ]] || die "diagnostic source file not found: $source_file"
  cat "$source_file"
else
  cat
fi | python3 - <<'PY'
import json
import re
import sys

pattern = re.compile(r"^(?P<path>.+?):(?P<line>\d+):(?P<column>\d+):\s*(?P<severity>error|warning|info)?\s*:?\s*(?P<message>.+)$")
items = []
for raw in sys.stdin:
    line = raw.rstrip("\n")
    m = pattern.match(line)
    if not m:
        continue
    items.append({
        "path": m.group("path"),
        "line": int(m.group("line")),
        "column": int(m.group("column")),
        "severity": m.group("severity") or "error",
        "message": m.group("message").strip(),
    })
print(json.dumps(items, indent=2))
PY
