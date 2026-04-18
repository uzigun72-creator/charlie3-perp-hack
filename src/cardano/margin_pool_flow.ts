/**
 * Server-side margin pool (Aiken) flows using `WALLET_MNEMONIC` via Lucid.
 */
import { randomBytes } from "node:crypto";
import { getAddressDetails } from "@lucid-evolution/utils";
import { Constr, Data } from "@lucid-evolution/lucid";
import type { UTxO } from "@lucid-evolution/core-types";
import { cardanoBackend } from "../config/cardano_env.js";
import { createAppLucid } from "./lucid_wallet.js";
import {
  loadMarginPoolBlueprint,
  marginDatumCbor,
  marginForwardToPoolRedeemerCbor,
  marginPoolScriptAddress,
  marginVaultScriptAddress,
  marginVaultSpendingScript,
  poolDatumCbor,
  poolMergeDepositRedeemerCbor,
  marginPoolSpendingScript,
  type MarginPoolBlueprintJson,
} from "./margin_pool_scripts.js";

export function marginPoolTxExplorerUrl(network: string, txHash: string): string {
  const n = network.toLowerCase();
  if (n === "preview") return `https://preview.cardanoscan.io/transaction/${txHash}`;
  return `https://preprod.cardanoscan.io/transaction/${txHash}`;
}

export type MarginPoolAddresses = {
  network: string;
  poolAddress: string;
  marginAddress: string;
  poolScriptHashHex: string;
  marginScriptHashHex: string;
  adminKeyHashHex: string;
};

async function loadContext(): Promise<{
  lucid: Awaited<ReturnType<typeof createAppLucid>>;
  network: string;
  blueprint: MarginPoolBlueprintJson;
  addresses: MarginPoolAddresses;
  marginScript: ReturnType<typeof marginVaultSpendingScript>;
  poolScript: ReturnType<typeof marginPoolSpendingScript>;
}> {
  if (cardanoBackend() !== "blockfrost") {
    throw new Error("Margin pool UI requires CARDANO_BACKEND=blockfrost");
  }
  const lucid = await createAppLucid();
  const network = lucid.config().network;
  if (!network) throw new Error("Lucid network not configured");

  const blueprint = loadMarginPoolBlueprint();
  const marginScript = marginVaultSpendingScript(blueprint);
  const poolScript = marginPoolSpendingScript(blueprint);
  const poolAddr = marginPoolScriptAddress(network, poolScript);
  const marginAddr = marginVaultScriptAddress(network, marginScript);

  const poolHash = blueprint.validators.find(
    (v) => v.title.includes("margin_pool") && v.title.endsWith(".spend"),
  )?.hash;
  const marginHash = blueprint.validators.find(
    (v) => v.title.includes("margin_vault") && v.title.endsWith(".spend"),
  )?.hash;
  if (!poolHash || !marginHash) {
    throw new Error("margin-pool blueprint missing validator hashes — run `npm run build:margin-pool`");
  }

  const addr = await lucid.wallet().address();
  const details = getAddressDetails(addr);
  if (details.paymentCredential?.type !== "Key") {
    throw new Error("Wallet payment credential must be a key hash");
  }
  const adminKeyHashHex = String(details.paymentCredential.hash);

  return {
    lucid,
    network,
    blueprint,
    marginScript,
    poolScript,
    addresses: {
      network,
      poolAddress: poolAddr,
      marginAddress: marginAddr,
      poolScriptHashHex: poolHash.toLowerCase(),
      marginScriptHashHex: marginHash.toLowerCase(),
      adminKeyHashHex,
    },
  };
}

export type MarginPoolUtxoSummary = {
  txHash: string;
  outputIndex: number;
  lovelace: string;
};

