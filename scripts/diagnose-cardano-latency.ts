/**
 * Read-only Cardano + oracle latency (no Midnight, no tx submit).
 * Usage: npx tsx scripts/diagnose-cardano-latency.ts
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getVerifiedIndexPrice } from "../src/charli3/price_feed.js";
import { charli3KupoUrl, feedConfigForPair } from "../src/charli3/config.js";
import { listUnspentC3asMatches } from "../src/charli3/kupo_client.js";
import { createAppLucid } from "../src/cardano/lucid_wallet.js";

const here = dirname(fileURLToPath(import.meta.url));
config({ path: join(here, "../.env") });

function ms(t0: number): string {
  return `${Date.now() - t0}ms`;
}

async function main(): Promise<void> {
  const t0 = Date.now();
  console.log("[diagnose-cardano] starting (no tx submit)…\n");

  const t1 = Date.now();
  const oracle = await getVerifiedIndexPrice("ADA-USD");
  console.log(`[diagnose-cardano] getVerifiedIndexPrice: ${ms(t1)} (mark≈${oracle.markPrice})`);

  const t2 = Date.now();
  const kupo = charli3KupoUrl();
  const feed = feedConfigForPair("ADA-USD");
  const matches = await listUnspentC3asMatches(kupo, feed);
  console.log(
    `[diagnose-cardano] listUnspentC3asMatches (Kupo): ${ms(t2)} (${matches.length} UTxO candidates)`,
  );

  const t3 = Date.now();
  await createAppLucid();
  console.log(`[diagnose-cardano] createAppLucid: ${ms(t3)}`);

  console.log(`\n[diagnose-cardano] total wall: ${ms(t0)}`);
  console.log(
    "Note: Full trade time is dominated by Midnight CLI (run-pipeline-split), not these steps.\n" +
      "  Set PERPS_PIPELINE_TIMING=1 when running the API to log midnight vs charli3_pull vs anchor.",
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
