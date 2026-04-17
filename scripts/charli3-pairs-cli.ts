#!/usr/bin/env npx tsx
/**
 * Multi-pair Charli3 ODV CLI — live Kupo feeds for all configured Preprod pairs.
 *
 * Usage:
 *   npx tsx scripts/charli3-pairs-cli.ts help
 *   npx tsx scripts/charli3-pairs-cli.ts list
 *   npx tsx scripts/charli3-pairs-cli.ts prices [PAIR ...]
 *   npx tsx scripts/charli3-pairs-cli.ts funding [PAIR ...]
 *   npx tsx scripts/charli3-pairs-cli.ts risk [--demo]
 *
 * Env: CHARLI3_KUPO_URL, CHARLI3_MAX_STALENESS_MS, CHARLI3_IGNORE_DATUM_EXPIRY (see .env.example)
 */
import "dotenv/config";
import { listFeedPairIds, feedConfigForPair } from "../src/charli3/config.js";
import { getVerifiedIndexPricesAll } from "../src/charli3/price_feed.js";
import { LiquidationEngine } from "../clearing/liquidation_engine.js";
import { OrderSide } from "../core/types.js";
import {
  fundingPreviewFromOracle,
  scanAtRiskWithCharli3Oracle,
} from "../clearing/risk_oracle.js";

function usage(): void {
  console.log(`charli3-pairs — multi-pair oracle + perps risk (Charli3 ODV on Preprod)

Commands:
  help              Show this message
  list              Configured pair ids and oracle addresses
  prices [PAIR...]  Index/mark from Kupo for all pairs (default) or subset
  funding [PAIR...] Funding-rate preview per pair (mark ≈ index in v1)
  risk [--demo]     Charli3 mark map → scan at-risk positions (optional demo positions)

Examples:
  npx tsx scripts/charli3-pairs-cli.ts prices
  npx tsx scripts/charli3-pairs-cli.ts prices ADA-USD BTC-USD
  npx tsx scripts/charli3-pairs-cli.ts funding USDM-ADA
  npx tsx scripts/charli3-pairs-cli.ts risk --demo
`);
}

function parsePairs(argv: string[]): string[] {
  const out: string[] = [];
  for (const a of argv) {
    if (a === "--demo") continue;
    if (a.startsWith("-")) continue;
    out.push(a);
  }
  return out;
}

function hasDemo(argv: string[]): boolean {
  return argv.includes("--demo");
}

async function cmdList(): Promise<void> {
  for (const id of listFeedPairIds()) {
    const f = feedConfigForPair(id);
    console.log(`${id}`);
    console.log(`  oracle: ${f.oracleAddress}`);
    console.log(`  policy: ${f.policyId}`);
  }
}

async function cmdPrices(pairIds: string[]): Promise<void> {
  const results = await getVerifiedIndexPricesAll(pairIds.length ? pairIds : undefined);
  console.log("pairId\tindex(÷1e6)\ttxHash\toutIx\ttimestampMs");
  for (const r of results) {
    if (!r.ok) {
      console.log(`${r.pairId}\tERROR\t${r.error}`);
      continue;
    }
    const v = r.data;
    console.log(
      `${v.pairId}\t${v.indexPrice}\t${v.outRef.txHash}\t${v.outRef.outputIndex}\t${v.timestampMs}`,
    );
  }
}

async function cmdFunding(pairIds: string[]): Promise<void> {
  const ids = pairIds.length ? pairIds : listFeedPairIds();
  for (const id of ids) {
    feedConfigForPair(id);
  }
  console.log("pairId\tpredictedRate\tspread\tlong$/unit\tshort$/unit");
  for (const id of ids) {
    try {
      const p = await fundingPreviewFromOracle(id);
      console.log(
        `${id}\t${p.predictedRate}\t${p.currentSpread}\t${p.estimatedPaymentPerUnitLong}\t${p.estimatedPaymentPerUnitShort}`,
      );
    } catch (e) {
      console.log(`${id}\tERROR\t${e instanceof Error ? e.message : e}`);
    }
  }
}

async function cmdRisk(argv: string[]): Promise<void> {
  const pairIds = listFeedPairIds();
  const engine = new LiquidationEngine({
    scanIntervalMs: 10_000,
    maintenanceMarginRatioBps: 50,
    liquidationPenaltyBps: 50,
    warningThresholdBps: 100,
    maxConcurrentLiquidations: 8,
  });

  if (hasDemo(argv)) {
    const results = await getVerifiedIndexPricesAll(pairIds);
    for (const r of results) {
      if (!r.ok) continue;
      const m = r.data.markPrice;
      engine.registerOpenPosition({
        positionId: `cli-demo-${r.data.pairId}`,
        traderId: "cli_trader",
        pairId: r.data.pairId,
        side: OrderSide.LONG,
        size: 10,
        entryPrice: m * 1.2,
        markPrice: m,
        leverage: 5,
        margin: 50,
        unrealizedPnl: 0,
        liquidationPrice: m * 0.85,
        openedAt: Date.now(),
      });
    }
  }

  const atRisk = await scanAtRiskWithCharli3Oracle(engine, pairIds);
  console.log("At-risk positions (oracle marks):", atRisk.length);
  for (const row of atRisk) {
    console.log(
      `  ${row.position.pairId} ${row.position.positionId} ratio=${row.currentMarginRatio.toFixed(4)} ${row.riskLevel}`,
    );
  }
  if (atRisk.length === 0 && !hasDemo(argv)) {
    console.log("(no registered positions — pass --demo to register stressed longs per pair)");
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0]?.toLowerCase() || "help";
  const rest = argv.slice(1);

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }
  if (cmd === "list") {
    await cmdList();
    return;
  }
  if (cmd === "prices") {
    await cmdPrices(parsePairs(rest));
    return;
  }
  if (cmd === "funding") {
    await cmdFunding(parsePairs(rest));
    return;
  }
  if (cmd === "risk") {
    await cmdRisk(rest);
    return;
  }
  console.error(`Unknown command: ${cmd}\n`);
  usage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
