import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/charli3perp-order/contract/index.js';

export type Charli3perpOrderPrivateState = {
  traderSecretKey?: Uint8Array;
};

export const charli3perpOrderWitnesses = {
  traderSecret: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpOrderPrivateState>): [
    Charli3perpOrderPrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    {
      is_some: true,
      value: privateState.traderSecretKey ?? new Uint8Array(),
    },
  ],
};
