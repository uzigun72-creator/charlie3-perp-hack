#!/usr/bin/env npx tsx
/**
 * Demo market-maker: POSTs **only** when there is resting liquidity to cross — it takes the
 * aggressor side against user/UI limit orders (`GET /api/orderbook?resting=1`).
 * Each match runs the full Midnight + Cardano flow — expensive.
 *
 * **Book mode (default):** short at best bid, long at best ask (alternates when both exist), capped
 * by `MM_BOT_RESTING_SIZE` / `MM_BOT_SIZE`. **No oracle/mark trades by default** — empty book → skip.
 * Set `MM_BOT_ORACLE_FALLBACK=1` to post at the mark when nothing is resting (legacy).
 *
 * `MM_BOT_MODE=oracle` ignores the book and always quotes the oracle mark (stress / legacy).
 *
 * Env (repo `.env` loaded from charlie3_hack root):
 *   MM_BOT_API=http://127.0.0.1:8791
 *   MM_BOT_INTERVAL_MS=15000    (default 15s — quick pickup of open orders; raise for testnets)
 *   MM_BOT_SIZE=25              (max base size for oracle ticks; default cap for resting if unset)
 *   MM_BOT_RESTING_SIZE=100     (optional — max ADA to take from a resting level per tick; use > MM_BOT_SIZE to clear user limits faster)
 *   MM_BOT_ORACLE_FALLBACK=0    (default — resting-only; set 1 for oracle ticks when book empty)
 *   MM_BOT_LEVERAGE=5
 *   MM_BOT_DRY_RUN=1            (log only, no POST)
 *   MM_BOT_MODE=book|oracle     (default `book` — use `oracle` for mark-only ticks)
 *   MM_BOT_FETCH_TIMEOUT_MS=45000  (abort if /api/oracle or /api/orderbook hangs)
 *
 * Trade POST uses Node `http`/`https` (not `fetch`) so there is no Undici **headersTimeout**
 * while the API waits on the full Midnight + Cardano pipeline before sending a response.
 */
import { config, parse } from "dotenv";
import { existsSync, readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { dirname, join } from "node:path";
import { fileURLToPath, URL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../..");
config({ path: join(repoRoot, ".env") });

/**
 * If `charlie3_hack/.env` defines `MM_BOT_INTERVAL_MS`, use that value even when the shell still
 * exports an old `MM_BOT_INTERVAL_MS` (dotenv does not override existing env vars by default).
 * Operators rely on `.env` for a short tick to match user resting orders quickly.
 */
function applyMmBotIntervalFromEnvFile(root: string): void {
  const p = join(root, ".env");
  if (!existsSync(p)) return;
  try {
    const parsed = parse(readFileSync(p, "utf8"));
    const v = parsed.MM_BOT_INTERVAL_MS;
    if (v != null && String(v).trim() !== "") {
      process.env.MM_BOT_INTERVAL_MS = String(v).trim();
    }
  } catch {
    /* ignore malformed .env */
  }
}

applyMmBotIntervalFromEnvFile(repoRoot);

const API = (process.env.MM_BOT_API || "http://127.0.0.1:8791").replace(/\/$/, "");
const INTERVAL_MS = Math.max(5_000, Number.parseInt(process.env.MM_BOT_INTERVAL_MS || "15000", 10));
const FETCH_TIMEOUT_MS = Math.max(
  5_000,
  Number.parseInt(process.env.MM_BOT_FETCH_TIMEOUT_MS || "45000", 10),
);
const SIZE_CAP = process.env.MM_BOT_SIZE || "25";
const LEV = Math.min(125, Math.max(1, Number.parseInt(process.env.MM_BOT_LEVERAGE || "5", 10)));
const DRY = ["1", "true", "yes"].includes((process.env.MM_BOT_DRY_RUN || "").toLowerCase());
const MODE = (process.env.MM_BOT_MODE || "book").toLowerCase() === "oracle" ? "oracle" : "book";
/** When book mode has no resting orders, optionally post oracle-backed trades (default off). */
const ORACLE_FALLBACK = !["0", "false", "no"].includes(
  (process.env.MM_BOT_ORACLE_FALLBACK ?? "0").toLowerCase(),
);

async function apiGet(url: string): Promise<Response> {
  return fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
}

/** POST with no client-side wait limit — pipeline can run a long time before any response bytes. */
function postJsonLongRunning(urlStr: string, jsonBody: Record<string, unknown>): Promise<{
  statusCode: number;
  raw: string;
}> {
  const payload = JSON.stringify(jsonBody);
  const url = new URL(urlStr);
  const isHttps = url.protocol === "https:";
  const lib = isHttps ? https : http;
  const defaultPort = isHttps ? 443 : 80;
  const port = url.port ? Number(url.port) : defaultPort;
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: url.hostname,
        port,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          "Content-Length": Buffer.byteLength(payload, "utf8"),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 0,
            raw: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("request socket timeout (internal)"));
    });
    req.setTimeout(0);
    req.write(payload);
    req.end();
  });
}

