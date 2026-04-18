import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import {
  submitUserPaidCardanoL1,
  type CardanoSessionPayload,
} from "./userPaidCardano";

const AdaUsdChart = lazy(async () => {
  const m = await import("./components/AdaUsdChart");
  return { default: m.AdaUsdChart };
});

const AccountDashboard = lazy(async () => {
  const m = await import("./AccountDashboard");
  return { default: m.AccountDashboard };
});

const ExplorerPage = lazy(async () => {
  const m = await import("./ExplorerPage");
  return { default: m.ExplorerPage };
});

type Oracle = {
  indexPrice: number;
  pairId: string;
};

type Health = {
  ok: boolean;
  proofServerReachable: boolean;
  cardanoConfigured: boolean;
};

type Orderbook = {
  bids: Array<{ price: number; size: number; commitmentHex: string }>;
  asks: Array<{ price: number; size: number; commitmentHex: string }>;
  totalConfirmed: number;
  restingOrders?: number;
  /** API sums size per price level */
  aggregatedLevels?: boolean;
  /** When true, book is live resting orders only (avoids mirroring bid/ask from historical index legs). */
  restingOnly?: boolean;
};

type MarketStats = {
  pairId: string;
  markPrice: number;
  indexPrice: number;
  liquidityBidUsd: number;
  liquidityAskUsd: number;
  liquidityTotalUsd: number;
  spread: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  crossed: boolean;
  restingOrderCount: number;
  restingLongCount: number;
  restingShortCount: number;
  confirmedTrades: number;
  pendingTrades: number;
  volumeBase24h: number;
  volumeUsd24h: number;
  volumeBaseAllTime: number;
  volumeUsdAllTime: number;
};

type SubmitState = "idle" | "submitting" | "done" | "error";

type OrderLookupEntry =
  | {
      kind: "resting";
      side: "LONG" | "SHORT";
      price: string;
      size: string;
      createdAt: string;
    }
  | {
      kind: "trade";
      status: "pending" | "pending_user_l1" | "confirmed";
      error?: string;
      createdAt: string;
      confirmedAt?: string;
    }
  | { kind: "not_found" };

type TrackedOrderRow = {
  id: string;
  side: "long" | "short";
  price: string;
  size: string;
  at: string;
};

/** FIFO client queue when API returns 429 (pipeline mutex). */
type QueuedTrade = {
  id: string;
  side: "long" | "short";
  price: string;
  size: string;
  leverage: number;
  margin: string;
  userPaysCardano: boolean;
};

function orderStatusLabel(entry: OrderLookupEntry | undefined): string {
  if (!entry) return "…";
  if (entry.kind === "resting") return "Open";
  if (entry.kind === "not_found") return "Closed";
  if (entry.kind === "trade") {
    if (entry.error) return "Failed";
    if (entry.status === "confirmed") return "Confirmed";
    if (entry.status === "pending_user_l1") return "Sign Cardano";
    return "Settling";
  }
  return "—";
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id;
}

function formatPx(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 100) return n.toFixed(2);
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

