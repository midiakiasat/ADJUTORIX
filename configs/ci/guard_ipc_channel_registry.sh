#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="${ROOT_DIR:-$(git rev-parse --show-toplevel)}"
CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_ipc_channel_registry/constitution-report.json}"

section() {
  printf '\n== %s ==\n' "$*"
}

ok() {
  printf '[guard:ipc_channel_registry] %s\n' "$*"
}

die() {
  printf '[guard:ipc_channel_registry] %s\n' "$*" >&2
  exit 1
}

run_constitution_preflight() {
  section "Repository constitution preflight"
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --root "$ROOT_DIR" --json --out "$CONSTITUTION_REPORT"
}

constitution_stratum_for_path() {
  local rel_path="${1#./}"
  node "$ROOT_DIR/scripts/lib/constitution-classifier.mjs" "$ROOT_DIR" "$rel_path"
}

assert_constitution_stratum() {
  local rel_path="${1#./}"
  local expected="$2"
  local stratum

  stratum="$(constitution_stratum_for_path "$rel_path" || printf 'unclassified')"
  if [[ "$stratum" != "$expected" ]]; then
    printf '[guard:ipc_channel_registry] expected %s for %s, got %s\n' "$expected" "$rel_path" "$stratum" >&2
    return 1
  fi
}

require_file() {
  local rel_path="$1"
  [[ -f "$ROOT_DIR/$rel_path" ]] || die "missing required IPC registry surface: $rel_path"
}

run_constitution_preflight

section "IPC channel registry sovereignty"

require_file "packages/adjutorix-app/src/main/ipc/channels.ts"
require_file "packages/adjutorix-app/src/main/boundary/ipc_guard.ts"
require_file "packages/adjutorix-app/src/main/runtime/bootstrap.ts"
require_file "packages/adjutorix-app/src/main/index.ts"
require_file "packages/adjutorix-app/src/main/ipc/agent_ipc.ts"
require_file "packages/adjutorix-app/src/main/ipc/diagnostics_ipc.ts"
require_file "packages/adjutorix-app/src/main/ipc/ledger_ipc.ts"
require_file "packages/adjutorix-app/src/main/ipc/patch_ipc.ts"
require_file "packages/adjutorix-app/src/main/ipc/verify_ipc.ts"
require_file "packages/adjutorix-app/src/main/ipc/workspace_ipc.ts"
require_file "packages/adjutorix-app/src/preload/bridge.ts"
require_file "packages/adjutorix-app/src/preload/preload.ts"
require_file "packages/adjutorix-app/tests/main/channels.test.ts"
require_file "packages/adjutorix-app/tests/main/preload_bridge.test.ts"

assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/channels.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/boundary/ipc_guard.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/runtime/bootstrap.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/index.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/agent_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/diagnostics_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/ledger_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/patch_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/verify_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/main/ipc/workspace_ipc.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/preload/bridge.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/src/preload/preload.ts" "authority/source"
assert_constitution_stratum "packages/adjutorix-app/tests/main/channels.test.ts" "authority/tests"
assert_constitution_stratum "packages/adjutorix-app/tests/main/preload_bridge.test.ts" "authority/tests"

python3 - "$ROOT_DIR" <<'PY'
from __future__ import annotations

import json
import re
import sys
from pathlib import Path

root = Path(sys.argv[1])
channel_re = re.compile(r'["\'](adjutorix:[A-Za-z0-9_.:-]+)["\']')

def read(rel: str) -> str:
    return (root / rel).read_text(encoding="utf-8", errors="ignore")

def channels_in(rel: str) -> set[str]:
    return set(channel_re.findall(read(rel)))

def duplicate_literals(rel: str) -> dict[str, int]:
    values = channel_re.findall(read(rel))
    return {value: values.count(value) for value in sorted(set(values)) if values.count(value) > 1}

main_registry_rel = "packages/adjutorix-app/src/main/ipc/channels.ts"
bridge_registry_rel = "packages/adjutorix-app/src/preload/bridge.ts"
domain_registry_rels = [
    "packages/adjutorix-app/src/main/ipc/agent_ipc.ts",
    "packages/adjutorix-app/src/main/ipc/diagnostics_ipc.ts",
    "packages/adjutorix-app/src/main/ipc/ledger_ipc.ts",
    "packages/adjutorix-app/src/main/ipc/patch_ipc.ts",
    "packages/adjutorix-app/src/main/ipc/verify_ipc.ts",
    "packages/adjutorix-app/src/main/ipc/workspace_ipc.ts",
]

main_registry = channels_in(main_registry_rel)
bridge_registry = channels_in(bridge_registry_rel)
ipc_guard = channels_in("packages/adjutorix-app/src/main/boundary/ipc_guard.ts")
runtime_bootstrap = channels_in("packages/adjutorix-app/src/main/runtime/bootstrap.ts")
domain_registries = {rel: channels_in(rel) for rel in domain_registry_rels}
domain_registry = set().union(*domain_registries.values())
main_index_text = read("packages/adjutorix-app/src/main/index.ts")
main_index_handlers = set(
    re.findall(r'(?:safeHandle|registerLegacyCompatHandler)\(\s*["\'](adjutorix:[A-Za-z0-9_.:-]+)["\']', main_index_text)
)
main_index_safe_handlers = set(
    re.findall(r'safeHandle\(\s*["\'](adjutorix:[A-Za-z0-9_.:-]+)["\']', main_index_text)
)

