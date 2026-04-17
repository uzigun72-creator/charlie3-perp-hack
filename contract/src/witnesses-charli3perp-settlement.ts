import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/charli3perp-settlement/contract/index.js';

export type Charli3perpSettlementPrivateState = {
  transitionPayload?: Uint8Array;
};

export const charli3perpSettlementWitnesses = {
  transitionPayload: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpSettlementPrivateState>): [
    Charli3perpSettlementPrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.transitionPayload ?? new Uint8Array(32) },
  ],
};
