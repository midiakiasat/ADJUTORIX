#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
print_repo_identity
printf "\n=== GOVERNED TARGETS ===\n"
find_governed_targets
printf "\n=== VERIFY POLICY ===\n"
find_verify_policy
printf "\n=== MUTATION POLICY ===\n"
find_mutation_policy
printf "\n=== PRIVACY MARKERS ===\n"
safe_rg -n -g "!node_modules" -g "!.git" "(secret|token|credential|private[_-]?key)" . || true
