import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/charli3perp-liquidation/contract/index.js';

export type Charli3perpLiquidationPrivateState = {
  marginWitness?: Uint8Array;
};

export const charli3perpLiquidationWitnesses = {
  marginWitness: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpLiquidationPrivateState>): [
    Charli3perpLiquidationPrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.marginWitness ?? new Uint8Array(32) },
  ],
};
