import { Data } from "@lucid-evolution/lucid";

export interface ParsedOdvFeedDatum {
  /** Raw integer from on-chain map key 0 (display = priceRaw / 1e6 per Charli3 demos). */
  priceRaw: bigint;
  timestampMs: bigint;
  expiryMs: bigint;
}

/**
 * Decode Charli3 ODV aggregate feed datum (legacy + ODV `GenericData` + `PriceData`).
 * Same layout as datum-demo `GenericData` / `PriceData` (constructor 0 + 2, price_map keys 0,1,2).
 */
export function parseOdvFeedDatum(datumCborHex: string): ParsedOdvFeedDatum {
  const d = Data.from(datumCborHex) as {
    index: number;
    fields: unknown[];
  };
  if (d.index !== 0 || !Array.isArray(d.fields) || d.fields.length < 1) {
    throw new Error("Expected GenericData (Constr 0) with price_data");
  }
  const priceData = d.fields[0] as { index: number; fields: unknown[] };
  if (priceData.index !== 2 || !Array.isArray(priceData.fields) || priceData.fields.length < 1) {
    throw new Error("Expected PriceData (Constr 2) with price_map");
  }
  const map = priceData.fields[0];
  if (!(map instanceof Map)) {
    throw new Error("Expected price_map as Plutus Map");
  }
  const priceRaw = map.get(0n);
  const timestampMs = map.get(1n);
  const expiryMs = map.get(2n);
  if (priceRaw === undefined || timestampMs === undefined || expiryMs === undefined) {
    throw new Error("price_map missing keys 0,1,2");
  }
  return {
    priceRaw: BigInt(priceRaw as bigint),
    timestampMs: BigInt(timestampMs as bigint),
    expiryMs: BigInt(expiryMs as bigint),
  };
}

/** Human-scale numeric (Charli3 demos divide raw price by 1e6). */
export function priceRawToNumber(priceRaw: bigint): number {
  return Number(priceRaw) / 1_000_000;
}
