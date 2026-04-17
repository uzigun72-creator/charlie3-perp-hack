import { createHash } from "node:crypto";
import type { VerifiedIndexPrice } from "./price_feed.js";

/** 32-byte hex digest for `C3PERP_L1_ANCHOR_HEX`, binding Midnight bind to a Charli3 observation. */
export function l1AnchorHexFromOracle(v: VerifiedIndexPrice): string {
  const h = createHash("sha256");
  h.update("CHARLI3PERP|ADA-USD|CHARLI3|");
  h.update(v.datumHash);
  h.update("|");
  h.update(v.priceRaw.toString());
  h.update("|");
  h.update(v.outRef.txHash);
  h.update("|");
  h.update(String(v.outRef.outputIndex));
  return h.digest("hex");
}
