import type { Position, PriceData } from "../core/types.js";
import { getVerifiedIndexPrice, verifiedToPriceData } from "../src/charli3/price_feed.js";
import type { LiquidationEngine } from "./liquidation_engine.js";
import { predictNextFundingRate, type FundingRatePrediction } from "./funding_rate.js";

/**
 * Build mark prices from live Charli3 ODV feeds for all given pair ids.
 */
export async function oracleMarkPricesForPairs(pairIds: string[]): Promise<Map<string, number>> {
  const m = new Map<string, number>();
  for (const pid of pairIds) {
    const v = await getVerifiedIndexPrice(pid);
    m.set(pid, v.markPrice);
  }
  return m;
}

export async function oraclePriceData(pairId: string): Promise<PriceData> {
  const v = await getVerifiedIndexPrice(pairId);
  return verifiedToPriceData(v);
}

/** Run `LiquidationEngine.scanAtRiskPositions` using Charli3-backed marks. */
export async function scanAtRiskWithCharli3Oracle(
  engine: LiquidationEngine,
  pairIds: string[],
): Promise<ReturnType<LiquidationEngine["scanAtRiskPositions"]>> {
  const marks = await oracleMarkPricesForPairs(pairIds);
  return engine.scanAtRiskPositions(marks);
}

const DEFAULT_FUNDING_INTERVAL_MS = 3_600_000;

export async function fundingPreviewFromOracle(
  pairId: string,
  fundingIntervalMs: number = DEFAULT_FUNDING_INTERVAL_MS,
): Promise<FundingRatePrediction> {
  const pd = await oraclePriceData(pairId);
  return predictNextFundingRate(pd, fundingIntervalMs);
}

export async function assessPositionWithOracle(
  engine: LiquidationEngine,
  position: Position,
): Promise<ReturnType<LiquidationEngine["assessPositionRisk"]>> {
  const v = await getVerifiedIndexPrice(position.pairId);
  return engine.assessPositionRisk(position, v.markPrice);
}
