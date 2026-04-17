#!/usr/bin/env npx tsx
/**
 * Charli3 oracle → L1 anchor digest → **off-chain witness builder** → env for five-contract Midnight pipeline.
 *
 * Does not run wallet txs unless invoked with `run` (spawns `npm run midnight:run-pipeline`).
 *
 * Env:
 *   C3PERP_BID_ORDER_JSON  — JSON OrderCommitmentInput (bid leg)
 *   C3PERP_ASK_ORDER_JSON  — JSON OrderCommitmentInput (ask leg)
 *   CHARLI3 pair (default ADA-USD via PAIR const)
 *
 * Usage:
 *   npx tsx scripts/trade-pipeline-orchestrator.ts print-env   # fetch oracle + print export lines
 *   npx tsx scripts/trade-pipeline-orchestrator.ts run          # print-env + run-pipeline (Preview wallet)
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getVerifiedIndexPrice } from "../src/charli3/price_feed.js";
import { l1AnchorHexFromOracle } from "../src/charli3/l1_anchor_digest.js";
import {
  buildPipelineWitnessEnv,
  parseOrderCommitmentJson,
} from "../src/pipeline/witness_builder.js";
import { orderCommitmentHex } from "../src/order/commitment.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAIR = process.env.C3PERP_PAIR_ID?.trim() || "ADA-USD";

function loadLegs(): { bidJson: string; askJson: string } {
  const bidJson = process.env.C3PERP_BID_ORDER_JSON?.trim();
  const askJson = process.env.C3PERP_ASK_ORDER_JSON?.trim();
  if (!bidJson || !askJson) {
    throw new Error(
      "Set C3PERP_BID_ORDER_JSON and C3PERP_ASK_ORDER_JSON to JSON strings of OrderCommitmentInput (see src/order/commitment.ts fields).",
    );
  }
  return { bidJson, askJson };
}

async function buildEnv(): Promise<Record<string, string>> {
  const { bidJson, askJson } = loadLegs();
  const bid = parseOrderCommitmentJson(bidJson);
  const ask = parseOrderCommitmentJson(askJson);
  const oracle = await getVerifiedIndexPrice(PAIR);
  const l1 = l1AnchorHexFromOracle(oracle);
  const witnesses = buildPipelineWitnessEnv({ bid, ask, oracle });
  const orderHex = orderCommitmentHex(bid);
  return {
    C3PERP_L1_ANCHOR_HEX: l1,
    C3PERP_ORDER_COMMITMENT_HEX: orderHex,
    ...witnesses,
  };
}

function printExport(env: Record<string, string>): void {
  console.log("\n# Paste into shell or .env for midnight:run-pipeline:\n");
  for (const [k, v] of Object.entries(env)) {
    console.log(`export ${k}=${v}`);
  }
  console.log("");
}

async function main(): Promise<void> {
  const cmd = process.argv[2] || "print-env";
  const envFragment = await buildEnv();
  printExport(envFragment);

  if (cmd === "print-env" || cmd === "env") {
    console.log("Oracle + witness env printed. Run `… orchestrator.ts run` to execute Midnight pipeline.");
    return;
  }

  if (cmd === "run") {
    const merged: NodeJS.ProcessEnv = {
      ...process.env,
      ...envFragment,
      MIDNIGHT_DEPLOY_NETWORK: process.env.MIDNIGHT_DEPLOY_NETWORK || "preview",
    };
    console.log("\n--- Spawning: npm run run-pipeline -w @charli3perp/cli ---\n");
    await new Promise<void>((resolve, reject) => {
      const child = spawn("npm", ["run", "run-pipeline", "-w", "@charli3perp/cli"], {
        cwd: ROOT,
        env: merged,
        stdio: "inherit",
        shell: false,
      });
      child.on("error", reject);
      child.on("close", (code) => {
        if (code !== 0) reject(new Error(`run-pipeline exited with ${code}`));
        else resolve();
      });
    });
    console.log("\n[pipeline-orchestrator] Done.");
    return;
  }

  console.error("Usage: print-env | run");
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
