import { describe, it, expect } from "vitest";
import { getVerifiedIndexPrice } from "../charli3/price_feed.js";

const LIVE = process.env.CHARLI3_LIVE_TEST === "1";

describe.skipIf(!LIVE)("Charli3 Preprod live (set CHARLI3_LIVE_TEST=1)", () => {
  it("reads ADA-USD from hackathon Kupo", async () => {
    const v = await getVerifiedIndexPrice("ADA-USD");
    expect(v.outRef.txHash).toMatch(/^[0-9a-f]{64}$/);
    expect(v.indexPrice).toBeGreaterThan(0);
  });
});
