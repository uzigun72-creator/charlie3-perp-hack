/**
 * Charli3 → Midnight full-pipeline → Cardano (pull + settlement anchor).
 * Mirrors `scripts/trade-adausd-network.ts` `all` command without process exit.
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cardanoBackend,
  cardanoCollateralViaMarginPool,
  marginPoolCollateralLovelace,
} from "../../src/config/cardano_env.js";
import type { VerifiedIndexPrice } from "../../src/charli3/price_feed.js";
import { getVerifiedIndexPrice } from "../../src/charli3/price_feed.js";
import { l1AnchorHexFromOracle } from "../../src/charli3/l1_anchor_digest.js";
import type { OrderCommitmentInput } from "../../src/order/commitment.js";
import { orderCommitmentHex } from "../../src/order/commitment.js";
import {
  buildPipelineWitnessEnv,
} from "../../src/pipeline/witness_builder.js";
import { createAppLucid } from "../../src/cardano/lucid_wallet.js";
import { submitCharli3OracleReferenceTx } from "../../src/cardano/charli3_pull_tx.js";
import { submitSettlementAnchorTx } from "../../src/cardano/submit_settlement_anchor.js";
import {
  lockCollateralForTrade,
  type LockCollateralForTradeResult,
} from "../../src/cardano/margin_pool_flow.js";
import type { OrderIndexEntry } from "./orderIndex.js";
import { updateEntry } from "./orderIndex.js";
import { cardanoTxExplorerUrl } from "./explorerUrls.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const PAIR = "ADA-USD";

/** Serialize settlement-anchor submits so parallel Midnight pipelines do not race the same Cardano wallet UTxOs. */
let settlementAnchorGate: Promise<void> = Promise.resolve();

