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

require_file "configs/ci/ipc_channel_taxonomy.json"
require_file "configs/ci/ipc_channel_contract_hash.json"
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

assert_constitution_stratum "configs/ci/ipc_channel_taxonomy.json" "authority/config"
assert_constitution_stratum "configs/ci/ipc_channel_contract_hash.json" "authority/config"
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

import hashlib
import os
import json
import re
import sys
from pathlib import Path
from typing import Any

root = Path(sys.argv[1])
channel_re = re.compile(r'["\'](adjutorix:[A-Za-z0-9_.:-]+)["\']')
taxonomy_rel = "configs/ci/ipc_channel_taxonomy.json"
contract_hash_rel = "configs/ci/ipc_channel_contract_hash.json"

def read(rel: str) -> str:
    return (root / rel).read_text(encoding="utf-8", errors="ignore")

def load_json(rel: str) -> dict[str, Any]:
    value = json.loads(read(rel))
    if not isinstance(value, dict):
        raise SystemExit(f"{rel} must contain a JSON object")
    return value

def string_list(path: str, value: Any) -> list[str]:
    if not isinstance(value, list) or any(not isinstance(item, str) for item in value):
        raise SystemExit(f"{path} must be a JSON string array")
    if len(value) != len(set(value)):
        raise SystemExit(f"{path} contains duplicate values")
    if value != sorted(value):
        raise SystemExit(f"{path} must be sorted lexicographically")
    return value

def string_set(path: str, value: Any) -> set[str]:
    return set(string_list(path, value))

