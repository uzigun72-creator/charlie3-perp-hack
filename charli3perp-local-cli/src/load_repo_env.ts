/**
 * Load repo-root `.env` so `npm run run-all -w @charli3perp/cli` from `charlie3_hack/`
 * picks up `BIP39_MNEMONIC` etc. without `source .env`.
 *
 * **Node WebSocket:** Wallet indexer sync uses `WebSocket` (WSS to GraphQL). Node has no global
 * `WebSocket` — without the `ws` package shim, sync stays `connected=false` forever. Pipeline
 * entrypoints used to set this per-file; we centralize it here so `midnight-fund-derived-wallets` etc.
 * behave the same as `run-pipeline` / `run-all`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import WebSocket from "ws";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnv = path.resolve(here, "../../.env");
config({ path: repoRootEnv });

if (typeof (globalThis as unknown as { WebSocket?: unknown }).WebSocket === "undefined") {
  (globalThis as unknown as { WebSocket: typeof WebSocket }).WebSocket = WebSocket;
}