/** Compact USD for liquidity / volume lines */
function formatUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}K`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return n.toFixed(2);
}

function formatAdaVol(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(2);
}

/** Order book size column — trim trailing zeros for whole numbers. */
function formatBookSize(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/\.?0+$/, "");
}

/** Relative width 0–100 for depth bars vs max visible size. */
function bookDepthPercent(size: number, maxSize: number): number {
  if (!(maxSize > 0) || !Number.isFinite(size)) return 0;
  return Math.min(100, Math.max(0, (size / maxSize) * 100));
}

/** Parse size/price strings (allows commas). */
function parseNumField(s: string): number {
  const n = Number.parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Isolated perp: notional (quote) = size × price, initial margin = notional / leverage.
 * Size = base (ADA), price = quote per base (USD), margin in quote (USD).
 */
function notionalUsd(size: string, price: string): number | null {
  const s = parseNumField(size);
  const p = parseNumField(price);
  if (!(s > 0 && p > 0)) return null;
  return s * p;
}

function initialMarginUsd(size: string, price: string, leverage: number): number | null {
  const n = notionalUsd(size, price);
  const lev = Number.isFinite(leverage) && leverage > 0 ? leverage : NaN;
  if (n === null || !Number.isFinite(lev) || lev < 1) return null;
  return n / lev;
}

function marginForSubmit(size: string, price: string, leverage: number): string {
  const m = initialMarginUsd(size, price, leverage);
  if (m === null) return "";
  return m.toFixed(8).replace(/\.?0+$/, "");
}

export function App() {
  const [oracle, setOracle] = useState<Oracle | null>(null);
  const [oracleAt, setOracleAt] = useState<number | null>(null);
  const [oracleErr, setOracleErr] = useState<string | null>(null);
  const [health, setHealth] = useState<Health | null>(null);
  const [book, setBook] = useState<Orderbook | null>(null);
  const [stats, setStats] = useState<MarketStats | null>(null);
  const [statsErr, setStatsErr] = useState<string | null>(null);

  const [side, setSide] = useState<"long" | "short">("long");
  const [price, setPrice] = useState("");
  const [size, setSize] = useState("100");
  const [leverage, setLeverage] = useState(5);

  const [riskText, setRiskText] = useState<string | null>(null);
  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitMessage, setSubmitMessage] = useState("");
  const [lastResult, setLastResult] = useState<Record<string, unknown> | null>(null);
  const [tab, setTab] = useState<"trade" | "account" | "explorer">("trade");
  const [trackedOrders, setTrackedOrders] = useState<TrackedOrderRow[]>([]);
  const [orderLookup, setOrderLookup] = useState<Record<string, OrderLookupEntry>>({});

  const submitQueueRef = useRef<QueuedTrade[]>([]);
  const flushQueueInFlightRef = useRef(false);
  const [queuedCount, setQueuedCount] = useState(0);
  const [queueBusy, setQueueBusy] = useState(false);

  const userPaysFeature = import.meta.env.VITE_USER_PAYS_CARDANO === "1";
  const [userPaysCardano, setUserPaysCardano] = useState(false);
  const [cip30WalletKey, setCip30WalletKey] = useState("");
  const [cip30Wallets, setCip30Wallets] = useState<string[]>([]);

  useEffect(() => {
    const w = typeof window !== "undefined" ? window.cardano : undefined;
    const keys = w ? Object.keys(w) : [];
    setCip30Wallets(keys);
    setCip30WalletKey((prev) => prev || keys[0] || "");
  }, []);

  const syncQueuedCount = useCallback(() => {
    setQueuedCount(submitQueueRef.current.length);
  }, []);

  const refreshOracle = useCallback(async () => {
    try {
      const r = await api("/api/oracle?pair=ADA-USD");
      const j = (await r.json()) as Oracle & { error?: string };
      if (!r.ok) throw new Error(j.error || "Oracle failed");
      setOracle({ indexPrice: j.indexPrice, pairId: j.pairId });
      setOracleAt(Date.now());
      setOracleErr(null);
    } catch (e) {
      setOracleErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const refreshHealth = useCallback(async () => {
    try {
      const r = await api("/api/health");
      setHealth((await r.json()) as Health);
    } catch {
      setHealth({ ok: false, proofServerReachable: false, cardanoConfigured: false });
    }
  }, []);

  const refreshBook = useCallback(async () => {
    try {
      const r = await api("/api/orderbook?pair=ADA-USD&levels=12&resting=1");
      setBook((await r.json()) as Orderbook);
    } catch {
      setBook(null);
    }
  }, []);

  const bookDepthMax = useMemo(() => {
    if (!book) return 1;
    const sizes = [...book.asks, ...book.bids].map((r) => r.size);
    if (sizes.length === 0) return 1;
    return Math.max(...sizes, 1e-12);
  }, [book]);

  const refreshStats = useCallback(async () => {
    try {
      const r = await api("/api/stats?pair=ADA-USD");
      const j = (await r.json()) as { error?: string } & Partial<MarketStats>;
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      setStats(j as MarketStats);
      setStatsErr(null);
    } catch (e) {
      setStatsErr(e instanceof Error ? e.message : String(e));
      setStats(null);
    }
  }, []);

  const refreshOrderLookup = useCallback(async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const r = await api("/api/orders/lookup", {
        method: "POST",
        body: JSON.stringify({ ids }),
      });
      const j = (await r.json()) as { orders?: Record<string, OrderLookupEntry>; error?: string };
      if (!r.ok) return;
      if (j.orders) setOrderLookup((prev) => ({ ...prev, ...j.orders }));
    } catch {
      /* ignore */
    }
  }, []);

  const tradeSubmitHeaders = useCallback((userPays: boolean): Record<string, string> => {
    const headers: Record<string, string> = {};
    const demoMnemonic = import.meta.env.VITE_BIP39_MNEMONIC;
    if (demoMnemonic && import.meta.env.DEV) {
      headers["X-Demo-Mnemonic"] = demoMnemonic;
    }
    if (userPays) {
      headers["X-Cardano-Payer"] = "user";
    }
    return headers;
  }, []);

  const completeUserPaidL1 = useCallback(
    async (j: Record<string, unknown>) => {
      const session = j.cardanoSession as CardanoSessionPayload | undefined;
      const tradeId = typeof j.tradeId === "string" ? j.tradeId : null;
      if (!session || !tradeId) {
        setSubmitState("error");
        setSubmitMessage("Missing cardano session from server.");
        return;
      }
      try {
        setSubmitMessage("Sign Charli3 pull + settlement anchor in your wallet (two prompts)…");
        const key = cip30WalletKey || cip30Wallets[0];
        if (!key) {
          throw new Error("No CIP-30 wallet found. Install Eternl, Lace, or Nami.");
        }
        const w = window.cardano?.[key];
        if (!w) throw new Error(`Wallet "${key}" is not available.`);
        const walletApi = await w.enable();
        const { charli3PullTxHash, settlementAnchorTxHash } = await submitUserPaidCardanoL1(
          session,
          walletApi,
        );
        setSubmitMessage("Recording Cardano txs…");
        const r = await api("/api/trade/user-l1-complete", {
          method: "POST",
          body: JSON.stringify({
            id: tradeId,
            charli3PullTxHash,
            settlementAnchorTxHash,
          }),
        });
        const cj = (await r.json()) as { ok?: boolean; error?: string; status?: string };
        if (!r.ok) throw new Error(cj.error || `HTTP ${r.status}`);
        setSubmitState("done");
        setSubmitMessage(
          cj.status === "confirmed"
            ? "Matched trade confirmed on Midnight and Cardano (user-paid L1)."
            : "Cardano txs submitted; waiting for confirmations.",
        );
        void refreshOrderLookup([tradeId]);
        void refreshBook();
        void refreshStats();
      } catch (e) {
        setSubmitState("error");
        setSubmitMessage(e instanceof Error ? e.message : String(e));
      }
    },
    [cip30WalletKey, cip30Wallets, refreshBook, refreshOrderLookup, refreshStats],
  );

  const applyTradeSuccess = useCallback(
    (j: Record<string, unknown>, ctx: { side: "long" | "short"; price: string; size: string }) => {
      setLastResult(j);
      if (j.needsUserCardano === true && j.cardanoSession && typeof j.tradeId === "string") {
        void completeUserPaidL1(j);
        const refId = j.tradeId as string;
        setTrackedOrders((prev) => {
          const row: TrackedOrderRow = {
            id: refId,
            side: ctx.side,
            price: ctx.price,
            size: ctx.size,
            at: new Date().toISOString(),
          };
          return [row, ...prev.filter((x) => x.id !== refId)].slice(0, 12);
        });
        void refreshOrderLookup([refId]);
        setSubmitState("submitting");
        return;
      }
      const refId =
        j.status === "resting" && typeof j.orderId === "string"
          ? j.orderId
          : typeof j.id === "string"
            ? j.id
            : null;
      if (refId) {
        setTrackedOrders((prev) => {
          const row: TrackedOrderRow = {
            id: refId,
            side: ctx.side,
            price: ctx.price,
            size: ctx.size,
            at: new Date().toISOString(),
          };
          return [row, ...prev.filter((x) => x.id !== refId)].slice(0, 12);
        });
        void refreshOrderLookup([refId]);
      }
      setSubmitState("done");
      setSubmitMessage(
        j.status === "resting"
          ? "Order is resting on the local book (no on-chain pipeline yet). It fills when an incoming order crosses your price — or post the opposite side to match yourself."
          : j.status === "confirmed"
            ? "Order confirmed on Midnight and Cardano."
            : "Submitted; some confirmations are still pending — check Details.",
      );
      void refreshBook();
      void refreshStats();
    },
    [completeUserPaidL1, refreshBook, refreshStats, refreshOrderLookup],
  );

  const flushSubmitQueue = useCallback(async () => {
    if (flushQueueInFlightRef.current) return;
    const q = submitQueueRef.current;
    if (q.length === 0) return;
    flushQueueInFlightRef.current = true;
    setQueueBusy(true);
    const item = q[0];
    try {
      const r = await api("/api/trade/submit", {
        method: "POST",
        headers: tradeSubmitHeaders(item.userPaysCardano),
        body: JSON.stringify({
          side: item.side,
          price: item.price,
          size: item.size,
          leverage: item.leverage,
          margin: item.margin,
        }),
      });
      const j = (await r.json()) as Record<string, unknown> & { error?: string };
      if (r.status === 429) {
        return;
      }
      if (!r.ok) {
        submitQueueRef.current = q.slice(1);
        syncQueuedCount();
        setSubmitState("error");
        setSubmitMessage(String(j.error || `HTTP ${r.status}`));
        return;
      }
      submitQueueRef.current = q.slice(1);
      syncQueuedCount();
      applyTradeSuccess(j, { side: item.side, price: item.price, size: item.size });
    } catch (e) {
      submitQueueRef.current = q.slice(1);
      syncQueuedCount();
      setSubmitState("error");
      setSubmitMessage(e instanceof Error ? e.message : String(e));
    } finally {
      flushQueueInFlightRef.current = false;
      setQueueBusy(false);
    }
  }, [applyTradeSuccess, syncQueuedCount, tradeSubmitHeaders]);

  useEffect(() => {
    const id = setInterval(() => {
      void flushSubmitQueue();
    }, 2500);
    return () => clearInterval(id);
  }, [flushSubmitQueue]);

  useEffect(() => {
    refreshOracle();
    refreshHealth();
    refreshBook();
    refreshStats();
    const t = setInterval(() => {
      refreshOracle();
      refreshBook();
      refreshStats();
    }, 15_000);
    return () => clearInterval(t);
  }, [refreshOracle, refreshBook, refreshHealth, refreshStats]);

  useEffect(() => {
    if (trackedOrders.length === 0) return;
    const ids = trackedOrders.map((o) => o.id);
    void refreshOrderLookup(ids);
    const t = setInterval(() => {
      void refreshOrderLookup(ids);
    }, 8_000);
    return () => clearInterval(t);
  }, [trackedOrders, refreshOrderLookup]);

  const priceEffective = price || (oracle ? String(oracle.indexPrice) : "");
  const marginStr = marginForSubmit(size, priceEffective, leverage);
  const notional = notionalUsd(size, priceEffective);

  useEffect(() => {
    const run = async () => {
      try {
        const px = price || (oracle ? String(oracle.indexPrice) : "");
        const r = await api("/api/risk/estimate", {
          method: "POST",
          body: JSON.stringify({
            side,
            price: px,
            size,
            leverage,
            margin: marginForSubmit(size, px, leverage),
          }),
        });
        const j = (await r.json()) as {
          estLiquidationPrice: number | null;
          markPrice: number | null;
        };
        if (j.estLiquidationPrice != null && Number.isFinite(j.estLiquidationPrice)) {
          setRiskText(
            `Approx. liquidation near ${formatPx(j.estLiquidationPrice)} (maintenance margin model; not financial advice).`,
          );
        } else {
          setRiskText("Enter limit price, size, and leverage to see an estimated liquidation level.");
        }
      } catch {
        setRiskText(null);
      }
    };
    const id = setTimeout(run, 300);
    return () => clearTimeout(id);
  }, [side, price, size, leverage, oracle?.indexPrice]);

  useEffect(() => {
    if (oracle && !price) {
      setPrice(String(oracle.indexPrice));
    }
  }, [oracle, price]);

  const onSubmit = async () => {
    setSubmitState("submitting");
    setSubmitMessage("Submitting… This may take several minutes (wallet sync + proving).");
    setLastResult(null);
    try {
      const px = price || (oracle ? String(oracle.indexPrice) : "");
      const marginComputed = marginForSubmit(size, px, leverage);
      if (!marginComputed) {
        throw new Error("Set valid price, size, and leverage so initial margin can be computed.");
      }
      const r = await api("/api/trade/submit", {
        method: "POST",
        headers: tradeSubmitHeaders(Boolean(userPaysFeature && userPaysCardano)),
        body: JSON.stringify({
          side,
          price: px,
          size,
          leverage,
          margin: marginComputed,
        }),
      });
      const j = (await r.json()) as Record<string, unknown> & { error?: string };
      if (r.status === 429) {
        const queued: QueuedTrade = {
          id: crypto.randomUUID(),
          side,
          price: px,
          size,
          leverage,
          margin: marginComputed,
          userPaysCardano: Boolean(userPaysFeature && userPaysCardano),
        };
        submitQueueRef.current = [...submitQueueRef.current, queued];
        syncQueuedCount();
        setSubmitState("done");
        setSubmitMessage(
          "Pipeline busy (Midnight + Cardano). Order queued — it will submit automatically when the pipeline is free.",
        );
        void flushSubmitQueue();
        return;
      }
      if (!r.ok) throw new Error(String(j.error || r.statusText));
      applyTradeSuccess(j, { side, price: px, size });
    } catch (e) {
      setSubmitState("error");
      setSubmitMessage(e instanceof Error ? e.message : String(e));
    }
  };

  const healthOk = health?.ok === true;

  return (
    <div className="app">
      <header className="header">
        <div>
          <h1>Charli3 Perps</h1>
          <span className="pair-pill">ADA-USD</span>
          <div className="health" style={{ marginTop: "0.5rem" }}>
            <span className={`health-dot ${healthOk ? "ok" : ""}`} />
            {healthOk ? "Connected" : "Check setup (API / proof server / Cardano)"}
          </div>
        </div>
        <div className="mark-block">
          <div className="mark-label">Mark (Charli3)</div>
          <div className="mark-price">
            {oracle ? formatPx(oracle.indexPrice) : oracleErr ? "—" : "…"}
          </div>
          {oracleAt && (
            <div className="mark-age">
              Updated {Math.round((Date.now() - oracleAt) / 1000)}s ago
            </div>
          )}
          {oracleErr && (
            <div className="mark-age" style={{ color: "var(--danger)" }}>
              {oracleErr}
            </div>
          )}
        </div>
      </header>

      <nav className="app-nav" aria-label="Primary">
        <button
          type="button"
          className={tab === "trade" ? "active" : ""}
          onClick={() => setTab("trade")}
        >
          Trade
        </button>
        <button
          type="button"
          className={tab === "account" ? "active" : ""}
          onClick={() => setTab("account")}
        >
          Account
        </button>
        <button
          type="button"
          className={tab === "explorer" ? "active" : ""}
          onClick={() => setTab("explorer")}
        >
          Explorer
        </button>
      </nav>

      {tab === "trade" && (
        <section className="market-stats" aria-label="Market statistics">
          {statsErr && (
            <div className="stats-err" role="status">
              Stats unavailable: {statsErr}
            </div>
          )}
          {stats && (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">24h volume (ADA)</div>
                <div className="stat-value">{formatAdaVol(stats.volumeBase24h)}</div>
                <div className="stat-sub">${formatUsdCompact(stats.volumeUsd24h)} notional</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">All-time volume (ADA)</div>
                <div className="stat-value">{formatAdaVol(stats.volumeBaseAllTime)}</div>
                <div className="stat-sub">${formatUsdCompact(stats.volumeUsdAllTime)} notional</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Resting liquidity (USD)</div>
                <div className="stat-value">${formatUsdCompact(stats.liquidityTotalUsd)}</div>
                <div className="stat-sub">
                  Bid ${formatUsdCompact(stats.liquidityBidUsd)} · Ask ${formatUsdCompact(stats.liquidityAskUsd)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Best bid / ask</div>
                <div className="stat-value mono">
                  {stats.bestBid != null ? formatPx(stats.bestBid) : "—"} /{" "}
                  {stats.bestAsk != null ? formatPx(stats.bestAsk) : "—"}
                </div>
                <div className="stat-sub">
                  Spread{" "}
                  {stats.spread != null && Number.isFinite(stats.spread)
                    ? formatPx(stats.spread)
                    : "—"}{" "}
                  · {stats.crossed ? "crossed" : "uncrossed"} (resting)
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Trades (index)</div>
                <div className="stat-value">
                  {stats.confirmedTrades} conf. / {stats.pendingTrades} pend.
                </div>
                <div className="stat-sub">{stats.restingOrderCount} resting orders</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Mark / index</div>
                <div className="stat-value">{formatPx(stats.markPrice)}</div>
                <div className="stat-sub">Oracle mark (ADA-USD)</div>
              </div>
            </div>
          )}
          {!stats && !statsErr && (
            <div className="stats-loading muted">Loading market stats…</div>
          )}
        </section>
      )}

      {tab === "account" ? (
        <Suspense fallback={<div className="panel chart-empty">Loading account…</div>}>
          <AccountDashboard />
        </Suspense>
      ) : tab === "explorer" ? (
        <Suspense fallback={<div className="panel chart-empty">Loading explorer…</div>}>
          <ExplorerPage />
        </Suspense>
      ) : (
        <>
          <Suspense fallback={<div className="panel chart-panel chart-empty">Loading chart…</div>}>
            <AdaUsdChart />
          </Suspense>

          <div className="grid">
        <div className="panel orderbook-panel">
          <h2>Order book</h2>
          {!book ? (
            <div className="empty-book">Loading…</div>
          ) : book.bids.length === 0 && book.asks.length === 0 ? (
            <div className="empty-book">
              No bids or asks yet. Place a limit order — it rests locally until matched.
            </div>
          ) : (
            <>
              <p className="book-meta muted">
                {book.restingOnly && (
                  <span title="Historical index legs add both bid and ask at the same price, which mirrored the two sides — the ladder shows live quotes only.">
                    Live resting book ·{" "}
                  </span>
                )}
                {book.restingOrders != null && (
                  <>
                    <strong>{book.restingOrders}</strong> orders ·{" "}
                  </>
                )}
                <strong>{book.totalConfirmed}</strong> confirmed in index
                {book.aggregatedLevels !== false && (
                  <> · sizes summed per price</>
                )}
              </p>
              <div className="book-side">
                <h3 className="ask-head">Asks</h3>
                <p className="book-side-hint muted">
                  Worst → best (lowest ask / best ask at bottom, next to bids)
                </p>
                <div className="book-rows">
                  <div className="book-col-head" aria-hidden>
                    <span>Price (USD)</span>
                    <span>Size (ADA)</span>
                  </div>
                  {book.asks.length === 0 ? (
                    <div className="empty-book">—</div>
                  ) : (
                    [...book.asks].reverse().map((r, i) => {
                      const pct = bookDepthPercent(r.size, bookDepthMax);
                      return (
                        <div key={`a-${r.price}-${i}`} className="book-row book-row--ask">
                          <div
                            className="book-depth-bar book-depth-bar--ask"
                            style={{ width: `${pct}%` }}
                            aria-hidden
                          />
                          <div className="book-row-inner">
                            <span className="book-price book-price--ask">{formatPx(r.price)}</span>
                            <span className="book-size">{formatBookSize(r.size)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
              <div className="book-side">
                <h3 className="bid-head">Bids</h3>
                <p className="book-side-hint muted">
                  Best → worst (highest bid / best bid at top)
                </p>
                <div className="book-rows">
                  <div className="book-col-head" aria-hidden>
                    <span>Price (USD)</span>
                    <span>Size (ADA)</span>
                  </div>
                  {book.bids.length === 0 ? (
                    <div className="empty-book">—</div>
                  ) : (
                    book.bids.map((r, i) => {
                      const pct = bookDepthPercent(r.size, bookDepthMax);
                      return (
                        <div key={`b-${i}`} className="book-row book-row--bid">
                          <div
                            className="book-depth-bar book-depth-bar--bid"
                            style={{ width: `${pct}%` }}
                            aria-hidden
                          />
                          <div className="book-row-inner">
                            <span className="book-price book-price--bid">{formatPx(r.price)}</span>
                            <span className="book-size">{formatBookSize(r.size)}</span>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="ticket-stack">
        <div className="panel ticket">
          <h2>Place order</h2>
          <div className="row">
            <label>Side</label>
            <div className="side-toggle">
              <button
                type="button"
                className={side === "long" ? "active long" : ""}
                onClick={() => setSide("long")}
              >
                Long
              </button>
              <button
                type="button"
                className={side === "short" ? "active short" : ""}
                onClick={() => setSide("short")}
              >
                Short
              </button>
            </div>
          </div>
          <div className="row">
            <label>Limit price (USD per ADA)</label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="USD per ADA" />
          </div>
          <div className="row">
            <label>Size (ADA)</label>
            <input value={size} onChange={(e) => setSize(e.target.value)} placeholder="ADA" />
          </div>
          <div className="row">
            <label>Leverage</label>
            <input
              type="number"
              min={1}
              max={125}
              value={leverage}
              onChange={(e) => {
                const v = Number(e.target.value);
                setLeverage(Number.isFinite(v) ? Math.min(125, Math.max(1, v)) : 1);
              }}
            />
          </div>
          <div className="row">
            <label>Notional (USD)</label>
            <input
              className="input-readonly"
              readOnly
              value={notional != null ? formatPx(notional) : "—"}
              title="size (ADA) × limit price (USD per ADA)"
            />
          </div>
          <div className="row">
            <label>Initial margin (USD)</label>
            <input
              className="input-readonly"
              readOnly
              value={
                marginStr
                  ? formatPx(Number.parseFloat(marginStr))
                  : "—"
              }
              title="(size × price) / leverage — sent with your order"
            />
          </div>
          <p className="formula-hint">
            Initial margin = notional ÷ leverage = (size × price) ÷ leverage
          </p>
          {riskText && <div className="risk-line">{riskText}</div>}
          {userPaysFeature && (
            <div className="row user-pays-row">
              <label className="user-pays-label">
                <input
                  type="checkbox"
                  checked={userPaysCardano}
                  onChange={(e) => setUserPaysCardano(e.target.checked)}
                />
                Pay Cardano fees (Charli3 + anchor) with browser wallet
              </label>
              {userPaysCardano && cip30Wallets.length > 0 && (
                <select
                  value={cip30WalletKey || cip30Wallets[0]}
                  onChange={(e) => setCip30WalletKey(e.target.value)}
                  aria-label="CIP-30 wallet"
                >
                  {cip30Wallets.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              )}
              {userPaysCardano && cip30Wallets.length === 0 && (
                <span className="user-pays-warn">No CIP-30 wallet detected — install Eternl, Lace, or Nami.</span>
              )}
              <p className="formula-hint">
                Requires API <code>ALLOW_USER_PAYS_CARDANO_L1=1</code> and{" "}
                <code>VITE_BLOCKFROST_PROJECT_ID</code> in <code>perps-web/.env</code>.
              </p>
            </div>
          )}
          <button
            type="button"
            className="btn-primary"
            disabled={
              submitState === "submitting" ||
              !price ||
              !size ||
              !marginStr ||
              (userPaysFeature && userPaysCardano && cip30Wallets.length === 0)
            }
            onClick={() => void onSubmit()}
          >
            {submitState === "submitting" ? (
              <>
                <span className="spinner" />
                Confirming on networks…
              </>
            ) : (
              "Place order"
            )}
          </button>
          {queuedCount > 0 && (
            <div className="status-banner status-banner--queue" role="status">
              <strong>{queuedCount}</strong> order{queuedCount === 1 ? "" : "s"} queued locally —{" "}
              {queueBusy ? "submitting the next one now…" : "will auto-submit when the pipeline is free."}
            </div>
          )}
          {submitState !== "idle" && (
            <div
              className={`status-banner ${submitState === "error" ? "error" : ""}`}
            >
              {submitMessage}
            </div>
          )}
          <details className="details">
            <summary>Technical details</summary>
            <p>
              Full flow: Charli3 oracle → Midnight five-contract pipeline → Cardano Charli3 reference tx
              + settlement anchor. Requires proof server, funded Midnight wallet, and Blockfrost in{" "}
              <code>.env</code>. Only one pipeline runs at a time on the API; if it&apos;s busy you get a
              client-side queue and automatic retry — orders are not lost while this tab stays open.
            </p>
            {lastResult && (
              <pre>{JSON.stringify(lastResult, null, 2)}</pre>
            )}
          </details>
        </div>

        <div className="panel order-status-panel">
          <h2>Order status</h2>
          <p className="order-status-hint muted">
            Orders you submit from this browser. Status updates every few seconds.
          </p>
          {trackedOrders.length === 0 ? (
            <div className="empty-book">No orders yet — submit a trade to track it here.</div>
          ) : (
            <div className="order-status-table-wrap">
              <table className="order-status-table">
                <thead>
                  <tr>
                    <th scope="col">Reference</th>
                    <th scope="col">Side</th>
                    <th scope="col">Price</th>
                    <th scope="col">Size</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {trackedOrders.map((row) => {
                    const st = orderLookup[row.id];
                    return (
                      <tr key={row.id}>
                        <td className="mono" title={row.id}>
                          {shortId(row.id)}
                        </td>
                        <td className={row.side === "long" ? "side-long" : "side-short"}>
                          {row.side === "long" ? "Long" : "Short"}
                        </td>
                        <td className="mono">{formatPx(parseNumField(row.price))}</td>
                        <td className="mono">{row.size}</td>
                        <td>{orderStatusLabel(st)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
