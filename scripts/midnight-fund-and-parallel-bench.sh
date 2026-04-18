#!/usr/bin/env bash
# Preview: fund HD indices 1–5 from funder 0 + DUST, then 5× parallel `run-pipeline` (one wallet each).
# Requires repo-root `.env` (BIP39_MNEMONIC, MIDNIGHT_DEPLOY_NETWORK=preview), proof server on :6300.
#
# Funder index 0 must have enough Preview tNIGHT on **shielded + unshielded** (faucet). If transfers fail with
# InsufficientFunds, top up or lower MIDNIGHT_FUND_TRANSFER_AMOUNT (per leg, shielded + unshielded each).
# Skip funding (workers already funded): SKIP_FUND=1 bash scripts/midnight-fund-and-parallel-bench.sh
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export MIDNIGHT_DEPLOY_NETWORK="${MIDNIGHT_DEPLOY_NETWORK:-preview}"

T0=$(date +%s)
if [[ "${SKIP_FUND:-0}" == "1" ]]; then
  echo "[midnight-bench] SKIP_FUND=1 — skipping fund-derived-wallets"
  FUND_S=0
  T1=$(date +%s)
else
  echo "[midnight-bench] === FUND 5 workers (derive 1–5) start $(date -Iseconds) ==="
  npm run midnight:fund-derived
  T1=$(date +%s)
  FUND_S=$((T1 - T0))
  echo "[midnight-bench] === FUND done wall_s=${FUND_S} ($(date -Iseconds)) ==="
fi

export MIDNIGHT_PARALLEL_COUNT="${MIDNIGHT_PARALLEL_COUNT:-5}"
export MIDNIGHT_PARALLEL_OFFSET="${MIDNIGHT_PARALLEL_OFFSET:-1}"
export MIDNIGHT_PARALLEL_SCRIPT="${MIDNIGHT_PARALLEL_SCRIPT:-run-pipeline}"
export C3PERP_PIPELINE_BENCH_LOG="${C3PERP_PIPELINE_BENCH_LOG:-1}"
export MIDNIGHT_PARALLEL_BENCH_JSON="${MIDNIGHT_PARALLEL_BENCH_JSON:-1}"

echo "[midnight-bench] === PARALLEL ${MIDNIGHT_PARALLEL_COUNT}× ${MIDNIGHT_PARALLEL_SCRIPT} (derive ${MIDNIGHT_PARALLEL_OFFSET}..$((MIDNIGHT_PARALLEL_OFFSET + MIDNIGHT_PARALLEL_COUNT - 1))) start $(date -Iseconds) ==="
npm run midnight:parallel-cli
T2=$(date +%s)
PAR_S=$((T2 - T1))
TOT_S=$((T2 - T0))
echo "[midnight-bench] === PARALLEL done wall_s=${PAR_S} ==="
echo "[midnight-bench] === TOTAL wall_s=${TOT_S} (fund ${FUND_S}s + parallel ${PAR_S}s) ==="
