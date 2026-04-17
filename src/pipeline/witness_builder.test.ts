import { describe, expect, it } from "vitest";
import type { OrderCommitmentInput } from "../order/commitment.js";
import { orderCommitmentHex } from "../order/commitment.js";
import { hashPair32, hashSingle32 } from "./midnight_hash.js";
import { buildPipelineWitnesses, orderLegPreimageBytes, parseOrderCommitmentJson } from "./witness_builder.js";

const sampleBid: OrderCommitmentInput = {
  pairId: "ADA-USD",
  side: "LONG",
  price: "0.25",
  size: "100",
  leverage: 5,
  margin: "1000",
  nonce: "bid-nonce-1",
};

const sampleAsk: OrderCommitmentInput = {
  pairId: "ADA-USD",
  side: "SHORT",
  price: "0.251",
  size: "100",
  leverage: 5,
  margin: "1000",
  nonce: "ask-nonce-1",
};

describe("parseOrderCommitmentJson", () => {
  it("round-trips", () => {
    const s = JSON.stringify(sampleBid);
    const o = parseOrderCommitmentJson(s);
    expect(orderCommitmentHex(o)).toBe(orderCommitmentHex(sampleBid));
  });
});

describe("buildPipelineWitnesses", () => {
  it("matching commitments match Compact hash32(preimage)", () => {
    const oracle = {
      pairId: "ADA-USD",
      indexPrice: 0.25,
      markPrice: 0.25,
      timestampMs: 1_700_000_000_000,
      expiryMs: 1_700_000_000_000 + 86_400_000,
      priceRaw: 250_000n,
      outRef: { txHash: "a".repeat(64), outputIndex: 0 },
      datumHash: "b".repeat(64),
    };
    const w = buildPipelineWitnesses({ bid: sampleBid, ask: sampleAsk, oracle });
    const bidPre = orderLegPreimageBytes(sampleBid);
    const askPre = orderLegPreimageBytes(sampleAsk);
    expect(w.C3PERP_BID_PREIMAGE_HEX).toBe(Buffer.from(bidPre).toString("hex"));
    const bidCommit = hashSingle32(bidPre);
    const askCommit = hashSingle32(askPre);
    expect(hashSingle32(Buffer.from(w.C3PERP_BID_PREIMAGE_HEX, "hex"))).toEqual(bidCommit);
    expect(w.C3PERP_SETTLEMENT_INITIAL_HEX).toBe(Buffer.from(bidCommit).toString("hex"));
    const payload = Buffer.from(w.C3PERP_SETTLEMENT_PAYLOAD_HEX, "hex");
    const initial = Buffer.from(w.C3PERP_SETTLEMENT_INITIAL_HEX, "hex");
    const next = hashPair32(new Uint8Array(initial), new Uint8Array(payload));
    expect(w.settlementNextDigestHex).toBe(Buffer.from(next).toString("hex"));
  });
});
