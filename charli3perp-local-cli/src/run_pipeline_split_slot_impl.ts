/**
 * One segment of the split pipeline: one contract + one HD wallet (`deriveKeysAt(baseIndex + slot)`).
 */
import { Buffer } from "buffer";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import {
  charli3perpOrderPrivateStateId,
  charli3perpMatchingPrivateStateId,
  charli3perpSettlementPrivateStateId,
  charli3perpLiquidationPrivateStateId,
  charli3perpAggregatePrivateStateId,
} from "@charli3perp/midnight-contract";
import {
  charli3perpOrderCompiledContractLocal,
  charli3perpMatchingCompiledContractLocal,
  charli3perpSettlementCompiledContractLocal,
  charli3perpLiquidationCompiledContractLocal,
  charli3perpAggregateCompiledContractLocal,
} from "./charli3perp-compiled-contract.js";
import { Charli3perpMidnightConfig } from "./config.js";
import {
  configureCharli3perpOrderProviders,
  configureCharli3perpMatchingProviders,
  configureCharli3perpSettlementProviders,
  configureCharli3perpLiquidationProviders,
  configureCharli3perpAggregateProviders,
} from "./providers.js";
import { initWalletWithSeed, persistMidnightWalletState, type WalletContext } from "./wallet.js";
import { midnightParallelEnvForDeriveIndex } from "./midnight_parallel_env.js";
import { traderLedgerPublicKey } from "./trader-key.js";
import { ensureDustReady } from "./dust.js";
import { waitForWalletSyncedWithHeartbeat } from "./wait_wallet_sync.js";
import { hashSingle32, hashPair32 } from "./midnight-hash.js";

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, "");
  if (h.length !== 64) throw new Error("expected 32-byte hex string");
  return Uint8Array.from(Buffer.from(h, "hex"));
}

function defaultHex(label: string, fallback: string): string {
  const v = process.env[label]?.trim();
  if (v && v.replace(/^0x/, "").length === 64) return v.replace(/^0x/, "");
  return fallback;
}

function logTx(label: string, pub: { txId: unknown; txHash: unknown; blockHeight?: unknown }) {
  const bh = pub.blockHeight !== undefined ? ` blockHeight=${pub.blockHeight}` : "";
  console.log(`${label}: txId=${String(pub.txId)} txHash=${String(pub.txHash)}${bh}`);
}

export type SplitWitnessInputs = {
  traderSk: Uint8Array;
  traderPk: Uint8Array;
  commitment: Uint8Array;
  l1Anchor: Uint8Array;
  bidPre: Uint8Array;
  askPre: Uint8Array;
  bidCommit: Uint8Array;
  askCommit: Uint8Array;
  matchDigest: Uint8Array;
  settlementInitial: Uint8Array;
  settlementPayload: Uint8Array;
  settlementNext: Uint8Array;
  marginWitness: Uint8Array;
  marginCommit: Uint8Array;
  liqThreshold: Uint8Array;
  aggLeft: Uint8Array;
  aggRight: Uint8Array;
  aggInitial: Uint8Array;
};

export function loadSplitWitnessInputsFromEnv(): SplitWitnessInputs {
  const traderSk = hexToBytes32(process.env.C3PERP_TRADER_SK_HEX ?? "03".repeat(32));
  const traderPk = traderLedgerPublicKey(traderSk);
  const commitment = hexToBytes32(process.env.C3PERP_ORDER_COMMITMENT_HEX ?? "00".repeat(32));
  const l1Anchor = hexToBytes32(process.env.C3PERP_L1_ANCHOR_HEX ?? "aa".repeat(32));
  const bidPre = hexToBytes32(defaultHex("C3PERP_BID_PREIMAGE_HEX", "c0".repeat(32)));
  const askPre = hexToBytes32(defaultHex("C3PERP_ASK_PREIMAGE_HEX", "d0".repeat(32)));
  const bidCommit = hashSingle32(bidPre);
  const askCommit = hashSingle32(askPre);
  const matchDigest = hexToBytes32(defaultHex("C3PERP_MATCH_DIGEST_HEX", "e0".repeat(32)));
  const settlementInitial = hexToBytes32(defaultHex("C3PERP_SETTLEMENT_INITIAL_HEX", "11".repeat(32)));
  const settlementPayload = hexToBytes32(defaultHex("C3PERP_SETTLEMENT_PAYLOAD_HEX", "22".repeat(32)));
  const settlementNext = hashPair32(settlementInitial, settlementPayload);
  const marginWitness = hexToBytes32(defaultHex("C3PERP_MARGIN_WITNESS_HEX", "33".repeat(32)));
  const marginCommit = hashSingle32(marginWitness);
  const liqThreshold = hexToBytes32(defaultHex("C3PERP_LIQUIDATION_THRESHOLD_HEX", "44".repeat(32)));
  const aggLeft = hexToBytes32(defaultHex("C3PERP_AGGREGATE_LEFT_HEX", "55".repeat(32)));
  const aggRight = hexToBytes32(defaultHex("C3PERP_AGGREGATE_RIGHT_HEX", "66".repeat(32)));
  const aggInitial = hexToBytes32(defaultHex("C3PERP_AGGREGATE_INITIAL_HEX", "00".repeat(32)));
  return {
    traderSk,
    traderPk,
    commitment,
    l1Anchor,
    bidPre,
    askPre,
    bidCommit,
    askCommit,
    matchDigest,
    settlementInitial,
    settlementPayload,
    settlementNext,
    marginWitness,
    marginCommit,
    liqThreshold,
    aggLeft,
    aggRight,
    aggInitial,
  };
}

