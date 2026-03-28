#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
[[ -f configs/policy/governed_targets.yaml ]] || die "missing governed target policy"
[[ -f configs/policy/mutation_policy.yaml ]] || die "missing mutation policy"
[[ -f configs/policy/verify_policy.yaml ]] || die "missing verify policy"
printf "governance=ok\n"
