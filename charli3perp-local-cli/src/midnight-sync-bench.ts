/**
 * One-off: `npx tsx src/midnight-sync-bench.ts` — wall time until `waitForSyncedState` (derive index 0).
 * Uses repo-root `.env` via `load_repo_env`.
 */
import "./load_repo_env.js";
import { performance } from "node:perf_hooks";
import * as bip39 from "bip39";
import { Buffer } from "buffer";
import { Charli3perpMidnightConfig } from "./config.js";
import { initWalletWithSeed } from "./wallet.js";
import { waitForWalletSyncedWithHeartbeat } from "./wait_wallet_sync.js";

async function main(): Promise<void> {
  const m = process.env.BIP39_MNEMONIC?.trim();
  if (!m || !bip39.validateMnemonic(m)) {
    console.error("Set BIP39_MNEMONIC in repo-root .env");
    process.exit(2);
  }
  const config = new Charli3perpMidnightConfig();
  const bf = config.indexer.includes("blockfrost");
  console.log(
    `[sync-bench] network=${config.deployNetwork} blockfrostIndexer=${bf} indexer=${config.indexer.slice(0, 96)}…`,
  );
  console.log(`[sync-bench] indexerWS=${config.indexerWS.slice(0, 96)}…`);
  console.log(`[sync-bench] relayHttpOrigin=${config.relayHttpOrigin.slice(0, 120)}`);
  const seed = Buffer.from(await bip39.mnemonicToSeed(m));
  const t0 = performance.now();
  const ctx = await initWalletWithSeed(seed, config, { deriveKeyIndex: 0 });
  await waitForWalletSyncedWithHeartbeat(ctx.wallet);
  await ctx.wallet.stop();
  const ms = performance.now() - t0;
  console.log(`[sync-bench] SYNC_WALL_MS=${Math.round(ms)} (${(ms / 1000).toFixed(1)}s)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
