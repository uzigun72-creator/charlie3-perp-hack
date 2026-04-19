import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "./api";

type Step = {
  key: "midnight_bind" | "midnight_matching_seal" | "charli3_pull" | "settlement_anchor";
  label: string;
  chain: "midnight" | "cardano";
  txHash: string | null;
  explorerUrl: string | null;
};

type TradeExplorerRow = {
  id: string;
  status: "pending" | "pending_user_l1" | "confirmed";
  pairId: string;
  createdAt: string;
  confirmedAt?: string;
  error?: string;
  /** Last lines from API pipeline (in-memory progress before tx hashes land). */
  pipelineLogTail?: string;
  bidCommitmentHex: string;
  askCommitmentHex: string;
  steps: Step[];
};

type ApiResponse = {
  trades?: TradeExplorerRow[];
  total?: number;
  networks?: { cardano: string; midnight: string };
};

function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

function shortHash(h: string | null): string {
  if (!h) return "—";
  const t = h.replace(/^0x/i, "");
  return t.length > 20 ? `${t.slice(0, 10)}…${t.slice(-8)}` : t;
}

function statusLabel(s: TradeExplorerRow["status"]): string {
  if (s === "confirmed") return "ok";
  if (s === "pending_user_l1") return "sign";
  return "…";
}

export function ExplorerPage() {
  const [rows, setRows] = useState<TradeExplorerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "confirmed" | "pending">("all");
  const [query, setQuery] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api("/api/explorer/trades");
      const j = (await r.json()) as ApiResponse & { error?: string };
      if (!r.ok) {
        setErr(j.error || `HTTP ${r.status}`);
        setRows([]);
        return;
      }
      setRows(Array.isArray(j.trades) ? j.trades : []);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 5_000);
    return () => clearInterval(t);
  }, [load]);

  const filteredTrades = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((t) => {
      if (statusFilter !== "all") {
        if (statusFilter === "pending") {
          if (t.status !== "pending" && t.status !== "pending_user_l1") return false;
        } else if (t.status !== statusFilter) {
          return false;
        }
      }
      if (!q) return true;
      if (t.id.toLowerCase().includes(q)) return true;
      if (t.pairId.toLowerCase().includes(q)) return true;
      if (t.bidCommitmentHex.toLowerCase().includes(q)) return true;
      if (t.askCommitmentHex.toLowerCase().includes(q)) return true;
      if (t.error?.toLowerCase().includes(q)) return true;
      return t.steps.some(
        (s) =>
          (s.txHash && s.txHash.toLowerCase().includes(q)) ||
          s.label.toLowerCase().includes(q),
      );
    });
  }, [rows, statusFilter, query]);

  const flatRows = useMemo(() => {
    const out: Array<{ trade: TradeExplorerRow; step: Step }> = [];
    for (const t of filteredTrades) {
      for (const s of t.steps) {
        out.push({ trade: t, step: s });
      }
    }
    return out;
  }, [filteredTrades]);

  return (
    <div className="explorer-dash">
      <div className="panel explorer-intro">
        <div className="explorer-toolbar">
          <label className="explorer-search">
            <span className="sr-only">Filter</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Filter"
            />
          </label>
          <div className="explorer-filters" role="group" aria-label="Status">
            {(["all", "confirmed", "pending"] as const).map((k) => (
              <button
                key={k}
                type="button"
                className={statusFilter === k ? "active" : ""}
                onClick={() => setStatusFilter(k)}
              >
                {k === "all" ? "All" : k === "confirmed" ? "Confirmed" : "Pending"}
              </button>
            ))}
          </div>
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>

      {err && (
        <p className="chart-err" role="alert">
          {err}
        </p>
      )}

      {loading && !rows.length ? (
        <p className="chart-empty">…</p>
      ) : flatRows.length === 0 ? (
        <p className="chart-empty">—</p>
      ) : (
        <div className="panel explorer-table-panel">
          <div className="explorer-table-wrap">
            <table className="explorer-table">
              <thead>
                <tr>
                  <th scope="col">Time</th>
                  <th scope="col">ID</th>
                  <th scope="col">Status</th>
                  <th scope="col">Step</th>
                  <th scope="col">Chain</th>
                  <th scope="col">Tx</th>
                  <th scope="col">Link</th>
                </tr>
              </thead>
              <tbody>
                {flatRows.map(({ trade: t, step: s }) => (
                  <tr key={`${t.id}-${s.key}`}>
                    <td className="mono-sm explorer-time">
                      {t.confirmedAt
                        ? new Date(t.confirmedAt).toLocaleString()
                        : new Date(t.createdAt).toLocaleString()}
                    </td>
                    <td className="explorer-trade">
                      <span className="mono-sm">{shortId(t.id)}</span>
                      <span className="explorer-pair muted">{t.pairId}</span>
                    </td>
                    <td>
                      <span
                        className={`explorer-status explorer-status--${t.status === "pending_user_l1" ? "pending" : t.status}`}
                      >
                        {statusLabel(t.status)}
                      </span>
                      {(t.status === "pending" || t.status === "pending_user_l1") && t.error && (
                        <span className="explorer-err-hint" title={t.error} aria-label={t.error}>
                          !
                        </span>
                      )}
                    </td>
                    <td className="explorer-step">{s.label}</td>
                    <td>
                      <span className={`chain-pill chain-pill--${s.chain}`}>
                        {s.chain === "midnight" ? "Midnight" : "Cardano"}
                      </span>
                    </td>
                    <td className="mono-sm explorer-hash">
                      {shortHash(s.txHash)}
                    </td>
                    <td className="explorer-links">
                      {s.explorerUrl && s.txHash ? (
                        <a href={s.explorerUrl} target="_blank" rel="noreferrer">
                          Open
                        </a>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
