import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrderCommitmentInput } from "../../src/order/commitment.js";
import { parseNum } from "../../scripts/perp_ui.js";
import type { TraderSubmitPayload } from "./mapTrade.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function repoRoot(): string {
  return join(__dirname, "../..");
}

export function restingBookPath(): string {
  return join(repoRoot(), ".perps-resting-book.json");
}

export type RestingOrder = {
  id: string;
  pairId: string;
  side: "LONG" | "SHORT";
  price: string;
  size: string;
  leverage: number;
  margin: string;
  nonce: string;
  createdAt: string;
};

type RestingStore = {
  version: 1;
  orders: RestingOrder[];
};

async function readStore(): Promise<RestingStore> {
  try {
    const raw = await readFile(restingBookPath(), "utf8");
    const p = JSON.parse(raw) as RestingStore;
    if (p.version !== 1 || !Array.isArray(p.orders)) return { version: 1, orders: [] };
    return p;
  } catch {
    return { version: 1, orders: [] };
  }
}

async function writeStore(s: RestingStore): Promise<void> {
  await writeFile(restingBookPath(), JSON.stringify(s, null, 2), "utf8");
}

/** Full snapshot for rollback if the on-chain pipeline fails after a match mutates the book. */
export async function snapshotResting(): Promise<RestingStore> {
  return readStore();
}

export async function restoreResting(s: RestingStore): Promise<void> {
  await writeStore(s);
}

export async function listRestingOrders(): Promise<RestingOrder[]> {
  const s = await readStore();
  return s.orders;
}

/** Wipes all resting limit orders (`.perps-resting-book.json`). */
export async function clearRestingBook(): Promise<void> {
  await writeStore({ version: 1, orders: [] });
}

/** Best resting bid (max long price) vs best ask (min short price) — auto-match runs only when `crossed` is true. */
export async function getRestingBookSummary(pairId = "ADA-USD"): Promise<{
  pairId: string;
  restingLongCount: number;
  restingShortCount: number;
  bestBid: number | null;
  bestAsk: number | null;
  crossed: boolean;
}> {
  const s = await readStore();
  let restingLongCount = 0;
  let restingShortCount = 0;
  let bestBid: number | null = null;
  let bestAsk: number | null = null;
  for (const o of s.orders) {
    if (o.pairId !== pairId) continue;
    if (o.side === "LONG") {
      restingLongCount++;
      const p = parseNum(o.price);
      if (Number.isFinite(p) && p > 0) {
        bestBid = bestBid === null ? p : Math.max(bestBid, p);
      }
    } else if (o.side === "SHORT") {
      restingShortCount++;
      const p = parseNum(o.price);
      if (Number.isFinite(p) && p > 0) {
        bestAsk = bestAsk === null ? p : Math.min(bestAsk, p);
      }
    }
  }
  const crossed =
    bestBid !== null && bestAsk !== null && bestBid >= bestAsk - 1e-12;
  return {
    pairId,
    restingLongCount,
    restingShortCount,
    bestBid,
    bestAsk,
    crossed,
  };
}

