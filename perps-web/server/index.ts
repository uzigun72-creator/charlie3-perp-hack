import { loadPerpsEnv } from "./loadEnv.js";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { randomUUID } from "node:crypto";
import type { OrderCommitmentInput } from "../../src/order/commitment.js";
import { traderLegFromPayload, type TraderSubmitPayload } from "./mapTrade.js";
import {
  addRestingFromPayload,
  getRestingBookSummary,
  listRestingOrders,
  matchAndConsume,
  matchRestingCrossOnce,
  restoreResting,
  snapshotResting,
} from "./restingBook.js";
import {
  appendPending,
  commitmentHexes,
  listEntries,
  updateEntry,
  type OrderIndexEntry,
} from "./orderIndex.js";
import {
  fetchOracleAndSubmitCharli3Pull,
  runFullPipelineTrade,
  useMidnightMatchingContract,
} from "./tradeOrchestrator.js";
import { cardanoConfirmFromHashesOrVisibility } from "./blockfrostPoll.js";
import { getVerifiedIndexPrice, type VerifiedIndexPrice } from "../../src/charli3/price_feed.js";
import {
  allowUserPaysCardanoL1,
  blockfrostConfig,
  cardanoBackend,
  cardanoCollateralViaMarginPool,
} from "../../src/config/cardano_env.js";
import { liquidationMark, parseNum, defaultPerpUiConfig } from "../../scripts/perp_ui.js";
import { getOracleOutRef, settlementAnchorBlueprintJson } from "./cardanoL1Support.js";
import { getCardanoWalletSummary } from "./cardanoWallet.js";
import { cardanoTxExplorerUrl, midnightTxExplorerUrl } from "./explorerUrls.js";
import { getMarketStats } from "./marketStats.js";
import { lookupOrderIds } from "./orderLookup.js";
import { registerMarginPoolRoutes } from "./marginPool.js";
import {
  assertAdminAuth,
  getMidnightJob,
  listMidnightJobs,
  midnightSetupSnapshot,
  startFundDerivedJob,
  startParallelCliJob,
} from "./midnightSetup.js";

loadPerpsEnv();

const app = new Hono();
registerMarginPoolRoutes(app);

/** One pipeline at a time — concurrent `run-all` + Cardano txs can OOM the API and duplicate Midnight retries. */
let tradePipelineInFlight = false;

app.use(
  "*",
  cors({
    origin: ["http://localhost:5173", "http://127.0.0.1:5173"],
  }),
);

app.get("/api/health", async (c) => {
  const proof = process.env.MIDNIGHT_PROOF_SERVER || "http://127.0.0.1:6300";
  let proofOk = false;
  try {
    const r = await fetch(proof, { signal: AbortSignal.timeout(2000) });
    proofOk = r.ok;
  } catch {
    proofOk = false;
  }
  let cardanoOk = false;
  try {
    if (cardanoBackend() === "blockfrost") {
      blockfrostConfig();
      cardanoOk = true;
    }
  } catch {
    cardanoOk = false;
  }
  return c.json({
    ok: proofOk && cardanoOk,
    proofServer: proof,
    proofServerReachable: proofOk,
    cardanoConfigured: cardanoOk,
    midnightSetup: {
      configured: Boolean(process.env.PERPS_ADMIN_SECRET?.trim()),
      get: "/api/midnight/setup",
    },
  });
});

/** Midnight HD workers: env defaults + which npm scripts the API can spawn (fund derived wallets, parallel CLI). */
app.get("/api/midnight/setup", (c) => {
  return c.json(midnightSetupSnapshot());
});

/** Fund HD-derived Midnight wallets from index 0 + DUST (long-running). Requires `PERPS_ADMIN_SECRET`. */
app.post("/api/midnight/fund-derived", async (c) => {
  const denied = assertAdminAuth(c);
  if (denied) return denied;
  let body: { funderIndex?: number; indices?: number[]; transferAmount?: string } = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object") {
      body = raw as typeof body;
    }
  } catch {
    body = {};
  }
  const job = startFundDerivedJob(body);
  return c.json(
    {
      ok: true,
      jobId: job.id,
      pid: job.pid,
      status: job.status,
      poll: `/api/midnight/jobs/${job.id}`,
    },
    202,
  );
});

