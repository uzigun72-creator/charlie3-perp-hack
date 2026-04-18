/**
 * Sync + persist Midnight wallet state for HD-derived worker indices (default **1–5**), matching
 * perps `midnightParallelEnvForDeriveIndex` + worker pool so `run-pipeline` loads fast from
 * `.midnight-wallet-state/` on the next run.
 *
 * Runs **sequentially** (each worker gets isolated `process.env` for private-state DB names).
 * Does **not** transfer funds — use `fund-derived-wallets` if workers need tNIGHT/DUST.
 *
 * Env:
 * - `BIP39_MNEMONIC`, `MIDNIGHT_DEPLOY_NETWORK=preview` (or preprod)
 * - `MIDNIGHT_SYNC_DERIVE_INDICES` — comma-separated (default `1,2,3,4,5`)
 */
import "./load_repo_env.js";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import { Charli3perpMidnightConfig } from "./config.js";
import { initWalletWithSeed, persistMidnightWalletState, type WalletContext } from "./wallet.js";
import { midnightParallelEnvForDeriveIndex } from "./midnight_parallel_env.js";
import { ensureDustReady } from "./dust.js";
import { waitForWalletSyncedWithHeartbeat } from "./wait_wallet_sync.js";

function mnemonicFromEnv(): string {
  const m = process.env.BIP39_MNEMONIC?.trim();
  if (!m || !bip39.validateMnemonic(m)) {
    console.error("Set valid BIP39_MNEMONIC (same seed as perps API).");
    process.exit(2);
  }
  return m;
}

function parseIndices(): number[] {
  const raw = process.env.MIDNIGHT_SYNC_DERIVE_INDICES?.trim() || "1,2,3,4,5";
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  const out = parts.filter((n) => Number.isFinite(n) && n >= 0);
  if (out.length === 0) {
    console.error("MIDNIGHT_SYNC_DERIVE_INDICES must list integers (e.g. 1,2,3,4,5)");
    process.exit(2);
  }
  return out;
}

async function syncOne(seed: Buffer, idx: number): Promise<void> {
  Object.assign(process.env, midnightParallelEnvForDeriveIndex(idx));
  const config = new Charli3perpMidnightConfig();
  console.log(`[midnight-sync-derived] deriveKeysAt(${idx}) — sync + DUST + persist…`);
  const ctx: WalletContext = await initWalletWithSeed(seed, config, { deriveKeyIndex: idx });
  await waitForWalletSyncedWithHeartbeat(ctx.wallet);
  await ensureDustReady(ctx, { timeoutMs: 300_000 });
  await persistMidnightWalletState(ctx);
  await ctx.wallet.stop();
  console.log(`[midnight-sync-derived] deriveKeysAt(${idx}) done.`);
}

async function main(): Promise<void> {
  const indices = parseIndices();
  const mnemonic = mnemonicFromEnv();
  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));

  console.log(
    `[midnight-sync-derived] indices=${indices.join(",")} — ` +
      `cache: MIDNIGHT_WALLET_STATE_DIR or repo .midnight-wallet-state/`,
  );

  for (const idx of indices) {
    await syncOne(seed, idx);
  }

  console.log(
    "[midnight-sync-derived] All requested wallets synced and stored. Perps round-robin workers should resume faster.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
