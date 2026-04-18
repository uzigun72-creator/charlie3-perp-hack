import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyDoubleCborEncoding,
  CBOREncodingLevel,
  validatorToAddress,
} from "@lucid-evolution/utils";
import { Constr, Data } from "@lucid-evolution/lucid";
import type { Address, Network, Script } from "@lucid-evolution/lucid";

const _here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLUEPRINT_PATH = join(_here, "../../cardano/margin-pool/plutus.json");

export interface MarginPoolBlueprintJson {
  preamble: { plutusVersion: string };
  validators: Array<{ title: string; compiledCode?: string; hash?: string }>;
}

export function loadMarginPoolBlueprint(
  blueprintPath?: string,
): MarginPoolBlueprintJson {
  const fromEnv = process.env.MARGIN_POOL_BLUEPRINT?.trim();
  const path =
    blueprintPath ?? (fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_BLUEPRINT_PATH);
  return JSON.parse(readFileSync(path, "utf8")) as MarginPoolBlueprintJson;
}

function plutusScriptType(preambleVersion: string): Script["type"] {
  if (preambleVersion === "v3") return "PlutusV3";
  if (preambleVersion === "v2") return "PlutusV2";
  return "PlutusV1";
}

function spendingScriptFromBlueprint(
  blueprint: MarginPoolBlueprintJson,
  titleSuffix: ".spend",
): Script {
  const row = blueprint.validators.find((v) => v.title.endsWith(titleSuffix));
  const raw = row?.compiledCode;
  if (!raw) throw new Error(`margin-pool: no ${titleSuffix} validator compiledCode in blueprint`);
  const level = CBOREncodingLevel(raw);
  const script = level === "double" ? raw : applyDoubleCborEncoding(raw);
  return { type: plutusScriptType(blueprint.preamble.plutusVersion), script };
}

export function marginVaultSpendingScript(
  blueprint: MarginPoolBlueprintJson = loadMarginPoolBlueprint(),
): Script {
  return spendingScriptFromBlueprint(blueprint, "margin_vault.margin_vault.spend");
}

export function marginPoolSpendingScript(
  blueprint: MarginPoolBlueprintJson = loadMarginPoolBlueprint(),
): Script {
  return spendingScriptFromBlueprint(blueprint, "margin_pool.margin_pool.spend");
}

export function validatorHashHex(
  blueprint: MarginPoolBlueprintJson,
  titleContains: string,
): string {
  const row = blueprint.validators.find((v) => v.title.includes(titleContains) && v.title.endsWith(".spend"));
  const h = row?.hash;
  if (!h || h.length !== 56) {
    throw new Error(`margin-pool: missing 28-byte script hash for ${titleContains}`);
  }
  return h.toLowerCase();
}

export function marginVaultScriptHashHex(
  blueprint: MarginPoolBlueprintJson = loadMarginPoolBlueprint(),
): string {
  return validatorHashHex(blueprint, "margin_vault");
}

export function marginPoolScriptHashHex(
  blueprint: MarginPoolBlueprintJson = loadMarginPoolBlueprint(),
): string {
  return validatorHashHex(blueprint, "margin_pool");
}

export function marginVaultScriptAddress(
  network: Network,
  script: Script = marginVaultSpendingScript(),
): Address {
  return validatorToAddress(network, script);
}

export function marginPoolScriptAddress(
  network: Network,
  script: Script = marginPoolSpendingScript(),
): Address {
  return validatorToAddress(network, script);
}

/** Inline datum CBOR hex for `MarginDatum` (constructor 0). */
export function marginDatumCbor(params: {
  ownerKeyHashHex: string;
  marketIdUtf8: string;
  positionNonceHex: string;
  orderCommitmentHex: string;
}): string {
  const owner = params.ownerKeyHashHex.replace(/^0x/i, "").toLowerCase();
  if (owner.length !== 56) {
    throw new Error("ownerKeyHashHex must be 28 bytes (56 hex chars)");
  }
  const marketHex = Buffer.from(params.marketIdUtf8, "utf8").toString("hex");
  const nonce = params.positionNonceHex.replace(/^0x/i, "").toLowerCase();
  const oc = params.orderCommitmentHex.replace(/^0x/i, "").toLowerCase();
  const d = new Constr(0, [owner, marketHex, nonce, oc]);
  return Data.to(d);
}

/** Inline datum CBOR hex for `PoolDatum` (constructor 0). */
export function poolDatumCbor(params: {
  poolScriptHashHex: string;
  marginScriptHashHex: string;
  adminKeyHashHex: string;
  totalMarginLovelace: bigint;
  mergeCount: bigint;
  positionsRootHex: string;
}): string {
  const poolH = params.poolScriptHashHex.replace(/^0x/i, "").toLowerCase();
  const marginH = params.marginScriptHashHex.replace(/^0x/i, "").toLowerCase();
  const admin = params.adminKeyHashHex.replace(/^0x/i, "").toLowerCase();
  if (poolH.length !== 56 || marginH.length !== 56 || admin.length !== 56) {
    throw new Error("pool, margin script hashes and admin key hash must be 56 hex chars (28 bytes)");
  }
  const root = params.positionsRootHex.replace(/^0x/i, "").toLowerCase();
  const d = new Constr(0, [
    poolH,
    marginH,
    admin,
    params.totalMarginLovelace,
    params.mergeCount,
    root,
  ]);
  return Data.to(d);
}

/** `OutputReference` as Plutus `Data` (constructor 0: tx id bytes, output index). */
export function outputReferenceData(txHashHex: string, outputIndex: number): Constr<unknown> {
  const txId = txHashHex.replace(/^0x/i, "").toLowerCase();
  if (txId.length !== 64) {
    throw new Error("transaction id must be 32 bytes (64 hex chars)");
  }
  return new Constr(0, [txId, BigInt(outputIndex)]);
}

/** Redeemer CBOR for `MergeDeposit`. */
export function poolMergeDepositRedeemerCbor(marginTxHash: string, marginOutputIndex: number): string {
  const ref = outputReferenceData(marginTxHash, marginOutputIndex);
  const r = new Constr(0, [ref]);
  return Data.to(r);
}

/** Redeemer CBOR for `ForwardToPool` (margin vault). */
export function marginForwardToPoolRedeemerCbor(): string {
  const r = new Constr(1, []);
  return Data.to(r);
}

/** Redeemer CBOR for `Refund` (margin vault). */
export function marginRefundRedeemerCbor(): string {
  const r = new Constr(0, []);
  return Data.to(r);
}

/** Redeemer CBOR for admin `WithdrawClose`. */
export function poolWithdrawCloseRedeemerCbor(withdrawLovelace: bigint): string {
  const r = new Constr(1, [withdrawLovelace]);
  return Data.to(r);
}
