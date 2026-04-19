/**
 * Transaction pages default to [1AM Explorer](https://explorer.1am.xyz) (`/tx/{hash}`).
 * Override with `EXPLORER_BASE` (both chains), or per-chain:
 * `CARDANO_EXPLORER_BASE`, `MIDNIGHT_EXPLORER_BASE` (no trailing slash).
 */

const DEFAULT_EXPLORER_BASE = "https://explorer.1am.xyz";

function explorerBase(...candidates: (string | undefined)[]): string {
  for (const c of candidates) {
    const t = c?.trim();
    if (t) return t.replace(/\/$/, "");
  }
  return DEFAULT_EXPLORER_BASE;
}

/** Cardano L1 transaction link. */
export function cardanoTxExplorerUrl(txHash: string): string {
  const h = txHash.replace(/^0x/i, "").toLowerCase();
  const base = explorerBase(process.env.CARDANO_EXPLORER_BASE, process.env.EXPLORER_BASE);
  return `${base}/tx/${h}`;
}

/** Midnight transaction link. */
export function midnightTxExplorerUrl(txHash: string): string | null {
  const h = txHash.replace(/^0x/i, "").trim().toLowerCase();
  if (!h || h.length < 16) return null;
  const base = explorerBase(process.env.MIDNIGHT_EXPLORER_BASE, process.env.EXPLORER_BASE);
  return `${base}/tx/${h}`;
}
