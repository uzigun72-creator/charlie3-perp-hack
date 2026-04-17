#!/usr/bin/env bash
# Load repo .env + sensible defaults for fast trading sessions.
#
# Usage (from any directory):
#   source /path/to/charlie3_hack/scripts/trade-env.sh
#
# Or add to ~/.bashrc:
#   alias c3perp-trade='source ~/charlie3_hack/scripts/trade-env.sh'
#
# Then from repo root:
#   npm run trade:fast
#   npm run perp -- midnight run-all
#
# Charli3 ODV feeds live on Cardano Preprod — nothing to "deploy"; only Kupo URL + keys in .env.

_TRADE_ENV_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")/.." && pwd)"
cd "$_TRADE_ENV_ROOT" || return 1
export TRADE_REPO_ROOT="$_TRADE_ENV_ROOT"

if [[ -f .env ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env
  set +a
else
  echo "[trade-env] No .env in $_TRADE_ENV_ROOT — run: npm run bootstrap" >&2
fi

export MIDNIGHT_PROOF_SERVER="${MIDNIGHT_PROOF_SERVER:-http://127.0.0.1:6300}"
export CARDANO_BACKEND="${CARDANO_BACKEND:-blockfrost}"
export CARDANO_NETWORK="${CARDANO_NETWORK:-Preprod}"
export CHARLI3_KUPO_URL="${CHARLI3_KUPO_URL:-http://35.209.192.203:1442}"
export CHARLI3_PAIR_ID="${CHARLI3_PAIR_ID:-ADA-USD}"

echo "[trade-env] TRADE_REPO_ROOT=$TRADE_REPO_ROOT"
echo "[trade-env] MIDNIGHT_PROOF_SERVER=$MIDNIGHT_PROOF_SERVER  CARDANO_BACKEND=$CARDANO_BACKEND"
