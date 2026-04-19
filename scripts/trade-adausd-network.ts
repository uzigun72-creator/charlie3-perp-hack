#!/usr/bin/env npx tsx
/**
 * End-to-end **live network** flow for ADA-USD: Charli3 (Kupo) → Midnight **Preview** → Cardano **Preprod**
 * (oracle reference tx + settlement anchor).
 *
 * Prerequisites (all real testnet / preview):
 * - `CARDANO_BACKEND=blockfrost`, `CARDANO_NETWORK=Preprod`, `BLOCKFROST_PROJECT_ID`, `WALLET_MNEMONIC` (tADA)
 * - `BIP39_MNEMONIC` funded on **Midnight Preview**
 * - `C3PERP_TRADER_SK_HEX`, `C3PERP_ORDER_COMMITMENT_HEX` (64 hex each)
 * - Kupo reachable (`CHARLI3_KUPO_URL`, default hackathon Preprod indexer)
 *
 * Usage:
 *   npx tsx scripts/trade-adausd-network.ts [command]
 *
 * Commands:
 *   all       Run oracle → midnight → cardano-pull → cardano-anchor (default)
 *   oracle    Only fetch Charli3 ADA-USD + print L1 anchor digest
 *   midnight  Only `npm run run-all` on Midnight Preview (uses L1 digest from oracle step env or re-fetch)
 *   cardano   Only Charli3 pull tx + settlement anchor (expects oracle + midnight env vars if anchoring).
 *             Optional: `C3PERP_CHARLI3_PULL_TX_HASH` = 64-char tx id to skip a new pull (reuse prior pull; helps when mempool races).
 *
 *   npx tsx scripts/trade-adausd-network.ts all --dry-run   # oracle + prints plan, no txs
 *
 * Full five-contract pipeline (Charli3 witness builder → run-pipeline):
 *   MIDNIGHT_RUN_MODE=full-pipeline
 *   C3PERP_BID_ORDER_JSON='{"pairId":"ADA-USD","side":"LONG",...}'
 *   C3PERP_ASK_ORDER_JSON='{"pairId":"ADA-USD","side":"SHORT",...}'
 *   (same BIP39 / trader keys as order-only; order commitment for Cardano = bid leg)
 */
import "dotenv/config";

/** Same mapping as `perps-web/server/loadEnv.ts` — CLI reads `C3PERP_*`, repo often has `ZKPERPS_*`. */
(() => {
  const t = process.env.C3PERP_TRADER_SK_HEX?.trim() || process.env.ZKPERPS_TRADER_SK_HEX?.trim();
  if (t) process.env.C3PERP_TRADER_SK_HEX = t;
  const oc =
    process.env.C3PERP_ORDER_COMMITMENT_HEX?.trim() ||
    process.env.ZKPERPS_ORDER_COMMITMENT_HEX?.trim();
  if (oc) process.env.C3PERP_ORDER_COMMITMENT_HEX = oc;
})();

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cardanoBackend } from "../src/config/cardano_env.js";
import { getVerifiedIndexPrice, type VerifiedIndexPrice } from "../src/charli3/price_feed.js";
import { l1AnchorHexFromOracle } from "../src/charli3/l1_anchor_digest.js";
import { orderCommitmentHex } from "../src/order/commitment.js";
import {
  buildPipelineWitnessEnv,
  parseOrderCommitmentJson,
} from "../src/pipeline/witness_builder.js";
import { submitCharli3OracleReferenceTx } from "../src/cardano/charli3_pull_tx.js";
import { submitSettlementAnchorTx } from "../src/cardano/submit_settlement_anchor.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PAIR = "ADA-USD";

function usage(): void {
  console.log(`trade-adausd-network — Charli3 + Midnight Preview + Cardano Preprod

Requires:
  MIDNIGHT_DEPLOY_NETWORK=preview (set automatically for midnight step)
  CARDANO_NETWORK=Preprod CARDANO_BACKEND=blockfrost
  BLOCKFROST_PROJECT_ID WALLET_MNEMONIC
  BIP39_MNEMONIC C3PERP_TRADER_SK_HEX
  C3PERP_ORDER_COMMITMENT_HEX (order-only path)
  For MIDNIGHT_RUN_MODE=full-pipeline: C3PERP_BID_ORDER_JSON + C3PERP_ASK_ORDER_JSON (JSON orders; Cardano uses bid commitment)

Commands: all | oracle | midnight | cardano | help
  --dry-run  With \`all\`: fetch oracle only, print digest, skip chains

Examples:
  npx tsx scripts/trade-adausd-network.ts all
  npx tsx scripts/trade-adausd-network.ts oracle
`);
}

function assertNetworks(): void {
  const cn = (process.env.CARDANO_NETWORK || "").trim();
  if (cn && cn !== "Preprod") {
    console.warn(`Warning: CARDANO_NETWORK=${cn} — this CLI expects Preprod for Cardano.`);
  }
  if (cardanoBackend() !== "blockfrost") {
    throw new Error("Set CARDANO_BACKEND=blockfrost for live Cardano Preprod txs.");
  }
}

