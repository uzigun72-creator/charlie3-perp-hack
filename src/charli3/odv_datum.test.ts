import { describe, expect, it } from "vitest";
import { parseOdvFeedDatum, priceRawToNumber } from "./odv_datum.js";

/** Captured Preprod Kupo datum (C3AS) — structural decode only; not a substitute for live integration. */
const SAMPLE_DATUM_HEX =
  "d8799fd87b9fa3001a0003e92b011b0000019d9a813fd8021b0000019d9a8a6798ffff";

describe("parseOdvFeedDatum", () => {
  it("decodes price map keys 0,1,2", () => {
    const p = parseOdvFeedDatum(SAMPLE_DATUM_HEX);
    expect(p.priceRaw).toBe(256299n);
    expect(p.timestampMs).toBe(1776413655000n);
    expect(p.expiryMs).toBe(1776414255000n);
    expect(priceRawToNumber(p.priceRaw)).toBeCloseTo(0.256299, 6);
  });
});
