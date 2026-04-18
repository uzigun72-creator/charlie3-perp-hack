import type { Hono } from "hono";
import {
  bootstrapMarginPool,
  depositMargin,
  getMarginPoolStatus,
  mergeMarginIntoPool,
  marginPoolTxExplorerUrl,
  runMarginPoolDemo,
} from "../../src/cardano/margin_pool_flow.js";

function marginActionsEnabled(): boolean {
  return process.env.MARGIN_POOL_UI_ACTIONS === "1";
}

/** Aiken margin pool: read status + optional on-chain actions (same wallet as `/api/cardano/wallet`). */
export function registerMarginPoolRoutes(app: Hono): void {
  app.get("/api/margin-pool/status", async (c) => {
    try {
      const status = await getMarginPoolStatus(marginActionsEnabled());
      return c.json(status);
    } catch (e) {
      return c.json(
        {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
          actionsEnabled: marginActionsEnabled(),
        },
        503,
      );
    }
  });

  app.post("/api/margin-pool/bootstrap", async (c) => {
    if (!marginActionsEnabled()) {
      return c.json({ error: "Set MARGIN_POOL_UI_ACTIONS=1 in repo .env to enable on-chain actions." }, 403);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as { lovelace?: string | number };
      const raw = body.lovelace ?? 5_000_000;
      const lovelace = BigInt(raw);
      const r = await bootstrapMarginPool(lovelace);
      return c.json({ ok: true as const, ...r });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/margin-pool/deposit", async (c) => {
    if (!marginActionsEnabled()) {
      return c.json({ error: "Set MARGIN_POOL_UI_ACTIONS=1 in repo .env to enable on-chain actions." }, 403);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as { lovelace?: string | number };
      const raw = body.lovelace ?? 3_000_000;
      const lovelace = BigInt(raw);
      const r = await depositMargin(lovelace);
      return c.json({ ok: true as const, ...r });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/margin-pool/merge", async (c) => {
    if (!marginActionsEnabled()) {
      return c.json({ error: "Set MARGIN_POOL_UI_ACTIONS=1 in repo .env to enable on-chain actions." }, 403);
    }
    try {
      const r = await mergeMarginIntoPool();
      return c.json({ ok: true as const, ...r });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });

  app.post("/api/margin-pool/demo", async (c) => {
    if (!marginActionsEnabled()) {
      return c.json({ error: "Set MARGIN_POOL_UI_ACTIONS=1 in repo .env to enable on-chain actions." }, 403);
    }
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        poolBootstrapLovelace?: string | number;
        marginDepositLovelace?: string | number;
      };
      const p = BigInt(body.poolBootstrapLovelace ?? 5_000_000);
      const m = BigInt(body.marginDepositLovelace ?? 3_000_000);
      const steps = await runMarginPoolDemo({ poolBootstrapLovelace: p, marginDepositLovelace: m });
      const net = (process.env.CARDANO_NETWORK || "Preprod").trim();
      return c.json({
        ok: true as const,
        steps: {
          bootstrapTxHash: steps.step1,
          depositTxHash: steps.step2,
          mergeTxHash: steps.step3,
          bootstrapUrl: marginPoolTxExplorerUrl(net, steps.step1),
          depositUrl: marginPoolTxExplorerUrl(net, steps.step2),
          mergeUrl: marginPoolTxExplorerUrl(net, steps.step3),
        },
      });
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }
  });
}
