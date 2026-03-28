#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
require_cmd python3
python3 - <<'PY'
import json
from pathlib import Path

required = [
    Path("configs/contracts/governance_decision.schema.json"),
    Path("configs/contracts/ledger_edges.json"),
    Path("configs/contracts/patch_artifact.schema.json"),
    Path("configs/contracts/protocol_versions.json"),
    Path("configs/contracts/rpc_capabilities.json"),
    Path("configs/contracts/transaction_states.json"),
    Path("configs/contracts/verify_summary.schema.json"),
]
missing = [str(p) for p in required if not p.exists()]
if missing:
    raise SystemExit("missing contract files:\n" + "\n".join(missing))
for path in required:
    json.loads(path.read_text(encoding="utf-8"))
print("contracts=valid")
PY
