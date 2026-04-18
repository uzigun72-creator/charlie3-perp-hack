/**
 * Load env before any `../../src` imports (they pull `cardano_env`, which must not win over repo secrets).
 *
 * Order: `perps-web/.env` first (Vite / local flags), then repo-root `.env` with **override** so shared
 * secrets (`WALLET_MNEMONIC`, Blockfrost, etc.) replace empty placeholders in perps-web/.env.
 */
import { config } from "dotenv";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const perpsRoot = join(__dirname, "..");
const repoRoot = join(__dirname, "../..");

config({ path: join(perpsRoot, ".env") });
config({ path: join(repoRoot, ".env"), override: true });

/** Map legacy `ZKPERPS_*` names to what `@charli3perp/cli` reads (`C3PERP_*`). */
function applyC3perpEnvAliases(): void {
  const t =
    process.env.C3PERP_TRADER_SK_HEX?.trim() || process.env.ZKPERPS_TRADER_SK_HEX?.trim();
  if (t) process.env.C3PERP_TRADER_SK_HEX = t;
  const oc =
    process.env.C3PERP_ORDER_COMMITMENT_HEX?.trim() ||
    process.env.ZKPERPS_ORDER_COMMITMENT_HEX?.trim();
  if (oc) process.env.C3PERP_ORDER_COMMITMENT_HEX = oc;
}

applyC3perpEnvAliases();

/** @deprecated Env is applied at import time; call is a no-op kept for existing entrypoints. */
export function loadPerpsEnv(): void {}
