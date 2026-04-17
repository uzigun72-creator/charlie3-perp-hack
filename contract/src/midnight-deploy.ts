/**
 * Midnight.js wiring: CompiledContract + ZK artifact paths.
 * Constructor args: [orderCommitment, traderPk]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CompiledContract } from '@midnight-ntwrk/compact-js';
import * as Charli3perpOrder from './managed/charli3perp-order/contract/index.js';
import * as Charli3perpMatching from './managed/charli3perp-matching/contract/index.js';
import * as Charli3perpSettlement from './managed/charli3perp-settlement/contract/index.js';
import * as Charli3perpLiquidation from './managed/charli3perp-liquidation/contract/index.js';
import * as Charli3perpAggregate from './managed/charli3perp-aggregate/contract/index.js';
import { charli3perpOrderWitnesses } from './witnesses-charli3perp-order.js';
import { charli3perpMatchingWitnesses } from './witnesses-charli3perp-matching.js';
import { charli3perpSettlementWitnesses } from './witnesses-charli3perp-settlement.js';
import { charli3perpLiquidationWitnesses } from './witnesses-charli3perp-liquidation.js';
import { charli3perpAggregateWitnesses } from './witnesses-charli3perp-aggregate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const charli3perpOrderZkConfigPath = path.resolve(
  __dirname,
  'managed',
  'charli3perp-order',
);

export const charli3perpOrderCompiledContract = CompiledContract.make(
  'charli3perp-order',
  Charli3perpOrder.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpOrderWitnesses),
  CompiledContract.withCompiledFileAssets(charli3perpOrderZkConfigPath),
);

export const charli3perpOrderPrivateStateId = 'charli3perpOrderPrivateState' as const;

export type Charli3perpOrderConstructorArgs = readonly [
  orderCommitment: Uint8Array,
  traderPk: Uint8Array,
];

export const charli3perpMatchingZkConfigPath = path.resolve(__dirname, 'managed', 'charli3perp-matching');

export const charli3perpMatchingCompiledContract = CompiledContract.make(
  'charli3perp-matching',
  Charli3perpMatching.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpMatchingWitnesses),
  CompiledContract.withCompiledFileAssets(charli3perpMatchingZkConfigPath),
);

export const charli3perpMatchingPrivateStateId = 'charli3perpMatchingPrivateState' as const;

export type Charli3perpMatchingConstructorArgs = readonly [bid: Uint8Array, ask: Uint8Array];

export const charli3perpSettlementZkConfigPath = path.resolve(__dirname, 'managed', 'charli3perp-settlement');

export const charli3perpSettlementCompiledContract = CompiledContract.make(
  'charli3perp-settlement',
  Charli3perpSettlement.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpSettlementWitnesses),
  CompiledContract.withCompiledFileAssets(charli3perpSettlementZkConfigPath),
);

export const charli3perpSettlementPrivateStateId = 'charli3perpSettlementPrivateState' as const;

export type Charli3perpSettlementConstructorArgs = readonly [initialDigest: Uint8Array];

export const charli3perpLiquidationZkConfigPath = path.resolve(__dirname, 'managed', 'charli3perp-liquidation');

export const charli3perpLiquidationCompiledContract = CompiledContract.make(
  'charli3perp-liquidation',
  Charli3perpLiquidation.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpLiquidationWitnesses),
  CompiledContract.withCompiledFileAssets(charli3perpLiquidationZkConfigPath),
);

export const charli3perpLiquidationPrivateStateId = 'charli3perpLiquidationPrivateState' as const;

export type Charli3perpLiquidationConstructorArgs = readonly [marginCommitment: Uint8Array];

export const charli3perpAggregateZkConfigPath = path.resolve(__dirname, 'managed', 'charli3perp-aggregate');

export const charli3perpAggregateCompiledContract = CompiledContract.make(
  'charli3perp-aggregate',
  Charli3perpAggregate.Contract,
).pipe(
  CompiledContract.withWitnesses(charli3perpAggregateWitnesses),
  CompiledContract.withCompiledFileAssets(charli3perpAggregateZkConfigPath),
);

export const charli3perpAggregatePrivateStateId = 'charli3perpAggregatePrivateState' as const;

export type Charli3perpAggregateConstructorArgs = readonly [initialRoot: Uint8Array];
