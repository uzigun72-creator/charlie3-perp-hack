import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/charli3perp-matching/contract/index.js';

export type Charli3perpMatchingPrivateState = {
  bidPreimage?: Uint8Array;
  askPreimage?: Uint8Array;
};

export const charli3perpMatchingWitnesses = {
  bidPreimage: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpMatchingPrivateState>): [
    Charli3perpMatchingPrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.bidPreimage ?? new Uint8Array(32) },
  ],
  askPreimage: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpMatchingPrivateState>): [
    Charli3perpMatchingPrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.askPreimage ?? new Uint8Array(32) },
  ],
};
