#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd -- "$SCRIPT_DIR/../.." && pwd)"
ROOT="$ROOT_DIR"
cd "$ROOT_DIR"

readonly SCRIPT_DIR
readonly ROOT_DIR
readonly ROOT

CONSTITUTION_CHECKER="${CONSTITUTION_CHECKER:-$ROOT_DIR/scripts/adjutorix-constitution-check.mjs}"
CONSTITUTION_REPORT="${CONSTITUTION_REPORT:-$ROOT_DIR/.tmp/ci/guard_v1_finality/constitution-report.json}"

run_constitution_preflight() {
  printf '\n== Repository constitution preflight ==\n'
  if ! command -v node >/dev/null 2>&1; then
    printf '%s\n' "[error] Required command not found: node" >&2
    return 1
  fi
  if [[ ! -x "$CONSTITUTION_CHECKER" ]]; then
    printf '%s\n' "[error] Missing executable constitution checker: $CONSTITUTION_CHECKER" >&2
    return 1
  fi
  mkdir -p "$(dirname "$CONSTITUTION_REPORT")"
  node "$CONSTITUTION_CHECKER" --root "$ROOT_DIR" --json --out "$CONSTITUTION_REPORT"
}


REPO_ROOT="$(cd -- "${SCRIPT_DIR}/../.." && pwd)"
cd "$REPO_ROOT"

CONSTITUTION_CHECKER="${REPO_ROOT}/scripts/adjutorix-constitution-check.mjs"
CONSTITUTION_REPORT="${REPO_ROOT}/.tmp/ci/guard_v1_finality/constitution-report.json"

run_constitution_preflight

echo "[guard:v1_finality] constitution"
test -x "$CONSTITUTION_CHECKER"
node "$CONSTITUTION_CHECKER" --report "$CONSTITUTION_REPORT"

echo "[guard:v1_finality] files"
test -f FINALITY.md
test -f configs/contracts/v1_finality_manifest.json
test -f configs/policy/v1_finality_policy.yaml

echo "[guard:v1_finality] marker"
grep -q "ADJUTORIX V1 FEATURE FINALITY" FINALITY.md
grep -q "FEATURE-COMPLETE FOR V1" FINALITY.md
grep -q "ADJUTORIX v1 is feature-complete, replay-proven, remotely verified, and privacy-sealed" FINALITY.md

echo "[guard:v1_finality] manifest"
python3 - <<'PY'
import json
from pathlib import Path

p = Path("configs/contracts/v1_finality_manifest.json")
data = json.loads(p.read_text(encoding="utf-8"))

assert data["schema"] == "adjutorix.v1.finality_manifest"
assert data["epoch"] == "v1"
assert data["status"] == "feature_complete"
assert data["scope_state"] == "closed"
assert data["supersession_rule"] == "future product expansion requires v2_or_later_epoch"

required_surface = {
    "repository_verification",
    "local_replay",
    "sterile_outsider_replay",
    "remote_github_actions_verification",
    "clean_tracked_tree_replay",
    "privacy_artifact_perimeter",
    "release_proof_bundles",
    "sanitized_final_proof_assets",
    "quarantined_deferred_smoke_scope",
    "deterministic_renderer_asset_manifest",
    "governed_verification_workflow",
}
assert required_surface.issubset(set(data["closed_surface"]))

required_mutations = {
    "security_remediation",
    "privacy_remediation",
    "verification_regression_repair",
    "dependency_or_platform_compatibility_repair",
    "proof_asset_repair",
    "non_scope_expanding_documentation_correction",
}
assert set(data["allowed_v1_mutation_classes"]) == required_mutations
print("v1-finality-manifest-ok")
PY

echo "[guard:v1_finality] policy"
grep -q "schema: adjutorix.v1.finality_policy" configs/policy/v1_finality_policy.yaml
grep -q "scope_state: closed" configs/policy/v1_finality_policy.yaml
grep -q "New product scope must be declared as v2 or later" configs/policy/v1_finality_policy.yaml

echo "[guard:v1_finality] no banned draft-language in finality files"
BAD="$(
  grep -RInE "TODO|TBD|FIXME|place""holder|aspir""ational|may""be|event""ually"  \
    FINALITY.md \
    configs/contracts/v1_finality_manifest.json \
    configs/policy/v1_finality_policy.yaml || true
)"
printf '%s\n' "$BAD"
test -z "$BAD"

echo "[guard:v1_finality] no tracked generated artifacts"
BAD_ARTIFACTS="$(
  git ls-files | grep -E '(^|/)(node_modules|dist|release|\.turbo|\.tmp|__pycache__|\.pytest_cache|\.venv|\.adjutorix-baseline|\.adjutorix-verify-venv)(/|$)|\.(pyc|pyo|dmg|asar|tar\.gz|zip|sqlite|db|pem|key|p12|pfx|crt|cer)$' || true
)"
printf '%s\n' "$BAD_ARTIFACTS"
test -z "$BAD_ARTIFACTS"

echo "[guard:v1_finality] pass"
