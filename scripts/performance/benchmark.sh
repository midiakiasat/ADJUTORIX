#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
start="$(python3 - <<'PY'
import time
print(time.time())
PY
)"
if [[ -f package.json ]]; then
  if grep -q "\"build\"" package.json; then
    run_node_task run build >/dev/null 2>&1 || true
  fi
fi
end="$(python3 - <<'PY'
import time
print(time.time())
PY
)"
python3 - <<PY
start = float("$start")
end = float("$end")
print(f"benchmark_seconds={end-start:.3f}")
PY
