import { useCallback, useEffect, useState } from "react";
import { api, readJsonBody } from "./api";

type MarginPoolErrBody = {
  ok: false;
  error: string;
  actionsEnabled?: boolean;
};

type MarginPoolOk = {
  ok: true;
  addresses: {
    network: string;
    poolAddress: string;
    marginAddress: string;
    poolScriptHashHex: string;
    marginScriptHashHex: string;
    adminKeyHashHex: string;
  };
  actionsEnabled: boolean;
  poolUtxos: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
  marginUtxos: Array<{ txHash: string; outputIndex: number; lovelace: string }>;
  poolLovelaceTotal: string;
  marginLovelaceTotal: string;
  poolDatumPreview: { totalMarginLovelace: string; mergeCount: string } | null;
};

function adaFromLovelace(s: string): string {
  const n = BigInt(s || "0");
  const whole = Number(n) / 1e6;
  if (!Number.isFinite(whole)) return s;
  return whole.toFixed(6);
}

export function MarginPoolPanel() {
  const [status, setStatus] = useState<MarginPoolOk | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [bootstrapAda, setBootstrapAda] = useState("5");
  const [depositAda, setDepositAda] = useState("3");

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api("/api/margin-pool/status");
      const parsed = await readJsonBody<MarginPoolOk | MarginPoolErrBody>(r);
      if (!parsed.ok) {
        setStatus(null);
        setErr(parsed.error || "Bad response");
        return;
      }
      const j = parsed.data;
      if ("ok" in j && j.ok === false) {
        setStatus(null);
        setErr(j.error || "Unavailable");
        return;
      }
      setStatus(j as MarginPoolOk);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const postAction = async (path: string, body?: object) => {
    setBusy(path);
    setMsg(null);
    try {
      const r = await api(path, {
        method: "POST",
        body: body ? JSON.stringify(body) : undefined,
      });
      const parsed = await readJsonBody<{
        error?: string;
        ok?: boolean;
        txHash?: string;
        explorerUrl?: string;
        steps?: {
          bootstrapTxHash: string;
          depositTxHash: string;
          mergeTxHash: string;
          bootstrapUrl: string;
          depositUrl: string;
          mergeUrl: string;
        };
      }>(r);
      if (!parsed.ok) {
        setMsg(parsed.error || `HTTP ${r.status}`);
        return;
      }
      const j = parsed.data;
      if (!r.ok) {
        setMsg(j.error || r.statusText);
        return;
      }
      if (j.txHash && j.explorerUrl) {
        setMsg(`${j.txHash.slice(0, 12)}…`);
      } else if (j.steps) {
        setMsg("OK");
      } else {
        setMsg("OK");
      }
      await load();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const bootstrapLovelace = () => {
    const n = Number.parseFloat(bootstrapAda);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg("Invalid amount");
      return;
    }
    void postAction("/api/margin-pool/bootstrap", { lovelace: Math.round(n * 1e6) });
  };

  const depositLov = () => {
    const n = Number.parseFloat(depositAda);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg("Invalid amount");
      return;
    }
    void postAction("/api/margin-pool/deposit", { lovelace: Math.round(n * 1e6) });
  };

  if (loading) {
    return (
      <div className="panel margin-pool-panel">
        <h2>Pool</h2>
        <p className="chart-empty">…</p>
      </div>
    );
  }

  if (err || !status) {
    return (
      <div className="panel margin-pool-panel">
        <h2>Pool</h2>
        <p className="chart-err" role="alert">
          {err || "—"}
        </p>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Retry
        </button>
      </div>
    );
  }

  const actions = status.actionsEnabled;

  return (
    <div className="panel margin-pool-panel">
      <div className="fills-head">
        <h2>Pool</h2>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <dl className="wallet-dl">
        <dt>Network</dt>
        <dd>{status.addresses.network}</dd>
        <dt>Pool</dt>
        <dd className="mono-addr">{status.addresses.poolAddress}</dd>
        <dt>Vault</dt>
        <dd className="mono-addr">{status.addresses.marginAddress}</dd>
        <dt>UTxO</dt>
        <dd>
          {status.poolUtxos.length} / {status.marginUtxos.length}
        </dd>
        <dt>ADA</dt>
        <dd>
          {adaFromLovelace(status.poolLovelaceTotal)} / {adaFromLovelace(status.marginLovelaceTotal)}
        </dd>
        {status.poolDatumPreview && (
          <>
            <dt>Datum</dt>
            <dd className="mono-sm">
              {status.poolDatumPreview.totalMarginLovelace} · {status.poolDatumPreview.mergeCount}
            </dd>
          </>
        )}
      </dl>

      {!actions && (
        <p className="account-hint" role="status">
          Off
        </p>
      )}

      {actions && (
        <div className="margin-pool-actions">
          <div className="margin-pool-row">
            <label>
              Bootstrap
              <input
                type="text"
                value={bootstrapAda}
                onChange={(e) => setBootstrapAda(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => bootstrapLovelace()}
            >
              {busy === "/api/margin-pool/bootstrap" ? "…" : "Bootstrap"}
            </button>
          </div>
          <div className="margin-pool-row">
            <label>
              Deposit
              <input
                type="text"
                value={depositAda}
                onChange={(e) => setDepositAda(e.target.value)}
                inputMode="decimal"
              />
            </label>
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => depositLov()}
            >
              {busy === "/api/margin-pool/deposit" ? "…" : "Deposit"}
            </button>
          </div>
          <div className="margin-pool-row">
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => void postAction("/api/margin-pool/merge")}
            >
              {busy === "/api/margin-pool/merge" ? "…" : "Merge"}
            </button>
          </div>
          <div className="margin-pool-row">
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() =>
                void postAction("/api/margin-pool/demo", {
                  poolBootstrapLovelace: Math.round(Number.parseFloat(bootstrapAda || "5") * 1e6),
                  marginDepositLovelace: Math.round(Number.parseFloat(depositAda || "3") * 1e6),
                })
              }
            >
              {busy === "/api/margin-pool/demo" ? "…" : "Demo"}
            </button>
          </div>
        </div>
      )}

      {msg && (
        <p className="account-hint" role="status">
          {msg}
        </p>
      )}
    </div>
  );
}
