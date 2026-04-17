import type { PriceData } from "../../core/types.js";
import {
  charli3IgnoreDatumExpiry,
  charli3KupoUrl,
  charli3MaxStalenessMs,
  feedConfigForPair,
  listFeedPairIds,
} from "./config.js";
import { fetchDatumHex, listUnspentC3asMatches } from "./kupo_client.js";
import { parseOdvFeedDatum, priceRawToNumber } from "./odv_datum.js";

export interface VerifiedIndexPrice {
  pairId: string;
  indexPrice: number;
  /** Same as index for v1 — both from verified ODV aggregate. */
  markPrice: number;
  timestampMs: number;
  expiryMs: number;
  priceRaw: bigint;
  /** Kupo source */
  outRef: { txHash: string; outputIndex: number };
  datumHash: string;
}

function nowMs(): number {
  return Date.now();
}

/**
 * Latest non-stale aggregate feed from Kupo (Charli3 ODV C3AS UTxO).
 */
export async function getVerifiedIndexPrice(
  pairId: string,
  options?: { kupoUrl?: string; maxStalenessMs?: number },
): Promise<VerifiedIndexPrice> {
  const feed = feedConfigForPair(pairId);
  const kupo = options?.kupoUrl ?? charli3KupoUrl();
  const maxStale = options?.maxStalenessMs ?? charli3MaxStalenessMs();
  const matches = await listUnspentC3asMatches(kupo, feed);
  if (matches.length === 0) {
    throw new Error(`No unspent C3AS oracle UTxOs for ${pairId} at ${feed.oracleAddress}`);
  }
  const sorted = [...matches].sort((a, b) => b.created_at.slot_no - a.created_at.slot_no);
  const errors: string[] = [];
  for (const m of sorted) {
    try {
      const hex = await fetchDatumHex(kupo, m.datum_hash);
      const p = parseOdvFeedDatum(hex);
      const t = Number(p.timestampMs);
      const exp = Number(p.expiryMs);
      const n = nowMs();
      if (!charli3IgnoreDatumExpiry() && n > exp) {
        errors.push(`past datum expiry ${m.datum_hash.slice(0, 12)}…`);
        continue;
      }
      if (n - t > maxStale || n < t - 60_000) {
        errors.push(`timestamp vs wall clock out of range for ${m.datum_hash.slice(0, 12)}…`);
        continue;
      }
      const indexPrice = priceRawToNumber(p.priceRaw);
      return {
        pairId,
        indexPrice,
        markPrice: indexPrice,
        timestampMs: t,
        expiryMs: exp,
        priceRaw: p.priceRaw,
        outRef: { txHash: m.transaction_id, outputIndex: m.output_index },
        datumHash: m.datum_hash,
      };
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }
  throw new Error(
    `No valid fresh Charli3 feed for ${pairId}. Attempts: ${errors.slice(0, 5).join("; ")}`,
  );
}

export function verifiedToPriceData(v: VerifiedIndexPrice, bestBidAskFallback?: number): PriceData {
  const px = bestBidAskFallback ?? v.markPrice;
  return {
    pairId: v.pairId,
    markPrice: v.markPrice,
    indexPrice: v.indexPrice,
    bestBid: px,
    bestAsk: px,
    timestamp: v.timestampMs,
  };
}

export async function getMarkPriceMapForPairs(pairIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  for (const id of pairIds) {
    const v = await getVerifiedIndexPrice(id);
    map.set(id, v.markPrice);
  }
  return map;
}

export type PairOracleResult =
  | { pairId: string; ok: true; data: VerifiedIndexPrice }
  | { pairId: string; ok: false; error: string };

/** Fetch oracle index for many pairs in parallel; failures are per-pair (do not throw). */
export async function getVerifiedIndexPricesAll(pairIds?: string[]): Promise<PairOracleResult[]> {
  const ids = pairIds?.length ? pairIds : listFeedPairIds();
  const settled = await Promise.allSettled(ids.map((id) => getVerifiedIndexPrice(id)));
  return ids.map((pairId, i) => {
    const r = settled[i]!;
    if (r.status === "fulfilled") return { pairId, ok: true, data: r.value };
    return {
      pairId,
      ok: false,
      error: r.reason instanceof Error ? r.reason.message : String(r.reason),
    };
  });
}

export { listFeedPairIds };
