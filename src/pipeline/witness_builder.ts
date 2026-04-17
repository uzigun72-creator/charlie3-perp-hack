/**
 * Off-chain witness builder: maps incoming orders + Charli3 oracle observation to
 * `C3PERP_*` hex env vars expected by [run-pipeline-all.ts](../../charli3perp-local-cli/src/run-pipeline-all.ts).
 *
 * v1 encoding: leg preimages are raw bytes of `orderCommitmentHex` (SHA256 of canonical order JSON);
 * matching contract stores `hashSingle32(preimage)`; match/settlement/liq/aggregate digests chain
 * persistentHash / sha256 domain tags as documented inline.
 */
import { createHash } from "node:crypto";
import type { OrderCommitmentInput } from "../order/commitment.js";
import { orderCommitmentHex } from "../order/commitment.js";
import type { VerifiedIndexPrice } from "../charli3/price_feed.js";
import { hashPair32, hashSingle32 } from "./midnight_hash.js";

export function bytesToHex(b: Uint8Array): string {
  return Buffer.from(b).toString("hex");
}

/** 32-byte leg preimage: commitment digest bytes (matches order hash used on charli3perp-order). */
export function orderLegPreimageBytes(order: OrderCommitmentInput): Uint8Array {
  const hex = orderCommitmentHex(order);
  return Uint8Array.from(Buffer.from(hex, "hex"));
}

export function parseOrderCommitmentJson(json: string): OrderCommitmentInput {
  const o = JSON.parse(json) as Record<string, unknown>;
  const pairId = String(o.pairId ?? "");
  const side = String(o.side ?? "").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    throw new Error("order.side must be LONG or SHORT");
  }
  const price = String(o.price ?? "");
  const size = String(o.size ?? "");
  const leverage = Number(o.leverage);
  const margin = String(o.margin ?? "");
  const nonce = String(o.nonce ?? "");
  if (!pairId || !price || !size || !Number.isFinite(leverage) || !margin || !nonce) {
    throw new Error("order must include pairId, price, size, leverage, margin, nonce");
  }
  return { pairId, side: side as "LONG" | "SHORT", price, size, leverage, margin, nonce };
}

export type PipelineWitnessBundle = {
  /** Env keys matching run-pipeline-all.ts */
  C3PERP_BID_PREIMAGE_HEX: string;
  C3PERP_ASK_PREIMAGE_HEX: string;
  C3PERP_MATCH_DIGEST_HEX: string;
  C3PERP_SETTLEMENT_INITIAL_HEX: string;
  C3PERP_SETTLEMENT_PAYLOAD_HEX: string;
  /** nextDigest = hashPair32(initial, payload) — for verification only; runner recomputes */
  settlementNextDigestHex: string;
  C3PERP_MARGIN_WITNESS_HEX: string;
  C3PERP_LIQUIDATION_THRESHOLD_HEX: string;
  C3PERP_AGGREGATE_LEFT_HEX: string;
  C3PERP_AGGREGATE_RIGHT_HEX: string;
  C3PERP_AGGREGATE_INITIAL_HEX: string;
};

function oracleTickTag32(oracle: VerifiedIndexPrice): Uint8Array {
  return createHash("sha256")
    .update("charli3perp:pipeline:oracle_tick:v1|")
    .update(oracle.datumHash, "hex")
    .update("|")
    .update(oracle.priceRaw.toString())
    .update("|")
    .update(oracle.outRef.txHash, "hex")
    .update("|")
    .update(String(oracle.outRef.outputIndex))
    .digest();
}

/**
 * Build all pipeline witness hex strings from two resting orders and a verified oracle tick.
 */
export function buildPipelineWitnesses(input: {
  bid: OrderCommitmentInput;
  ask: OrderCommitmentInput;
  oracle: VerifiedIndexPrice;
}): PipelineWitnessBundle {
  const bidPre = orderLegPreimageBytes(input.bid);
  const askPre = orderLegPreimageBytes(input.ask);
  const bidCommit = hashSingle32(bidPre);
  const askCommit = hashSingle32(askPre);

  const oracleTag = oracleTickTag32(input.oracle);
  const matchDigest = hashPair32(hashPair32(bidPre, askPre), oracleTag);

  const settlementInitial = bidCommit;
  const settlementPayload = hashPair32(matchDigest, oracleTag);
  const settlementNext = hashPair32(settlementInitial, settlementPayload);

  const marginBody = JSON.stringify({
    v: 1,
    bid: orderCommitmentHex(input.bid),
    ask: orderCommitmentHex(input.ask),
    mark: input.oracle.indexPrice,
    priceRaw: input.oracle.priceRaw.toString(),
  });
  const marginWitness = createHash("sha256").update("charli3perp:margin_bundle:v1|").update(marginBody).digest();

  const liqBody = JSON.stringify({
    v: 1,
    maintenanceBps: 50,
    mark: input.oracle.indexPrice,
    bidEntry: input.bid.price,
    askEntry: input.ask.price,
  });
  const liqThreshold = createHash("sha256").update("charli3perp:liq_threshold:v1|").update(liqBody).digest();

  const aggInitial = new Uint8Array(32);
  const aggLeft = matchDigest;
  const aggRight = hashPair32(bidCommit, askCommit);

  return {
    C3PERP_BID_PREIMAGE_HEX: bytesToHex(bidPre),
    C3PERP_ASK_PREIMAGE_HEX: bytesToHex(askPre),
    C3PERP_MATCH_DIGEST_HEX: bytesToHex(matchDigest),
    C3PERP_SETTLEMENT_INITIAL_HEX: bytesToHex(settlementInitial),
    C3PERP_SETTLEMENT_PAYLOAD_HEX: bytesToHex(settlementPayload),
    settlementNextDigestHex: bytesToHex(settlementNext),
    C3PERP_MARGIN_WITNESS_HEX: bytesToHex(new Uint8Array(marginWitness)),
    C3PERP_LIQUIDATION_THRESHOLD_HEX: bytesToHex(new Uint8Array(liqThreshold)),
    C3PERP_AGGREGATE_LEFT_HEX: bytesToHex(aggLeft),
    C3PERP_AGGREGATE_RIGHT_HEX: bytesToHex(aggRight),
    C3PERP_AGGREGATE_INITIAL_HEX: bytesToHex(aggInitial),
  };
}

/** Flat env fragment for `process.env` (64 hex, no 0x). Excludes settlementNext (runner derives it). */
export function buildPipelineWitnessEnv(input: {
  bid: OrderCommitmentInput;
  ask: OrderCommitmentInput;
  oracle: VerifiedIndexPrice;
}): Record<string, string> {
  const w = buildPipelineWitnesses(input);
  const { settlementNextDigestHex: _s, ...rest } = w;
  void _s;
  return rest;
}
