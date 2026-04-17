import type { Charli3FeedConfig } from "./config.js";
import { c3asAssetKey } from "./config.js";

export interface KupoMatch {
  transaction_id: string;
  output_index: number;
  address: string;
  value: { coins: number; assets?: Record<string, number> };
  datum_hash: string;
  datum_type: string;
  spent_at: null | { slot_no: number };
  created_at: { slot_no: number };
}

export async function fetchMatches(kupoBase: string, address: string): Promise<KupoMatch[]> {
  const url = `${kupoBase.replace(/\/$/, "")}/v1/matches/${address}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kupo matches ${res.status}: ${await res.text()}`);
  return (await res.json()) as KupoMatch[];
}

export async function fetchDatumHex(kupoBase: string, datumHash: string): Promise<string> {
  const h = datumHash.replace(/^0x/, "");
  const url = `${kupoBase.replace(/\/$/, "")}/v1/datums/${h}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Kupo datums ${res.status}: ${await res.text()}`);
  const j = (await res.json()) as { datum?: string };
  if (!j.datum) throw new Error("Kupo datums response missing datum");
  return j.datum;
}

/** Unspent C3AS rows at the feed oracle address (ODV aggregate state NFT). */
export async function listUnspentC3asMatches(
  kupoBase: string,
  feed: Charli3FeedConfig,
): Promise<KupoMatch[]> {
  const unit = c3asAssetKey(feed.policyId, feed.aggregateNftNameHex);
  const all = await fetchMatches(kupoBase, feed.oracleAddress);
  return all.filter((m) => {
    if (m.spent_at !== null) return false;
    const assets = m.value.assets ?? {};
    return Object.prototype.hasOwnProperty.call(assets, unit);
  });
}
