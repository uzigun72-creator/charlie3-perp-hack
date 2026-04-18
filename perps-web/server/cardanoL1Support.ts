import { loadSettlementAnchorBlueprint } from "../../src/cardano/settlement_anchor.js";
import { charli3KupoUrl, feedConfigForPair } from "../../src/charli3/config.js";
import { listUnspentC3asMatches } from "../../src/charli3/kupo_client.js";

/** Latest C3AS oracle UTxO for the pair (same source as Charli3 pull tx). */
export async function getOracleOutRef(pairId: string): Promise<{
  txHash: string;
  outputIndex: number;
}> {
  const feed = feedConfigForPair(pairId);
  const kupo = charli3KupoUrl();
  const matches = await listUnspentC3asMatches(kupo, feed);
  if (matches.length === 0) {
    throw new Error(`No unspent C3AS UTxOs for ${pairId}`);
  }
  const best = [...matches].sort((a, b) => b.created_at.slot_no - a.created_at.slot_no)[0]!;
  return { txHash: best.transaction_id, outputIndex: best.output_index };
}

export function settlementAnchorBlueprintJson(): ReturnType<typeof loadSettlementAnchorBlueprint> {
  return loadSettlementAnchorBlueprint();
}
