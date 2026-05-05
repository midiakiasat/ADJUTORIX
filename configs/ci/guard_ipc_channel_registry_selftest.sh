#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(git rev-parse --show-toplevel)}"
SELFTEST_ROOT="${SELFTEST_ROOT:-$ROOT_DIR/.tmp/ci/guard_ipc_channel_registry_selftest}"
LOG_DIR="$SELFTEST_ROOT/logs"
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

python3 - "$case_count" "$LOG_DIR" <<'PY'
import json
import sys

print(json.dumps(
    {
        "ok": True,
        "negativeCaseCount": int(sys.argv[1]),
        "logDir": sys.argv[2],
    },
    indent=2,
    sort_keys=True,
))
PY

printf '[guard:ipc_channel_registry_selftest] negative IPC guard selftest holds\n'
