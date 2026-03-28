#!/usr/bin/env bash
set -euo pipefail
source "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/lib/common.sh"
cd_root
base="${1:-origin/main}"
head="${2:-HEAD}"
tmp1="$(mktemp)"
tmp2="$(mktemp)"
trap "rm -f \"$tmp1\" \"$tmp2\"" EXIT
git diff --name-status "$base" "$head" | sort > "$tmp1"
git diff --name-status "$base" "$head" | sort > "$tmp2"
cmp -s "$tmp1" "$tmp2" || die "replay diff output diverged"
echo "replay=deterministic"
cat "$tmp1"
