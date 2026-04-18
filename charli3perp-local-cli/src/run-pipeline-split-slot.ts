/**
 * Single slot (0..4) of the split pipeline — used by parallel `run-pipeline-split-all` subprocesses.
 *
 * Env: `MIDNIGHT_SPLIT_SLOT` (required 0..4), `MIDNIGHT_SPLIT_BASE_INDEX` (HD base, default 0),
 * same `BIP39_MNEMONIC` / `C3PERP_*` as the parent split runner.
 */
import "./load_repo_env.js";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import { loadSplitWitnessInputsFromEnv, runSplitPipelineSlot } from "./run_pipeline_split_slot_impl.js";
import { ensureProofServerPortReachable, printProvingFailureHints } from "./proof_server_preflight.js";

async function main(): Promise<void> {
  const slot = Number.parseInt(process.env.MIDNIGHT_SPLIT_SLOT ?? "-1", 10);
  const base = Number.parseInt(process.env.MIDNIGHT_SPLIT_BASE_INDEX ?? "0", 10);
  if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
    console.error("Set MIDNIGHT_SPLIT_SLOT to 0..4");
    process.exit(1);
  }
  if (!Number.isInteger(base) || base < 0) {
    console.error("Set MIDNIGHT_SPLIT_BASE_INDEX to a non-negative integer");
    process.exit(1);
  }

  const mnemonic = process.env.BIP39_MNEMONIC;
  if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
    console.error("Set valid BIP39_MNEMONIC");
    process.exit(1);
  }

  const proofPort = Number.parseInt(process.env.PROOF_SERVER_PORT ?? "6300", 10);
  const proofServer = process.env.MIDNIGHT_PROOF_SERVER?.trim() || `http://127.0.0.1:${proofPort}`;
  console.log(`[split-slot ${slot}] Proof server: ${proofServer}`);
  await ensureProofServerPortReachable(proofServer);

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const w = loadSplitWitnessInputsFromEnv();
  await runSplitPipelineSlot(seed, base, slot, w);
  console.log(`[split-slot ${slot}] done.`);
}

main().catch((e) => {
  console.error(e);
  printProvingFailureHints(e);
  process.exit(1);
});
