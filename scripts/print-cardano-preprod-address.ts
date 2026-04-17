/** Print Base address for WALLET_MNEMONIC (Preprod when CARDANO_NETWORK=Preprod). */
import "dotenv/config";
import { createAppLucid } from "../src/cardano/lucid_wallet.js";

(async () => {
  const lucid = await createAppLucid();
  console.log(await lucid.wallet().address());
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
