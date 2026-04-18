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
        setMsg(`Tx ${j.txHash.slice(0, 12)}… — ${j.explorerUrl}`);
      } else if (j.steps) {
        setMsg(
          `Demo: bootstrap → ${j.steps.bootstrapUrl} | deposit → ${j.steps.depositUrl} | merge → ${j.steps.mergeUrl}`,
        );
      } else {
        setMsg("Done.");
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
      setMsg("Enter a positive ADA amount for bootstrap.");
      return;
    }
    void postAction("/api/margin-pool/bootstrap", { lovelace: Math.round(n * 1e6) });
  };

  const depositLov = () => {
    const n = Number.parseFloat(depositAda);
    if (!Number.isFinite(n) || n <= 0) {
      setMsg("Enter a positive ADA amount for margin deposit.");
      return;
    }
    void postAction("/api/margin-pool/deposit", { lovelace: Math.round(n * 1e6) });
  };

  if (loading) {
    return (
      <div className="panel margin-pool-panel">
        <h2>L1 margin pool (Aiken)</h2>
        <p className="chart-empty">Loading…</p>
      </div>
    );
  }

  if (err || !status) {
    return (
      <div className="panel margin-pool-panel">
        <h2>L1 margin pool (Aiken)</h2>
        <p className="chart-err" role="alert">
          {err || "Margin pool status unavailable."}
        </p>
        <p className="account-hint">
          Requires Blockfrost Preprod and compiled <code>cardano/margin-pool/plutus.json</code> (
          <code>npm run build:margin-pool</code>).
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
        <h2>L1 margin pool (Aiken)</h2>
        <button type="button" className="btn-ghost" onClick={() => void load()}>
          Refresh
        </button>
      </div>
      <p className="account-hint">
        On-chain margin vault + pooled collateral (see <code>cardano/margin-pool/</code>). Uses the same{" "}
        <code>WALLET_MNEMONIC</code> as the Cardano wallet above. Read-only status is always shown; on-chain
        actions require <code>MARGIN_POOL_UI_ACTIONS=1</code> in repo <code>.env</code>.
      </p>

      <dl className="wallet-dl">
        <dt>Network</dt>
        <dd>{status.addresses.network}</dd>
        <dt>Pool script address</dt>
        <dd className="mono-addr">{status.addresses.poolAddress}</dd>
        <dt>Margin vault address</dt>
        <dd className="mono-addr">{status.addresses.marginAddress}</dd>
        <dt>Pool UTxOs / margin UTxOs</dt>
        <dd>
          {status.poolUtxos.length} / {status.marginUtxos.length}
        </dd>
        <dt>ADA at pool / margin scripts</dt>
        <dd>
          {adaFromLovelace(status.poolLovelaceTotal)} / {adaFromLovelace(status.marginLovelaceTotal)} tADA
        </dd>
        {status.poolDatumPreview && (
          <>
            <dt>Pool datum (merge total / count)</dt>
            <dd className="mono-sm">
              {status.poolDatumPreview.totalMarginLovelace} lovelace merged · {status.poolDatumPreview.mergeCount}{" "}
              merges
            </dd>
          </>
        )}
      </dl>

      {!actions && (
        <p className="account-hint" role="status">
          On-chain actions disabled. Set <code>MARGIN_POOL_UI_ACTIONS=1</code> and restart the API to bootstrap,
          deposit margin, or merge.
        </p>
      )}

      {actions && (
        <div className="margin-pool-actions">
          <div className="margin-pool-row">
            <label>
              Bootstrap pool (ADA)
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
              {busy === "/api/margin-pool/bootstrap" ? "…" : "Bootstrap pool"}
            </button>
          </div>
          <div className="margin-pool-row">
            <label>
              Deposit margin (ADA)
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
              {busy === "/api/margin-pool/deposit" ? "…" : "Deposit to margin vault"}
            </button>
          </div>
          <div className="margin-pool-row">
            <button
              type="button"
              className="btn-ghost"
              disabled={!!busy}
              onClick={() => void postAction("/api/margin-pool/merge")}
            >
              {busy === "/api/margin-pool/merge" ? "…" : "Merge margin → pool"}
            </button>
            <span className="account-hint">Requires exactly one pool UTxO and ≥1 margin UTxO.</span>
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
              {busy === "/api/margin-pool/demo" ? "…" : "Run full demo (3 txs)"}
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
