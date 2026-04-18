import { useCallback, useEffect, useMemo, useState } from "react";
import { api, readJsonBody } from "./api";
import { MarginPoolPanel } from "./MarginPoolPanel";

/** Rough taker fee for display; not enforced on-chain in this demo. */
const FEE_BPS_EST = 5;

type WalletOk = {
  ok: true;
  address: string;
  ada: string;
  lovelace: string;
  network: string;
};

type FillRow = {
  id: string;
  pairId: string;
  bid: { side: string; price: string; size: string; leverage: number };
  ask: { side: string; price: string; size: string; leverage: number };
  oracleIndexPriceAtFill?: number;
  charli3PullTxHash?: string;
  settlementAnchorTxHash?: string;
  midnightBindTxHash?: string;
  explorers: { charli3Pull: string | null; settlementAnchor: string | null };
  confirmedAt?: string;
};

function num(s: string): number {
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

function formatUsd(n: number, digits = 4): string {
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "−" : "";
  return sign + Math.abs(n).toFixed(digits);
}

function pnlClass(n: number): string {
  if (n > 1e-12) return "fill-pnl-pos";
  if (n < -1e-12) return "fill-pnl-neg";
  return "fill-pnl-flat";
}

export function AccountDashboard() {
  const [wallet, setWallet] = useState<WalletOk | null>(null);
  const [walletErr, setWalletErr] = useState<string | null>(null);
  const [fills, setFills] = useState<FillRow[]>([]);
  const [fillsLoading, setFillsLoading] = useState(true);
  const [mark, setMark] = useState<number | null>(null);

  const loadWallet = useCallback(async () => {
    try {
      const r = await api("/api/cardano/wallet");
      const parsed = await readJsonBody<{ error?: string } & Partial<WalletOk>>(r);
      if (!parsed.ok) {
        setWalletErr(parsed.error);
        setWallet(null);
        return;
      }
      const j = parsed.data;
      if (!r.ok) {
        setWalletErr(j.error || r.statusText);
        setWallet(null);
        return;
      }
      setWalletErr(null);
      if (j.ok && j.address) {
        setWallet(j as WalletOk);
      } else {
        setWallet(null);
      }
    } catch (e) {
      setWalletErr(e instanceof Error ? e.message : String(e));
      setWallet(null);
    }
  }, []);

  const loadFills = useCallback(async () => {
    setFillsLoading(true);
    try {
      const r = await api("/api/account/fills");
      const parsed = await readJsonBody<{ fills?: FillRow[] }>(r);
      if (!parsed.ok) {
        setFills([]);
        return;
      }
      const j = parsed.data;
      setFills(Array.isArray(j.fills) ? j.fills : []);
    } catch {
      setFills([]);
    } finally {
      setFillsLoading(false);
    }
  }, []);

  const loadMark = useCallback(async () => {
    try {
      const r = await api("/api/stats?pair=ADA-USD");
      const parsed = await readJsonBody<{ markPrice?: number }>(r);
      if (!parsed.ok) return;
      const m = parsed.data.markPrice;
      if (typeof m === "number" && Number.isFinite(m)) {
        setMark(m);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const fillPnlRows = useMemo(() => {
    if (mark == null || fills.length === 0) return [];
    const sorted = [...fills].sort((a, b) => {
      const ta = a.confirmedAt ? Date.parse(a.confirmedAt) : 0;
      const tb = b.confirmedAt ? Date.parse(b.confirmedAt) : 0;
      return ta - tb;
    });
    let running = 0;
    return sorted.map((f) => {
      const sz = num(f.bid.size);
      const bidPx = num(f.bid.price);
      const askPx = num(f.ask.price);
      const notional = sz * bidPx;
      const longUpnl = sz * (mark - bidPx);
      const shortUpnl = sz * (askPx - mark);
      const netUpnl = longUpnl + shortUpnl;
      const fee = (-notional * FEE_BPS_EST) / 10_000;
      const rowChange = netUpnl + fee;
      running += rowChange;
      return { f, netUpnl, fee, rowChange, running, notional };
    });
  }, [fills, mark]);

  const pnlTotals = useMemo(() => {
    if (fillPnlRows.length === 0) {
      return { sumNet: 0, sumFees: 0, sumVolume: 0, running: 0 };
    }
    let sumNet = 0;
    let sumFees = 0;
    let sumVolume = 0;
    for (const row of fillPnlRows) {
      sumNet += row.netUpnl;
      sumFees += row.fee;
      sumVolume += row.notional;
    }
    const last = fillPnlRows[fillPnlRows.length - 1];
    return { sumNet, sumFees, sumVolume, running: last.running };
  }, [fillPnlRows]);

  useEffect(() => {
    void loadWallet();
    void loadFills();
    void loadMark();
    const t = setInterval(() => {
      void loadFills();
      void loadMark();
    }, 20_000);
    return () => clearInterval(t);
  }, [loadWallet, loadFills, loadMark]);

  return (
    <div className="account-dash">
      <div className="panel wallet-panel">
        <h2>Cardano wallet</h2>
        <p className="account-hint">
          Uses <code>WALLET_MNEMONIC</code> from <code>.env</code> (same wallet as Charli3 pull / settlement
          anchors on Preprod).
        </p>
        {walletErr && (
          <p className="chart-err" role="alert">
            {walletErr}
          </p>
        )}
        {wallet && (
          <dl className="wallet-dl">
            <dt>Network</dt>
            <dd>{wallet.network}</dd>
            <dt>Address</dt>
            <dd className="mono-addr">{wallet.address}</dd>
            <dt>Balance</dt>
            <dd>
              <strong>{wallet.ada}</strong> tADA
            </dd>
          </dl>
        )}
        {!walletErr && !wallet && (
          <p className="chart-empty">Loading wallet…</p>
        )}
      </div>

      <MarginPoolPanel />

      <div className="panel fills-panel">
        <div className="fills-head">
          <h2>Filled orders</h2>
          <button type="button" className="btn-ghost" onClick={() => void loadFills()}>
            Refresh
          </button>
        </div>
        <p className="account-hint">
          Trades confirmed on Midnight + both Cardano txs (from this app&apos;s index). Unrealized P&amp;L uses
          the current mark; matched long/short legs at the same price offset. Est. fees assume {FEE_BPS_EST} bps
          per fill (demo only).
        </p>
        {fillsLoading ? (
          <p className="chart-empty">Loading…</p>
        ) : fills.length === 0 ? (
          <p className="chart-empty">No confirmed fills yet.</p>
        ) : (
          <>
            {mark != null && (
              <div className="fills-pnl-summary" role="status">
                <span>
                  Mark <strong className="mono-sm">{formatUsd(mark, 6)}</strong>
                </span>
                <span>
                  Volume (notional) <strong className="mono-sm">{formatUsd(pnlTotals.sumVolume, 2)}</strong> USD
                </span>
                <span>
                  Σ Net uPnL <strong className={`mono-sm ${pnlClass(pnlTotals.sumNet)}`}>{formatUsd(pnlTotals.sumNet, 4)}</strong> USD
                </span>
                <span>
                  Σ Est. fees <strong className={`mono-sm ${pnlClass(pnlTotals.sumFees)}`}>{formatUsd(pnlTotals.sumFees, 4)}</strong> USD
                </span>
                <span>
                  Running P&amp;L <strong className={`mono-sm ${pnlClass(pnlTotals.running)}`}>{formatUsd(pnlTotals.running, 4)}</strong> USD
                </span>
              </div>
            )}
            {mark === null && (
              <p className="account-hint">Loading mark price for P&amp;L…</p>
            )}
            <div className="fills-table-wrap">
              <table className="fills-table">
                <thead>
                  <tr>
                    <th>Time</th>
                    <th>Pair</th>
                    <th>Bid</th>
                    <th>Ask</th>
                    <th>Net uPnL</th>
                    <th>Est. fee</th>
                    <th>Running P&amp;L</th>
                    <th>Cardano</th>
                  </tr>
                </thead>
                <tbody>
                  {(mark != null ? fillPnlRows : []).map(({ f, netUpnl, fee, running }) => (
                    <tr key={f.id}>
                      <td className="mono-sm">
                        {f.confirmedAt
                          ? new Date(f.confirmedAt).toLocaleString()
                          : "—"}
                      </td>
                      <td>{f.pairId}</td>
                      <td>
                        {f.bid.side} {f.bid.size} @ {f.bid.price} ({f.bid.leverage}x)
                      </td>
                      <td>
                        {f.ask.side} {f.ask.size} @ {f.ask.price} ({f.ask.leverage}x)
                      </td>
                      <td className={`mono-sm ${pnlClass(netUpnl)}`}>{formatUsd(netUpnl, 4)}</td>
                      <td className={`mono-sm ${pnlClass(fee)}`}>{formatUsd(fee, 4)}</td>
                      <td className={`mono-sm ${pnlClass(running)}`}>{formatUsd(running, 4)}</td>
                      <td className="fills-links">
                        {f.explorers.charli3Pull && (
                          <a href={f.explorers.charli3Pull} target="_blank" rel="noreferrer">
                            Pull
                          </a>
                        )}
                        {f.explorers.charli3Pull && f.explorers.settlementAnchor && " · "}
                        {f.explorers.settlementAnchor && (
                          <a href={f.explorers.settlementAnchor} target="_blank" rel="noreferrer">
                            Anchor
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                  {mark === null &&
                    fills.map((f) => (
                      <tr key={f.id}>
                        <td className="mono-sm">
                          {f.confirmedAt
                            ? new Date(f.confirmedAt).toLocaleString()
                            : "—"}
                        </td>
                        <td>{f.pairId}</td>
                        <td>
                          {f.bid.side} {f.bid.size} @ {f.bid.price} ({f.bid.leverage}x)
                        </td>
                        <td>
                          {f.ask.side} {f.ask.size} @ {f.ask.price} ({f.ask.leverage}x)
                        </td>
                        <td className="mono-sm">—</td>
                        <td className="mono-sm">—</td>
                        <td className="mono-sm">—</td>
                        <td className="fills-links">
                          {f.explorers.charli3Pull && (
                            <a href={f.explorers.charli3Pull} target="_blank" rel="noreferrer">
                              Pull
                            </a>
                          )}
                          {f.explorers.charli3Pull && f.explorers.settlementAnchor && " · "}
                          {f.explorers.settlementAnchor && (
                            <a href={f.explorers.settlementAnchor} target="_blank" rel="noreferrer">
                              Anchor
                            </a>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