export type MarginPoolStatus = {
  ok: true;
  addresses: MarginPoolAddresses;
  actionsEnabled: boolean;
  poolUtxos: MarginPoolUtxoSummary[];
  marginUtxos: MarginPoolUtxoSummary[];
  poolLovelaceTotal: string;
  marginLovelaceTotal: string;
  /** Best-effort decode of the first pool UTxO inline datum. */
  poolDatumPreview: {
    totalMarginLovelace: string;
    mergeCount: string;
  } | null;
};

function utxoSummary(u: UTxO): MarginPoolUtxoSummary {
  return {
    txHash: u.txHash,
    outputIndex: u.outputIndex,
    lovelace: String(u.assets.lovelace ?? 0n),
  };
}

function parsePoolDatumPreview(d: Data): { totalMarginLovelace: string; mergeCount: string } | null {
  try {
    if (!(d instanceof Constr) || d.index !== 0 || d.fields.length < 6) return null;
    const total = d.fields[3];
    const merges = d.fields[4];
    return {
      totalMarginLovelace: typeof total === "bigint" ? total.toString() : String(total),
      mergeCount: typeof merges === "bigint" ? merges.toString() : String(merges),
    };
  } catch {
    return null;
  }
}

export async function getMarginPoolStatus(actionsEnabled: boolean): Promise<MarginPoolStatus> {
  const { lucid, addresses } = await loadContext();
  const poolUtxos = (await lucid.utxosAt(addresses.poolAddress)).map(utxoSummary);
  const marginUtxos = (await lucid.utxosAt(addresses.marginAddress)).map(utxoSummary);
  let poolLovelaceTotal = 0n;
  for (const u of await lucid.utxosAt(addresses.poolAddress)) {
    poolLovelaceTotal += u.assets.lovelace ?? 0n;
  }
  let marginLovelaceTotal = 0n;
  for (const u of await lucid.utxosAt(addresses.marginAddress)) {
    marginLovelaceTotal += u.assets.lovelace ?? 0n;
  }

  let poolDatumPreview: MarginPoolStatus["poolDatumPreview"] = null;
  const rawPool = await lucid.utxosAt(addresses.poolAddress);
  if (rawPool.length > 0) {
    try {
      const datum = await lucid.datumOf(rawPool[0]!);
      poolDatumPreview = parsePoolDatumPreview(datum);
    } catch {
      poolDatumPreview = null;
    }
  }

  return {
    ok: true,
    addresses,
    actionsEnabled,
    poolUtxos,
    marginUtxos,
    poolLovelaceTotal: poolLovelaceTotal.toString(),
    marginLovelaceTotal: marginLovelaceTotal.toString(),
    poolDatumPreview,
  };
}

export async function bootstrapMarginPool(lovelace: bigint): Promise<{ txHash: string; explorerUrl: string }> {
  const { lucid, network, addresses, poolScript } = await loadContext();
  const poolUtxos = await lucid.utxosAt(addresses.poolAddress);
  if (poolUtxos.length > 0) {
    throw new Error("Pool script already has UTxOs — bootstrap skipped (use merge / new wallet / burn off-chain)");
  }
  const poolDatum0 = poolDatumCbor({
    poolScriptHashHex: addresses.poolScriptHashHex,
    marginScriptHashHex: addresses.marginScriptHashHex,
    adminKeyHashHex: addresses.adminKeyHashHex,
    totalMarginLovelace: 0n,
    mergeCount: 0n,
    positionsRootHex: "",
  });
  const tx = await lucid
    .newTx()
    .pay.ToContract(addresses.poolAddress, { kind: "inline", value: poolDatum0 }, { lovelace })
    .complete()
    .then((t) => t.sign.withWallet().complete());
  const txHash = await tx.submit();
  return { txHash, explorerUrl: marginPoolTxExplorerUrl(network, txHash) };
}