function mkNonce(): string {
  return `n-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

function sizeStr(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  return s.toFixed(8).replace(/\.?0+$/, "");
}

function marginStr(size: number, price: number, lev: number): string {
  const m = (size * price) / lev;
  return m.toFixed(8).replace(/\.?0+$/, "");
}

export async function addRestingFromPayload(body: TraderSubmitPayload): Promise<RestingOrder> {
  const pairId = body.pairId ?? "ADA-USD";
  const o: RestingOrder = {
    id: randomUUID(),
    pairId,
    side: body.side === "long" ? "LONG" : "SHORT",
    price: body.price,
    size: body.size,
    leverage: body.leverage,
    margin: body.margin,
    nonce: mkNonce(),
    createdAt: new Date().toISOString(),
  };
  const s = await readStore();
  s.orders.push(o);
  await writeStore(s);
  return o;
}

export type MatchResult =
  | {
      kind: "match";
      bid: OrderCommitmentInput;
      ask: OrderCommitmentInput;
      remainderPayload: TraderSubmitPayload | null;
    }
  | { kind: "no_match" };

/**
 * CLOB-style cross: long taker matches lowest resting short at or below limit; short taker matches
 * highest resting long at or above limit. Execution price is the maker's price. Both legs use the
 * taker's leverage for symmetric commitments. Persists maker removal/reduction immediately — caller
 * must snapshot with `snapshotResting()` before calling and `restoreResting()` if the pipeline fails.
 */
/**
 * Best resting maker for a taker cross: O(n) single pass (replaces filter + sort).
 * Long taker → cheapest short ≤ limit (FIFO on tie). Short taker → highest long ≥ limit (FIFO on tie).
 */
function pickMakerForTaker(
  orders: RestingOrder[],
  pairId: string,
  side: "long" | "short",
  inLimit: number,
): RestingOrder | null {
  let best: RestingOrder | null = null;
  let bestPx = side === "long" ? Infinity : -Infinity;
  for (const o of orders) {
    if (o.pairId !== pairId) continue;
    const p = parseNum(o.price);
    if (!Number.isFinite(p)) continue;
    if (side === "long") {
      if (o.side !== "SHORT" || p > inLimit + 1e-12) continue;
      if (p < bestPx - 1e-12) {
        bestPx = p;
        best = o;
      }
    } else {
      if (o.side !== "LONG" || p < inLimit - 1e-12) continue;
      if (p > bestPx + 1e-12) {
        bestPx = p;
        best = o;
      }
    }
  }
  return best;
}

/** Best bid (max price, then oldest) and best ask (min price, then oldest) for crossed-book sweeps — O(n). */
function pickBestLongAndShort(
  orders: RestingOrder[],
  pairId: string,
): { bestLong: RestingOrder | null; bestShort: RestingOrder | null } {
  let bestLong: RestingOrder | null = null;
  let bestShort: RestingOrder | null = null;
  for (const o of orders) {
    if (o.pairId !== pairId) continue;
    const p = parseNum(o.price);
    if (!Number.isFinite(p) || p <= 0) continue;
    if (o.side === "LONG") {
      if (!bestLong) {
        bestLong = o;
        continue;
      }
      const bl = parseNum(bestLong.price);
      if (p > bl + 1e-12) bestLong = o;
      else if (Math.abs(p - bl) <= 1e-12 && o.createdAt < bestLong.createdAt) bestLong = o;
    } else if (o.side === "SHORT") {
      if (!bestShort) {
        bestShort = o;
        continue;
      }
      const bs = parseNum(bestShort.price);
      if (p < bs - 1e-12) bestShort = o;
      else if (Math.abs(p - bs) <= 1e-12 && o.createdAt < bestShort.createdAt) bestShort = o;
    }
  }
  return { bestLong, bestShort };
}

export async function matchAndConsume(body: TraderSubmitPayload): Promise<MatchResult> {
  const pairId = body.pairId ?? "ADA-USD";
  const inLimit = parseNum(body.price);
  const inSize = parseNum(body.size);
  const lev = body.leverage;
  if (!Number.isFinite(inLimit) || !Number.isFinite(inSize) || inSize <= 0 || !(lev >= 1)) {
    return { kind: "no_match" };
  }

  const s = await readStore();
  const maker = pickMakerForTaker(s.orders, pairId, body.side, inLimit);
  if (!maker) return { kind: "no_match" };

  const execPx = parseNum(maker.price);
  const makerSz = parseNum(maker.size);
  const fillQty = Math.min(inSize, makerSz);
  if (!(fillQty > 0) || !Number.isFinite(execPx)) return { kind: "no_match" };

  const fillStr = sizeStr(fillQty);
  const pxStr = maker.price;
  const mStr = marginStr(fillQty, execPx, lev);

  const bid: OrderCommitmentInput = {
    pairId,
    side: "LONG",
    price: pxStr,
    size: fillStr,
    leverage: lev,
    margin: mStr,
    nonce: mkNonce(),
  };
  const ask: OrderCommitmentInput = {
    pairId,
    side: "SHORT",
    price: pxStr,
    size: fillStr,
    leverage: lev,
    margin: mStr,
    nonce: mkNonce(),
  };

  const idx = s.orders.findIndex((x) => x.id === maker.id);
  if (idx >= 0) {
    const rem = makerSz - fillQty;
    if (rem <= 1e-12) {
      s.orders.splice(idx, 1);
    } else {
      const remStr = sizeStr(rem);
      const remMargin = marginStr(rem, execPx, maker.leverage);
      s.orders[idx] = {
        ...maker,
        size: remStr,
        margin: remMargin,
        nonce: mkNonce(),
      };
    }
  }
  await writeStore(s);

  let remainderPayload: TraderSubmitPayload | null = null;
  if (inSize - fillQty > 1e-12) {
    const remSize = sizeStr(inSize - fillQty);
    const remMargin = marginStr(inSize - fillQty, inLimit, lev);
    remainderPayload = {
      ...body,
      size: remSize,
      margin: remMargin,
    };
  }

  return { kind: "match", bid, ask, remainderPayload };
}

export type RestingCrossMatch = {
  kind: "match";
  bid: OrderCommitmentInput;
  ask: OrderCommitmentInput;
};

/**
 * When the book is crossed (highest resting bid ≥ lowest resting ask), match **best bid** vs **best ask**:
 * FIFO among equal prices via `createdAt`. Execution price is the **ask** (lowest short). Leverage for both
 * commitment legs follows the **newer** resting order (taker). Mutates the store: reduces or removes both
 * orders. Caller must snapshot before calling and restore if the on-chain pipeline fails.
 */
export async function matchRestingCrossOnce(pairId = "ADA-USD"): Promise<RestingCrossMatch | { kind: "no_match" }> {
  const s = await readStore();
  const { bestLong, bestShort } = pickBestLongAndShort(s.orders, pairId);
  if (!bestLong || !bestShort) return { kind: "no_match" };
  const pL = parseNum(bestLong.price);
  const pS = parseNum(bestShort.price);
  if (!Number.isFinite(pL) || !Number.isFinite(pS) || pL < pS - 1e-12) {
    return { kind: "no_match" };
  }

  const longSz = parseNum(bestLong.size);
  const shortSz = parseNum(bestShort.size);
  const fillQty = Math.min(longSz, shortSz);
  if (!(fillQty > 0)) return { kind: "no_match" };

  const execPx = parseNum(bestShort.price);
  if (!Number.isFinite(execPx)) return { kind: "no_match" };

  const longNewer = bestLong.createdAt >= bestShort.createdAt;
  const takerLev = longNewer ? bestLong.leverage : bestShort.leverage;
  if (!(takerLev >= 1)) return { kind: "no_match" };

  const fillStr = sizeStr(fillQty);
  const pxStr = bestShort.price;
  const mStr = marginStr(fillQty, execPx, takerLev);

  const bid: OrderCommitmentInput = {
    pairId,
    side: "LONG",
    price: pxStr,
    size: fillStr,
    leverage: takerLev,
    margin: mStr,
    nonce: mkNonce(),
  };
  const ask: OrderCommitmentInput = {
    pairId,
    side: "SHORT",
    price: pxStr,
    size: fillStr,
    leverage: takerLev,
    margin: mStr,
    nonce: mkNonce(),
  };

  const remL = longSz - fillQty;
  const remS = shortSz - fillQty;

  const others = s.orders.filter((o) => o.id !== bestLong.id && o.id !== bestShort.id);
  const next: RestingOrder[] = [...others];
  if (remL > 1e-12) {
    next.push({
      ...bestLong,
      size: sizeStr(remL),
      margin: marginStr(remL, pL, bestLong.leverage),
      nonce: mkNonce(),
    });
  }
  if (remS > 1e-12) {
    next.push({
      ...bestShort,
      size: sizeStr(remS),
      margin: marginStr(remS, pS, bestShort.leverage),
      nonce: mkNonce(),
    });
  }
  s.orders = next;
  await writeStore(s);
  return { kind: "match", bid, ask };
}