/** Spawn N parallel `npm run … -w @charli3perp/cli` (default `run-all`, or `run-pipeline`). Requires `PERPS_ADMIN_SECRET`. */
app.post("/api/midnight/parallel-cli", async (c) => {
  const denied = assertAdminAuth(c);
  if (denied) return denied;
  let body: { count?: number; offset?: number; script?: string } = {};
  try {
    const raw = await c.req.json();
    if (raw && typeof raw === "object") {
      body = raw as typeof body;
    }
  } catch {
    body = {};
  }
  const started = startParallelCliJob(body);
  if (!started.ok) {
    return c.json({ ok: false, error: started.error }, 400);
  }
  const job = started.job;
  return c.json(
    {
      ok: true,
      jobId: job.id,
      pid: job.pid,
      status: job.status,
      poll: `/api/midnight/jobs/${job.id}`,
    },
    202,
  );
});

/** List recent Midnight maintenance jobs (admin). */
app.get("/api/midnight/jobs", (c) => {
  const denied = assertAdminAuth(c);
  if (denied) return denied;
  const limit = Math.min(50, Math.max(1, Number.parseInt(c.req.query("limit") || "20", 10) || 20));
  return c.json({ jobs: listMidnightJobs(limit) });
});

app.get("/api/midnight/jobs/:id", (c) => {
  const denied = assertAdminAuth(c);
  if (denied) return denied;
  const id = c.req.param("id")?.trim();
  if (!id) {
    return c.json({ error: "missing id" }, 400);
  }
  const job = getMidnightJob(id);
  if (!job) {
    return c.json({ error: "job not found" }, 404);
  }
  return c.json(job);
});

