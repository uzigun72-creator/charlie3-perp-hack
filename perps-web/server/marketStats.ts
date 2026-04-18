import { getVerifiedIndexPrice } from "../../src/charli3/price_feed.js";
import { parseNum } from "../../scripts/perp_ui.js";
import { listEntries } from "./orderIndex.js";
import { getRestingBookSummary, listRestingOrders } from "./restingBook.js";

export type MarketStats = {
  pairId: string;
  markPrice: number;
  indexPrice: number;
  oracleTimestampMs: number;
  restingOrderCount: number;
  restingLongCount: number;
  restingShortCount: number;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  crossed: boolean;
  /** Sum of (price × size) in USD for resting longs — bid-side depth */
  liquidityBidUsd: number;
  /** Sum of (price × size) in USD for resting shorts — ask-side depth */
  liquidityAskUsd: number;
  liquidityTotalUsd: number;
  confirmedTrades: number;
  pendingTrades: number;
  volumeBaseAllTime: number;
  volumeUsdAllTime: number;
  volumeBase24h: number;
  volumeUsd24h: number;
};

export async function getMarketStats(pairId = "ADA-USD"): Promise<MarketStats> {
  const oracle = await getVerifiedIndexPrice(pairId);
  const resting = await listRestingOrders();
  const summary = await getRestingBookSummary(pairId);
  const entries = await listEntries();
  const confirmed = entries.filter((e) => e.status === "confirmed");
  const pending = entries.filter(
    (e) => e.status === "pending" || e.status === "pending_user_l1",
  );

  let liquidityBidUsd = 0;
  let liquidityAskUsd = 0;
  for (const o of resting) {
    if (o.pairId !== pairId) continue;
    const p = parseNum(o.price);
    const s = parseNum(o.size);
    if (!Number.isFinite(p) || !Number.isFinite(s)) continue;
    const usd = p * s;
    if (o.side === "LONG") liquidityBidUsd += usd;
    else liquidityAskUsd += usd;
  }

  let volumeBaseAll = 0;
  let volumeUsdAll = 0;
  let volumeBase24h = 0;
  let volumeUsd24h = 0;
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;

  for (const e of confirmed) {
    const sz = parseNum(e.bid.size);
    const px = parseNum(e.bid.price);
    if (!Number.isFinite(sz) || !Number.isFinite(px)) continue;
    volumeBaseAll += sz;
    volumeUsdAll += sz * px;
    const t = e.confirmedAt ? Date.parse(e.confirmedAt) : 0;
    if (Number.isFinite(t) && t >= dayAgo) {
      volumeBase24h += sz;
      volumeUsd24h += sz * px;
    }
  }

  const spread =
    summary.bestBid != null && summary.bestAsk != null
      ? summary.bestAsk - summary.bestBid
      : null;

  return {
    pairId,
    markPrice: oracle.indexPrice,
    indexPrice: oracle.indexPrice,
    oracleTimestampMs: oracle.timestampMs,
    restingOrderCount: resting.filter((o) => o.pairId === pairId).length,
    restingLongCount: summary.restingLongCount,
    restingShortCount: summary.restingShortCount,
    bestBid: summary.bestBid,
    bestAsk: summary.bestAsk,
    spread,
    crossed: summary.crossed,
    liquidityBidUsd,
    liquidityAskUsd,
    liquidityTotalUsd: liquidityBidUsd + liquidityAskUsd,
    confirmedTrades: confirmed.length,
    pendingTrades: pending.length,
    volumeBaseAllTime: volumeBaseAll,
    volumeUsdAllTime: volumeUsdAll,
    volumeBase24h,
    volumeUsd24h,
  };
}
