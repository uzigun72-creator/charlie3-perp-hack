#!/usr/bin/env npx tsx
/**
 * Seed resting liquidity on both sides of the oracle mark (non-crossing ladder).
 * Each order POSTs to `/api/trade/rest-only` (resting JSON only; never blocks on Midnight/Cardano pipeline mutex).
 *
 * Env (repo `.env`):
 *   SEED_API=http://127.0.0.1:8791
 *   SEED_LEVELS=4          rungs per side (default 4)
 *   SEED_SIZE=25            base size per rung
 *   SEED_LEVERAGE=5
 *   SEED_SPREAD=0.002       price step between rungs (quote per base)
 *   SEED_GAP=0.001          extra gap so best_bid < best_ask (half-spread from mid optional)
 *   SEED_DELAY_MS=800       pause between POSTs (optional; rest-only does not hit pipeline 429)
 *   SEED_REST_EPS=1e-8      min gap vs best ask (longs) / best bid (shorts) so orders rest, not match
 *   SEED_DRY_RUN=1          log only
 *
 * Before each POST, prices are nudged using GET /api/matching/status so longs stay strictly below
 * the resting best ask and shorts strictly above the best bid (adds liquidity only; no taker match).
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
config({ path: join(repoRoot, ".env") });

const API = (process.env.SEED_API || process.env.MM_BOT_API || "http://127.0.0.1:8791").replace(/\/$/, "");
const LEVELS = Math.max(1, Math.min(12, Number.parseInt(process.env.SEED_LEVELS || "4", 10)));
const SIZE = process.env.SEED_SIZE || "25";
const LEV = Math.min(125, Math.max(1, Number.parseInt(process.env.SEED_LEVERAGE || "5", 10)));
const SPREAD = Math.max(0.0001, Number.parseFloat(process.env.SEED_SPREAD || "0.002"));
const GAP = Math.max(0, Number.parseFloat(process.env.SEED_GAP || "0.001"));
const DELAY_MS = Math.max(200, Number.parseInt(process.env.SEED_DELAY_MS || "800", 10));
const DRY = ["1", "true", "yes"].includes((process.env.SEED_DRY_RUN || "").toLowerCase());
/** Keeps long.limit < bestAsk and short.limit > bestBid (strict), so the order rests. */
const REST_EPS = Math.max(1e-12, Number.parseFloat(process.env.SEED_REST_EPS || "1e-8"));

function marginStr(size: number, price: number, lev: number): string {
  const m = (size * price) / lev;
  return m.toFixed(8).replace(/\.?0+$/, "");
}

function priceStr(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "";
  if (p >= 1) return p.toFixed(6).replace(/\.?0+$/, "");
  return p.toFixed(8).replace(/\.?0+$/, "");
}

function sizeStr(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  return s.toFixed(8).replace(/\.?0+$/, "");
}

async function oraclePrice(): Promise<number> {
  const r = await fetch(`${API}/api/oracle?pair=ADA-USD`, { signal: AbortSignal.timeout(60_000) });
  const j = (await r.json()) as { indexPrice?: number; error?: string };
  if (!r.ok) throw new Error(j.error || `oracle ${r.status}`);
  if (typeof j.indexPrice !== "number" || !Number.isFinite(j.indexPrice)) {
    throw new Error("bad indexPrice");
  }
  return j.indexPrice;
}

type MatchingStatus = { bestBid: number | null; bestAsk: number | null };

async function fetchMatchingStatus(): Promise<MatchingStatus> {
  const r = await fetch(`${API}/api/matching/status`, { signal: AbortSignal.timeout(60_000) });
  const j = (await r.json()) as {
    bestBid?: number | null;
    bestAsk?: number | null;
    error?: string;
  };
  if (!r.ok) throw new Error(j.error || `matching/status ${r.status}`);
  const bestBid = typeof j.bestBid === "number" && Number.isFinite(j.bestBid) ? j.bestBid : null;
  const bestAsk = typeof j.bestAsk === "number" && Number.isFinite(j.bestAsk) ? j.bestAsk : null;
  return { bestBid, bestAsk };
}

/** Long rests iff no short has price ≤ limit → require limit < min(short) = bestAsk. */
function adjustLongForResting(planned: number, bestAsk: number | null, eps: number): number {
  if (bestAsk === null) return planned;
  return Math.min(planned, bestAsk - eps);
}

/** Short rests iff no long has price ≥ limit → require limit > max(long) = bestBid. */
function adjustShortForResting(planned: number, bestBid: number | null, eps: number): number {
  if (bestBid === null) return planned;
  return Math.max(planned, bestBid + eps);
}

