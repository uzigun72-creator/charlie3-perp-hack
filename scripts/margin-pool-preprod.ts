/**
 * Preprod demo: bootstrap empty pool UTxO, deposit margin at `margin_vault`, merge into pool.
 *
 * Requires repo-root `.env` with `CARDANO_BACKEND=blockfrost`, `WALLET_MNEMONIC`, Blockfrost Preprod.
 * Run `npm run build:margin-pool` first so `cardano/margin-pool/plutus.json` exists.
 *
 * Usage: `npm run margin-pool:demo`
 */
import "dotenv/config";
import { marginPoolTxExplorerUrl, runMarginPoolDemo } from "../src/cardano/margin_pool_flow.js";

const POOL_BOOTSTRAP_LOVELACE = 5_000_000n;
const MARGIN_DEPOSIT_LOVELACE = 3_000_000n;

async function main(): Promise<void> {
  const steps = await runMarginPoolDemo({
    poolBootstrapLovelace: POOL_BOOTSTRAP_LOVELACE,
    marginDepositLovelace: MARGIN_DEPOSIT_LOVELACE,
  });
  const net = (process.env.CARDANO_NETWORK || "Preprod").trim();
  console.log("[margin-pool-demo] Bootstrap tx:", marginPoolTxExplorerUrl(net, steps.step1));
  console.log("[margin-pool-demo] Margin deposit tx:", marginPoolTxExplorerUrl(net, steps.step2));
  console.log("[margin-pool-demo] Merge tx:", marginPoolTxExplorerUrl(net, steps.step3));
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
