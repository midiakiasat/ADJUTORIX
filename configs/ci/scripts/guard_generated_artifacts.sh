#!/usr/bin/env bash
set -euo pipefail

guard_tracked_generated() {
  if git ls-files | grep -Eqi '^(\.agent/|runtime/)'; then
    echo "ERROR: generated artifacts are tracked (.agent/ or runtime/)."
    git ls-files | grep -Ei '^(\.agent/|runtime/)' || true
    return 1
  fi
  return 0
}

cd "$(git rev-parse --show-toplevel)"

echo ">>> Guard: forbid tracked generated artifacts (.agent/ and runtime/)"
guard_tracked_generated

echo ">>> Negative test: force-add .agent to index (must be rejected)"

NEG_DIR=".agent/ci-negative"
NEG_FILE="$NEG_DIR/should_fail.txt"

mkdir -p "$NEG_DIR"
printf "x\n" > "$NEG_FILE"

# Force-add into index to simulate bypass of .gitignore
git add -f "$NEG_FILE"

set +e
guard_tracked_generated
rc=$?
set -e

# cleanup: remove from index AND working tree
git restore -SW --staged --worktree "$NEG_FILE" 2>/dev/null || true
rm -rf "$NEG_DIR"

if [[ $rc -eq 0 ]]; then
  echo "ERROR: negative test did not fail (guard is broken)."
  exit 1
fi

echo "OK: negative test failed as expected"
