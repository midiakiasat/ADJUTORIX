#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root

contract_status="skipped"
typecheck_status="skipped"
test_status="skipped"

if [[ -f configs/contracts/protocol_versions.json ]]; then
  "$ADJ_ROOT/scripts/contracts/validate.sh"
  contract_status="ok"
fi

if [[ -f package.json ]]; then
  if grep -q "\"check\"" package.json; then
    run_node_task run check
    typecheck_status="ok"
  elif grep -q "\"build\"" package.json; then
    run_node_task run build
    typecheck_status="ok"
  fi
fi

if [[ -f package.json ]] && grep -q "\"test\"" package.json; then
  run_node_task run test
  test_status="ok"
fi

echo "verify_contracts=$contract_status"
echo "verify_typecheck=$typecheck_status"
echo "verify_tests=$test_status"
