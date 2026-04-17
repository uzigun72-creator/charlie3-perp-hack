/**
 * Terminal UI + risk math for the perp order CLI (live Charli3 ODV + env-aligned networks).
 */
import { stdout as stdoutProc } from "node:process";
import type { OrderCommitmentInput } from "../src/order/commitment.js";
import { orderCommitmentHex } from "../src/order/commitment.js";
import { feedConfigForPair } from "../src/charli3/config.js";
import type { VerifiedIndexPrice } from "../src/charli3/price_feed.js";
import type { OrderBookSnapshot } from "../book/order_book.js";

export type PerpUiConfig = {
  /** Maintenance margin as fraction of notional at mark (e.g. 50 = 0.5%). */
  maintenanceBps: number;
};

export const defaultPerpUiConfig: PerpUiConfig = {
  maintenanceBps: 50,
};

export function parseNum(s: string): number {
  const n = Number.parseFloat(String(s).replace(/,/g, ""));
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Isolated-style liquidation mark: equity = collateral + sidePnL = maintenance at mark.
 * collateral and prices in same quote units (USD); size in base units (e.g. ADA).
 */
export function liquidationMark(
  entry: number,
  size: number,
  collateral: number,
  side: "LONG" | "SHORT",
  maintenanceBps: number,
): number | null {
  if (!(entry > 0 && size > 0 && collateral > 0)) return null;
  const mm = maintenanceBps / 10_000;
  if (side === "LONG") {
    const den = size * (mm - 1);
    if (Math.abs(den) < 1e-24) return null;
    const M = (collateral - entry * size) / den;
    return Number.isFinite(M) && M > 0 ? M : null;
  }
  const den = size * (1 + mm);
  if (Math.abs(den) < 1e-24) return null;
  const M = (collateral + entry * size) / den;
  return Number.isFinite(M) && M > 0 ? M : null;
}

/** Fallback when rational formula unstable (display only). */
export function liquidationSimple(entry: number, lev: number, side: "LONG" | "SHORT", maintenanceBps: number): number {
  const im = 1 / Math.max(1, lev);
  const mm = maintenanceBps / 10_000;
  return side === "LONG" ? entry * (1 - im + mm) : entry * (1 + im - mm);
}

export type BookRow = { price: number; label: string; side: "bid" | "ask" };

/** Charli3 v1 feed is a single aggregate — no CLOB depth; show one reference level each side at index. */
export function liveReferenceBook(mid: number): { asks: BookRow[]; bids: BookRow[] } {
  const tag = "ODV idx";
  return {
    asks: [{ price: mid, label: tag, side: "ask" }],
    bids: [{ price: mid, label: tag, side: "bid" }],
  };
}

export type DeploymentStrip = {
  cardanoNetwork: string;
  cardanoBackend: string;
  midnightNetwork: string;
  kupoDisplay: string;
  oracleAddrShort: string;
  policyShort: string;
};

export function deploymentStripFromEnv(pairId: string): DeploymentStrip | { error: string } {
  try {
    const feed = feedConfigForPair(pairId);
    const kupo = (process.env.CHARLI3_KUPO_URL?.trim() || "http://35.209.192.203:1442").replace(/\/$/, "");
    let kupoDisplay = kupo;
    try {
      const u = new URL(kupo);
      kupoDisplay = u.host + u.pathname.replace(/\/$/, "");
    } catch {
      /* keep raw */
    }
    return {
      cardanoNetwork: (process.env.CARDANO_NETWORK || "Preprod").trim() || "Preprod",
      cardanoBackend: (process.env.CARDANO_BACKEND || "blockfrost").trim() || "blockfrost",
      midnightNetwork: (process.env.MIDNIGHT_DEPLOY_NETWORK || "preview").trim() || "preview",
      kupoDisplay,
      oracleAddrShort: `${feed.oracleAddress.slice(0, 18)}…${feed.oracleAddress.slice(-8)}`,
      policyShort: `${feed.policyId.slice(0, 10)}…${feed.policyId.slice(-6)}`,
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

export function formatPx(p: number): string {
  if (!Number.isFinite(p)) return "—";
  if (p >= 100) return p.toFixed(2);
  if (p >= 1) return p.toFixed(4);
  return p.toFixed(6);
}

/** Respect https://no-color.org/ and TTY; allow FORCE_COLOR=1 */
export function tuiColorsEnabled(): boolean {
  const nc = process.env.NO_COLOR;
  if (nc !== undefined && nc !== "") return false;
  if (process.env.FORCE_COLOR === "1" || process.env.FORCE_COLOR === "2" || process.env.FORCE_COLOR === "3") return true;
  return stdoutProc.isTTY === true;
}

type A = {
  r: (s: string) => string;
  g: (s: string) => string;
  y: (s: string) => string;
  c: (s: string) => string;
  m: (s: string) => string;
  dim: (s: string) => string;
  b: (s: string) => string;
  e: string;
};

function ansi(on: boolean): A {
  if (!on) {
    const id = (s: string) => s;
    return { r: id, g: id, y: id, c: id, m: id, dim: id, b: id, e: "" };
  }
  const e = "\x1B[0m";
  return {
    r: (s) => `\x1B[31m${s}${e}`,
    g: (s) => `\x1B[32m${s}${e}`,
    y: (s) => `\x1B[33m${s}${e}`,
    c: (s) => `\x1B[36m${s}${e}`,
    m: (s) => `\x1B[35m${s}${e}`,
    dim: (s) => `\x1B[2m${s}${e}`,
    b: (s) => `\x1B[1m${s}${e}`,
    e,
  };
}

/** Clear viewport + scrollback on common xterm-like TTYs (fixes stacked dashboards after child stdio). */
export function clearTuiScreen(): void {
  if (!stdoutProc.isTTY || process.env.PERP_TUI_NO_CLEAR === "1") {
    stdoutProc.write("\n");
    return;
  }
  stdoutProc.write("\x1B[3J\x1B[2J\x1B[H");
}

export function renderDashboard(opts: {
  draft: OrderCommitmentInput;
  ui: PerpUiConfig;
  oracleMark: number | null;
  oracleError: string | null;
  midOverride: number | null;
  oracleDetail: VerifiedIndexPrice | null;
  /** Wall time of last `pullLiveOracle` attempt (success or fail). */
  lastOracleFetchMs: number | null;
  /** Aggregated session-local book (`post` in terminal); omit or empty for ODV-only ref strip. */
  localBook?: OrderBookSnapshot | null;
  /** Max price levels per side for local book (default 6). */
  bookLevels?: number;
  colors?: boolean;
}): string {
  const {
    draft,
    ui,
    oracleMark,
    oracleError,
    midOverride,
    oracleDetail,
    lastOracleFetchMs,
    localBook = null,
    bookLevels = 6,
    colors = tuiColorsEnabled(),
  } = opts;
  const a = ansi(colors);
  const entry = parseNum(draft.price);
  const size = parseNum(draft.size);
  const collateral = parseNum(draft.margin);
  let mid =
    midOverride !== null && Number.isFinite(midOverride)
      ? midOverride
      : oracleMark !== null && Number.isFinite(oracleMark)
        ? oracleMark
        : Number.isFinite(entry)
          ? entry
          : NaN;
  const useLocalBook = localBook !== null && localBook !== undefined && localBook.totalOrders > 0;
  if (useLocalBook && localBook && (!Number.isFinite(mid) || mid <= 0)) {
    const bb = localBook.bestBid;
    const ba = localBook.bestAsk;
    if (bb !== null && ba !== null) mid = (bb + ba) / 2;
    else if (bb !== null) mid = bb;
    else if (ba !== null) mid = ba;
  }
  const hasRefPx = Number.isFinite(mid);
  let asks: BookRow[];
  let bids: BookRow[];
  if (useLocalBook && localBook) {
    asks = [...localBook.asks]
      .sort((x, y) => y.price - x.price)
      .slice(0, bookLevels)
      .map((x) => ({
        price: x.price,
        label: `${x.totalSize}@${x.orderCount}`,
        side: "ask" as const,
      }));
    bids = localBook.bids.slice(0, bookLevels).map((x) => ({
      price: x.price,
      label: `${x.totalSize}@${x.orderCount}`,
      side: "bid" as const,
    }));
  } else {
    const ref = hasRefPx ? liveReferenceBook(mid) : { asks: [] as BookRow[], bids: [] as BookRow[] };
    asks = ref.asks;
    bids = ref.bids;
  }

  const liqRational =
    Number.isFinite(entry) && Number.isFinite(size) && Number.isFinite(collateral)
      ? liquidationMark(entry, size, collateral, draft.side, ui.maintenanceBps)
      : null;
  const liqSimple = Number.isFinite(entry)
    ? liquidationSimple(entry, draft.leverage, draft.side, ui.maintenanceBps)
    : NaN;
  const liqDisplay =
    liqRational !== null ? liqRational : Number.isFinite(liqSimple) ? liqSimple : NaN;

  const notional = Number.isFinite(entry) && Number.isFinite(size) ? entry * size : NaN;
  const imRate = 1 / Math.max(1, draft.leverage);
  const hash = orderCommitmentHex(draft);
  const hashShort = `${hash.slice(0, 10)}…${hash.slice(-6)}`;

  const dep = deploymentStripFromEnv(draft.pairId);
  const depLines =
    "error" in dep
      ? [`  deploy: ${dep.error}`]
      : [
          `  Cardano ${dep.cardanoNetwork} · backend ${dep.cardanoBackend}   │   Midnight ${dep.midnightNetwork}`,
          `  Kupo ${dep.kupoDisplay}`,
          `  ODV script ${dep.oracleAddrShort}  policy ${dep.policyShort}`,
        ];

  const oracleLines: string[] = [];
  if (oracleError) {
    oracleLines.push(
      `  ${a.r("feed: ERROR — " + oracleError.slice(0, 72) + (oracleError.length > 72 ? "…" : ""))}`,
    );
  } else if (oracleDetail) {
    const t = new Date(oracleDetail.timestampMs).toISOString();
    oracleLines.push(
      `  ${a.dim("Charli3 ODV ·")} index ${a.y(formatPx(oracleDetail.indexPrice))}  mark ${a.y(formatPx(oracleDetail.markPrice))}  ${a.dim("raw")} ${oracleDetail.priceRaw.toString()}`,
    );
    oracleLines.push(
      `  ${a.dim(`UTxO ${oracleDetail.outRef.txHash.slice(0, 14)}…#${oracleDetail.outRef.outputIndex}  datum ${oracleDetail.datumHash.slice(0, 12)}…  t=${t}`)}`,
    );
  } else {
    oracleLines.push("  " + a.dim("feed: not loaded — run `oracle` (live Kupo → Preprod ODV)"));
  }

  const midLabel = midOverride !== null ? `${formatPx(mid)} (mark override)` : formatPx(mid);
  const bookMode =
    useLocalBook && localBook
      ? `    MMR ${(ui.maintenanceBps / 100).toFixed(2)}%    session local book (${localBook.totalOrders}) + ODV`
      : `    MMR ${(ui.maintenanceBps / 100).toFixed(2)}%    live ODV — \`post\` adds to local book`;
  const lines: string[] = [];
  const bar = "══════════════════════════════════════════════════════════════════════════════";
  const rule = "──────────────────────────────────────────────────────────────────────────────";
  lines.push(a.dim(bar));
  lines.push(
    `  ${a.b(a.c("ZK PERP"))}${a.dim(" · ")}${a.b(draft.pairId)}${a.dim("    ref ")}${a.y(Number.isFinite(mid) ? midLabel : "—")}${a.dim(bookMode)}`,
  );
  lines.push(a.dim(bar));
  lines.push(...depLines.map((l) => a.dim(l)));
  lines.push(a.dim(rule));
  lines.push(...oracleLines);
  if (lastOracleFetchMs !== null) {
    lines.push(
      `  ${a.dim(`TUI last fetch: ${new Date(lastOracleFetchMs).toISOString()} (price unchanged if ODV UTxO still same)`)}`,
    );
  }
  lines.push(a.dim(rule));
  lines.push(
    a.dim(
      useLocalBook
        ? "  LOCAL DEPTH (aggregated posts)                  │  YOUR ORDER (commitment hash)"
        : "  REF PRICE (long / short cross here)             │  YOUR ORDER (commitment hash)",
    ),
  );
  lines.push(a.dim(rule));

  const W = 42;
  const L = (s: string) => s.padEnd(W).slice(0, W);

  const sideStr =
    draft.side === "LONG" ? `${a.g("LONG")}${a.dim("  [L]ong / [S]hort")}` : `${a.r("SHORT")}${a.dim("  [L]ong / [S]hort")}`;
  const posLines = [
    `${a.dim("side")}      ${sideStr}`,
    `${a.dim("entry px")}  ${a.y(draft.price)}`,
    `${a.dim("size")}      ${draft.size}`,
    `${a.dim("leverage")}  ${draft.leverage}x`,
    `${a.dim("margin")}    ${draft.margin}`,
    `${a.dim("notional")}  ${Number.isFinite(notional) ? notional.toFixed(4) : "—"}   ${a.dim(`IM≈${(imRate * 100).toFixed(1)}%×ntl`)}`,
    `${a.dim("liq px ≈")}  ${Number.isFinite(liqDisplay) ? a.y(formatPx(liqDisplay)) : "—"} ${a.dim("@ ref (model)")}`,
    `${a.dim("hash")}      ${a.dim(hashShort)}`,
  ];

  const midDivider =
    useLocalBook && localBook && localBook.spread !== null && Number.isFinite(localBook.spread)
      ? `── mid ${formatPx(mid)}  sprd ${formatPx(localBook.spread)} `.padEnd(42).slice(0, 42)
      : `─────────── REF ${formatPx(mid).padStart(12)} ───────────`.padEnd(42).slice(0, 42);

  let pi = 0;
  if (!useLocalBook && (!hasRefPx || asks.length === 0)) {
    lines.push(
      "  " + a.m(L(`ASK ${"—".padStart(14)}  —`)) + a.dim("│ ") + (posLines[pi++] ?? ""),
    );
    lines.push("  " + a.dim(L(`─────────── REF ${"—".padStart(12)} ───────────`)) + a.dim("│ ") + (posLines[pi++] ?? ""));
    lines.push("  " + a.g(L(`BID ${"—".padStart(14)}  —`)) + a.dim("│ ") + (posLines[pi++] ?? ""));
  } else {
    for (const row of asks) {
      lines.push(
        "  " +
          a.m(L(`ASK ${formatPx(row.price).padStart(14)}  ${row.label.padEnd(8)}`)) +
          a.dim("│ ") +
          (posLines[pi++] ?? ""),
      );
    }
    lines.push("  " + a.dim(L(midDivider)) + a.dim("│ ") + (posLines[pi++] ?? ""));
    for (const row of bids) {
      lines.push(
        "  " +
          a.g(L(`BID ${formatPx(row.price).padStart(14)}  ${row.label.padEnd(8)}`)) +
          a.dim("│ ") +
          (posLines[pi++] ?? ""),
      );
    }
  }
  while (pi < posLines.length) {
    lines.push("  " + L("") + a.dim("│ ") + (posLines[pi++] ?? ""));
  }
  lines.push(a.dim(bar));
  lines.push(
    a.dim(
      "  set pairId|… | oracle | post | clearbook | mark clear|<px> | mmr <bps> | submit | full | commit | help | quit",
    ),
  );
  lines.push(a.dim(bar));
  return lines.join("\n");
}
