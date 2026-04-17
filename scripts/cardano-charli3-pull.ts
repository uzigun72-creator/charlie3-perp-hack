/**
 * Submit a **Preprod** transaction that **references** the latest Charli3 ODV C3AS oracle UTxO
 * (`readFrom`) so the oracle datum is included in the transaction witness — pull-oracle pattern
 * for integrators (see Charli3 datum-demo / docs).
 *
 * Requires: CARDANO_BACKEND=blockfrost, WALLET_MNEMONIC, BLOCKFROST_PROJECT_ID, live Kupo.
 *
 * Usage:
 *   CHARLI3_PAIR_ID=ADA-USD npx tsx scripts/cardano-charli3-pull.ts
 */
import "dotenv/config";
import { cardanoBackend } from "../src/config/cardano_env.js";
import { submitCharli3OracleReferenceTx } from "../src/cardano/charli3_pull_tx.js";

async function main(): Promise<void> {
  if (cardanoBackend() !== "blockfrost") {
    throw new Error("cardano-charli3-pull requires CARDANO_BACKEND=blockfrost (live Preprod).");
  }
  const pairId = process.env.CHARLI3_PAIR_ID?.trim() || "ADA-USD";
  const { txHash, explorerUrl, oracleRef } = await submitCharli3OracleReferenceTx(pairId);
  console.log("pairId=", pairId);
  console.log("oracle_ref=", oracleRef.txHash, oracleRef.outputIndex);
  console.log("txHash=", txHash);
  console.log("explorer=", explorerUrl);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
