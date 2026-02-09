#!/usr/bin/env bash
set -euo pipefail
cd "$(git rev-parse --show-toplevel)"
exec ./configs/ci/scripts/guard_generated_artifacts.sh