async function postRestOnly(body: Record<string, unknown>): Promise<{ ok: boolean; raw: string; status: number }> {
  const r = await fetch(`${API}/api/trade/rest-only`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  return { ok: r.ok, raw, status: r.status };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function main(): Promise<void> {
  const mark = await oraclePrice();
  const sz = Number.parseFloat(SIZE);
  if (!Number.isFinite(sz) || sz <= 0) throw new Error("SEED_SIZE invalid");

  const bids: { side: "long"; price: number }[] = [];
  const asks: { side: "short"; price: number }[] = [];

  // Bids: below mark — highest bid closest to mark (i=1 nearest)
  for (let i = 1; i <= LEVELS; i++) {
    const p = mark - GAP - i * SPREAD;
    if (p <= 0) throw new Error(`computed bid price ${p} invalid; reduce LEVELS/SPREAD`);
    bids.push({ side: "long", price: p });
  }
  // Asks: above mark — lowest ask closest to mark
  for (let i = 1; i <= LEVELS; i++) {
    const p = mark + GAP + i * SPREAD;
    asks.push({ side: "short", price: p });
  }

  const bestBid = Math.max(...bids.map((b) => b.price));
  const bestAsk = Math.min(...asks.map((a) => a.price));
  if (bestBid >= bestAsk) {
    throw new Error(`ladder would cross: bestBid ${bestBid} >= bestAsk ${bestAsk}`);
  }

  console.log(
    `[seed-liquidity] mark=${mark.toFixed(6)} levels/side=${LEVELS} size=${SIZE} lev=${LEV} spread=${SPREAD} gap=${GAP} → bestRestingBid≈${bestBid.toFixed(6)} bestRestingAsk≈${bestAsk.toFixed(6)}`,
  );

  const queue = [...bids, ...asks];
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < queue.length; i++) {
    const q = queue[i];
    const planned = q.price;
    let ms: MatchingStatus;
    try {
      ms = await fetchMatchingStatus();
    } catch (e) {
      console.error(`[seed-liquidity] FAIL matching/status`, e);
      fail++;
      await sleep(DELAY_MS);
      continue;
    }
    const adj =
      q.side === "long"
        ? adjustLongForResting(planned, ms.bestAsk, REST_EPS)
        : adjustShortForResting(planned, ms.bestBid, REST_EPS);

    if (!Number.isFinite(adj) || adj <= 0) {
      console.warn(
        `[seed-liquidity] SKIP ${i + 1}/${queue.length} ${q.side}: adjusted price ${adj} invalid (planned=${planned} bestBid=${ms.bestBid} bestAsk=${ms.bestAsk})`,
      );
      fail++;
      await sleep(DELAY_MS);
      continue;
    }

    if (q.side === "long" && ms.bestAsk !== null && adj >= ms.bestAsk) {
      console.warn(`[seed-liquidity] SKIP long: still not below bestAsk after nudge (${adj} >= ${ms.bestAsk})`);
      fail++;
      await sleep(DELAY_MS);
      continue;
    }
    if (q.side === "short" && ms.bestBid !== null && adj <= ms.bestBid) {
      console.warn(`[seed-liquidity] SKIP short: still not above bestBid after nudge (${adj} <= ${ms.bestBid})`);
      fail++;
      await sleep(DELAY_MS);
      continue;
    }

    const pS = priceStr(adj);
    const sS = sizeStr(sz);
    const body = {
      side: q.side,
      price: pS,
      size: sS,
      leverage: LEV,
      margin: marginStr(sz, adj, LEV),
    };
    const nudge =
      Math.abs(adj - planned) > 1e-12 ? ` (nudged from ${priceStr(planned)})` : "";
    const label = `${q.side} @ ${pS}${nudge}`;
    if (DRY) {
      console.log(`[seed-liquidity] DRY ${i + 1}/${queue.length} ${label} bestBid=${ms.bestBid} bestAsk=${ms.bestAsk}`);
      continue;
    }
    const res = await postRestOnly(body);
    let j: { status?: string; error?: string; ok?: boolean; offchainOnly?: boolean; orderId?: string };
    try {
      j = res.raw.trim() ? (JSON.parse(res.raw) as typeof j) : {};
    } catch {
      console.error(`[seed-liquidity] FAIL ${label} non-JSON HTTP ${res.status}`, res.raw.slice(0, 200));
      fail++;
      await sleep(DELAY_MS);
      continue;
    }
    if (!res.ok) {
      const hint =
        res.status === 409
          ? " (would match — tighten SEED_REST_EPS / prices vs book)"
          : "";
      console.error(`[seed-liquidity] FAIL ${label} HTTP ${res.status}${hint}`, j.error || res.raw.slice(0, 200));
      fail++;
    } else if (j.status !== "resting") {
      console.error(
        `[seed-liquidity] UNEXPECTED_RESPONSE ${label} → status=${String(j.status)} (expected resting)`,
      );
      fail++;
    } else {
      ok++;
      console.log(`[seed-liquidity] OK ${label} → resting orderId=${String(j.orderId ?? "")}`);
    }
    await sleep(DELAY_MS);
  }

  console.log(`[seed-liquidity] done ok=${ok} fail=${fail} (GET /api/orderbook?resting=1 to inspect)`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
