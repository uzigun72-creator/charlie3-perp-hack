#!/usr/bin/env bash
# One-time (or repeat) setup: deps, contract build, patches, .env template, proof-server probe.
# Charli3: feeds are already on Preprod — this repo only needs Kupo URL + wallet keys in .env.
#
# Usage: npm run bootstrap
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "=== [1/4] npm install (workspaces + patch-package) ==="
npm install

echo "=== [2/4] build Compact contract artifacts (charli3perp-local-cli needs dist/) ==="
npm run build:contract

echo "=== [3/4] .env ==="
if [[ ! -f .env ]]; then
  cp .env.example .env
  echo "Created .env from .env.example — add BLOCKFROST_PROJECT_ID, WALLET_MNEMONIC, BIP39_MNEMONIC, C3PERP_* hex."
else
  echo ".env already exists (not overwritten)."
fi

echo "=== [4/4] Local proof server (recommended for Preview) ==="
if curl -sf -m 2 "http://127.0.0.1:6300/" >/dev/null 2>&1; then
  echo "OK: something responds on http://127.0.0.1:6300"
else
  echo "No HTTP on :6300 — for local proving run in another terminal:"
  echo "  npm run proof-server"
  echo "Or set MIDNIGHT_PROOF_SERVER to hosted Lace URL in .env (see charli3perp-local-cli/README.md)."
fi

echo ""
echo "=== Next: fast terminal workflow ==="
echo "  source $ROOT/scripts/trade-env.sh"
echo "  npm run trade:fast                    # full Charli3 + Midnight + Cardano"
echo "  npm run deploy:midnight:order         # Midnight: order contract + ZK only"
echo "  npm run deploy:midnight:full          # Midnight: all 5 contracts (heavy; needs C3PERP_* extras)"
echo ""
echo "See docs/live-run.md and README (Unified perp CLI)."
