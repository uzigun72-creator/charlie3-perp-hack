import { createAppLucid, type AppLucid } from "./lucid_wallet.js";
import {
  anchorDatumCbor,
  settlementAnchorScriptAddress,
  settlementAnchorSpendingScript,
} from "./settlement_anchor.js";
import { blockfrostConfig, cardanoBackend } from "../config/cardano_env.js";

export interface SubmitSettlementAnchorParams {
  settlementId: string;
  orderCommitmentHex64: string;
  midnightTxUtf8?: string;
  /** Reuse wallet context (avoids a second Lucid init when pull + anchor run in one pipeline). */
  lucid?: AppLucid;
}

export interface SubmitSettlementAnchorResult {
  txHash: string;
  scriptAddress: string;
  explorerUrl: string;
}

function explorerUrl(txHash: string): string {
  if (cardanoBackend() === "emulator") return "(emulator)";
  const net = process.env.CARDANO_NETWORK || "Preprod";
  return net === "Preview"
    ? `https://preview.cardanoscan.io/transaction/${txHash}`
    : `https://preprod.cardanoscan.io/transaction/${txHash}`;
}

async function blockfrostTxExists(txHash: string): Promise<boolean> {
  const { url, projectId } = blockfrostConfig();
  const r = await fetch(`${url}/txs/${txHash}`, {
    headers: { project_id: projectId },
  });
  return r.ok;
}

/** Preprod/Preview nodes sometimes return Conway mempool errors even when the tx is accepted; confirm via Blockfrost. */
async function waitForTxVisible(
  txHash: string,
  maxWaitMs: number,
): Promise<boolean> {
  const step = Math.max(
    400,
    Number.parseInt(process.env.ANCHOR_BF_POLL_MS || "1500", 10) || 1500,
  );
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await blockfrostTxExists(txHash)) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return blockfrostTxExists(txHash);
}

function isSpentInputsMempoolError(err: unknown): boolean {
  const s = err instanceof Error ? err.message : String(err);
  return s.includes("All inputs are spent") || s.includes("ConwayMempoolFailure");
}

export async function submitSettlementAnchorTx(
  params: SubmitSettlementAnchorParams,
): Promise<SubmitSettlementAnchorResult> {
  const orderCommitment = params.orderCommitmentHex64.replace(/^0x/i, "");
  if (orderCommitment.length !== 64 || !/^[0-9a-fA-F]+$/.test(orderCommitment)) {
    throw new Error("orderCommitmentHex64 must be 64 hex chars");
  }

  const minLovelace = BigInt(process.env.ANCHOR_MIN_LOVELACE || "2000000");
  const maxAttempts = Math.max(1, Number(process.env.ANCHOR_SUBMIT_RETRIES || "6"));
  let lastErr: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const lucid = params.lucid ?? (await createAppLucid());
    const network = lucid.config().network;
    if (!network) throw new Error("Lucid network is not configured");

    const script = settlementAnchorSpendingScript();
    const scriptAddr = settlementAnchorScriptAddress(network, script);
    const settlementId =
      attempt === 1
        ? params.settlementId
        : `${params.settlementId}-r${attempt}-${Date.now()}`;
    const datumCbor = anchorDatumCbor({
      settlementId,
      orderCommitmentHex: orderCommitment,
      midnightTxUtf8: params.midnightTxUtf8 ?? "",
    });

    try {
      const signed = await lucid
        .newTx()
        .pay.ToContract(scriptAddr, { kind: "inline", value: datumCbor }, { lovelace: minLovelace })
        .complete()
        .then((tb) => tb.sign.withWallet().complete());

      const txHash = signed.toHash();
      try {
        await signed.submit();
      } catch (submitErr) {
        if (cardanoBackend() !== "blockfrost") {
          throw submitErr;
        }
        const maxWait = Math.max(
          5000,
          Number.parseInt(process.env.ANCHOR_BF_SUBMIT_WAIT_MS || "45000", 10) || 45_000,
        );
        const visible = await waitForTxVisible(txHash, maxWait);
        if (!visible) {
          throw submitErr;
        }
      }
      return {
        txHash,
        scriptAddress: scriptAddr,
        explorerUrl: explorerUrl(txHash),
      };
    } catch (e) {
      lastErr = e;
      if (!isSpentInputsMempoolError(e) || attempt === maxAttempts) {
        throw e;
      }
      const delayMs = Math.min(15000, 2000 * attempt);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
