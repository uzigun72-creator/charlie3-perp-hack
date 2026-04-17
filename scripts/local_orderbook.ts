/**
 * Session-local CLOB view: aggregates `OrderCommitmentInput` posts into
 * [PrivateOrderBook](book/order_book.ts) with harness proofs (not production ZK).
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { OrderCommitment } from "../core/types.js";
import { OrderSide } from "../core/types.js";
import { minimalVerifiedProof } from "../core/utils.js";
import type { OrderBookEntry, OrderBookSnapshot } from "../book/order_book.js";
import { PrivateOrderBook } from "../book/order_book.js";
import type { OrderCommitmentInput } from "../src/order/commitment.js";
import { orderCommitmentHex } from "../src/order/commitment.js";
import { parseNum } from "./perp_ui.js";

export type PostedOrderRecord = {
  draft: OrderCommitmentInput;
  postedAt: number;
};

type StoreFileV1 = {
  version: 1;
  pairs: Record<string, PostedOrderRecord[]>;
};

function makeCommitmentFromHex(hex64: string): OrderCommitment {
  const h = hex64.replace(/^0x/i, "");
  const p = minimalVerifiedProof("validity", ["01"]);
  const t = minimalVerifiedProof("timelock", ["01"]);
  return {
    commitmentHash: `0x${h}`,
    validityProof: p,
    timelockProof: t,
    committedAt: Date.now(),
  };
}

function makeProofs(price: number, size: number, side: OrderSide) {
  const sideTag = side === OrderSide.SHORT ? "SHORT" : "LONG";
  return {
    priceRangeProof: minimalVerifiedProof("price-range-v1", ["px", String(price)]),
    marginProof: minimalVerifiedProof("margin-v1", [sideTag, String(size)]),
    timelockProof: minimalVerifiedProof("timelock-v1", [sideTag]),
  };
}

function entryFromDraft(draft: OrderCommitmentInput): OrderBookEntry {
  const price = parseNum(draft.price);
  const size = parseNum(draft.size);
  if (!Number.isFinite(price) || price <= 0) throw new Error("invalid price");
  if (!Number.isFinite(size) || size <= 0) throw new Error("invalid size");
  const side = draft.side === "SHORT" ? OrderSide.SHORT : OrderSide.LONG;
  const hex = orderCommitmentHex(draft);
  const commitment = makeCommitmentFromHex(hex);
  const proofs = makeProofs(price, size, side);
  return {
    orderId: randomUUID(),
    commitment,
    side,
    priceLevel: price,
    size,
    remainingSize: size,
    priorityTimestamp: Date.now(),
    proofs,
  };
}

function hashKey(hex: string): string {
  return hex.replace(/^0x/i, "").toLowerCase();
}

type PairSession = {
  book: PrivateOrderBook;
  seenHashes: Set<string>;
  records: PostedOrderRecord[];
};

export class LocalOrderBookManager {
  private readonly storePath: string;
  private readonly sessions = new Map<string, PairSession>();

  constructor(storePath: string) {
    this.storePath = storePath;
    this.load();
  }

  private ensure(pairId: string): PairSession {
    let s = this.sessions.get(pairId);
    if (!s) {
      s = { book: new PrivateOrderBook(pairId), seenHashes: new Set(), records: [] };
      this.sessions.set(pairId, s);
    }
    return s;
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storePath, "utf8")) as StoreFileV1;
      if (raw.version !== 1 || !raw.pairs || typeof raw.pairs !== "object") return;
      for (const [pairId, recs] of Object.entries(raw.pairs)) {
        if (!Array.isArray(recs)) continue;
        const s = this.ensure(pairId);
        for (const r of recs) {
          if (!r?.draft) continue;
          const h = hashKey(orderCommitmentHex(r.draft));
          if (s.seenHashes.has(h)) continue;
          try {
            s.book.addOrder(entryFromDraft(r.draft));
            s.seenHashes.add(h);
            s.records.push(r);
          } catch {
            /* skip bad row */
          }
        }
      }
    } catch {
      /* ignore corrupt file */
    }
  }

  private persist(): void {
    const pairs: Record<string, PostedOrderRecord[]> = {};
    for (const [pid, s] of this.sessions) {
      if (s.records.length > 0) pairs[pid] = s.records;
    }
    try {
      writeFileSync(this.storePath, JSON.stringify({ version: 1, pairs } satisfies StoreFileV1, null, 2), "utf8");
    } catch {
      /* ignore */
    }
  }

  post(pairId: string, draft: OrderCommitmentInput): { ok: true } | { ok: false; error: string } {
    const s = this.ensure(pairId);
    const h = hashKey(orderCommitmentHex(draft));
    if (s.seenHashes.has(h)) {
      return { ok: false, error: "duplicate commitment — change nonce or fields, then post again" };
    }
    try {
      s.book.addOrder(entryFromDraft(draft));
      s.seenHashes.add(h);
      s.records.push({ draft: { ...draft }, postedAt: Date.now() });
      this.persist();
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  clear(pairId: string): void {
    const s = this.ensure(pairId);
    s.book.clear();
    s.seenHashes.clear();
    s.records = [];
    this.persist();
  }

  snapshot(pairId: string, levels: number): OrderBookSnapshot {
    return this.ensure(pairId).book.getSnapshot(levels);
  }

  totalPosted(pairId: string): number {
    return this.ensure(pairId).records.length;
  }
}

export function defaultLocalOrderbookPath(repoRoot: string): string {
  return path.join(repoRoot, ".local-orderbook.json");
}
