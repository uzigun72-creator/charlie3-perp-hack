/**
 * Print NIGHT balances for a synced wallet (same seed + network as other CLIs).
 *
 *   MIDNIGHT_DEPLOY_NETWORK=preview BIP39_MNEMONIC="…" npx tsx src/midnight-wallet-balance.ts
 *
 * Uses `MIDNIGHT_DERIVE_KEY_INDEX` (default 0) for HD `deriveKeysAt`.
 */
import "./load_repo_env.js";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import * as rx from "rxjs";
import { Charli3perpMidnightConfig } from "./config.js";
import { deriveKeyIndexFromEnv, initWalletWithSeed } from "./wallet.js";
import { waitForWalletSyncedWithHeartbeat } from "./wait_wallet_sync.js";

const NIGHT_RAW_SCALE = 1_000_000_000n;

function nightLabel(raw: bigint): string {
  const whole = raw / NIGHT_RAW_SCALE;
  const frac = raw % NIGHT_RAW_SCALE;
  if (frac === 0n) return `${whole} NIGHT`;
  return `${whole}.${frac.toString().padStart(9, "0").replace(/0+$/, "")} NIGHT`;
}

async function main(): Promise<void> {
  const mnemonic = process.env.BIP39_MNEMONIC?.trim();
  if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
    console.error("Set valid BIP39_MNEMONIC.");
    process.exit(2);
  }
  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const deriveKeyIndex = deriveKeyIndexFromEnv();
  const config = new Charli3perpMidnightConfig();

  const ctx = await initWalletWithSeed(seed, config, { deriveKeyIndex });
  await waitForWalletSyncedWithHeartbeat(ctx.wallet);

  const st = await rx.firstValueFrom(ctx.wallet.state().pipe(rx.filter((s) => s.isSynced), rx.take(1)));
  const rawU = ledger.unshieldedToken().raw;
  const rawS = ledger.shieldedToken().raw;
  const un = st.unshielded.balances[rawU] ?? 0n;
  const sh = st.shielded.balances[rawS] ?? 0n;

  const out = {
    networkId: config.networkId,
    deriveKeysAt: deriveKeyIndex,
    unshieldedRaw: un.toString(),
    shieldedRaw: sh.toString(),
    unshieldedNIGHT: nightLabel(un),
    shieldedNIGHT: nightLabel(sh),
    note: "Transfers use unshielded pool for tNIGHT outputs and shielded pool for shielded outputs; sum is not a single spendable balance.",
  };
  console.log(JSON.stringify(out, null, 2));

  await ctx.wallet.stop();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
