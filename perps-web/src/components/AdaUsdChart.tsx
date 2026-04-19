import { useCallback, useEffect, useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api";

const POLL_MS = 5000;
const MAX_POINTS = 240;

type Point = { t: number; price: number };

function formatPxAxis(n: number): string {
  if (!Number.isFinite(n)) return "";
  if (n >= 1) return n.toFixed(4);
  return n.toFixed(6);
}

export function AdaUsdChart() {
  const [data, setData] = useState<Point[]>([]);
  const [err, setErr] = useState<string | null>(null);

  const sample = useCallback(async () => {
    try {
      const r = await api("/api/oracle?pair=ADA-USD");
      const j = (await r.json()) as { indexPrice?: number; error?: string };
      if (!r.ok) throw new Error(j.error || "Oracle failed");
      if (typeof j.indexPrice !== "number" || !Number.isFinite(j.indexPrice)) {
        throw new Error("Invalid index price");
      }
      setErr(null);
      setData((prev) => {
        const next = [...prev, { t: Date.now(), price: j.indexPrice! }];
        return next.length > MAX_POINTS ? next.slice(-MAX_POINTS) : next;
      });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void sample();
    const id = window.setInterval(() => void sample(), POLL_MS);
    return () => window.clearInterval(id);
  }, [sample]);

  const chartData = data;

  const last = data.length > 0 ? data[data.length - 1] : null;
  const first = data.length > 0 ? data[0] : null;
  const delta =
    last && first && data.length > 1 ? last.price - first.price : null;

  return (
    <div className="panel chart-panel">
      <div className="chart-header">
        <div>
          <h2>ADA/USD</h2>
        </div>
        {last && (
          <div className="chart-meta">
            <span className="chart-last">{formatPxAxis(last.price)}</span>
            {delta != null && (
              <span className={delta >= 0 ? "delta up" : "delta down"}>
                {delta >= 0 ? "+" : ""}
                {delta.toFixed(6)}
              </span>
            )}
          </div>
        )}
      </div>
      {err && (
        <p className="chart-err" role="alert">
          {err}
        </p>
      )}
      {chartData.length < 2 ? (
        <div className="chart-empty">…</div>
      ) : (
        <div className="chart-wrap">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={chartData} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="adaUsdFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#3ee0a8" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="#3ee0a8" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#252b36" vertical={false} />
              <XAxis
                dataKey="t"
                type="number"
                domain={["dataMin", "dataMax"]}
                tickFormatter={(ts) =>
                  new Date(ts).toLocaleTimeString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                  })
                }
                stroke="#8b93a3"
                tick={{ fill: "#8b93a3", fontSize: 11 }}
                tickLine={false}
              />
              <YAxis
                domain={["auto", "auto"]}
                tickFormatter={formatPxAxis}
                stroke="#8b93a3"
                tick={{ fill: "#8b93a3", fontSize: 11 }}
                tickLine={false}
                width={64}
              />
              <Tooltip
                contentStyle={{
                  background: "#141820",
                  border: "1px solid #252b36",
                  borderRadius: "8px",
                  color: "#e8eaef",
                }}
                labelFormatter={(ts) =>
                  new Date(Number(ts)).toLocaleString(undefined, {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })
                }
                formatter={(value: number | undefined) => [
                  value != null ? formatPxAxis(value) : "—",
                  "",
                ]}
              />
              <Area
                type="monotone"
                dataKey="price"
                stroke="#3ee0a8"
                strokeWidth={2}
                fill="url(#adaUsdFill)"
                dot={false}
                activeDot={{ r: 4, fill: "#3ee0a8" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