function formatNodeErr(e: unknown): string {
  if (!(e instanceof Error)) return String(e);
  const parts = [e.message];
  let c: unknown = e.cause;
  let depth = 0;
  while (c instanceof Error && depth++ < 5) {
    parts.push(`cause: ${c.message}`);
    c = c.cause;
  }
  return parts.join(" | ");
}

type BookLevel = { price: number; size: number; commitmentHex: string };
type OrderbookJson = {
  bids?: BookLevel[];
  asks?: BookLevel[];
};

function marginStr(size: number, price: number, lev: number): string {
  const m = (size * price) / lev;
  return m.toFixed(8).replace(/\.?0+$/, "");
}

async function oraclePrice(): Promise<number> {
  const r = await apiGet(`${API}/api/oracle?pair=ADA-USD`);
  const j = (await r.json()) as { indexPrice?: number; error?: string };
  if (!r.ok) throw new Error(j.error || `oracle ${r.status}`);
  if (typeof j.indexPrice !== "number" || !Number.isFinite(j.indexPrice)) {
    throw new Error("bad indexPrice");
  }
  return j.indexPrice;
}

async function fetchOrderbook(): Promise<{ bids: BookLevel[]; asks: BookLevel[] }> {
  const r = await apiGet(`${API}/api/orderbook?pair=ADA-USD&levels=24&resting=1`);
  const j = (await r.json()) as OrderbookJson & { error?: string };
  if (!r.ok) throw new Error(j.error || `orderbook ${r.status}`);
  const bids = Array.isArray(j.bids) ? j.bids : [];
  const asks = Array.isArray(j.asks) ? j.asks : [];
  return { bids, asks };
}

/** Price string stable for API / margin check */
function priceStr(p: number): string {
  if (!Number.isFinite(p) || p <= 0) return "";
  if (p >= 1) return p.toFixed(6).replace(/\.?0+$/, "");
  return p.toFixed(8).replace(/\.?0+$/, "");
}

/** Size string from base units */
function sizeStr(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "";
  return s.toFixed(8).replace(/\.?0+$/, "");
}

type Planned = {
  side: "long" | "short";
  price: string;
  size: string;
  margin: string;
  source: "book_bid" | "book_ask" | "oracle";
};

function parseCap(): number {
  const n = Number.parseFloat(SIZE_CAP);
  return Number.isFinite(n) && n > 0 ? n : 25;
}

/** Max base (ADA) to take from resting book per tick — can exceed `MM_BOT_SIZE` to fill user limits faster. */
function parseRestingCap(): number {
  const raw = process.env.MM_BOT_RESTING_SIZE?.trim();
  if (raw) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n) && n > 0) return Math.min(1e9, n);
  }
  return parseCap();
}

/**
 * Cross top of resting book: sell into best bid (short), buy from best ask (long).
 * Alternates bid vs ask when both exist so both sides get hit over time.
 * `restingCap` controls max ADA taken per level (use `MM_BOT_RESTING_SIZE` to fill larger limits).
 */
function planFromBook(
  bids: BookLevel[],
  asks: BookLevel[],
  tick: number,
  restingCap: number,
): Planned | null {
  const bestBid = bids[0];
  const bestAsk = asks[0];

  if (!bestBid && !bestAsk) return null;

  let side: "long" | "short";
  let px: number;
  let sz: number;
  let source: Planned["source"];
  const bookSource: "book_bid" | "book_ask" =
    bestBid && bestAsk ? (tick % 2 === 0 ? "book_bid" : "book_ask") : bestBid ? "book_bid" : "book_ask";

  if (bookSource === "book_bid" && bestBid) {
    side = "short";
    px = bestBid.price;
    sz = Math.min(bestBid.size, restingCap);
    source = "book_bid";
  } else if (bestAsk) {
    side = "long";
    px = bestAsk.price;
    sz = Math.min(bestAsk.size, restingCap);
    source = "book_ask";
  } else if (bestBid) {
    side = "short";
    px = bestBid.price;
    sz = Math.min(bestBid.size, restingCap);
    source = "book_bid";
  } else {
    return null;
  }

  if (!(px > 0) || !(sz > 0)) return null;

  const pS = priceStr(px);
  const sS = sizeStr(sz);
  if (!pS || !sS) return null;

  return {
    side,
    price: pS,
    size: sS,
    margin: marginStr(sz, px, LEV),
    source,
  };
}

