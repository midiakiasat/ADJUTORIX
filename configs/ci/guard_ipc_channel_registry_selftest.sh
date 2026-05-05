#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(git rev-parse --show-toplevel)}"
SELFTEST_ROOT="${SELFTEST_ROOT:-$ROOT_DIR/.tmp/ci/guard_ipc_channel_registry_selftest}"
if [[ "$SELFTEST_ROOT" != /* ]]; then
  SELFTEST_ROOT="$ROOT_DIR/$SELFTEST_ROOT"
fi
LOG_DIR="$SELFTEST_ROOT/logs"
SUMMARY="$SELFTEST_ROOT/summary.json"
TMP_PARENT=""

mkdir -p "$LOG_DIR"

die() {
  printf '[guard:ipc_channel_registry_selftest] %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "${TMP_PARENT:-}" && -d "$TMP_PARENT" ]]; then
    if [[ -d "$TMP_PARENT/worktree" ]]; then
      git -C "$ROOT_DIR" worktree remove --force "$TMP_PARENT/worktree" >/dev/null 2>&1 || true
    fi
    rm -rf "$TMP_PARENT"
  fi
}

trap cleanup EXIT

TMP_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/adjutorix-ipc-guard-selftest.XXXXXX")"
WT="$TMP_PARENT/worktree"

git -C "$ROOT_DIR" worktree add --detach "$WT" HEAD >/dev/null

GUARD="./configs/ci/guard_ipc_channel_registry.sh"
case_count=0
refresh_case_count=0
report_artifact_case_count=0

reset_wt() {
  git -C "$WT" reset --hard HEAD >/dev/null
  git -C "$WT" clean -fdx >/dev/null
}

run_baseline() {
  reset_wt
  (cd "$WT" && bash "$GUARD") >"$LOG_DIR/baseline.log" 2>&1 || {
    cat "$LOG_DIR/baseline.log" >&2
    die "baseline IPC guard failed in isolated worktree"
  }
  printf '[guard:ipc_channel_registry_selftest] baseline pass\n'
}

expect_fail() {
  local name="$1"
  local needle="$2"
  local mutator="$3"
  local log="$LOG_DIR/$name.log"

  case_count=$((case_count + 1))
  reset_wt
  "$mutator"

  set +e
  (cd "$WT" && bash "$GUARD") >"$log" 2>&1
  local status=$?
  set -e

  if [[ "$status" -eq 0 ]]; then
    cat "$log" >&2
    die "negative case unexpectedly passed: $name"
  fi

  if ! grep -F "$needle" "$log" >/dev/null; then
    cat "$log" >&2
    die "negative case failed without expected diagnostic: $name :: $needle"
  fi

  printf '[guard:ipc_channel_registry_selftest] negative pass: %s\n' "$name"
}

expect_refresh() {
  local name="$1"
  local mutator="$2"
  local log="$LOG_DIR/${name}.log"

  refresh_case_count=$((refresh_case_count + 1))

  reset_wt
  "$mutator"

  (
    export ADJUTORIX_IPC_CONTRACT_HASH_UPDATE=true
    cd "$WT"
    bash configs/ci/guard_ipc_channel_registry.sh >"$log" 2>&1
  )

  python3 - "$WT/configs/ci/ipc_channel_contract_hash.json" <<'PY_REFRESH_ASSERT'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
hash_value = data.get("hash")
if hash_value == "0" * 64:
    raise SystemExit("refreshed hash still contains stale sentinel")
if not isinstance(hash_value, str) or len(hash_value) != 64:
    raise SystemExit("refreshed hash is not a 64-character digest")
PY_REFRESH_ASSERT

  grep -F '"contractHashUpdateMode": true' "$log" >/dev/null
  printf '[guard:ipc_channel_registry_selftest] refresh pass: %s\n' "$name"
}

expect_report_artifacts() {
  local name="$1"
  local case_root="$SELFTEST_ROOT/$name"
  local default_report="$WT/.tmp/ci/ipc_channel_registry/report.json"
  local relative_report="relative-ipc-channel-registry-report.json"
  local absolute_report="$case_root/absolute-ipc-channel-registry-report.json"

  report_artifact_case_count=$((report_artifact_case_count + 1))

  reset_wt
  rm -rf "$case_root"
  mkdir -p "$case_root"
  rm -f "$default_report" "$WT/$relative_report" "$absolute_report"

  (
    cd "$WT"
    bash configs/ci/guard_ipc_channel_registry.sh >"$LOG_DIR/${name}-default.log" 2>&1
  )

  (
    cd "$WT"
    ADJUTORIX_IPC_CHANNEL_REGISTRY_REPORT="$relative_report" \
      bash configs/ci/guard_ipc_channel_registry.sh >"$LOG_DIR/${name}-relative.log" 2>&1
  )

  (
    cd "$WT"
    ADJUTORIX_IPC_CHANNEL_REGISTRY_REPORT="$absolute_report" \
      bash configs/ci/guard_ipc_channel_registry.sh >"$LOG_DIR/${name}-absolute.log" 2>&1
  )

  python3 - "$WT/configs/ci/ipc_channel_registry_report_schema.json" "$default_report" "$WT/$relative_report" "$absolute_report" <<'PY_REPORT_ASSERT'
import json
import re
import sys
from pathlib import Path

schema_path = Path(sys.argv[1])
paths = [Path(value) for value in sys.argv[2:]]
schema = json.loads(schema_path.read_text())
reports = []

for path in paths:
    if not path.is_file():
        raise SystemExit(f"missing report artifact: {path}")
    data = json.loads(path.read_text())
    reports.append(data)

hashes = {data.get("contractHash") for data in reports}
if len(hashes) != 1:
    raise SystemExit("report artifact contract hashes differ")

required = set(schema["required"])
field_types = schema["fieldTypes"]
invariants = schema["invariants"]

for data in reports:
    missing = sorted(required - set(data))
    if missing:
        raise SystemExit(f"report artifact missing keys: {missing}")
    for key, expected_type in sorted(field_types.items()):
        value = data.get(key)
        if expected_type == "string" and not isinstance(value, str):
            raise SystemExit(f"report artifact field {key} is not a string")
        if expected_type == "boolean" and not isinstance(value, bool):
            raise SystemExit(f"report artifact field {key} is not a boolean")
        if expected_type == "integer" and (not isinstance(value, int) or isinstance(value, bool)):
            raise SystemExit(f"report artifact field {key} is not an integer")
        if expected_type == "array" and not isinstance(value, list):
            raise SystemExit(f"report artifact field {key} is not an array")
        if expected_type == "object" and not isinstance(value, dict):
            raise SystemExit(f"report artifact field {key} is not an object")
    if data["contractHashAlgorithm"] != invariants["contractHashAlgorithm"]:
        raise SystemExit("unexpected contract hash algorithm")
    if data["reportSchema"] != invariants["reportSchema"]:
        raise SystemExit("unexpected report schema path")
    if data["reportSchemaVersion"] != schema["schemaVersion"]:
        raise SystemExit("unexpected report schema version")
    if data["contractHashUpdateMode"] is not False:
        raise SystemExit("report artifact should record normal update mode as false")
    if not isinstance(data["contractHash"], str) or not re.fullmatch(invariants["contractHashPattern"], data["contractHash"]):
        raise SystemExit("report artifact contract hash is not lowercase sha256 hex")
PY_REPORT_ASSERT

  printf '[guard:ipc_channel_registry_selftest] report artifact pass: %s\n' "$name"
}


mutate_report_schema_requires_unknown_key() {
  python3 - "$WT/configs/ci/ipc_channel_registry_report_schema.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
required = list(data["required"])
if "schemaContractSentinelMissingKey" not in required:
    required.append("schemaContractSentinelMissingKey")
data["required"] = required
data["fieldTypes"]["schemaContractSentinelMissingKey"] = "string"
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n", encoding="utf-8")
PY
}

mutate_bridge_unknown() {
  cat >>"$WT/packages/adjutorix-app/src/preload/bridge.ts" <<'EOF'

const __guardSelftestBridgeOnly = "adjutorix:selftest:bridgeOnly";
EOF
}

mutate_bridge_manifest_stale() {
  python3 - "$WT/configs/ci/ipc_channel_taxonomy.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["bridge_compat_only"] = sorted(data["bridge_compat_only"] + ["adjutorix:selftest:staleBridgeCompatOnly"])
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

mutate_domain_unknown() {
  cat >>"$WT/packages/adjutorix-app/src/main/ipc/agent_ipc.ts" <<'EOF'

const __guardSelftestDomainOnly = "adjutorix:selftest:domainOnly";
EOF
}

mutate_domain_manifest_stale() {
  python3 - "$WT/configs/ci/ipc_channel_taxonomy.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
rel = "packages/adjutorix-app/src/main/ipc/agent_ipc.ts"
data["domain_only_by_file"][rel] = sorted(data["domain_only_by_file"][rel] + ["adjutorix:selftest:staleDomainOnly"])
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

mutate_legacy_manifest_stale() {
  python3 - "$WT/configs/ci/ipc_channel_taxonomy.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["legacy_main_index_handlers"] = sorted(data["legacy_main_index_handlers"] + ["adjutorix:selftest:staleLegacyHandler"])
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

mutate_preload_boundary_escape() {
  cat >>"$WT/packages/adjutorix-app/src/main/index.ts" <<'EOF'

const __guardSelftestRawElectron = "ipcRenderer";
EOF
}

mutate_unsorted_manifest() {
  python3 - "$WT/configs/ci/ipc_channel_taxonomy.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["bridge_compat_only"] = list(reversed(data["bridge_compat_only"]))
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

mutate_contract_hash_manifest_stale() {
  python3 - "$WT/configs/ci/ipc_channel_contract_hash.json" <<'PY'
import json
import sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
data["hash"] = "0" * 64
path.write_text(json.dumps(data, indent=2, sort_keys=True) + "\n")
PY
}

run_baseline
expect_report_artifacts "machine_report_artifacts"
expect_fail "report_schema_contract_stale" "report artifact missing keys" mutate_report_schema_requires_unknown_key
expect_fail "bridge_unknown" "unsanctioned bridge-only channels" mutate_bridge_unknown
expect_fail "bridge_manifest_stale" "sanctioned bridge-only compatibility set is stale" mutate_bridge_manifest_stale
expect_fail "domain_unknown" "unsanctioned domain-only IPC channels" mutate_domain_unknown
expect_fail "domain_manifest_stale" "domain-only IPC taxonomy is stale" mutate_domain_manifest_stale
expect_fail "legacy_manifest_stale" "legacy compatibility handler taxonomy is stale" mutate_legacy_manifest_stale
expect_fail "preload_boundary_escape" "raw ipcRenderer outside preload boundary" mutate_preload_boundary_escape
expect_fail "unsorted_manifest" "must be sorted lexicographically" mutate_unsorted_manifest
expect_fail "contract_hash_manifest_stale" "IPC contract hash mismatch" mutate_contract_hash_manifest_stale
expect_refresh "contract_hash_manifest_refresh" mutate_contract_hash_manifest_stale

reset_wt

python3 - "$case_count" "$refresh_case_count" "$report_artifact_case_count" "$LOG_DIR" "$SUMMARY" <<'PY'
import json
import sys
from pathlib import Path

negative_case_count = int(sys.argv[1])
refresh_case_count = int(sys.argv[2])
report_artifact_case_count = int(sys.argv[3])
summary_path = Path(sys.argv[5])
summary = {
    "ok": True,
    "negativeCaseCount": negative_case_count,
    "refreshCaseCount": refresh_case_count,
    "reportArtifactCaseCount": report_artifact_case_count,
    "totalCaseCount": negative_case_count + refresh_case_count + report_artifact_case_count,
    "logDir": sys.argv[4],
    "summaryPath": str(summary_path),
}
summary_text = json.dumps(summary, indent=2, sort_keys=True)
summary_path.parent.mkdir(parents=True, exist_ok=True)
summary_path.write_text(summary_text + "\n", encoding="utf-8")
print(summary_text)
PY

printf '[guard:ipc_channel_registry_selftest] negative IPC guard selftest holds\n'