export async function depositMargin(lovelace: bigint): Promise<{ txHash: string; explorerUrl: string }> {
  if (lovelace <= 0n) throw new Error("lovelace must be positive");
  const { lucid, network, addresses } = await loadContext();
  const nonceHex = Buffer.from(`ui-${Date.now()}-${Math.random().toString(36).slice(2)}`, "utf8").toString("hex");
  const marginDatum = marginDatumCbor({
    ownerKeyHashHex: addresses.adminKeyHashHex,
    marketIdUtf8: "ADA-USD",
    positionNonceHex: nonceHex,
    orderCommitmentHex: "",
  });
  const tx = await lucid
    .newTx()
    .pay.ToContract(addresses.marginAddress, { kind: "inline", value: marginDatum }, { lovelace })
    .complete()
    .then((t) => t.sign.withWallet().complete());
  const txHash = await tx.submit();
  return { txHash, explorerUrl: marginPoolTxExplorerUrl(network, txHash) };
}

function normalizeOrderCommitmentHex64(hex: string): string {
  const h = hex.replace(/^0x/i, "").toLowerCase();
  if (h.length !== 64 || !/^[0-9a-f]+$/.test(h)) {
    throw new Error("orderCommitmentHex64 must be 64 hex characters (32 bytes)");
  }
  return h;
}

/** Deposit tADA to `margin_vault` with `order_commitment` set (ties custody to the bid used for the anchor). */
export async function depositMarginForOrder(opts: {
  lovelace: bigint;
  orderCommitmentHex64: string;
  marketId: string;
}): Promise<{ txHash: string; explorerUrl: string }> {
  if (opts.lovelace <= 0n) throw new Error("lovelace must be positive");
  const oc = normalizeOrderCommitmentHex64(opts.orderCommitmentHex64);
  const { lucid, network, addresses } = await loadContext();
  const nonceHex = randomBytes(32).toString("hex");
  const marginDatum = marginDatumCbor({
    ownerKeyHashHex: addresses.adminKeyHashHex,
    marketIdUtf8: opts.marketId,
    positionNonceHex: nonceHex,
    orderCommitmentHex: oc,
  });
  const tx = await lucid
    .newTx()
    .pay.ToContract(addresses.marginAddress, { kind: "inline", value: marginDatum }, { lovelace: opts.lovelace })
    .complete()
    .then((t) => t.sign.withWallet().complete());
  const txHash = await tx.submit();
  return { txHash, explorerUrl: marginPoolTxExplorerUrl(network, txHash) };
}

async function findMarginUtxoFromDepositTx(
  lucid: Awaited<ReturnType<typeof createAppLucid>>,
  marginAddress: string,
  depositTxHash: string,
): Promise<UTxO> {
  const utxos = await lucid.utxosAt(marginAddress);
  const matches = utxos.filter((u) => u.txHash === depositTxHash);
  if (matches.length === 0) {
    throw new Error(
      `No margin UTxO at margin script for deposit tx ${depositTxHash}. Confirm the deposit confirmed on-chain.`,
    );
  }
  matches.sort((a, b) => a.outputIndex - b.outputIndex);
  return matches[0]!;
}

function sortOutRef(a: UTxO, b: UTxO): number {
  const c = a.txHash.localeCompare(b.txHash);
  return c !== 0 ? c : a.outputIndex - b.outputIndex;
}

