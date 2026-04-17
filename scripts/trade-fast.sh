#!/usr/bin/env bash
# Load trade-env.sh then run the ADA-USD orchestrator (pass-through args, default: all).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# shellcheck disable=SC1091
source "$ROOT/scripts/trade-env.sh"
cd "$ROOT"
if [[ $# -eq 0 ]]; then
  exec npm run trade:adausd -- all
else
  exec npm run trade:adausd -- "$@"
fi