app.get("/api/oracle", async (c) => {
  const pair = c.req.query("pair") || "ADA-USD";
  try {
    const v = await getVerifiedIndexPrice(pair);
    return c.json({
      pairId: v.pairId,
      indexPrice: v.indexPrice,
      markPrice: v.markPrice,
      timestampMs: v.timestampMs,
      datumHash: v.datumHash,
      outRef: v.outRef,
    });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Volume, resting liquidity (USD notional), spread, trade counts — for the Trade UI stats bar. */
app.get("/api/stats", async (c) => {
  const pair = c.req.query("pair") || "ADA-USD";
  try {
    const s = await getMarketStats(pair);
    return c.json(s);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Order book: resting liquidity + optional confirmed trade legs. Pass `resting=1` to return **only** live resting orders (MM bot uses this to cross user-placed quotes, not historical index rows). */
app.get("/api/orderbook", async (c) => {
  const levels = Math.min(24, Math.max(4, Number(c.req.query("levels")) || 12));
  const restingOnly = ["1", "true", "yes"].includes((c.req.query("resting") || "").toLowerCase());
  const entries = await listEntries();
  const confirmed = entries.filter((e) => e.status === "confirmed");

  type Row = { price: number; size: number; side: "bid" | "ask"; commitmentHex: string };

  /** Sum size at each price level (avoids repeated-price rows from many small orders / index legs). */
  function aggregateByPriceLevel(raw: Row[]): Row[] {
    const map = new Map<string, Row>();
    for (const r of raw) {
      const key = `${r.side}:${r.price.toFixed(10)}`;
      const prev = map.get(key);
      if (prev) {
        prev.size += r.size;
      } else {
        map.set(key, { ...r });
      }
    }
    return [...map.values()];
  }

  const rows: Row[] = [];

  const resting = await listRestingOrders();
  for (const o of resting) {
    if (o.pairId !== "ADA-USD") continue;
    const p = parseNum(o.price);
    const sz = parseNum(o.size);
    if (!Number.isFinite(p) || p <= 0 || !Number.isFinite(sz) || sz <= 0) continue;
    if (o.side === "LONG") {
      rows.push({ price: p, size: sz, side: "bid", commitmentHex: `resting:${o.id}` });
    } else {
      rows.push({ price: p, size: sz, side: "ask", commitmentHex: `resting:${o.id}` });
    }
  }

  if (!restingOnly) {
    for (const e of confirmed) {
      const bp = parseNum(e.bid.price);
      const bs = parseNum(e.bid.size);
      const ap = parseNum(e.ask.price);
      const asz = parseNum(e.ask.size);
      if (Number.isFinite(bp) && bp > 0 && Number.isFinite(bs) && bs > 0) {
        rows.push({ price: bp, size: bs, side: "bid", commitmentHex: e.bidCommitmentHex });
      }
      if (Number.isFinite(ap) && ap > 0 && Number.isFinite(asz) && asz > 0) {
        rows.push({ price: ap, size: asz, side: "ask", commitmentHex: e.askCommitmentHex });
      }
    }
  }

  const merged = aggregateByPriceLevel(rows);

  /** Bids: best bid (highest) first — matches CLOB / mm-bot `bids[0]`. */
  const bids = merged
    .filter((r) => r.side === "bid")
    .sort((a, b) => b.price - a.price)
    .slice(0, levels);
  /** Asks: best ask (lowest) first — matches mm-bot `asks[0]`; UI may reverse for display. */
  const asks = merged
    .filter((r) => r.side === "ask")
    .sort((a, b) => a.price - b.price)
    .slice(0, levels);

  return c.json({
    pairId: "ADA-USD",
    bids,
    asks,
    totalConfirmed: confirmed.length,
    restingOrders: resting.filter((o) => o.pairId === "ADA-USD").length,
    restingOnly,
    aggregatedLevels: true,
  });
});

/** Resting-only best bid/ask and whether the book is crossed (auto-match eligible). Ignores historical index rows. */
app.get("/api/matching/status", async (c) => {
  const s = await getRestingBookSummary("ADA-USD");
  return c.json({
    ...s,
    hint: s.crossed
      ? "crossed: a submit or in-flight sweep can match and run the pipeline"
      : "not_crossed: need a resting long price >= resting short price (e.g. long at 0.26 vs short at 0.24)",
  });
});

/** Look up resting order IDs and/or trade pipeline IDs from this session. Body: `{ "ids": ["uuid", ...] }` (max 20). */
app.post("/api/orders/lookup", async (c) => {
  let body: { ids?: unknown };
  try {
    body = (await c.req.json()) as { ids?: unknown };
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const ids = Array.isArray(body.ids)
    ? (body.ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
  if (ids.length > 20) {
    return c.json({ error: "At most 20 ids per request" }, 400);
  }
  try {
    const orders = await lookupOrderIds(ids);
    return c.json({ orders });
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** Cardano Preprod wallet from `WALLET_MNEMONIC` (tADA balance via Blockfrost). */
app.get("/api/cardano/wallet", async (c) => {
  try {
    const w = await getCardanoWalletSummary();
    if (!w.ok) {
      return c.json({ error: w.error }, 503);
    }
    return c.json(w);
  } catch (e) {
    return c.json(
      { error: e instanceof Error ? e.message : String(e) },
      500,
    );
  }
});

/** C3AS oracle UTxO ref for building Charli3 pull in the browser (same as server pull tx). */
app.get("/api/cardano/oracle-ref", async (c) => {
  const pair = c.req.query("pair") || "ADA-USD";
  try {
    const ref = await getOracleOutRef(pair);
    return c.json(ref);
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 502);
  }
});

/** Plutus blueprint JSON for settlement anchor script (browser Lucid). */
app.get("/api/cardano/settlement-anchor-blueprint", async (c) => {
  try {
    return c.json(settlementAnchorBlueprintJson());
  } catch (e) {
    return c.json({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});

/** After browser-signed Charli3 pull + settlement anchor, record hashes and confirm the trade. */
app.post("/api/trade/user-l1-complete", async (c) => {
  let body: { id?: string; charli3PullTxHash?: string; settlementAnchorTxHash?: string };
  try {
    body = (await c.req.json()) as typeof body;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const id = body.id?.trim();
  const pull = body.charli3PullTxHash?.replace(/^0x/i, "").toLowerCase().trim();
  const anchor = body.settlementAnchorTxHash?.replace(/^0x/i, "").toLowerCase().trim();
  if (!id || !pull || !anchor) {
    return c.json({ error: "id, charli3PullTxHash, settlementAnchorTxHash required" }, 400);
  }
  if (!/^[0-9a-f]{64}$/.test(pull) || !/^[0-9a-f]{64}$/.test(anchor)) {
    return c.json({ error: "tx hashes must be 64 hex chars" }, 400);
  }
  const entries = await listEntries();
  const entry = entries.find((e) => e.id === id);
  if (!entry) return c.json({ error: "trade not found" }, 404);
  if (entry.status !== "pending_user_l1") {
    return c.json({ error: "trade is not waiting for user L1 steps" }, 400);
  }
  const { pullOk, anchorOk } = await cardanoConfirmFromHashesOrVisibility(pull, anchor);
  const bindOk = (entry.midnightBindTxHash?.length ?? 0) > 0;
  const matchOk =
    !useMidnightMatchingContract() || (entry.midnightMatchingSealTxHash?.length ?? 0) > 0;
  const midnightOk = bindOk && matchOk;
  const confirmed = Boolean(pullOk && anchorOk && midnightOk);
  await updateEntry(id, {
    charli3PullTxHash: pull,
    settlementAnchorTxHash: anchor,
    status: confirmed ? "confirmed" : "pending",
    confirmedAt: confirmed ? new Date().toISOString() : undefined,
    oracleIndexPrice: confirmed ? entry.oracleIndexPrice : entry.oracleIndexPrice,
  });
  return c.json({
    ok: true,
    status: confirmed ? "confirmed" : "pending",
    charli3PullTxHash: pull,
    settlementAnchorTxHash: anchor,
    explorers: {
      charli3Pull: cardanoTxExplorerUrl(pull),
      settlementAnchor: cardanoTxExplorerUrl(anchor),
    },
  });
});

/** Confirmed fills from local index (L1+L2 anchored trades) with explorer links. */
app.get("/api/account/fills", async (c) => {
  const entries = await listEntries();
  const confirmed = entries.filter((e) => e.status === "confirmed");
  const fills = confirmed.map((e) => ({
    id: e.id,
    pairId: e.bid.pairId,
    bid: {
      side: e.bid.side,
      price: e.bid.price,
      size: e.bid.size,
      leverage: e.bid.leverage,
    },
    ask: {
      side: e.ask.side,
      price: e.ask.price,
      size: e.ask.size,
      leverage: e.ask.leverage,
    },
    bidCommitmentHex: e.bidCommitmentHex,
    askCommitmentHex: e.askCommitmentHex,
    oracleIndexPriceAtFill: e.oracleIndexPrice,
    charli3PullTxHash: e.charli3PullTxHash,
    settlementAnchorTxHash: e.settlementAnchorTxHash,
    midnightBindTxHash: e.midnightBindTxHash,
    midnightMatchingSealTxHash: e.midnightMatchingSealTxHash,
    explorers: {
      charli3Pull: e.charli3PullTxHash ? cardanoTxExplorerUrl(e.charli3PullTxHash) : null,
      settlementAnchor: e.settlementAnchorTxHash ? cardanoTxExplorerUrl(e.settlementAnchorTxHash) : null,
    },
    confirmedAt: e.confirmedAt,
    createdAt: e.createdAt,
  }));
  return c.json({ fills, total: fills.length });
});

/**
 * All trades from the local index with Midnight + Cardano transaction hashes and explorer URLs
 * for manual verification on chain explorers.
 */
app.get("/api/explorer/trades", async (c) => {
  const entries = await listEntries();
  const cardanoNetwork = (process.env.CARDANO_NETWORK || "Preprod").trim();
  const trades = entries.map((e) => {
    const mh = e.midnightBindTxHash?.trim() ?? "";
    const mm = e.midnightMatchingSealTxHash?.trim() ?? "";
    const pull = e.charli3PullTxHash?.trim() ?? "";
    const anchor = e.settlementAnchorTxHash?.trim() ?? "";
    const steps = [
      {
        key: "midnight_bind" as const,
        label: "Midnight — bind / order deploy",
        chain: "midnight" as const,
        txHash: mh || null,
        explorerUrl: mh ? midnightTxExplorerUrl(mh) : null,
      },
      {
        key: "midnight_matching_seal" as const,
        label: "Midnight — matching (sealMatchRecord)",
        chain: "midnight" as const,
        txHash: mm || null,
        explorerUrl: mm ? midnightTxExplorerUrl(mm) : null,
      },
      {
        key: "charli3_pull" as const,
        label: "Cardano — Charli3 oracle reference",
        chain: "cardano" as const,
        txHash: pull || null,
        explorerUrl: pull ? cardanoTxExplorerUrl(pull) : null,
      },
      {
        key: "settlement_anchor" as const,
        label: "Cardano — settlement anchor",
        chain: "cardano" as const,
        txHash: anchor || null,
        explorerUrl: anchor ? cardanoTxExplorerUrl(anchor) : null,
      },
    ];
    return {
      id: e.id,
      status: e.status,
      pairId: e.bid.pairId,
      createdAt: e.createdAt,
      confirmedAt: e.confirmedAt,
      error: e.error,
      bidCommitmentHex: e.bidCommitmentHex,
      askCommitmentHex: e.askCommitmentHex,
      steps,
    };
  });
  return c.json({
    trades,
    total: trades.length,
    networks: {
      cardano: cardanoNetwork,
      midnight: "Preview",
    },
  });
});

/** Isolated perp: initial margin (quote) = (size × price) / leverage. */
function assertInitialMarginConsistent(body: TraderSubmitPayload): string | null {
  const p = parseNum(body.price);
  const s = parseNum(body.size);
  const m = parseNum(body.margin);
  const lev = body.leverage;
  if (!Number.isFinite(p) || !Number.isFinite(s) || !Number.isFinite(m) || !(lev >= 1)) {
    return "Invalid price, size, leverage, or margin";
  }
  if (!(p > 0 && s > 0 && m > 0)) {
    return "price, size, and margin must be positive";
  }
  const expected = (s * p) / lev;
  const tol = 1e-5 * Math.max(1, Math.abs(expected));
  if (Math.abs(m - expected) > tol) {
    return `Initial margin must equal (size × price) / leverage (expected ≈ ${expected.toFixed(6)} USD for isolated margin)`;
  }
  return null;
}

type PipelineJson = Record<string, unknown>;

async function runFullPipelineForBidAsk(
  bid: OrderCommitmentInput,
  ask: OrderCommitmentInput,
  bookSnapshot: Awaited<ReturnType<typeof snapshotResting>>,
  flags: {
    autoMatched?: boolean;
    userPaysCardano?: boolean;
    /** Parallel Midnight worker (HD index + isolated private state). */
    midnightDeriveKeyIndex?: number;
    /** One Charli3 pull + oracle shared across a parallel sweep batch (set both). */
    sharedOracle?: VerifiedIndexPrice;
    sharedCharli3PullTxHash?: string;
  },
): Promise<
  { ok: true; data: PipelineJson } | { ok: false; status: 500; data: PipelineJson }
> {
  const hex = commitmentHexes(bid, ask);
  const id = randomUUID();
  const now = new Date().toISOString();
  const pending: OrderIndexEntry = {
    id,
    status: "pending",
    bid,
    ask,
    bidCommitmentHex: hex.bidCommitmentHex,
    askCommitmentHex: hex.askCommitmentHex,
    createdAt: now,
  };
  try {
    await appendPending(pending);
    const pipelineResult = await runFullPipelineTrade(bid, ask, {
      userPaysCardano: flags.userPaysCardano === true,
      ...(flags.midnightDeriveKeyIndex !== undefined
        ? { midnightDeriveKeyIndex: flags.midnightDeriveKeyIndex }
        : {}),
      ...(flags.sharedOracle !== undefined && flags.sharedCharli3PullTxHash !== undefined
        ? {
            sharedOracle: flags.sharedOracle,
            sharedCharli3PullTxHash: flags.sharedCharli3PullTxHash,
          }
        : {}),
    });

    if (pipelineResult.userPaysCardano && pipelineResult.cardanoSession) {
      await updateEntry(id, {
        midnightBindTxHash: pipelineResult.midnightBindTxHash,
        midnightMatchingSealTxHash: pipelineResult.midnightMatchingSealTxHash,
        pipelineLogTail: pipelineResult.pipelineStdout.slice(-8000),
        status: "pending_user_l1",
        oracleIndexPrice: pipelineResult.oracle.indexPrice,
      });
      return {
        ok: true,
        data: {
          ok: true,
          matched: true,
          ...(flags.autoMatched ? { autoMatched: true } : {}),
          id,
          needsUserCardano: true,
          tradeId: id,
          cardanoSession: pipelineResult.cardanoSession,
          midnightBindTxHash: pipelineResult.midnightBindTxHash,
          midnightMatchingSealTxHash: pipelineResult.midnightMatchingSealTxHash,
          bidCommitmentHex: hex.bidCommitmentHex,
          askCommitmentHex: hex.askCommitmentHex,
          indexPrice: pipelineResult.oracle.indexPrice,
          status: "pending_user_l1",
        },
      };
    }

    const { pullOk, anchorOk } = await cardanoConfirmFromHashesOrVisibility(
      pipelineResult.charli3PullTxHash,
      pipelineResult.settlementAnchorTxHash,
    );
    const bindOk = pipelineResult.midnightBindTxHash.length > 0;
    const matchOk =
      !useMidnightMatchingContract() || pipelineResult.midnightMatchingSealTxHash.length > 0;
    const midnightOk = bindOk && matchOk;

    const confirmed = Boolean(pullOk && anchorOk && midnightOk);
    await updateEntry(id, {
      charli3PullTxHash: pipelineResult.charli3PullTxHash,
      settlementAnchorTxHash: pipelineResult.settlementAnchorTxHash,
      midnightBindTxHash: pipelineResult.midnightBindTxHash,
      midnightMatchingSealTxHash: pipelineResult.midnightMatchingSealTxHash,
      pipelineLogTail: pipelineResult.pipelineStdout.slice(-8000),
      status: confirmed ? "confirmed" : "pending",
      confirmedAt: confirmed ? new Date().toISOString() : undefined,
      oracleIndexPrice: confirmed ? pipelineResult.oracle.indexPrice : undefined,
    });

    return {
      ok: true,
      data: {
        ok: true,
        matched: true,
        ...(flags.autoMatched ? { autoMatched: true } : {}),
        id,
        charli3PullTxHash: pipelineResult.charli3PullTxHash,
        settlementAnchorTxHash: pipelineResult.settlementAnchorTxHash,
        midnightBindTxHash: pipelineResult.midnightBindTxHash,
        midnightMatchingSealTxHash: pipelineResult.midnightMatchingSealTxHash,
        bidCommitmentHex: hex.bidCommitmentHex,
        askCommitmentHex: hex.askCommitmentHex,
        explorers: {
          charli3Pull: pipelineResult.charli3PullExplorer,
          settlementAnchor: pipelineResult.settlementAnchorExplorer,
        },
        indexPrice: pipelineResult.oracle.indexPrice,
        status: confirmed ? "confirmed" : "pending",
      },
    };
  } catch (e) {
    await restoreResting(bookSnapshot);
    const msg = e instanceof Error ? e.message : String(e);
    await updateEntry(id, { error: msg });
    return { ok: false, status: 500, data: { ok: false, id, error: msg } };
  }
}

function parallelSweepMatchesEnabled(): boolean {
  return (process.env.PERPS_PARALLEL_SWEEP_MATCHES ?? "1").trim() !== "0";
}

function midnightWorkerPoolSize(): number {
  return Math.max(1, Number.parseInt(process.env.PERPS_MIDNIGHT_WORKER_POOL_SIZE || "5", 10) || 5);
}

function midnightWorkerOffset(): number {
  return Math.max(0, Number.parseInt(process.env.PERPS_MIDNIGHT_WORKER_OFFSET || "1", 10) || 1);
}

const SWEEP_PAIR_ID = "ADA-USD";

/**
 * Repeatedly match crossed resting bid/ask until the book is uncrossed or a pipeline fails.
 * When `PERPS_PARALLEL_SWEEP_MATCHES=1` (default) and `CARDANO_COLLATERAL_VIA_MARGIN_POOL` is off,
 * collects all crosses first and runs **full pipelines in parallel** (distinct `midnightDeriveKeyIndex`
 * + isolated private state, one shared Charli3 pull per sweep). Settlement anchors are serialized
 * inside the orchestrator to avoid wallet UTxO races.
 */
async function sweepRestingCrosses(): Promise<
  | { ok: true; data: PipelineJson }
  | { ok: false; status: 500; data: PipelineJson }
  | null
> {
  const useParallelSweep =
    parallelSweepMatchesEnabled() && !cardanoCollateralViaMarginPool();

  if (!useParallelSweep) {
    let last: { ok: true; data: PipelineJson } | null = null;
    for (;;) {
      const snap = await snapshotResting();
      const cross = await matchRestingCrossOnce();
      if (cross.kind === "no_match") break;
      const r = await runFullPipelineForBidAsk(cross.bid, cross.ask, snap, { autoMatched: true });
      if (!r.ok) return r;
      last = r;
    }
    return last;
  }

  const snap = await snapshotResting();
  const crosses: Array<{ bid: OrderCommitmentInput; ask: OrderCommitmentInput }> = [];
  for (;;) {
    const cross = await matchRestingCrossOnce();
    if (cross.kind === "no_match") break;
    crosses.push({ bid: cross.bid, ask: cross.ask });
  }
  if (crosses.length === 0) return null;

  if (crosses.length === 1) {
    console.log(
      `[perps-api] sweep: single cross (one pipeline; batch Promise.all needs 2+ crosses — HD worker still round-robin via orchestrator). pair=${SWEEP_PAIR_ID}`,
    );
    return runFullPipelineForBidAsk(crosses[0]!.bid, crosses[0]!.ask, snap, { autoMatched: true });
  }

  let shared: Awaited<ReturnType<typeof fetchOracleAndSubmitCharli3Pull>>;
  try {
    shared = await fetchOracleAndSubmitCharli3Pull(SWEEP_PAIR_ID);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await restoreResting(snap);
    return { ok: false, status: 500, data: { ok: false, error: msg, sweepRollback: true } };
  }

  const pool = midnightWorkerPoolSize();
  const offset = midnightWorkerOffset();
  let last: { ok: true; data: PipelineJson } | null = null;

  console.log(
    `[perps-api] sweep: parallel batch crosses=${crosses.length} pool=${pool} derive_offset=${offset} shared_charli3_pull (one per batch)`,
  );

  for (let i = 0; i < crosses.length; i += pool) {
    const chunk = crosses.slice(i, i + pool);
    console.log(
      `[perps-api] sweep: parallel chunk ${i / pool + 1} size=${chunk.length} derive=${offset}…${offset + chunk.length - 1}`,
    );
    const results = await Promise.all(
      chunk.map((c, j) =>
        runFullPipelineForBidAsk(c.bid, c.ask, snap, {
          autoMatched: true,
          midnightDeriveKeyIndex: offset + j,
          sharedOracle: shared.oracle,
          sharedCharli3PullTxHash: shared.pullTxHash,
        }),
      ),
    );
    const failed = results.find((r) => !r.ok);
    if (failed) {
      await restoreResting(snap);
      console.error(
        "[perps-api] Parallel sweep failed after one or more pipelines; restored resting book snapshot. " +
          "If any Midnight/Cardano steps succeeded on-chain, reconcile manually.",
      );
      return failed;
    }
    last = results[results.length - 1]! as { ok: true; data: PipelineJson };
  }

  return last;
}

function applyMnemonicFromRequest(c: { req: { header: (n: string) => string | undefined } }): void {
  const allow = process.env.ALLOW_INSECURE_MNEMONIC_FROM_CLIENT === "1";
  if (!allow) return;
  const fromHeader = c.req.header("x-demo-mnemonic")?.trim();
  const fromEnv = process.env.VITE_BIP39_MNEMONIC?.trim();
  if (fromHeader) {
    process.env.BIP39_MNEMONIC = fromHeader;
  } else if (fromEnv) {
    process.env.BIP39_MNEMONIC = fromEnv;
  }
}

app.post("/api/trade/submit", async (c) => {
  applyMnemonicFromRequest(c);
  let body: TraderSubmitPayload;
  try {
    body = (await c.req.json()) as TraderSubmitPayload;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.side || (body.side !== "long" && body.side !== "short")) {
    return c.json({ error: "side must be 'long' or 'short'" }, 400);
  }
  if (!body.price || !body.size || body.leverage === undefined || !body.margin) {
    return c.json({ error: "price, size, leverage, margin required" }, 400);
  }

  const marginErr = assertInitialMarginConsistent(body);
  if (marginErr) {
    return c.json({ error: marginErr }, 400);
  }

  if (tradePipelineInFlight) {
    return c.json(
      {
        error:
          "Another trade pipeline is already running (Midnight + Cardano). Wait for it to finish before submitting again.",
      },
      429,
    );
  }

  const userPaysHeader = c.req.header("x-cardano-payer")?.toLowerCase() === "user";
  if (userPaysHeader && !allowUserPaysCardanoL1()) {
    return c.json(
      {
        error:
          "Set ALLOW_USER_PAYS_CARDANO_L1=1 on the API to use X-Cardano-Payer: user (browser-signed Charli3 + anchor).",
      },
      400,
    );
  }

  tradePipelineInFlight = true;
  try {
    const snap = await snapshotResting();
    const match = await matchAndConsume(body);
    if (match.kind === "match") {
      const first = await runFullPipelineForBidAsk(match.bid, match.ask, snap, {
        userPaysCardano: userPaysHeader,
      });
      if (!first.ok) return c.json(first.data, first.status);
      if (match.remainderPayload) {
        await addRestingFromPayload(match.remainderPayload);
      }
      const swept = await sweepRestingCrosses();
      if (swept) {
        if (!swept.ok) return c.json(swept.data, swept.status);
        return c.json(swept.data);
      }
      return c.json(first.data);
    }

    const rest = await addRestingFromPayload(body);
    const swept = await sweepRestingCrosses();
    if (swept) {
      if (!swept.ok) return c.json(swept.data, swept.status);
      return c.json(swept.data);
    }
    return c.json({
      ok: true,
      status: "resting",
      orderId: rest.id,
      side: rest.side,
      price: rest.price,
      size: rest.size,
      createdAt: rest.createdAt,
    });
  } finally {
    tradePipelineInFlight = false;
  }
});

/**
 * Append a single limit to the resting book only — **no** Midnight/Cardano pipeline and **no** wait on
 * `tradePipelineInFlight`. Use for seed scripts / MM resting quotes when a full pipeline may be running.
 * If the order would match a resting counterparty, the book is rolled back and the handler returns 409.
 * Does **not** run `sweepRestingCrosses` (that can start pipelines); normal `/api/trade/submit` still sweeps.
 */
app.post("/api/trade/rest-only", async (c) => {
  applyMnemonicFromRequest(c);
  let body: TraderSubmitPayload;
  try {
    body = (await c.req.json()) as TraderSubmitPayload;
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.side || (body.side !== "long" && body.side !== "short")) {
    return c.json({ error: "side must be 'long' or 'short'" }, 400);
  }
  if (!body.price || !body.size || body.leverage === undefined || !body.margin) {
    return c.json({ error: "price, size, leverage, margin required" }, 400);
  }

  const marginErr = assertInitialMarginConsistent(body);
  if (marginErr) {
    return c.json({ error: marginErr }, 400);
  }

  const snap = await snapshotResting();
  const match = await matchAndConsume(body);
  if (match.kind === "match") {
    await restoreResting(snap);
    return c.json(
      {
        error:
          "Order would match an existing resting quote. Widen price vs /api/matching/status or use /api/trade/submit to run the pipeline.",
      },
      409,
    );
  }

  const rest = await addRestingFromPayload(body);
  return c.json({
    ok: true,
    status: "resting",
    offchainOnly: true,
    orderId: rest.id,
    side: rest.side,
    price: rest.price,
    size: rest.size,
    createdAt: rest.createdAt,
  });
});

/** Risk estimate for ticket (trader leg only — no synthetic counterparty). */
app.post("/api/risk/estimate", async (c) => {
  let body: TraderSubmitPayload;
  try {
    body = (await c.req.json()) as TraderSubmitPayload;
  } catch {
    return c.json({ error: "Invalid JSON" }, 400);
  }
  const leg = traderLegFromPayload(body);
  const entry = parseNum(leg.price);
  const size = parseNum(leg.size);
  const collateral = parseNum(leg.margin);
  const side = leg.side;
  let mark: number | null = null;
  try {
    const o = await getVerifiedIndexPrice("ADA-USD");
    mark = o.indexPrice;
  } catch {
    mark = null;
  }
  const liq = liquidationMark(
    entry,
    size,
    collateral,
    side,
    defaultPerpUiConfig.maintenanceBps,
  );
  return c.json({
    estLiquidationPrice: liq,
    markPrice: mark,
    maintenanceBps: defaultPerpUiConfig.maintenanceBps,
    leg: side,
  });
});

app.notFound((c) => {
  if (c.req.path.startsWith("/api")) {
    return c.json(
      {
        error: `No API route ${c.req.method} ${c.req.path}. If you just pulled new code or the Account tab 404s, restart the perps API (stop \`npm run perps:dev\` and start it again).`,
      },
      404,
    );
  }
  return c.text("404 Not Found", 404);
});

const port = Number(process.env.PERPS_API_PORT || 8791);
console.log(`[perps-api] http://127.0.0.1:${port}`);
serve({ fetch: app.fetch, port, hostname: "127.0.0.1" });