function extractBindTxHash(stdout: string): string | undefined {
  const line = stdout.split("\n").find((l) => l.includes("bindCardanoAnchor") && l.includes("txHash="));
  if (!line) return undefined;
  const m = line.match(/txHash=([^\s]+)/);
  return m?.[1];
}

/** Run command with live terminal output (not buffered). Collects merged stdout for parsing. */
function runWithLiveOutput(
  command: string,
  args: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["inherit", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
      process.stderr.write(d);
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout: stdout + (stderr ? "\n" + stderr : ""), exitCode });
    });
  });
}

async function stepOracle(): Promise<{ v: VerifiedIndexPrice; l1: string }> {
  const v = await getVerifiedIndexPrice(PAIR);
  const l1 = l1AnchorHexFromOracle(v);
  console.log("\n--- Charli3 ODV (ADA-USD) ---");
  console.log("indexPrice(÷1e6):", v.indexPrice);
  console.log("oracle outRef:", v.outRef.txHash, v.outRef.outputIndex);
  console.log("datumHash:", v.datumHash);
  console.log("C3PERP_L1_ANCHOR_HEX (bind digest):", l1);
  return { v, l1 };
}

async function stepMidnight(l1Hex: string, oracle?: VerifiedIndexPrice): Promise<string> {
  const mnemonic = process.env.BIP39_MNEMONIC?.trim();
  if (!mnemonic) throw new Error("Set BIP39_MNEMONIC for Midnight Preview.");

  const mode = (process.env.MIDNIGHT_RUN_MODE || "full-pipeline").trim();
  const useFullPipeline = mode === "full-pipeline";

  let witnessEnv: Record<string, string> = {};
  let orderCommitmentForCardano = process.env.C3PERP_ORDER_COMMITMENT_HEX?.replace(/^0x/i, "") ?? "";

  if (useFullPipeline) {
    if (!oracle) {
      throw new Error("MIDNIGHT_RUN_MODE=full-pipeline requires a fresh Charli3 observation (run after oracle step or pass oracle in flow).");
    }
    const bidJson = process.env.C3PERP_BID_ORDER_JSON?.trim();
    const askJson = process.env.C3PERP_ASK_ORDER_JSON?.trim();
    if (!bidJson || !askJson) {
      throw new Error(
        "MIDNIGHT_RUN_MODE=full-pipeline requires C3PERP_BID_ORDER_JSON and C3PERP_ASK_ORDER_JSON (JSON OrderCommitmentInput each). " +
          "Or set MIDNIGHT_RUN_MODE=order-only with C3PERP_ORDER_COMMITMENT_HEX for the fast charli3perp-order-only path (no on-chain matching contract).",
      );
    }
    const bid = parseOrderCommitmentJson(bidJson);
    const ask = parseOrderCommitmentJson(askJson);
    witnessEnv = buildPipelineWitnessEnv({ bid, ask, oracle });
    orderCommitmentForCardano = orderCommitmentHex(bid);
    process.env.C3PERP_ORDER_COMMITMENT_HEX = orderCommitmentForCardano;
    console.log("\n--- Midnight Preview (five-contract pipeline + built witnesses) ---");
  } else {
    console.log("\n--- Midnight Preview (charli3perp-order run-all — fast path) ---");
  }
  console.log(
    "(Streaming output — wallet sync + DUST can take several minutes; not stuck.)\n",
  );
  const npmScript = useFullPipeline ? "run-pipeline" : "run-all";
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    MIDNIGHT_DEPLOY_NETWORK: "preview",
    C3PERP_L1_ANCHOR_HEX: l1Hex,
    ...witnessEnv,
  };
  if (useFullPipeline) {
    env.C3PERP_ORDER_COMMITMENT_HEX = orderCommitmentForCardano;
  }
  const { stdout, exitCode } = await runWithLiveOutput(
    "npm",
    ["run", npmScript, "-w", "@charli3perp/cli"],
    {
      cwd: ROOT,
      env,
    },
  );
  if (exitCode !== 0) {
    throw new Error(`Midnight ${npmScript} exited with code ${exitCode}`);
  }
  const bindHash = extractBindTxHash(stdout);
  if (bindHash) console.log("\n[parsed] Midnight bind txHash:", bindHash);
  return bindHash ?? "";
}

/** Resolve 32-byte order commitment for settlement anchor (same bid leg as full-pipeline Midnight). */
function resolveOrderCommitmentHexForAnchor(): string {
  const normalize = (h: string) => h.replace(/^0x/i, "").toLowerCase();
  const isValid = (h: string) =>
    h.length === 64 && /^[0-9a-f]+$/.test(h);

  const c3 = normalize(process.env.C3PERP_ORDER_COMMITMENT_HEX ?? "");
  if (isValid(c3)) return c3;

  const bidJson =
    process.env.C3PERP_BID_ORDER_JSON?.trim() ||
    process.env.ZKPERPS_BID_ORDER_JSON?.trim() ||
    "";
  if (bidJson) {
    const fromBid = normalize(orderCommitmentHex(parseOrderCommitmentJson(bidJson)));
    if (isValid(fromBid)) {
      process.env.C3PERP_ORDER_COMMITMENT_HEX = fromBid;
      return fromBid;
    }
  }

  const legacy = normalize(process.env.ZKPERPS_ORDER_COMMITMENT_HEX ?? "");
  if (isValid(legacy)) return legacy;

  return "";
}

