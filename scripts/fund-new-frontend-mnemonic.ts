/**
 * Generates a fresh BIP39 mnemonic, writes `VITE_BIP39_MNEMONIC` to `perps-web/.env`,
 * and sends Preprod tADA from `WALLET_MNEMONIC` (repo-root `.env`) to the Cardano
 * base address derived from that new mnemonic.
 *
 * Usage: `npm run fund:frontend-mnemonic` or `npm run fund:frontend-mnemonic -- 5000000` (lovelace)
 */
import "dotenv/config";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import bip39 from "bip39";
import { Blockfrost, Lucid, walletFromSeed } from "@lucid-evolution/lucid";
import { blockfrostConfig, walletMnemonic } from "../src/config/cardano_env.js";

const DEFAULT_LOVELACE = 10_000_000n;

async function main() {
  const lovelace = process.argv[2]
    ? BigInt(process.argv[2])
    : DEFAULT_LOVELACE;

  const newMnemonic = bip39.generateMnemonic(256);
  const perpsEnvPath = join(process.cwd(), "perps-web", ".env");
  let perpsEnv = "";
  try {
    perpsEnv = readFileSync(perpsEnvPath, "utf8");
  } catch {
    // new file
  }
  const line = `VITE_BIP39_MNEMONIC="${newMnemonic}"`;
  if (/^VITE_BIP39_MNEMONIC=/m.test(perpsEnv)) {
    perpsEnv = perpsEnv.replace(/^VITE_BIP39_MNEMONIC=.*$/m, line);
  } else {
    perpsEnv =
      perpsEnv.trimEnd() + (perpsEnv.trimEnd() ? "\n" : "") + line + "\n";
  }
  writeFileSync(perpsEnvPath, perpsEnv, "utf8");
  console.log("Wrote VITE_BIP39_MNEMONIC to perps-web/.env");

  const c = blockfrostConfig();
  const lucid = await Lucid(new Blockfrost(c.url, c.projectId), c.network);
  lucid.selectWallet.fromSeed(walletMnemonic().trim(), {
    addressType: "Base",
    accountIndex: 0,
  });

  const recipient = walletFromSeed(newMnemonic, {
    network: c.network,
    addressType: "Base",
    accountIndex: 0,
  });

  console.log("Recipient (Cardano Preprod):", recipient.address);
  console.log("Sending lovelace:", lovelace.toString());

  const signed = await lucid
    .newTx()
    .pay.ToAddress(recipient.address, { lovelace })
    .complete()
    .then((x) => x.sign.withWallet().complete());
  const txHash = await signed.submit();
  console.log("Submitted:", txHash);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
