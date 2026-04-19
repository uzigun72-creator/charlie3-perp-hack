/**
 * Five-contract pipeline with **one HD-derived wallet per contract** (derive index = base + slot, slot 0..4).
 * Each segment: sync, DUST, deploy+prove for **that** contract only, persist, stop.
 *
 * **Parallel (default):** five **subprocesses** run concurrently (`MIDNIGHT_SPLIT_PARALLEL` unset or `1`),
 * each with its own wallet + private state — matches perps API expectation (5 wallets × 5 contracts).
 * **Sequential:** set `MIDNIGHT_SPLIT_PARALLEL=0` (one process, easier debugging).
 *
 * Env:
 * - `BIP39_MNEMONIC`, same `C3PERP_*` / witness env as `run-pipeline-all.ts`
 * - `MIDNIGHT_DERIVE_KEY_INDEX` — **base** index (default 0); slots use base…base+4
 * - `MIDNIGHT_SPLIT_PARALLEL` — `1` (default) parallel subprocesses; `0` sequential in-process
 */
import "./load_repo_env.js";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import { deriveKeyIndexFromEnv } from "./wallet.js";
import { loadSplitWitnessInputsFromEnv, runSplitPipelineSlot } from "./run_pipeline_split_slot_impl.js";
import { ensureProofServerPortReachable, printProvingFailureHints } from "./proof_server_preflight.js";
import { spawnSplitSlotProcess } from "./split_parallel_spawn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function splitParallelFromEnv(): boolean {
  const v = process.env.MIDNIGHT_SPLIT_PARALLEL?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

async function runFiveSlotsParallelSubprocesses(base: number): Promise<void> {
  console.log(
    `[run-pipeline-split] parallel: 5 concurrent workers deriveKeysAt(${base})…(${base + 4}) (node+tsx per slot, not npm — avoids npm global lock)`,
  );
  const tasks = [0, 1, 2, 3, 4].map(
    (slot) =>
      new Promise<void>((resolve, reject) => {
        const env = {
          ...process.env,
          MIDNIGHT_SPLIT_SLOT: String(slot),
          MIDNIGHT_SPLIT_BASE_INDEX: String(base),
        };
        const child = spawnSplitSlotProcess({ env, stdio: "inherit" });
        child.on("error", reject);
        child.on("close", (code) =>
          code === 0 ? resolve() : reject(new Error(`split slot ${slot} exit ${code}`)),
        );
      }),
  );
  await Promise.all(tasks);
}

async function main(): Promise<void> {
  const mnemonic = process.env.BIP39_MNEMONIC;
  if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
    console.error("Set valid BIP39_MNEMONIC");
    process.exit(1);
  }

  const proofPort = Number.parseInt(process.env.PROOF_SERVER_PORT ?? "6300", 10);
  const proofServer = process.env.MIDNIGHT_PROOF_SERVER?.trim() || `http://127.0.0.1:${proofPort}`;
  console.log(`Proof server: ${proofServer}`);
  await ensureProofServerPortReachable(proofServer);

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const base = deriveKeyIndexFromEnv();
  const w = loadSplitWitnessInputsFromEnv();

  if (splitParallelFromEnv()) {
    await runFiveSlotsParallelSubprocesses(base);
  } else {
    console.log("[run-pipeline-split] sequential mode (MIDNIGHT_SPLIT_PARALLEL=0)");
    for (let slot = 0; slot < 5; slot++) {
      await runSplitPipelineSlot(seed, base, slot, w);
    }
  }

  console.log("\nDone. Five-contract split pipeline (5 wallets × 5 segments) submitted.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  printProvingFailureHints(e);
  process.exit(1);
});
