/** Cardano explorer links for Preprod / Preview testnets. */
export function cardanoTxExplorerUrl(txHash: string): string {
  const h = txHash.replace(/^0x/i, "").toLowerCase();
  const net = (process.env.CARDANO_NETWORK || "Preprod").toLowerCase();
  if (net === "preview") {
    return `https://preview.cardanoscan.io/transaction/${h}`;
  }
  return `https://preprod.cardanoscan.io/transaction/${h}`;
}

/**
 * Midnight Preview transaction page.
 * Override base with `MIDNIGHT_EXPLORER_BASE` (no trailing slash), e.g. `https://preview.midnightexplorer.com`.
 */
export function midnightTxExplorerUrl(txHash: string): string | null {
  const h = txHash.replace(/^0x/i, "").trim().toLowerCase();
  if (!h || h.length < 16) return null;
  const base = (process.env.MIDNIGHT_EXPLORER_BASE || "https://preview.midnightexplorer.com").replace(
    /\/$/,
    "",
  );
  return `${base}/tx/${h}`;
}
