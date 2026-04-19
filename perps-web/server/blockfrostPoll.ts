import { blockfrostConfig } from "../../src/config/cardano_env.js";

/** True if `txHash` looks like a 64-char Cardano tx id (no RPC call). */
export function hasValidCardanoTxHash(txHash: string): boolean {
  const h = txHash.replace(/^0x/i, "").toLowerCase().trim();
  return h.length === 64 && /^[0-9a-f]+$/.test(h);
}

export async function blockfrostTxVisible(txHash: string): Promise<boolean> {
  const h = txHash.replace(/^0x/i, "").toLowerCase();
  if (h.length !== 64 || !/^[0-9a-f]+$/.test(h)) return false;
  try {
    const { url, projectId } = blockfrostConfig();
    const r = await fetch(`${url}/txs/${h}`, {
      headers: { project_id: projectId },
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Defaults from `PERPS_BF_POLL_MAX_MS` / `PERPS_BF_POLL_STEP_MS` (faster confirmation polling). */
export function defaultBfPollOpts(): { maxWaitMs: number; stepMs: number } {
  const maxWaitMs = Math.max(
    5000,
    Number.parseInt(process.env.PERPS_BF_POLL_MAX_MS || "120000", 10) || 120_000,
  );
  const stepMs = Math.max(
    400,
    Number.parseInt(process.env.PERPS_BF_POLL_STEP_MS || "1500", 10) || 1500,
  );
  return { maxWaitMs, stepMs };
}

/** Poll until tx appears or timeout (mempool settled on-chain). */
export async function waitForTxVisible(
  txHash: string,
  opts: { maxWaitMs?: number; stepMs?: number } = {},
): Promise<boolean> {
  const d = defaultBfPollOpts();
  const maxWaitMs = opts.maxWaitMs ?? d.maxWaitMs;
  const stepMs = opts.stepMs ?? d.stepMs;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await blockfrostTxVisible(txHash)) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return blockfrostTxVisible(txHash);
}

/**
 * When `PERPS_REQUIRE_CARDANO_TX_VISIBILITY=1`, poll Blockfrost until txs appear.
 * Otherwise (default): trust submitted hashes — confirm as soon as we have valid 64-hex ids (faster API / UX).
 */
export async function cardanoConfirmFromHashesOrVisibility(
  pullTxHash: string,
  anchorTxHash: string,
): Promise<{ pullOk: boolean; anchorOk: boolean }> {
  if ((process.env.PERPS_REQUIRE_CARDANO_TX_VISIBILITY ?? "").trim() === "1") {
    return {
      pullOk: await waitForTxVisible(pullTxHash),
      anchorOk: await waitForTxVisible(anchorTxHash),
    };
  }
  return {
    pullOk: hasValidCardanoTxHash(pullTxHash),
    anchorOk: hasValidCardanoTxHash(anchorTxHash),
  };
}
