import { describe, expect, it } from "vitest";
import { l1AnchorHexFromOracle } from "./l1_anchor_digest.js";
import type { VerifiedIndexPrice } from "./price_feed.js";

describe("l1AnchorHexFromOracle", () => {
  it("is deterministic for fixed oracle snapshot", () => {
    const v = {
      pairId: "ADA-USD",
      indexPrice: 0.256299,
      markPrice: 0.256299,
      timestampMs: 1776413655000,
      expiryMs: 1776414255000,
      priceRaw: 256299n,
      outRef: {
        txHash: "d1e36eb2dbfa3478ab966c50fea96c75171ba0fd9600f828ff84fdbc730b81b8",
        outputIndex: 1,
      },
      datumHash: "0c3cfd790f2f53b0c3b1a624e00ed63c8c26e7cf34ee33ddc15faa01cee6d286",
    } satisfies VerifiedIndexPrice;
    expect(l1AnchorHexFromOracle(v)).toBe(
      "9bf1ac5366c8f1cab66db265906e13a93be12976142645c7856bff5da7455356",
    );
  });
});