const labels = ["order", "matching", "settlement", "liquidation", "aggregate"] as const;

export async function runSplitPipelineSlot(
  seed: Buffer,
  baseIndex: number,
  slot: number,
  w: SplitWitnessInputs,
): Promise<void> {
  if (slot < 0 || slot > 4 || !Number.isInteger(slot)) {
    throw new Error(`slot must be 0..4, got ${slot}`);
  }
  const idx = baseIndex + slot;
  Object.assign(process.env, midnightParallelEnvForDeriveIndex(idx));
  const config = new Charli3perpMidnightConfig();

  console.log(
    `\n[run-pipeline-split] === slot ${slot} (${labels[slot]}) deriveKeysAt(${idx}) private DB suffix ${idx} ===\n`,
  );

  const walletCtx: WalletContext = await initWalletWithSeed(seed, config, { deriveKeyIndex: idx });
  await waitForWalletSyncedWithHeartbeat(walletCtx.wallet);

  console.log("Ensuring DUST is ready…");
  await ensureDustReady(walletCtx, { timeoutMs: 240_000 });
  console.log("DUST ready.");
  await persistMidnightWalletState(walletCtx);

  if (slot === 0) {
    const orderProviders = await configureCharli3perpOrderProviders(walletCtx, config);
    console.log("Deploying charli3perp-order…");
    const orderDeployed = await deployContract(orderProviders, {
      compiledContract: charli3perpOrderCompiledContractLocal,
      privateStateId: charli3perpOrderPrivateStateId,
      initialPrivateState: { traderSecretKey: new Uint8Array(w.traderSk) },
      args: [new Uint8Array(w.commitment), new Uint8Array(w.traderPk)],
    });
    logTx("order:deploy", orderDeployed.deployTxData.public);
    const orderCall = orderDeployed.callTx;
    logTx("order:proveIntentAuthority", (await orderCall.proveIntentAuthority()).public);
    logTx("order:bindCardanoAnchor", (await orderCall.bindCardanoAnchor(new Uint8Array(w.l1Anchor))).public);
  } else if (slot === 1) {
    const matchProviders = await configureCharli3perpMatchingProviders(walletCtx, config);
    console.log("Deploying charli3perp-matching…");
    const matchDeployed = await deployContract(matchProviders, {
      compiledContract: charli3perpMatchingCompiledContractLocal,
      privateStateId: charli3perpMatchingPrivateStateId,
      initialPrivateState: {
        bidPreimage: new Uint8Array(w.bidPre),
        askPreimage: new Uint8Array(w.askPre),
      },
      args: [new Uint8Array(w.bidCommit), new Uint8Array(w.askCommit)],
    });
    logTx("matching:deploy", matchDeployed.deployTxData.public);
    logTx(
      "matching:sealMatchRecord",
      (await matchDeployed.callTx.sealMatchRecord(new Uint8Array(w.matchDigest))).public,
    );
  } else if (slot === 2) {
    const settleProviders = await configureCharli3perpSettlementProviders(walletCtx, config);
    console.log("Deploying charli3perp-settlement…");
    const settleDeployed = await deployContract(settleProviders, {
      compiledContract: charli3perpSettlementCompiledContractLocal,
      privateStateId: charli3perpSettlementPrivateStateId,
      initialPrivateState: { transitionPayload: new Uint8Array(w.settlementPayload) },
      args: [new Uint8Array(w.settlementInitial)],
    });
    logTx("settlement:deploy", settleDeployed.deployTxData.public);
    logTx(
      "settlement:stepSettlementDigest",
      (await settleDeployed.callTx.stepSettlementDigest(new Uint8Array(w.settlementNext))).public,
    );
  } else if (slot === 3) {
    const liqProviders = await configureCharli3perpLiquidationProviders(walletCtx, config);
    console.log("Deploying charli3perp-liquidation…");
    const liqDeployed = await deployContract(liqProviders, {
      compiledContract: charli3perpLiquidationCompiledContractLocal,
      privateStateId: charli3perpLiquidationPrivateStateId,
      initialPrivateState: { marginWitness: new Uint8Array(w.marginWitness) },
      args: [new Uint8Array(w.marginCommit)],
    });
    logTx("liquidation:deploy", liqDeployed.deployTxData.public);
    logTx(
      "liquidation:attestLiquidation",
      (await liqDeployed.callTx.attestLiquidation(new Uint8Array(w.liqThreshold))).public,
    );
  } else {
    const aggProviders = await configureCharli3perpAggregateProviders(walletCtx, config);
    console.log("Deploying charli3perp-aggregate…");
    const aggDeployed = await deployContract(aggProviders, {
      compiledContract: charli3perpAggregateCompiledContractLocal,
      privateStateId: charli3perpAggregatePrivateStateId,
      initialPrivateState: {
        leftProofDigest: new Uint8Array(w.aggLeft),
        rightProofDigest: new Uint8Array(w.aggRight),
      },
      args: [new Uint8Array(w.aggInitial)],
    });
    logTx("aggregate:deploy", aggDeployed.deployTxData.public);
    logTx("aggregate:mergeProofBatch", (await aggDeployed.callTx.mergeProofBatch()).public);
  }

  console.log("[midnight wallet] Saving sync state after segment…");
  await persistMidnightWalletState(walletCtx);
  await walletCtx.wallet.stop();
}
