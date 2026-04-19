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
  if (entry.kind === "resting") return "Resting";
  if (entry.kind === "not_found") return "Closed";
  if (entry.kind === "trade") {
    if (entry.error) return "Failed";
    if (entry.status === "confirmed") return "Done";
    if (entry.status === "pending_user_l1") return "Sign";
    return "…";
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

  const [submitState, setSubmitState] = useState<SubmitState>("idle");
  const [submitMessage, setSubmitMessage] = useState("");
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
        setSubmitMessage("Sign…");
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
        setSubmitMessage("…");
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
        setSubmitMessage(cj.status === "confirmed" ? "Done" : "Pending");
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
        j.status === "resting" ? "Resting" : j.status === "confirmed" ? "Done" : "Pending",
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

  /** Ask → long (buy at offer); bid → short (sell into bid). */
  const applyOrderBookLevel = useCallback((bookSide: "bid" | "ask", levelPrice: number, levelSize: number) => {
    setSide(bookSide === "ask" ? "long" : "short");
    setPrice(formatPx(levelPrice));
    setSize(formatBookSize(levelSize));
  }, []);

  useEffect(() => {
    if (oracle && !price) {
      setPrice(String(oracle.indexPrice));
    }
  }, [oracle, price]);

  const onSubmit = async () => {
    setSubmitState("submitting");
    setSubmitMessage("…");
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
        setSubmitMessage("Queued");
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
          <h1>Perps</h1>
          <span className="pair-pill">ADA-USD</span>
          <div className="health" style={{ marginTop: "0.5rem" }}>
            <span className={`health-dot ${healthOk ? "ok" : ""}`} />
            {healthOk ? "Connected" : "Offline"}
          </div>
        </div>
        <div className="mark-block">
          <div className="mark-label">Mark</div>
          <div className="mark-price">
            {oracle ? formatPx(oracle.indexPrice) : oracleErr ? "—" : "…"}
          </div>
          {oracleAt && (
            <div className="mark-age">{Math.round((Date.now() - oracleAt) / 1000)}s</div>
          )}
          {oracleErr && (
            <div className="mark-age" style={{ color: "var(--danger)" }}>
              {oracleErr}
            </div>
          )}
        </div>
      </header>

      <nav className="app-nav" aria-label="Main">
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
        <section className="market-stats" aria-label="Stats">
          {statsErr && (
            <div className="stats-err" role="status">
              {statsErr}
            </div>
          )}
          {stats && (
            <div className="stats-grid">
              <div className="stat-card">
                <div className="stat-label">24h</div>
                <div className="stat-value">{formatAdaVol(stats.volumeBase24h)}</div>
                <div className="stat-sub">${formatUsdCompact(stats.volumeUsd24h)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">All-time</div>
                <div className="stat-value">{formatAdaVol(stats.volumeBaseAllTime)}</div>
                <div className="stat-sub">${formatUsdCompact(stats.volumeUsdAllTime)}</div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Liquidity</div>
                <div className="stat-value">${formatUsdCompact(stats.liquidityTotalUsd)}</div>
                <div className="stat-sub">
                  {formatUsdCompact(stats.liquidityBidUsd)} / {formatUsdCompact(stats.liquidityAskUsd)}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Bid / ask</div>
                <div className="stat-value mono">
                  {stats.bestBid != null ? formatPx(stats.bestBid) : "—"} /{" "}
                  {stats.bestAsk != null ? formatPx(stats.bestAsk) : "—"}
                </div>
                <div className="stat-sub">
                  {stats.spread != null && Number.isFinite(stats.spread) ? formatPx(stats.spread) : "—"}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Trades</div>
                <div className="stat-value">
                  {stats.confirmedTrades}/{stats.pendingTrades} · {stats.restingOrderCount}
                </div>
              </div>
              <div className="stat-card">
                <div className="stat-label">Mark</div>
                <div className="stat-value">{formatPx(stats.markPrice)}</div>
              </div>
            </div>
          )}
          {!stats && !statsErr && (
            <div className="stats-loading muted">…</div>
          )}
        </section>
      )}

      {tab === "account" ? (
        <Suspense fallback={<div className="panel chart-empty">…</div>}>
          <AccountDashboard />
        </Suspense>
      ) : tab === "explorer" ? (
        <Suspense fallback={<div className="panel chart-empty">…</div>}>
          <ExplorerPage />
        </Suspense>
      ) : (
        <>
          <Suspense fallback={<div className="panel chart-panel chart-empty">…</div>}>
            <AdaUsdChart />
          </Suspense>

          <div className="grid">
        <div className="panel orderbook-panel">
          <h2>Book</h2>
          {!book ? (
            <div className="empty-book">Loading…</div>
          ) : book.bids.length === 0 && book.asks.length === 0 ? (
            <div className="empty-book">Empty</div>
          ) : (
            <>
              <div className="book-side">
                <h3 className="ask-head">Asks</h3>
                <div className="book-rows">
                  <div className="book-col-head" aria-hidden>
                    <span>Price</span>
                    <span>Size</span>
                  </div>
                  {book.asks.length === 0 ? (
                    <div className="empty-book">—</div>
                  ) : (
                    [...book.asks].reverse().map((r, i) => {
                      const pct = bookDepthPercent(r.size, bookDepthMax);
                      return (
                        <div
                          key={`a-${r.price}-${i}`}
                          className="book-row book-row--ask"
                          role="button"
                          tabIndex={0}
                          aria-label={`Fill order form: long ${formatPx(r.price)} ${formatBookSize(r.size)} ADA`}
                          onClick={() => applyOrderBookLevel("ask", r.price, r.size)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              applyOrderBookLevel("ask", r.price, r.size);
                            }
                          }}
                        >
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
                <div className="book-rows">
                  <div className="book-col-head" aria-hidden>
                    <span>Price</span>
                    <span>Size</span>
                  </div>
                  {book.bids.length === 0 ? (
                    <div className="empty-book">—</div>
                  ) : (
                    book.bids.map((r, i) => {
                      const pct = bookDepthPercent(r.size, bookDepthMax);
                      return (
                        <div
                          key={`b-${i}`}
                          className="book-row book-row--bid"
                          role="button"
                          tabIndex={0}
                          aria-label={`Fill order form: short ${formatPx(r.price)} ${formatBookSize(r.size)} ADA`}
                          onClick={() => applyOrderBookLevel("bid", r.price, r.size)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              applyOrderBookLevel("bid", r.price, r.size);
                            }
                          }}
                        >
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
          <h2>Order</h2>
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
            <label>Price</label>
            <input value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <div className="row">
            <label>Size</label>
            <input value={size} onChange={(e) => setSize(e.target.value)} />
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
            <label>Notional</label>
            <input
              className="input-readonly"
              readOnly
              value={notional != null ? formatPx(notional) : "—"}
            />
          </div>
          <div className="row">
            <label>Margin</label>
            <input
              className="input-readonly"
              readOnly
              value={
                marginStr
                  ? formatPx(Number.parseFloat(marginStr))
                  : "—"
              }
            />
          </div>
          {userPaysFeature && (
            <div className="row user-pays-row">
              <label className="user-pays-label">
                <input
                  type="checkbox"
                  checked={userPaysCardano}
                  onChange={(e) => setUserPaysCardano(e.target.checked)}
                />
                L1 fees
              </label>
              {userPaysCardano && cip30Wallets.length > 0 && (
                <select
                  value={cip30WalletKey || cip30Wallets[0]}
                  onChange={(e) => setCip30WalletKey(e.target.value)}
                  aria-label="Wallet"
                >
                  {cip30Wallets.map((k) => (
                    <option key={k} value={k}>
                      {k}
                    </option>
                  ))}
                </select>
              )}
              {userPaysCardano && cip30Wallets.length === 0 && (
                <span className="user-pays-warn">—</span>
              )}
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
                …
              </>
            ) : (
              "Submit"
            )}
          </button>
          {queuedCount > 0 && (
            <div className="status-banner status-banner--queue" role="status">
              {queuedCount}
              {queueBusy ? " · …" : ""}
            </div>
          )}
          {submitState !== "idle" && (
            <div
              className={`status-banner ${submitState === "error" ? "error" : ""}`}
            >
              {submitMessage}
            </div>
          )}
        </div>

        <div className="panel order-status-panel">
          <h2>Status</h2>
          {trackedOrders.length === 0 ? (
            <div className="empty-book">None</div>
          ) : (
            <div className="order-status-table-wrap">
              <table className="order-status-table">
                <thead>
                  <tr>
                    <th scope="col">ID</th>
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
                        <td className="mono">
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