def object_value(path: str, value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise SystemExit(f"{path} must be a JSON object")
    return value

def channels_in(rel: str) -> set[str]:
    return set(channel_re.findall(read(rel)))

def duplicate_literals(rel: str) -> dict[str, int]:
    values = channel_re.findall(read(rel))
    return {value: values.count(value) for value in sorted(set(values)) if values.count(value) > 1}

taxonomy = load_json(taxonomy_rel)
if taxonomy.get("schema") != 1:
    raise SystemExit("IPC taxonomy manifest schema must be 1")

contract_hash_manifest = load_json(contract_hash_rel)
if contract_hash_manifest.get("schema") != 1:
    raise SystemExit("IPC contract hash manifest schema must be 1")
expected_contract_hash_algorithm = contract_hash_manifest.get("algorithm")
if expected_contract_hash_algorithm != "sha256:ipc-channel-registry-v1":
    raise SystemExit("IPC contract hash manifest algorithm must be sha256:ipc-channel-registry-v1")
expected_contract_hash = contract_hash_manifest.get("hash")
if not isinstance(expected_contract_hash, str) or not re.fullmatch(r"[0-9a-f]{64}", expected_contract_hash):
    raise SystemExit("IPC contract hash manifest hash must be a lowercase 64-character sha256 hex digest")

update_contract_hash_manifest = os.environ.get("ADJUTORIX_IPC_CONTRACT_HASH_UPDATE") == "true"

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

sanctioned_legacy_main_index_handlers = string_set(
    "legacy_main_index_handlers",
    taxonomy.get("legacy_main_index_handlers"),
)
sanctioned_bridge_compat_only = string_set(
    "bridge_compat_only",
    taxonomy.get("bridge_compat_only"),
)

domain_only_raw = object_value("domain_only_by_file", taxonomy.get("domain_only_by_file"))
sanctioned_domain_only_by_file = {
    rel: set(string_list(f"domain_only_by_file.{rel}", values))
    for rel, values in sorted(domain_only_raw.items())
}
domain_taxonomy_keys = set(sanctioned_domain_only_by_file)
domain_registry_key_set = set(domain_registry_rels)
if domain_taxonomy_keys != domain_registry_key_set:
    raise SystemExit(
        "domain-only taxonomy file keys must exactly match domain IPC registry files: "
        + json.dumps(
            {
                "missing": sorted(domain_registry_key_set - domain_taxonomy_keys),
                "extra": sorted(domain_taxonomy_keys - domain_registry_key_set),
            },
            sort_keys=True,
        )
    )

preload_boundary = object_value("preload_boundary", taxonomy.get("preload_boundary"))
allowed_raw_ipc_renderer = string_set(
    "preload_boundary.allowed_raw_ipc_renderer",
    preload_boundary.get("allowed_raw_ipc_renderer"),
)
allowed_context_bridge = string_set(
    "preload_boundary.allowed_context_bridge",
    preload_boundary.get("allowed_context_bridge"),
)

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
main_index_legacy_handlers = main_index_handlers - main_index_safe_handlers

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

unknown_legacy_handlers = sorted(main_index_legacy_handlers - sanctioned_legacy_main_index_handlers)
missing_legacy_handlers = sorted(sanctioned_legacy_main_index_handlers - main_index_legacy_handlers)
if unknown_legacy_handlers:
    raise SystemExit(
        "main/index.ts has unsanctioned legacy compatibility handlers: "
        + json.dumps(unknown_legacy_handlers, sort_keys=True)
    )
if missing_legacy_handlers:
    raise SystemExit(
        "main/index.ts legacy compatibility handler taxonomy is stale; missing active handlers: "
        + json.dumps(missing_legacy_handlers, sort_keys=True)
    )

domain_only_by_file = {
    rel: values - main_registry
    for rel, values in domain_registries.items()
}
for rel, expected in sanctioned_domain_only_by_file.items():
    actual = domain_only_by_file.get(rel, set())
    unknown = sorted(actual - expected)
    missing = sorted(expected - actual)
    if unknown:
        raise SystemExit(
            f"{rel} has unsanctioned domain-only IPC channels: "
            + json.dumps(unknown, sort_keys=True)
        )
    if missing:
        raise SystemExit(
            f"{rel} domain-only IPC taxonomy is stale; missing active channels: "
            + json.dumps(missing, sort_keys=True)
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

contract_snapshot = {
    "schema": "ipc-channel-registry-v1",
    "taxonomy": taxonomy,
    "mainRegistry": sorted(main_registry),
    "bridgeRegistry": sorted(bridge_registry),
    "domainRegistries": {rel: sorted(values) for rel, values in sorted(domain_registries.items())},
    "mainIndexHandlers": sorted(main_index_handlers),
    "mainIndexSafeHandlers": sorted(main_index_safe_handlers),
    "mainIndexLegacyHandlers": sorted(main_index_legacy_handlers),
    "ipcGuardChannels": sorted(ipc_guard),
    "runtimeBootstrapChannels": sorted(runtime_bootstrap),
    "preloadBoundaryAllowedRawIpcRenderer": sorted(allowed_raw_ipc_renderer),
    "preloadBoundaryAllowedContextBridge": sorted(allowed_context_bridge),
}
contract_hash = hashlib.sha256(
    json.dumps(contract_snapshot, sort_keys=True, separators=(",", ":")).encode("utf-8")
).hexdigest()

if update_contract_hash_manifest:
    contract_hash_manifest["schema"] = 1
    contract_hash_manifest["algorithm"] = "sha256:ipc-channel-registry-v1"
    contract_hash_manifest["hash"] = contract_hash
    (root / contract_hash_rel).write_text(
        json.dumps(contract_hash_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )
    expected_contract_hash = contract_hash

if contract_hash != expected_contract_hash:
    raise SystemExit(
        "IPC contract hash mismatch: "
        + json.dumps(
            {
                "actual": contract_hash,
                "expected": expected_contract_hash,
                "manifest": contract_hash_rel,
            },
            sort_keys=True,
        )
    )

def validate_machine_report_schema(report_data, schema_data):
    required = set(schema_data["required"])
    missing = sorted(required - set(report_data))
    if missing:
        raise SystemExit(f"report artifact missing keys: {missing}")

    field_types = schema_data["fieldTypes"]
    for key, expected_type in sorted(field_types.items()):
        value = report_data.get(key)
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

    invariants = schema_data["invariants"]
    if report_data["reportSchema"] != invariants["reportSchema"]:
        raise SystemExit("unexpected report schema path")
    if report_data["reportSchemaHashManifest"] != invariants["reportSchemaHashManifest"]:
        raise SystemExit("unexpected report schema hash manifest path")
    if report_data["reportSchemaHashAlgorithm"] != invariants["reportSchemaHashAlgorithm"]:
        raise SystemExit("unexpected report schema hash algorithm")
    if report_data["reportSchemaVersion"] != schema_data["schemaVersion"]:
        raise SystemExit("unexpected report schema version")
    if report_data["contractHashAlgorithm"] != invariants["contractHashAlgorithm"]:
        raise SystemExit("unexpected contract hash algorithm")
    if not re.fullmatch(invariants["contractHashPattern"], report_data["contractHash"]):
        raise SystemExit("report artifact contract hash is not lowercase sha256 hex")
    if not re.fullmatch(invariants["schemaHashPattern"], report_data["reportSchemaHash"]):
        raise SystemExit("report artifact schema hash is not lowercase sha256 hex")

report_schema_rel = "configs/ci/ipc_channel_registry_report_schema.json"
report_schema_hash_manifest_rel = "configs/ci/ipc_channel_registry_report_schema_hash.json"
report_schema_hash_algorithm = "sha256:ipc-channel-registry-report-schema-v1"
report_schema_text = (root / report_schema_rel).read_text(encoding="utf-8")
report_schema_hash = hashlib.sha256(report_schema_text.encode("utf-8")).hexdigest()
report_schema_hash_manifest_path = root / report_schema_hash_manifest_rel
report_schema_hash_manifest = json.loads(report_schema_hash_manifest_path.read_text(encoding="utf-8"))
report_schema_hash_update_mode = os.environ.get("ADJUTORIX_UPDATE_IPC_REPORT_SCHEMA_HASH") == "1"

if report_schema_hash_manifest.get("schemaPath") != report_schema_rel:
    raise SystemExit("unexpected IPC report schema hash manifest path")
if report_schema_hash_manifest.get("schemaHashAlgorithm") != report_schema_hash_algorithm:
    raise SystemExit("unexpected IPC report schema hash algorithm")

if report_schema_hash_update_mode:
    report_schema_hash_manifest = {
        "schemaHash": report_schema_hash,
        "schemaHashAlgorithm": report_schema_hash_algorithm,
        "schemaPath": report_schema_rel,
    }
    report_schema_hash_manifest_path.write_text(
        json.dumps(report_schema_hash_manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
    )

expected_report_schema_hash = report_schema_hash_manifest.get("schemaHash")
if report_schema_hash != expected_report_schema_hash:
    raise SystemExit(
        "IPC report schema hash manifest is stale: "
        f"expected {expected_report_schema_hash}, got {report_schema_hash}. "
        "Run ADJUTORIX_UPDATE_IPC_REPORT_SCHEMA_HASH=1 configs/ci/guard_ipc_channel_registry.sh "
        "after intentional schema changes."
    )

report_schema = json.loads(report_schema_text)

report = {
    "reportSchema": report_schema_rel,
    "reportSchemaHashManifest": report_schema_hash_manifest_rel,
    "reportSchemaHash": report_schema_hash,
    "reportSchemaHashAlgorithm": report_schema_hash_algorithm,
    "reportSchemaHashUpdateMode": report_schema_hash_update_mode,
    "reportSchemaVersion": "ipc-channel-registry-report-v1",
    "taxonomyManifest": taxonomy_rel,
    "contractHashManifest": contract_hash_rel,
    "contractHash": contract_hash,
    "contractHashAlgorithm": "sha256:ipc-channel-registry-v1",
    "contractHashUpdateMode": update_contract_hash_manifest,
    "mainRegistryChannelCount": len(main_registry),
    "bridgeRegistryChannelCount": len(bridge_registry),
    "domainRegistryChannelCount": len(domain_registry),
    "mainIndexHandlerChannelCount": len(main_index_handlers),
    "mainIndexSafeHandleChannelCount": len(main_index_safe_handlers),
    "mainIndexLegacyHandlerCount": len(main_index_legacy_handlers),
    "mainIndexLegacyHandlers": sorted(main_index_legacy_handlers),
    "ipcGuardChannelCount": len(ipc_guard),
    "runtimeBootstrapChannelCount": len(runtime_bootstrap),
    "domainOnlyChannelCount": sum(len(v) for v in domain_only_by_file.values()),
    "domainOnlyChannelsByFile": {rel: sorted(values) for rel, values in sorted(domain_only_by_file.items())},
    "bridgeCompatOnlyChannelCount": len(bridge_compat_only),
    "bridgeCompatOnlyChannels": sorted(bridge_compat_only),
    "domainRegistryCounts": {rel: len(values) for rel, values in sorted(domain_registries.items())},
    "preloadBoundaryAllowedRawIpcRenderer": sorted(allowed_raw_ipc_renderer),
    "preloadBoundaryAllowedContextBridge": sorted(allowed_context_bridge),
}
validate_machine_report_schema(report, report_schema)
report_text = json.dumps(report, indent=2, sort_keys=True)
report_path_value = os.environ.get("ADJUTORIX_IPC_CHANNEL_REGISTRY_REPORT")
report_path = Path(report_path_value) if report_path_value else root / ".tmp/ci/ipc_channel_registry/report.json"
if not report_path.is_absolute():
    report_path = root / report_path
report_path.parent.mkdir(parents=True, exist_ok=True)
report_path.write_text(report_text + "\n", encoding="utf-8")
print(report_text)
print("preload boundary raw Electron authority confined")
PY

ok "IPC channel registry sovereignty holds"
