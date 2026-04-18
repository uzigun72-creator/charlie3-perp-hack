/**
 * Browser-signed Charli3 oracle reference tx + settlement anchor (user-paid L1).
 */
import { Blockfrost, Lucid } from "@lucid-evolution/lucid";
import type { WalletApi } from "@lucid-evolution/core-types";
import type { BlueprintJson } from "@charlie3/src/cardano/settlement_anchor_codec.ts";
import {
  anchorDatumCbor,
  settlementAnchorScriptAddress,
  settlementAnchorSpendingScriptFromBlueprint,
} from "@charlie3/src/cardano/settlement_anchor_codec.ts";

/** Mirrors server `CardanoSessionPayload` JSON. */
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
  anchorMinLovelace: string;
  pullLovelaceToSelf: string;
  cardanoNetwork: string;
  midnightMatchingSealTxHash?: string;
};

function apiPrefix(): string {
  return import.meta.env.VITE_API_URL || "";
}

function blockfrost(): { url: string; projectId: string } {
  const projectId = import.meta.env.VITE_BLOCKFROST_PROJECT_ID?.trim();
  if (!projectId) {
    throw new Error("Set VITE_BLOCKFROST_PROJECT_ID (Preprod Blockfrost project id for browser submits).");
  }
  const url =
    import.meta.env.VITE_BLOCKFROST_URL?.trim() || "https://cardano-preprod.blockfrost.io/api/v0";
  return { url, projectId };
}

export async function submitUserPaidCardanoL1(
  session: CardanoSessionPayload,
  walletApi: WalletApi,
): Promise<{ charli3PullTxHash: string; settlementAnchorTxHash: string }> {
  const net = session.cardanoNetwork.toLowerCase() === "preview" ? "Preview" : "Preprod";
  const { url, projectId } = blockfrost();
  const lucid = await Lucid(new Blockfrost(url, projectId), net);
  lucid.selectWallet.fromAPI(walletApi);

  const refRes = await fetch(
    `${apiPrefix()}/api/cardano/oracle-ref?pair=${encodeURIComponent(session.pairId)}`,
  );
  const refJson = (await refRes.json()) as {
    txHash?: string;
    outputIndex?: number;
    error?: string;
  };
  if (!refRes.ok) throw new Error(refJson.error || `oracle-ref HTTP ${refRes.status}`);
  if (refJson.txHash === undefined || refJson.outputIndex === undefined) {
    throw new Error("oracle-ref: missing txHash/outputIndex");
  }

  const refs = await lucid.utxosByOutRef([
    { txHash: refJson.txHash, outputIndex: refJson.outputIndex },
  ]);
  if (refs.length === 0) throw new Error("Oracle UTxO not found (wrong network or Blockfrost project?)");
  const oracleUtxo = refs[0]!;
  const addr = await lucid.wallet().address();
  const pullL = BigInt(session.pullLovelaceToSelf);

  const signedPull = await lucid
    .newTx()
    .readFrom([oracleUtxo])
    .pay.ToAddress(addr, { lovelace: pullL })
    .complete()
    .then((x) => x.sign.withWallet().complete());
  const pullTxHash = await signedPull.submit();
  await lucid.awaitTx(pullTxHash);

  const bpRes = await fetch(`${apiPrefix()}/api/cardano/settlement-anchor-blueprint`);
  if (!bpRes.ok) {
    const t = await bpRes.text();
    throw new Error(`settlement-anchor-blueprint: ${t.slice(0, 200)}`);
  }
  const blueprint = (await bpRes.json()) as BlueprintJson;

  const script = settlementAnchorSpendingScriptFromBlueprint(blueprint);
  const scriptAddr = settlementAnchorScriptAddress(net, script);
  const midnightBlob = JSON.stringify({
    pair: session.pairId,
    charli3: {
      indexPrice: session.oracle.indexPrice,
      priceRaw: session.oracle.priceRaw,
      datumHash: session.oracle.datumHash,
      outRef: session.oracle.outRef,
      pullTxHash,
    },
    midnightPreview: {
      bindCardanoAnchorTxHash: session.midnightBindTxHash || null,
      matchingSealTxHash: session.midnightMatchingSealTxHash || null,
    },
    network: { cardano: "preprod", midnight: "preview" },
  });
  const minL = BigInt(session.anchorMinLovelace);
  const datumCbor = anchorDatumCbor({
    settlementId: session.settlementId,
    orderCommitmentHex: session.orderCommitmentHex64,
    midnightTxUtf8: midnightBlob,
  });

  const signedAnchor = await lucid
    .newTx()
    .pay.ToContract(scriptAddr, { kind: "inline", value: datumCbor }, { lovelace: minL })
    .complete()
    .then((x) => x.sign.withWallet().complete());
  const settlementAnchorTxHash = await signedAnchor.submit();
  await lucid.awaitTx(settlementAnchorTxHash);

  return { charli3PullTxHash: pullTxHash, settlementAnchorTxHash };
}