sanctioned_bridge_compat_only = {
    "adjutorix:workspace:reveal",
    "adjutorix:workspace:trust:read",
    "adjutorix:workspace:trust:set",
    "adjutorix:patch:approve",
    "adjutorix:patch:clear",
    "adjutorix:event:workspace",
    "adjutorix:event:agent",
    "adjutorix:event:diagnostics",
    "adjutorix:event:patch",
    "adjutorix:event:verify",
}

if not main_registry:
    raise SystemExit("main IPC registry has no adjutorix:* channel literals")
if not bridge_registry:
    raise SystemExit("preload bridge registry has no adjutorix:* channel literals")

for rel in [main_registry_rel, bridge_registry_rel]:
    dup = duplicate_literals(rel)
    if dup:
        raise SystemExit(f"duplicate channel literal inside sovereign registry {rel}: {json.dumps(dup, sort_keys=True)}")

unknown_guard_channels = sorted(ipc_guard - main_registry)
if unknown_guard_channels:
    raise SystemExit(
        "ipc_guard.ts references channels absent from main IPC registry: "
        + json.dumps(unknown_guard_channels, sort_keys=True)
    )

unknown_bootstrap_channels = sorted(runtime_bootstrap - main_registry)
if unknown_bootstrap_channels:
    raise SystemExit(
        "runtime/bootstrap.ts references channels absent from main IPC registry: "
        + json.dumps(unknown_bootstrap_channels, sort_keys=True)
    )

unknown_safe_handle_channels = sorted(main_index_safe_handlers - main_registry)
if unknown_safe_handle_channels:
    raise SystemExit(
        "main/index.ts safeHandle channel absent from main IPC registry: "
        + json.dumps(unknown_safe_handle_channels, sort_keys=True)
    )

authoritative_bridge_carriers = main_registry | domain_registry | main_index_handlers
bridge_compat_only = bridge_registry - authoritative_bridge_carriers
unknown_bridge_channels = sorted(bridge_compat_only - sanctioned_bridge_compat_only)
missing_sanctioned_bridge_compat = sorted(sanctioned_bridge_compat_only - bridge_compat_only)

if unknown_bridge_channels:
    raise SystemExit(
        "preload bridge has unsanctioned bridge-only channels: "
        + json.dumps(unknown_bridge_channels, sort_keys=True)
    )
if missing_sanctioned_bridge_compat:
    raise SystemExit(
        "sanctioned bridge-only compatibility set is stale; missing active bridge channels: "
        + json.dumps(missing_sanctioned_bridge_compat, sort_keys=True)
    )

print(json.dumps(
    {
        "mainRegistryChannelCount": len(main_registry),
        "bridgeRegistryChannelCount": len(bridge_registry),
        "domainRegistryChannelCount": len(domain_registry),
        "mainIndexHandlerChannelCount": len(main_index_handlers),
        "mainIndexSafeHandleChannelCount": len(main_index_safe_handlers),
        "ipcGuardChannelCount": len(ipc_guard),
        "runtimeBootstrapChannelCount": len(runtime_bootstrap),
        "bridgeCompatOnlyChannelCount": len(bridge_compat_only),
        "bridgeCompatOnlyChannels": sorted(bridge_compat_only),
        "domainRegistryCounts": {rel: len(values) for rel, values in sorted(domain_registries.items())},
    },
    indent=2,
    sort_keys=True,
))
PY

python3 - "$ROOT_DIR" <<'PY'
from __future__ import annotations

import sys
from pathlib import Path

root = Path(sys.argv[1])
allowed_raw_ipc_renderer = {
    "packages/adjutorix-app/src/preload/preload.ts",
}
allowed_context_bridge = {
    "packages/adjutorix-app/src/preload/preload.ts",
}

bad_ipc_renderer: list[str] = []
bad_context_bridge: list[str] = []

for path in sorted((root / "packages/adjutorix-app/src").rglob("*")):
    if not path.is_file() or path.suffix not in {".ts", ".tsx", ".js", ".jsx"}:
        continue
    rel = path.relative_to(root).as_posix()
    text = path.read_text(encoding="utf-8", errors="ignore")
    for line_no, line in enumerate(text.splitlines(), start=1):
        if "ipcRenderer" in line and rel not in allowed_raw_ipc_renderer:
            bad_ipc_renderer.append(f"{rel}:{line_no}:{line.strip()}")
        if "contextBridge.exposeInMainWorld" in line and rel not in allowed_context_bridge:
            bad_context_bridge.append(f"{rel}:{line_no}:{line.strip()}")

if bad_ipc_renderer:
    raise SystemExit("raw ipcRenderer outside preload boundary:\n" + "\n".join(bad_ipc_renderer))
if bad_context_bridge:
    raise SystemExit("contextBridge exposure outside preload boundary:\n" + "\n".join(bad_context_bridge))

print("preload boundary raw Electron authority confined")
PY

ok "IPC channel registry sovereignty holds"
