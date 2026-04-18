import type { OrderCommitmentInput } from "../../src/order/commitment.js";

export type TraderSubmitPayload = {
  side: "long" | "short";
  price: string;
  size: string;
  leverage: number;
  /** Initial margin (quote, USD) = (size × price) / leverage for isolated margin. */
  margin: string;
  pairId?: string;
};

function mkNonce(): string {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

/** Single trader leg (LONG or SHORT) for risk UI and resting payloads — no synthetic counterparty. */
export function traderLegFromPayload(input: TraderSubmitPayload): OrderCommitmentInput {
  const pairId = input.pairId ?? "ADA-USD";
  return {
    pairId,
    side: input.side === "long" ? "LONG" : "SHORT",
    price: input.price,
    size: input.size,
    leverage: input.leverage,
    margin: input.margin,
    nonce: mkNonce(),
  };
}
