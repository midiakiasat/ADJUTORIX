#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
input="${1:-}"
[[ -n "$input" ]] || die "usage: scripts/diagnostics/link.sh <path:line:col:message>"
python3 - "$input" <<'PY'
import re
import sys
value = sys.argv[1]
m = re.match(r"^(?P<path>.+?):(?P<line>\d+):(?P<col>\d+):(?P<message>.+)$", value)
if not m:
    raise SystemExit("invalid diagnostic format")
print(f"path={m.group(path)}")
print(f"line={m.group(line)}")
print(f"column={m.group(col)}")
print(f"message={m.group(message).strip()}")
PY