function planFromOracle(price: number, tick: number, cap: number): Planned {
  const side = tick % 2 === 0 ? "long" : "short";
  const sz = cap;
  return {
    side,
    price: priceStr(price),
    size: sizeStr(sz),
    margin: marginStr(sz, price, LEV),
    source: "oracle",
  };
}

let tick = 0;

async function tickOnce(): Promise<void> {
  const cap = parseCap();
  const restingCap = parseRestingCap();
  let planned: Planned | null = null;

  const t0 = new Date().toISOString();

  if (MODE === "oracle") {
    console.log(
      `[mm-bot] ${t0} tick ${tick}: requesting /api/oracle (timeout ${FETCH_TIMEOUT_MS}ms)…`,
    );
    const price = await oraclePrice();
    planned = planFromOracle(price, tick, cap);
  } else {
    console.log(
      `[mm-bot] ${t0} tick ${tick}: requesting /api/orderbook?resting=1 (timeout ${FETCH_TIMEOUT_MS}ms)…`,
    );
    const { bids, asks } = await fetchOrderbook();
    const fromBook = planFromBook(bids, asks, tick, restingCap);
    if (fromBook) {
      planned = fromBook;
      console.log(
        `[mm-bot] ${new Date().toISOString()} resting liquidity: bids=${bids.length} asks=${asks.length} → take ${fromBook.source} (cap=${restingCap} ADA)`,
      );
    } else if (ORACLE_FALLBACK) {
      console.log(
        `[mm-bot] ${new Date().toISOString()} no resting orders — oracle fallback (MM_BOT_ORACLE_FALLBACK=1)`,
      );
      const mark = await oraclePrice();
      planned = planFromOracle(mark, tick, cap);
    } else {
      console.log(
        `[mm-bot] ${new Date().toISOString()} no resting orders — skip (MM_BOT_ORACLE_FALLBACK=0)`,
      );
    }
  }

  tick += 1;

  if (!planned) {
    return;
  }

  const body = {
    side: planned.side,
    price: planned.price,
    size: planned.size,
    leverage: LEV,
    margin: planned.margin,
  };
  const ts = new Date().toISOString();
  console.log(
    `[mm-bot] ${ts} planned source=${planned.source} side=${planned.side} price=${body.price} size=${body.size}`,
  );
  if (DRY) {
    console.log(
      `[mm-bot] ${ts} DRY_RUN mode=${MODE} — skipping POST`,
    );
    return;
  }
  console.log(
    `[mm-bot] ${ts} POST /api/trade/submit — may return quickly (order resting), or wait many minutes on a match + full pipeline. Do not assume a hang.`,
  );
  let statusCode: number;
  let raw: string;
  try {
    const res = await postJsonLongRunning(`${API}/api/trade/submit`, body);
    statusCode = res.statusCode;
    raw = res.raw;
  } catch (e) {
    console.error(`[mm-bot] ${ts} POST transport error: ${formatNodeErr(e)}`);
    return;
  }
  let j: { error?: string; status?: string; ok?: boolean; matched?: boolean };
  try {
    j = raw.trim()
      ? (JSON.parse(raw) as { error?: string; status?: string; ok?: boolean; matched?: boolean })
      : {};
  } catch {
    console.error(`[mm-bot] ${ts} FAIL non-JSON (HTTP ${statusCode}):`, raw.slice(0, 300));
    return;
  }
  if (statusCode < 200 || statusCode >= 300) {
    console.error(`[mm-bot] ${ts} FAIL HTTP ${statusCode}`, j.error || raw.slice(0, 200));
    return;
  }
  console.log(
    `[mm-bot] ${ts} OK mode=${MODE} source=${planned.source} side=${planned.side} status=${j.status ?? "?"} matched=${String(j.matched ?? "")}`,
  );
}

async function main(): Promise<void> {
  console.log(
    `[mm-bot] API=${API} interval_ms=${INTERVAL_MS} fetch_timeout_ms=${FETCH_TIMEOUT_MS} size_cap=${SIZE_CAP} resting_cap=${parseRestingCap()} oracle_fallback=${ORACLE_FALLBACK} leverage=${LEV} mode=${MODE} dry_run=${DRY}`,
  );
  for (;;) {
    try {
      await tickOnce();
    } catch (e) {
      console.error("[mm-bot]", formatNodeErr(e));
    }
    await new Promise((r) => setTimeout(r, INTERVAL_MS));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
