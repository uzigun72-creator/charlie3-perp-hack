import { createAppLucid, type AppLucid } from "./lucid_wallet.js";
import { cardanoBackend } from "../config/cardano_env.js";
import { charli3KupoUrl, feedConfigForPair } from "../charli3/config.js";
import { listUnspentC3asMatches } from "../charli3/kupo_client.js";

function explorerTxUrl(txHash: string): string {
  const h = txHash.replace(/^0x/i, "").toLowerCase();
  const base = (
    process.env.CARDANO_EXPLORER_BASE?.trim() ||
    process.env.EXPLORER_BASE?.trim() ||
    "https://explorer.1am.xyz"
  ).replace(/\/$/, "");
  return `${base}/tx/${h}`;
}

/** Submit Preprod tx that `readFrom` latest C3AS oracle UTxO for the pair. */
export async function submitCharli3OracleReferenceTx(
  pairId: string,
  opts?: { lucid?: AppLucid },
): Promise<{ txHash: string; explorerUrl: string; oracleRef: { txHash: string; outputIndex: number } }> {
  if (cardanoBackend() !== "blockfrost") {
    throw new Error("submitCharli3OracleReferenceTx requires CARDANO_BACKEND=blockfrost");
  }
  const feed = feedConfigForPair(pairId);
  const kupo = charli3KupoUrl();
  const matches = await listUnspentC3asMatches(kupo, feed);
  if (matches.length === 0) {
    throw new Error(`No unspent C3AS UTxOs for ${pairId}`);
  }
  let best = matches[0]!;
  for (const m of matches) {
    if (m.created_at.slot_no > best.created_at.slot_no) best = m;
  }

  const lucid = opts?.lucid ?? (await createAppLucid());
  const refs = await lucid.utxosByOutRef([
    { txHash: best.transaction_id, outputIndex: best.output_index },
  ]);
  if (refs.length === 0) {
    throw new Error("Blockfrost could not resolve oracle UTxO (CARDANO_NETWORK=Preprod?)");
  }
  const oracleUtxo = refs[0]!;
  const addr = await lucid.wallet().address();
  const signed = await lucid
    .newTx()
    .readFrom([oracleUtxo])
    .pay.ToAddress(addr, { lovelace: 1_000_000n })
    .complete()
    .then((x) => x.sign.withWallet().complete());

  const txHash = await signed.submit();
  return {
    txHash,
    explorerUrl: explorerTxUrl(txHash),
    oracleRef: { txHash: best.transaction_id, outputIndex: best.output_index },
  };
}
