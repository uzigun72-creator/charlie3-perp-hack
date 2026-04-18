/**
 * Isolated Midnight private-state DB names + `MIDNIGHT_DERIVE_KEY_INDEX` (same as perps `tradeOrchestrator`).
 * Apply with `Object.assign(process.env, midnightParallelEnvForDeriveIndex(n))` before `new Charli3perpMidnightConfig()`.
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
