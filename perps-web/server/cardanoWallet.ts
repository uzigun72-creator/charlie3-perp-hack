import { createAppLucid } from "../../src/cardano/lucid_wallet.js";
import { blockfrostConfig, cardanoBackend } from "../../src/config/cardano_env.js";

export type CardanoWalletSummary =
  | {
      ok: true;
      address: string;
      lovelace: string;
      ada: string;
      network: string;
    }
  | { ok: false; error: string };

async function blockfrostLovelaceForAddress(address: string): Promise<
  | { ok: true; lovelace: string; ada: string }
  | { ok: false; error: string }
> {
  const { url, projectId } = blockfrostConfig();
  const pathAddr = encodeURIComponent(address);
  const r = await fetch(`${url}/addresses/${pathAddr}`, {
    headers: { project_id: projectId },
  });
  if (r.status === 404) {
    return { ok: true, lovelace: "0", ada: "0.000000" };
  }
  if (!r.ok) {
    const t = await r.text();
    return { ok: false, error: `Blockfrost ${r.status}: ${t.slice(0, 200)}` };
  }
  const j = (await r.json()) as {
    amount?: Array<{ unit: string; quantity: string }>;
  };
  const lovelace = j.amount?.find((a) => a.unit === "lovelace")?.quantity ?? "0";
  const adaN = Number(lovelace) / 1e6;
  const ada = Number.isFinite(adaN) ? adaN.toFixed(6) : "0";
  return { ok: true, lovelace, ada };
}

/**
 * Wallet from `WALLET_MNEMONIC` (same as settlement / Charli3 pull txs).
 * Balance via Blockfrost address endpoint.
 */
export async function getCardanoWalletSummary(): Promise<CardanoWalletSummary> {
  try {
    if (cardanoBackend() !== "blockfrost") {
      return {
        ok: false,
        error: "Set CARDANO_BACKEND=blockfrost and configure Blockfrost for the wallet dashboard.",
      };
    }
    const lucid = await createAppLucid();
    const address = await lucid.wallet().address();
    const bal = await blockfrostLovelaceForAddress(address);
    if (!bal.ok) return { ok: false, error: bal.error };
    const network = (process.env.CARDANO_NETWORK || "Preprod").trim();
    return {
      ok: true,
      address,
      lovelace: bal.lovelace,
      ada: bal.ada,
      network,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