/** Merge a specific margin UTxO (e.g. the output of `depositMarginForOrder`) into the pool. */
export async function mergeMarginUtxoIntoPool(marginUtxo: UTxO): Promise<{ txHash: string; explorerUrl: string }> {
  const { lucid, network, addresses, marginScript, poolScript } = await loadContext();
  const poolList = await lucid.utxosAt(addresses.poolAddress);
  if (poolList.length !== 1) {
    throw new Error(
      `Merge expects exactly one pool UTxO, found ${poolList.length}. Bootstrap the pool first (one UTxO only).`,
    );
  }
  const poolUtxo = poolList[0]!;

  const poolDatumData = await lucid.datumOf(poolUtxo);
  if (!(poolDatumData instanceof Constr) || poolDatumData.index !== 0 || poolDatumData.fields.length < 6) {
    throw new Error("Could not read pool inline datum");
  }
  const prevTotal = poolDatumData.fields[3];
  const prevMerges = poolDatumData.fields[4];
  const prevTotalBi = typeof prevTotal === "bigint" ? prevTotal : BigInt(String(prevTotal));
  const prevMergesBi = typeof prevMerges === "bigint" ? prevMerges : BigInt(String(prevMerges));

  const marginL = marginUtxo.assets.lovelace ?? 0n;
  const poolInL = poolUtxo.assets.lovelace ?? 0n;
  const newTotal = prevTotalBi + marginL;
  const newMerges = prevMergesBi + 1n;
  const poolOutL = poolInL + marginL;

  const poolDatum1 = poolDatumCbor({
    poolScriptHashHex: addresses.poolScriptHashHex,
    marginScriptHashHex: addresses.marginScriptHashHex,
    adminKeyHashHex: addresses.adminKeyHashHex,
    totalMarginLovelace: newTotal,
    mergeCount: newMerges,
    positionsRootHex: "",
  });

  const poolRedeemer = poolMergeDepositRedeemerCbor(marginUtxo.txHash, marginUtxo.outputIndex);
  const marginRedeemer = marginForwardToPoolRedeemerCbor();

  const tx = await lucid
    .newTx()
    .attach.SpendingValidator(poolScript)
    .attach.SpendingValidator(marginScript)
    .collectFrom([poolUtxo], poolRedeemer)
    .collectFrom([marginUtxo], marginRedeemer)
    .pay.ToContract(addresses.poolAddress, { kind: "inline", value: poolDatum1 }, { lovelace: poolOutL })
    .complete()
    .then((t) => t.sign.withWallet().complete());
  const txHash = await tx.submit();
  return { txHash, explorerUrl: marginPoolTxExplorerUrl(network, txHash) };
}

export async function mergeMarginIntoPool(): Promise<{ txHash: string; explorerUrl: string }> {
  const { lucid, addresses } = await loadContext();
  const marginList = await lucid.utxosAt(addresses.marginAddress);
  if (marginList.length < 1) {
    throw new Error("No margin UTxOs to merge — deposit margin first.");
  }
  marginList.sort(sortOutRef);
  return mergeMarginUtxoIntoPool(marginList[0]!);
}

export type LockCollateralForTradeResult = {
  depositTxHash: string;
  depositExplorerUrl: string;
  mergeTxHash: string;
  mergeExplorerUrl: string;
};

/** Deposit → confirm → merge the new margin UTxO into the pool (two txs). Uses `WALLET_MNEMONIC` via Lucid. */
export async function lockCollateralForTrade(opts: {
  lovelace: bigint;
  orderCommitmentHex64: string;
  marketId: string;
}): Promise<LockCollateralForTradeResult> {
  const dep = await depositMarginForOrder(opts);
  const lucid = await createAppLucid();
  await lucid.awaitTx(dep.txHash);
  const { addresses } = await loadContext();
  const marginUtxo = await findMarginUtxoFromDepositTx(lucid, addresses.marginAddress, dep.txHash);
  const merge = await mergeMarginUtxoIntoPool(marginUtxo);
  return {
    depositTxHash: dep.txHash,
    depositExplorerUrl: dep.explorerUrl,
    mergeTxHash: merge.txHash,
    mergeExplorerUrl: merge.explorerUrl,
  };
}

/** Full three-step demo (same as CLI). */
export async function runMarginPoolDemo(opts: {
  poolBootstrapLovelace: bigint;
  marginDepositLovelace: bigint;
}): Promise<{ step1: string; step2: string; step3: string }> {
  const a = await bootstrapMarginPool(opts.poolBootstrapLovelace);
  const lucid = await createAppLucid();
  await lucid.awaitTx(a.txHash);
  const b = await depositMargin(opts.marginDepositLovelace);
  await lucid.awaitTx(b.txHash);
  const c = await mergeMarginIntoPool();
  return { step1: a.txHash, step2: b.txHash, step3: c.txHash };
}