function runExclusiveSettlementAnchor<T>(fn: () => Promise<T>): Promise<T> {
  const run = settlementAnchorGate.then(fn, fn);
  settlementAnchorGate = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Persist partial pipeline results so `/api/explorer/trades` shows tx hashes as each step finishes. */
async function patchTradeIndex(
  tradeId: string | undefined,
  patch: Partial<OrderIndexEntry>,
): Promise<void> {
  const id = tradeId?.trim();
  if (!id) return;
  await updateEntry(id, patch);
}

/**
 * Isolated Midnight private-state DB names + `MIDNIGHT_DERIVE_KEY_INDEX`, matching
 * `charli3perp-local-cli/src/midnight-parallel-cli.ts`.
 */
export function midnightParallelEnvForDeriveIndex(deriveKeyIndex: number): Record<string, string> {
  return {
    MIDNIGHT_DERIVE_KEY_INDEX: String(deriveKeyIndex),
    MIDNIGHT_PRIVATE_STATE_STORE: `charli3perp-order-parallel-${deriveKeyIndex}`,
    MIDNIGHT_PRIVATE_STATE_STORE_MATCHING: `charli3perp-matching-parallel-${deriveKeyIndex}`,
    MIDNIGHT_PRIVATE_STATE_STORE_SETTLEMENT: `charli3perp-settlement-parallel-${deriveKeyIndex}`,
    MIDNIGHT_PRIVATE_STATE_STORE_LIQUIDATION: `charli3perp-liquidation-parallel-${deriveKeyIndex}`,
    MIDNIGHT_PRIVATE_STATE_STORE_AGGREGATE: `charli3perp-aggregate-parallel-${deriveKeyIndex}`,
  };
}

let midnightWorkerRoundRobin = 0;

function midnightWorkerPoolSizeFromEnv(): number {
  return Math.max(1, Number.parseInt(process.env.PERPS_MIDNIGHT_WORKER_POOL_SIZE || "5", 10) || 5);
}

function midnightWorkerOffsetFromEnv(): number {
  const raw = process.env.PERPS_MIDNIGHT_WORKER_OFFSET?.trim();
  if (!raw) return 1;
  const n = Number.parseInt(raw, 10);
  /** `0` is valid (faucet usually funds `deriveKeysAt(0)`); avoid `|| 1` which turned 0 into 1. */
  return Number.isFinite(n) && n >= 0 ? n : 1;
}

/** Round-robin derive index in [offset, offset + pool - 1] — aligns with `midnight-parallel-cli` worker slots. */
export function nextMidnightWorkerDeriveIndex(): number {
  const pool = midnightWorkerPoolSizeFromEnv();
  const offset = midnightWorkerOffsetFromEnv();
  const idx = offset + (midnightWorkerRoundRobin % pool);
  midnightWorkerRoundRobin += 1;
  return idx;
}

function parallelMidnightAssignEnabled(): boolean {
  return (process.env.PERPS_MIDNIGHT_PARALLEL_ASSIGN ?? "1").trim() !== "0";
}

/**
 * Parallel HD workers (isolated private state + derive index) for every full-pipeline unless disabled.
 * Explicit `midnightDeriveKeyIndex` wins; margin pool uses legacy `MIDNIGHT_DERIVE_KEY_INDEX` env only.
 */
function resolveMidnightWorkerEnv(opts: { midnightDeriveKeyIndex?: number }): Record<string, string> {
  if (opts.midnightDeriveKeyIndex !== undefined) {
    return midnightParallelEnvForDeriveIndex(opts.midnightDeriveKeyIndex);
  }
  if (cardanoCollateralViaMarginPool()) {
    const deriveIdx = process.env.MIDNIGHT_DERIVE_KEY_INDEX?.trim();
    return deriveIdx ? { MIDNIGHT_DERIVE_KEY_INDEX: deriveIdx } : {};
  }
  if (parallelMidnightAssignEnabled()) {
    return midnightParallelEnvForDeriveIndex(nextMidnightWorkerDeriveIndex());
  }
  const deriveIdx = process.env.MIDNIGHT_DERIVE_KEY_INDEX?.trim();
  return deriveIdx ? { MIDNIGHT_DERIVE_KEY_INDEX: deriveIdx } : {};
}

/** One Charli3 pull tx + oracle snapshot for a batch of parallel Midnight pipelines (avoids N duplicate pulls). */
export async function fetchOracleAndSubmitCharli3Pull(pairId: string): Promise<{
  oracle: VerifiedIndexPrice;
  pullTxHash: string;
  pullExplorer: string;
}> {
  assertNetworks();
  if (cardanoBackend() !== "blockfrost") {
    throw new Error("fetchOracleAndSubmitCharli3Pull requires CARDANO_BACKEND=blockfrost.");
  }
  const oracle = await getVerifiedIndexPrice(pairId);
  const lucid = await createAppLucid();
  const pull = await submitCharli3OracleReferenceTx(pairId, { lucid });
  return {
    oracle,
    pullTxHash: pull.txHash,
    pullExplorer: pull.explorerUrl,
  };
}

function assertNetworks(): void {
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

/** `run-pipeline` logs `matching:sealMatchRecord: txId=… txHash=…` — this is the on-chain matching seal. */
function extractMatchingSealTxHash(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .find((l) => l.includes("matching:sealMatchRecord") && l.includes("txHash="));
  if (!line) return undefined;
  const m = line.match(/txHash=([^\s]+)/);
  return m?.[1];
}

/** When true, Midnight runs `run-pipeline` (charli3perp-matching + sealMatchRecord with real bid/ask witnesses). */
export function useMidnightMatchingContract(): boolean {
  return (process.env.MIDNIGHT_RUN_MODE ?? "full-pipeline").trim() === "full-pipeline";
}

/**
 * `run-pipeline` = one wallet, five contracts sequential (`run-pipeline-all.ts`).
 * `run-pipeline-split` = five HD wallets × five contracts; **parallel subprocesses by default** in the CLI (`MIDNIGHT_SPLIT_PARALLEL`).
 *
 * Default here: **split + parallel-friendly script** unless `PERPS_MIDNIGHT_PARALLEL_CONTRACTS=0` (then `run-pipeline`).
 * Override anytime with `PERPS_MIDNIGHT_PIPELINE_SCRIPT=run-pipeline|run-pipeline-split`.
 */
function fullPipelineNpmScript(): "run-pipeline" | "run-pipeline-split" {
  const explicit = process.env.PERPS_MIDNIGHT_PIPELINE_SCRIPT?.trim();
  if (explicit === "run-pipeline-split") return "run-pipeline-split";
  if (explicit === "run-pipeline") return "run-pipeline";
  if ((process.env.PERPS_MIDNIGHT_PARALLEL_CONTRACTS ?? "1").trim() === "0") {
    return "run-pipeline";
  }
  return "run-pipeline-split";
}

/** Wall-clock cap for `npm run run-pipeline*`. `0` = unlimited. Default 60m so a hung CLI does not block the API forever. */
function midnightCliMaxMs(): number {
  const raw = process.env.PERPS_MIDNIGHT_CLI_MAX_MS?.trim();
  if (raw === "0" || raw === "") return 0;
  if (raw) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 60 * 60 * 1000;
}

function runMidnightCliCapture(
  env: NodeJS.ProcessEnv,
  script: "run-all" | "run-pipeline" | "run-pipeline-split",
): Promise<{ stdout: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", script, "-w", "@charli3perp/cli"], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxMs = midnightCliMaxMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      fn();
    };

    if (maxMs > 0) {
      timer = setTimeout(() => {
        const msg = `[perps-api] Midnight ${script} exceeded PERPS_MIDNIGHT_CLI_MAX_MS=${maxMs} (wall clock). Sending SIGTERM to npm child; orphan run-pipeline-split-slot workers may remain — pkill -f run-pipeline-split-slot if needed.`;
        console.error(msg);
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        setTimeout(() => {
          try {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, 4000);
        finish(() =>
          reject(
            new Error(
              `Midnight ${script} timed out after ${maxMs}ms (PERPS_MIDNIGHT_CLI_MAX_MS). ` +
                `Often: stuck wallet sync (indexer), proof server overload, or very slow Preview. ` +
                `Try MIDNIGHT_WALLET_STATE_DISABLE=1, MIDNIGHT_SPLIT_PARALLEL=0, or raise the limit / 0=unlimited.`,
            ),
          ),
        );
      }, maxMs);
    }

    child.stdout?.on("data", (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr?.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("error", (e) => finish(() => reject(e)));
    child.on("close", (exitCode, signal) => {
      if (settled) return;
      finish(() =>
        resolve({
          stdout:
            stdout +
            (stderr ? "\n" + stderr : "") +
            (signal ? `\n[perps-api] npm child exited with signal ${signal}` : ""),
          exitCode,
        }),
      );
    });
  });
}

async function runMidnightWithRetries(
  env: NodeJS.ProcessEnv,
  npmScript: "run-all" | "run-pipeline" | "run-pipeline-split",
): Promise<{ stdout: string }> {
  const maxAttempts = Math.min(5, Math.max(1, Number.parseInt(process.env.C3PERP_MIDNIGHT_RETRIES || "3", 10)));
  let stdout = "";
  let exitCode: number | null = -1;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const r = await runMidnightCliCapture(env, npmScript);
    stdout = r.stdout;
    exitCode = r.exitCode;
    if (exitCode === 0) break;
    const tail = stdout.slice(-6000);
    console.warn(
      `[perps-api] Midnight ${npmScript} failed (exit ${exitCode}) attempt ${attempt}/${maxAttempts}. CLI output tail:\n${tail}`,
    );
    if (attempt < maxAttempts) {
      const delay = Math.min(30_000, 2000 * attempt ** 2);
      console.warn(`[perps-api] Retrying ${npmScript} in ${delay}ms…`);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  if (exitCode !== 0) {
    throw new Error(
      `Midnight ${npmScript} exited with code ${exitCode} after ${maxAttempts} attempt(s). Output (tail):\n${stdout.slice(-4000)}`,
    );
  }
  return { stdout };
}

function pipelineTimingEnabled(): boolean {
  return (process.env.PERPS_PIPELINE_TIMING ?? "").trim() === "1";
}

function logPipelinePhase(phase: string, startedAt: number): void {
  if (!pipelineTimingEnabled()) return;
  console.log(`[perps-pipeline-timing] ${phase}: ${Date.now() - startedAt}ms`);
}

/** Serialized for the browser to build Charli3 pull + settlement anchor after Midnight. */
export type CardanoSessionPayload = {
  pairId: string;
  orderCommitmentHex64: string;
  settlementId: string;
  midnightBindTxHash: string;
  oracle: {
    pairId: string;
    indexPrice: number;
    markPrice: number;
    timestampMs: number;
    priceRaw: string;
    outRef: { txHash: string; outputIndex: number };
    datumHash: string;
  };
  /** Lovelace paid to settlement anchor script (min-ADA). */
  anchorMinLovelace: string;
  /** Lovelace in pull tx output back to user wallet (reference pattern). */
  pullLovelaceToSelf: string;
  cardanoNetwork: string;
  /** Set when `MIDNIGHT_RUN_MODE=full-pipeline` — included in settlement anchor blob. */
  midnightMatchingSealTxHash?: string;
};

export type FullTradeResult = {
  oracle: VerifiedIndexPrice;
  l1AnchorHex: string;
  bid: OrderCommitmentInput;
  ask: OrderCommitmentInput;
  orderCommitmentHex: string;
  midnightBindTxHash: string;
  /** Midnight `charli3perp-matching` — `sealMatchRecord` tx (only when `MIDNIGHT_RUN_MODE=full-pipeline`). */
  midnightMatchingSealTxHash: string;
  pipelineStdout: string;
  charli3PullTxHash: string;
  charli3PullExplorer: string;
  settlementAnchorTxHash: string;
  settlementAnchorExplorer: string;
  /** Present when `CARDANO_COLLATERAL_VIA_MARGIN_POOL=1`: deposit + merge txs before Midnight. */
  marginPool?: LockCollateralForTradeResult;
  /** When true, client must sign pull + anchor; `charli3Pull*` / `settlementAnchor*` are empty until `POST /api/trade/user-l1-complete`. */
  userPaysCardano?: boolean;
  cardanoSession?: CardanoSessionPayload;
};

export async function runFullPipelineTrade(
  bid: OrderCommitmentInput,
  ask: OrderCommitmentInput,
  opts: {
    bip39Mnemonic?: string;
    userPaysCardano?: boolean;
    /** Batch sweep: same oracle + one shared Charli3 pull for all parallel Midnight workers (must pass both). */
    sharedOracle?: VerifiedIndexPrice;
    sharedCharli3PullTxHash?: string;
    /** HD-derived worker index for isolated Midnight state (parallel sweep / CLI pattern). */
    midnightDeriveKeyIndex?: number;
    /** When set, explorer index is updated incrementally as each tx lands (hashes appear before full pipeline returns). */
    tradeIndexId?: string;
  } = {},
): Promise<FullTradeResult> {
  assertNetworks();

  const pipelineT0 = Date.now();

  const mnemonic = opts.bip39Mnemonic?.trim() || process.env.BIP39_MNEMONIC?.trim();
  if (!mnemonic) {
    throw new Error("Set BIP39_MNEMONIC in .env or pass bip39Mnemonic for Midnight.");
  }

  const userPaysCardano = Boolean(opts.userPaysCardano);
  if (userPaysCardano && cardanoCollateralViaMarginPool()) {
    throw new Error(
      "User-paid Cardano L1 is incompatible with CARDANO_COLLATERAL_VIA_MARGIN_POOL (margin pool txs are server-signed). Disable one of them.",
    );
  }

  const hasSharedPull = Boolean(opts.sharedCharli3PullTxHash?.trim());
  const hasSharedOracle = opts.sharedOracle !== undefined;
  if (hasSharedPull !== hasSharedOracle) {
    throw new Error("sharedOracle and sharedCharli3PullTxHash must both be set for batch parallel pipelines.");
  }
  if (hasSharedPull && userPaysCardano) {
    throw new Error("Shared Charli3 pull batch mode is incompatible with user-paid Cardano L1.");
  }
  if (opts.midnightDeriveKeyIndex !== undefined && cardanoCollateralViaMarginPool()) {
    throw new Error(
      "midnightDeriveKeyIndex (parallel Midnight) is incompatible with CARDANO_COLLATERAL_VIA_MARGIN_POOL; run sweep sequentially or disable margin pool.",
    );
  }
  if (hasSharedPull && cardanoCollateralViaMarginPool()) {
    throw new Error("Shared Charli3 pull batch mode is incompatible with CARDANO_COLLATERAL_VIA_MARGIN_POOL.");
  }

  const orderCommitmentForCardano = orderCommitmentHex(bid);
  const orderHex = orderCommitmentForCardano.replace(/^0x/i, "").toLowerCase();
  if (orderHex.length !== 64) {
    throw new Error("Invalid bid order commitment for anchor.");
  }

  let marginPool: LockCollateralForTradeResult | undefined;
  if (cardanoCollateralViaMarginPool()) {
    if (cardanoBackend() !== "blockfrost") {
      throw new Error("CARDANO_COLLATERAL_VIA_MARGIN_POOL requires CARDANO_BACKEND=blockfrost.");
    }
    const hex64 = orderCommitmentForCardano.replace(/^0x/i, "").toLowerCase();
    if (hex64.length !== 64) {
      throw new Error("Invalid bid order commitment for margin pool lock.");
    }
    const lovelace = marginPoolCollateralLovelace();
    if (lovelace <= 0n) {
      throw new Error("MARGIN_POOL_COLLATERAL_LOVELACE must be positive when CARDANO_COLLATERAL_VIA_MARGIN_POOL=1.");
    }
    marginPool = await lockCollateralForTrade({
      lovelace,
      orderCommitmentHex64: hex64,
      marketId: bid.pairId ?? PAIR,
    });
    logPipelinePhase("margin_pool_lock", pipelineT0);
  }

  const v = opts.sharedOracle ?? (await getVerifiedIndexPrice(PAIR));
  logPipelinePhase("oracle_fetch", pipelineT0);
  const l1 = l1AnchorHexFromOracle(v);

  const mode = (process.env.MIDNIGHT_RUN_MODE ?? "full-pipeline").trim();
  const useFullPipeline = mode === "full-pipeline";

  const witnessEnv = useFullPipeline
    ? buildPipelineWitnessEnv({ bid, ask, oracle: v })
    : ({} as Record<string, string>);

  const npmScript = useFullPipeline ? fullPipelineNpmScript() : "run-all";

  let midnightWorker = resolveMidnightWorkerEnv({
    midnightDeriveKeyIndex: opts.midnightDeriveKeyIndex,
  });
  /** Split pipeline uses five wallets `deriveKeysAt(base…base+4)` in parallel — not round-robin single index. */
  if (npmScript === "run-pipeline-split") {
    const splitBaseRaw = process.env.PERPS_MIDNIGHT_SPLIT_BASE?.trim();
    const splitBase = Math.max(
      0,
      splitBaseRaw
        ? Number.parseInt(splitBaseRaw, 10) || midnightWorkerOffsetFromEnv()
        : midnightWorkerOffsetFromEnv(),
    );
    midnightWorker = midnightParallelEnvForDeriveIndex(splitBase);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BIP39_MNEMONIC: mnemonic,
    MIDNIGHT_DEPLOY_NETWORK: "preview",
    C3PERP_L1_ANCHOR_HEX: l1,
    C3PERP_ORDER_COMMITMENT_HEX: orderCommitmentForCardano,
    ...midnightWorker,
    // CLI `waitForWalletSyncedWithHeartbeat` can hang forever if unset — trade stays "pending" in UI with no error.
    ...(process.env.MIDNIGHT_SYNC_TIMEOUT_MS?.trim()
      ? {}
      : { MIDNIGHT_SYNC_TIMEOUT_MS: "1200000" }),
    // Split pipeline: five tsx workers in parallel unless MIDNIGHT_SPLIT_PARALLEL is set explicitly (e.g. `0` to debug).
    ...(npmScript === "run-pipeline-split" && !process.env.MIDNIGHT_SPLIT_PARALLEL?.trim()
      ? { MIDNIGHT_SPLIT_PARALLEL: "1" }
      : {}),
    // Pin on-disk sync cache to repo `.midnight-wallet-state/` (per derive index) so restarts resync faster.
    ...(process.env.MIDNIGHT_WALLET_STATE_DISABLE?.trim() !== "1" &&
    !process.env.MIDNIGHT_WALLET_STATE_DIR?.trim()
      ? { MIDNIGHT_WALLET_STATE_DIR: join(ROOT, ".midnight-wallet-state") }
      : {}),
    ...(useFullPipeline
      ? {
          MIDNIGHT_RUN_MODE: "full-pipeline",
          C3PERP_BID_ORDER_JSON: JSON.stringify(bid),
          C3PERP_ASK_ORDER_JSON: JSON.stringify(ask),
          ...witnessEnv,
        }
      : {}),
  };

  const net = (process.env.CARDANO_NETWORK || "Preprod").trim();
  const anchorMinLovelace = String(process.env.ANCHOR_MIN_LOVELACE || "2000000");

  await patchTradeIndex(opts.tradeIndexId, {
    pipelineLogTail: `[perps-api] ${new Date().toISOString()} Starting Midnight: npm run ${npmScript} (mode=${mode}). Tx hashes appear after this step completes; Cardano runs next unless user-paid L1.\n`,
  });

  if (userPaysCardano) {
    const { stdout } = await runMidnightWithRetries(env, npmScript);
    logPipelinePhase("midnight_cli_user_pays_cardano", pipelineT0);
    const midnightBindTxHash = extractBindTxHash(stdout) ?? "";
    const midnightMatchingSealTxHash = useFullPipeline
      ? (extractMatchingSealTxHash(stdout) ?? "")
      : "";
    await patchTradeIndex(opts.tradeIndexId, {
      midnightBindTxHash,
      midnightMatchingSealTxHash,
    });
    const settlementId = `ada-usd-${new Date().toISOString().replace(/[:.]/g, "-")}`;
    const cardanoSession: CardanoSessionPayload = {
      pairId: PAIR,
      orderCommitmentHex64: orderHex,
      settlementId,
      midnightBindTxHash,
      ...(midnightMatchingSealTxHash
        ? { midnightMatchingSealTxHash: midnightMatchingSealTxHash }
        : {}),
      oracle: {
        pairId: v.pairId,
        indexPrice: v.indexPrice,
        markPrice: v.markPrice,
        timestampMs: v.timestampMs,
        priceRaw: v.priceRaw.toString(),
        outRef: v.outRef,
        datumHash: v.datumHash,
      },
      anchorMinLovelace,
      pullLovelaceToSelf: "1000000",
      cardanoNetwork: net,
    };
    return {
      oracle: v,
      l1AnchorHex: l1,
      bid,
      ask,
      orderCommitmentHex: orderHex,
      midnightBindTxHash,
      midnightMatchingSealTxHash,
      pipelineStdout: stdout,
      charli3PullTxHash: "",
      charli3PullExplorer: "",
      settlementAnchorTxHash: "",
      settlementAnchorExplorer: "",
      ...(marginPool ? { marginPool } : {}),
      userPaysCardano: true,
      cardanoSession,
    };
  }

  const reusePull =
    (opts.sharedCharli3PullTxHash ?? process.env.C3PERP_CHARLI3_PULL_TX_HASH)?.replace(/^0x/i, "").trim() ?? "";
  const reusePullOk = reusePull.length === 64 && /^[0-9a-f]+$/i.test(reusePull);
  /**
   * Default **sequential**: finish Midnight CLI (deploy + ZK + matching when applicable), then Cardano Charli3 pull,
   * then settlement anchor. Set `C3PERP_PARALLEL_MIDNIGHT_CHARLI3_PULL=1` to run Midnight CLI and Charli3 pull
   * concurrently (shorter wall time when both stacks are healthy; more load on proof server + wallet).
   */
  const parallelMidnightAndPull =
    (process.env.C3PERP_PARALLEL_MIDNIGHT_CHARLI3_PULL ?? "0").trim() === "1" && !reusePullOk;

  let stdout: string;
  let pullTxHash: string;
  let pullExplorer: string;
  let lucidForAnchor: Awaited<ReturnType<typeof createAppLucid>> | undefined;

  if (reusePullOk) {
    const mid = await runMidnightWithRetries(env, npmScript);
    logPipelinePhase("midnight_cli_reuse_pull", pipelineT0);
    stdout = mid.stdout;
    pullTxHash = reusePull.toLowerCase();
    pullExplorer = cardanoTxExplorerUrl(pullTxHash);
    await patchTradeIndex(opts.tradeIndexId, {
      midnightBindTxHash: extractBindTxHash(stdout) ?? "",
      midnightMatchingSealTxHash: useFullPipeline
        ? (extractMatchingSealTxHash(stdout) ?? "")
        : "",
      charli3PullTxHash: pullTxHash,
    });
    lucidForAnchor = await createAppLucid();
    logPipelinePhase("createAppLucid_after_reuse_pull", pipelineT0);
  } else if (parallelMidnightAndPull) {
    const lucid = await createAppLucid();
    logPipelinePhase("createAppLucid_before_parallel_midnight_pull", pipelineT0);
    const tParallel = Date.now();
    const midnightP = runMidnightWithRetries(env, npmScript).then((r) => {
      logPipelinePhase("midnight_cli_wall", tParallel);
      return r;
    });
    const pullP = submitCharli3OracleReferenceTx(PAIR, { lucid }).then((r) => {
      logPipelinePhase("charli3_pull_tx_wall", tParallel);
      return r;
    });
    const [mid, pull] = await Promise.all([midnightP, pullP]);
    logPipelinePhase("parallel_midnight_plus_charli3_total_wall", tParallel);
    stdout = mid.stdout;
    pullTxHash = pull.txHash;
    pullExplorer = pull.explorerUrl;
    lucidForAnchor = lucid;
  } else {
    const tSeq = Date.now();
    const mid = await runMidnightWithRetries(env, npmScript);
    logPipelinePhase("midnight_cli_sequential_first", tSeq);
    stdout = mid.stdout;
    const midnightBindEarly = extractBindTxHash(stdout) ?? "";
    const midnightMatchEarly = useFullPipeline
      ? (extractMatchingSealTxHash(stdout) ?? "")
      : "";
    await patchTradeIndex(opts.tradeIndexId, {
      midnightBindTxHash: midnightBindEarly,
      midnightMatchingSealTxHash: midnightMatchEarly,
    });
    const lucid = await createAppLucid();
    const pull = await submitCharli3OracleReferenceTx(PAIR, { lucid });
    logPipelinePhase("charli3_pull_tx_sequential_after_midnight", tSeq);
    pullTxHash = pull.txHash;
    pullExplorer = pull.explorerUrl;
    lucidForAnchor = lucid;
    await patchTradeIndex(opts.tradeIndexId, { charli3PullTxHash: pullTxHash });
  }

  const midnightBindTxHash = extractBindTxHash(stdout) ?? "";
  const midnightMatchingSealTxHash = useFullPipeline
    ? (extractMatchingSealTxHash(stdout) ?? "")
    : "";

  if (parallelMidnightAndPull) {
    await patchTradeIndex(opts.tradeIndexId, {
      midnightBindTxHash,
      midnightMatchingSealTxHash,
      charli3PullTxHash: pullTxHash,
    });
  }

  const settlementId = `ada-usd-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const midnightBlob = JSON.stringify({
    pair: PAIR,
    charli3: {
      indexPrice: v.indexPrice,
      priceRaw: v.priceRaw.toString(),
      datumHash: v.datumHash,
      outRef: v.outRef,
      pullTxHash,
    },
    midnightPreview: {
      bindCardanoAnchorTxHash: midnightBindTxHash || null,
      matchingSealTxHash: midnightMatchingSealTxHash || null,
    },
    network: { cardano: "preprod", midnight: "preview" },
  });

  const tAnchor = Date.now();
  const anchor = await runExclusiveSettlementAnchor(() =>
    submitSettlementAnchorTx({
      settlementId,
      orderCommitmentHex64: orderHex,
      midnightTxUtf8: midnightBlob,
      lucid: lucidForAnchor,
    }),
  );
  logPipelinePhase("settlement_anchor_submit", tAnchor);
  logPipelinePhase("runFullPipelineTrade_total", pipelineT0);

  await patchTradeIndex(opts.tradeIndexId, {
    settlementAnchorTxHash: anchor.txHash,
  });

  return {
    oracle: v,
    l1AnchorHex: l1,
    bid,
    ask,
    orderCommitmentHex: orderHex,
    midnightBindTxHash,
    midnightMatchingSealTxHash,
    pipelineStdout: stdout,
    charli3PullTxHash: pullTxHash,
    charli3PullExplorer: pullExplorer,
    settlementAnchorTxHash: anchor.txHash,
    settlementAnchorExplorer: anchor.explorerUrl,
    ...(marginPool ? { marginPool } : {}),
  };
}
