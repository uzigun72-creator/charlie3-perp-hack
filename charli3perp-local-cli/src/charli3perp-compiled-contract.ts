/**
 * Must use the same `@midnight-ntwrk/compact-js` instance as `@midnight-ntwrk/midnight-js-contracts`.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import {
  Charli3perpOrder,
  charli3perpOrderWitnesses,
  Charli3perpMatching,
  charli3perpMatchingWitnesses,
  Charli3perpSettlement,
  charli3perpSettlementWitnesses,
  Charli3perpLiquidation,
  charli3perpLiquidationWitnesses,
  Charli3perpAggregate,
  charli3perpAggregateWitnesses,
} from '@charli3perp/midnight-contract';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const charli3perpOrderCompiledContractLocal = CompiledContract.make(
  'charli3perp-order',
  Charli3perpOrder.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpOrderWitnesses),
  CompiledContract.withCompiledFileAssets(
    path.resolve(__dirname, '../../contract/src/managed/charli3perp-order'),
  ),
);

export const charli3perpMatchingCompiledContractLocal = CompiledContract.make(
  'charli3perp-matching',
  Charli3perpMatching.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpMatchingWitnesses),
  CompiledContract.withCompiledFileAssets(
    path.resolve(__dirname, '../../contract/src/managed/charli3perp-matching'),
  ),
);

export const charli3perpSettlementCompiledContractLocal = CompiledContract.make(
  'charli3perp-settlement',
  Charli3perpSettlement.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpSettlementWitnesses),
  CompiledContract.withCompiledFileAssets(
    path.resolve(__dirname, '../../contract/src/managed/charli3perp-settlement'),
  ),
);

export const charli3perpLiquidationCompiledContractLocal = CompiledContract.make(
  'charli3perp-liquidation',
  Charli3perpLiquidation.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpLiquidationWitnesses),
  CompiledContract.withCompiledFileAssets(
    path.resolve(__dirname, '../../contract/src/managed/charli3perp-liquidation'),
  ),
);

export const charli3perpAggregateCompiledContractLocal = CompiledContract.make(
  'charli3perp-aggregate',
  Charli3perpAggregate.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpAggregateWitnesses),
  CompiledContract.withCompiledFileAssets(
    path.resolve(__dirname, '../../contract/src/managed/charli3perp-aggregate'),
  ),
);
