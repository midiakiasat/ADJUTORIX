#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
out_dir="${1:-configs/contracts}"
ensure_dir "$out_dir"
require_cmd python3
python3 - <<'PY'
import json
from pathlib import Path

root = Path(".")
out = root / "configs" / "contracts"
out.mkdir(parents=True, exist_ok=True)

def write_json(path: Path, payload) -> None:
    path.write_text(json.dumps(payload, indent=2, sort_keys=True) + "\n", encoding="utf-8")

write_json(out / "protocol_versions.json", {
    "rpc": "1.0.0",
    "patch_artifact": "1.0.0",
    "ledger_edges": "1.0.0",
    "transaction_state": "1.0.0",
    "verify_summary": "1.0.0"
})
write_json(out / "transaction_states.json", {
    "states": [
        "planned",
        "queued",
        "running",
        "blocked",
        "failed",
        "rolled_back",
        "verified",
        "completed"
    ]
})
write_json(out / "ledger_edges.json", {
    "edge_types": [
        "depends_on",
        "produces",
        "supersedes",
        "rolled_back_by",
        "verified_by"
    ]
})
write_json(out / "rpc_capabilities.json", {
    "capabilities": [
        "workspace.scan",
        "ledger.replay",
        "patch.preview",
        "patch.apply",
        "verify.run",
        "governance.audit"
    ]
})
write_json(out / "governance_decision.schema.json", {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "GovernanceDecision",
    "type": "object",
    "required": ["ok", "reasons"],
    "properties": {
        "ok": {"type": "boolean"},
        "reasons": {"type": "array", "items": {"type": "string"}},
        "targets": {"type": "array", "items": {"type": "string"}}
    },
    "additionalProperties": False
})
write_json(out / "patch_artifact.schema.json", {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "PatchArtifact",
    "type": "object",
    "required": ["id", "basis", "targets", "summary"],
    "properties": {
        "id": {"type": "string"},
        "basis": {"type": "string"},
        "targets": {"type": "array", "items": {"type": "string"}},
        "summary": {"type": "string"},
        "rollback": {"type": "object"},
        "metadata": {"type": "object", "additionalProperties": {"type": "string"}}
    },
    "additionalProperties": False
})
write_json(out / "verify_summary.schema.json", {
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "title": "VerifySummary",
    "type": "object",
    "required": ["ok", "checks"],
    "properties": {
        "ok": {"type": "boolean"},
        "checks": {
            "type": "array",
            "items": {
                "type": "object",
                "required": ["name", "ok"],
                "properties": {
                    "name": {"type": "string"},
                    "ok": {"type": "boolean"},
                    "detail": {"type": "string"}
                },
                "additionalProperties": False
            }
        }
    },
    "additionalProperties": False
})
PY
printf "contract snapshots refreshed under %s\n" "$out_dir"