function cardanoExplorerTxUrl(txHash: string): string {
  const h = txHash.replace(/^0x/i, "").toLowerCase();
  const base = (
    process.env.CARDANO_EXPLORER_BASE?.trim() ||
    process.env.EXPLORER_BASE?.trim() ||
    "https://explorer.1am.xyz"
  ).replace(/\/$/, "");
  return `${base}/tx/${h}`;
}

async function stepCardano(oracle: VerifiedIndexPrice, midnightBindTx: string): Promise<void> {
  const reusePull = process.env.C3PERP_CHARLI3_PULL_TX_HASH?.replace(/^0x/i, "").trim() ?? "";
  let pullTxHash: string;
  let pullExplorer: string;
  if (reusePull.length === 64 && /^[0-9a-f]+$/i.test(reusePull)) {
    pullTxHash = reusePull.toLowerCase();
    pullExplorer = cardanoExplorerTxUrl(pullTxHash);
    console.log("\n--- Cardano Preprod: Charli3 reference tx (skipped; using C3PERP_CHARLI3_PULL_TX_HASH) ---");
    console.log("charli3_pull txHash:", pullTxHash);
    console.log("explorer:", pullExplorer);
  } else {
    console.log("\n--- Cardano Preprod: Charli3 reference tx ---");
    const pull = await submitCharli3OracleReferenceTx(PAIR);
    pullTxHash = pull.txHash;
    pullExplorer = pull.explorerUrl;
    console.log("charli3_pull txHash:", pullTxHash);
    console.log("explorer:", pullExplorer);
  }

  const orderHex = resolveOrderCommitmentHexForAnchor();
  if (orderHex.length !== 64) {
    throw new Error(
      "Set C3PERP_ORDER_COMMITMENT_HEX (64 hex), or C3PERP_BID_ORDER_JSON (bid leg JSON) so the anchor commitment matches your Midnight order.",
    );
  }
  console.log("order commitment (anchor):", orderHex);

  const settlementId = `ada-usd-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const midnightBlob = JSON.stringify({
    pair: PAIR,
    charli3: {
      indexPrice: oracle.indexPrice,
      priceRaw: oracle.priceRaw.toString(),
      datumHash: oracle.datumHash,
      outRef: oracle.outRef,
      pullTxHash: pullTxHash,
    },
    midnightPreview: {
      bindCardanoAnchorTxHash: midnightBindTx || null,
    },
    network: { cardano: "preprod", midnight: "preview" },
  });

  console.log("\n--- Cardano Preprod: settlement anchor ---");
  const anchor = await submitSettlementAnchorTx({
    settlementId,
    orderCommitmentHex64: orderHex,
    midnightTxUtf8: midnightBlob,
  });
  console.log("anchor txHash:", anchor.txHash);
  console.log("scriptAddress:", anchor.scriptAddress);
  console.log("explorer:", anchor.explorerUrl);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const dry = argv.includes("--dry-run");
  const cmd = argv.find((a) => !a.startsWith("-")) || "all";

  if (cmd === "help" || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  assertNetworks();

  if (cmd === "oracle") {
    await stepOracle();
    return;
  }

  if (cmd === "midnight") {
    const mode = (process.env.MIDNIGHT_RUN_MODE || "full-pipeline").trim();
    if (mode === "full-pipeline") {
      const { v, l1 } = await stepOracle();
      const l1Hex = process.env.C3PERP_L1_ANCHOR_HEX?.trim() || l1;
      await stepMidnight(l1Hex, v);
    } else {
      const l1 =
        process.env.C3PERP_L1_ANCHOR_HEX?.trim() ||
        l1AnchorHexFromOracle((await stepOracle()).v);
      await stepMidnight(l1);
    }
    return;
  }

  if (cmd === "cardano") {
    const { v } = await stepOracle();
    const bind =
      process.env.MIDNIGHT_BIND_TX_HASH?.trim() ||
      "";
    await stepCardano(v, bind);
    return;
  }

  if (cmd === "all") {
    if (dry) {
      const { v, l1 } = await stepOracle();
      console.log("\n[--dry-run] Skipping Midnight + Cardano submits.");
      console.log("Would set C3PERP_L1_ANCHOR_HEX=" + l1);
      console.log("Oracle indexPrice:", v.indexPrice);
      return;
    }
    const { v, l1 } = await stepOracle();
    const bindTx = await stepMidnight(l1, v);
    await stepCardano(v, bindTx);
    console.log("\nDone. ADA-USD path: Charli3 → Midnight Preview → Cardano Preprod.");
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  usage();
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
