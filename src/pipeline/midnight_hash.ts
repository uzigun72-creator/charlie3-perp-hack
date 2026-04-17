/**
 * Matches `hash32` / `combineDigest` / `openCommitment` in Compact contracts — same as
 * [charli3perp-local-cli/src/midnight-hash.ts](../../charli3perp-local-cli/src/midnight-hash.ts).
 */
import { CompactTypeBytes, CompactTypeVector, persistentHash } from "@midnight-ntwrk/compact-runtime";

const vec1 = new CompactTypeVector(1, new CompactTypeBytes(32));
const vec2 = new CompactTypeVector(2, new CompactTypeBytes(32));

export function hashSingle32(x: Uint8Array): Uint8Array {
  if (x.length !== 32) throw new Error("expected 32-byte preimage");
  return persistentHash(vec1, [x]);
}

export function hashPair32(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length !== 32 || b.length !== 32) throw new Error("expected 32-byte inputs");
  return persistentHash(vec2, [a, b]);
}
