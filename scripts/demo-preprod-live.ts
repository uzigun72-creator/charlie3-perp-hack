/**
 * Live Preprod demo: Charli3 oracle price → liquidation risk scan + funding preview.
 * No synthetic prices — reads ODV aggregate from Kupo.
 *
 *   CARDANO_BACKEND=blockfrost  # only needed for cardano:charli3-pull step
 *   npx tsx scripts/demo-preprod-live.ts
 */
import "dotenv/config";
import { LiquidationEngine } from "../clearing/liquidation_engine.js";
import type { Position } from "../core/types.js";
import { OrderSide } from "../core/types.js";
import {
  assessPositionWithOracle,
  fundingPreviewFromOracle,
  scanAtRiskWithCharli3Oracle,
} from "../clearing/risk_oracle.js";
import { getVerifiedIndexPrice } from "../src/charli3/price_feed.js";

const pairId = process.env.CHARLI3_PAIR_ID?.trim() || "ADA-USD";

async function main(): Promise<void> {
  const v = await getVerifiedIndexPrice(pairId);
  console.log("Charli3 ODV feed", pairId);
  console.log("  index/mark (scaled /1e6):", v.indexPrice);
  console.log("  outRef:", v.outRef.txHash, v.outRef.outputIndex);
  console.log("  timestampMs:", v.timestampMs, "expiryMs:", v.expiryMs);

  const preview = await fundingPreviewFromOracle(pairId);
  console.log("Funding preview (mark≈index in v1):");
  console.log("  predictedRate:", preview.predictedRate);
  console.log("  spread:", preview.currentSpread);

  const engine = new LiquidationEngine({
    scanIntervalMs: 10_000,
    maintenanceMarginRatioBps: 50,
    liquidationPenaltyBps: 50,
    warningThresholdBps: 100,
    maxConcurrentLiquidations: 4,
  });

  const stress: Position = {
    positionId: "demo-stress-1",
    traderId: "addr_demo",
    pairId,
    side: OrderSide.LONG,
    size: 100,
    entryPrice: v.markPrice * 1.5,
    markPrice: v.markPrice,
    leverage: 10,
    margin: 100,
    unrealizedPnl: 0,
    liquidationPrice: v.markPrice * 0.9,
    openedAt: Date.now(),
  };
  engine.registerOpenPosition(stress);

  const atRisk = await scanAtRiskWithCharli3Oracle(engine, [pairId]);
  console.log("At-risk positions (oracle marks):", atRisk.length);

  const assessed = await assessPositionWithOracle(engine, stress);
  console.log("Stress position margin ratio:", assessed.currentMarginRatio, "level:", assessed.riskLevel);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
