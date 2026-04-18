/**
 * Browser-safe settlement anchor encoding (no Node fs). Used by perps-web user-paid L1 flow.
 */
import {
  applyDoubleCborEncoding,
  CBOREncodingLevel,
  validatorToAddress,
} from "@lucid-evolution/utils";
import { Constr, Data } from "@lucid-evolution/lucid";
import type { Network, Script } from "@lucid-evolution/lucid";

export interface BlueprintJson {
  preamble: { plutusVersion: string };
  validators: Array<{ title: string; compiledCode?: string }>;
}

function plutusScriptType(preambleVersion: string): Script["type"] {
  if (preambleVersion === "v3") return "PlutusV3";
  if (preambleVersion === "v2") return "PlutusV2";
  return "PlutusV1";
}

export function settlementAnchorSpendingScriptFromBlueprint(blueprint: BlueprintJson): Script {
  const row = blueprint.validators.find((v) => v.title.endsWith(".spend"));
  const raw = row?.compiledCode;
  if (!raw) throw new Error("settlement_anchor: no .spend validator compiledCode in blueprint");
  const level = CBOREncodingLevel(raw);
  const script = level === "double" ? raw : applyDoubleCborEncoding(raw);
  return { type: plutusScriptType(blueprint.preamble.plutusVersion), script };
}

export function settlementAnchorScriptAddress(network: Network, script: Script): string {
  return validatorToAddress(network, script);
}

export function anchorDatumCbor(params: {
  settlementId: string;
  orderCommitmentHex: string;
  midnightTxUtf8?: string;
}): string {
  const order = params.orderCommitmentHex.replace(/^0x/i, "");
  if (order.length !== 64 || !/^[0-9a-fA-F]+$/.test(order)) {
    throw new Error("orderCommitmentHex must be exactly 64 hex digits (32 bytes)");
  }
  const settlementHex = Buffer.from(params.settlementId, "utf8").toString("hex");
  const midnightHex = Buffer.from(params.midnightTxUtf8 ?? "", "utf8").toString("hex");
  const d = new Constr(0, [settlementHex, order.toLowerCase(), midnightHex]);
  return Data.to(d);
}
