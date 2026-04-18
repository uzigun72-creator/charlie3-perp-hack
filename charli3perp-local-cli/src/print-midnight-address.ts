/**
 * Print Midnight unshielded + shielded addresses for `deriveKeysAt` — no chain sync (keys-only shielded).
 *
 *   MIDNIGHT_DEPLOY_NETWORK=preview BIP39_MNEMONIC="…" npx tsx src/print-midnight-address.ts
 *
 * Funder in `fund-derived-wallets` uses `MIDNIGHT_FUNDER_INDEX` (default `0`). Same as `MIDNIGHT_DERIVE_KEY_INDEX` if set.
 *
 * Without BIP39_MNEMONIC: generates a new 24-word phrase and prints it (save immediately).
 */
import "./load_repo_env.js";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import { Charli3perpMidnightConfig } from "./config.js";
import { deriveMidnightReceiveAddressesFromSeed } from "./wallet.js";

function parseDeriveIndex(): number {
  const raw =
    process.env.MIDNIGHT_FUNDER_INDEX?.trim() ||
    process.env.MIDNIGHT_DERIVE_KEY_INDEX?.trim() ||
    "0";
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    console.error("MIDNIGHT_FUNDER_INDEX / MIDNIGHT_DERIVE_KEY_INDEX must be a non-negative integer");
    process.exit(1);
  }
  return n;
}

async function main(): Promise<void> {
  const config = new Charli3perpMidnightConfig();
  const deriveKeysAt = parseDeriveIndex();

  let mnemonic = process.env.BIP39_MNEMONIC?.trim();
  let generated = false;
  if (!mnemonic) {
    mnemonic = bip39.generateMnemonic(256);
    generated = true;
  }
  if (!bip39.validateMnemonic(mnemonic)) {
    console.error("Invalid BIP39_MNEMONIC");
    process.exit(1);
  }

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const derived = await deriveMidnightReceiveAddressesFromSeed(seed, config, deriveKeysAt);

  const faucet =
    config.networkId === "preview"
      ? "https://faucet.preview.midnight.network"
      : config.networkId === "preprod"
        ? "https://faucet.preprod.midnight.network"
        : "local / undeployed faucet (see Midnight docs)";

  console.log(
    JSON.stringify(
      {
        midnightNetworkId: config.networkId,
        deriveKeysAt,
        role: deriveKeysAt === 0 ? "typical funder (MIDNIGHT_FUNDER_INDEX default)" : "derived identity",
        unshieldedAddress: derived.unshieldedStr,
        shieldedAddress: derived.shieldedStr,
        ...(generated ? { generatedMnemonic24: mnemonic } : {}),
        note: `Fund tNIGHT at unshielded via ${faucet} (funder slot is usually deriveKeysAt 0).`,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
