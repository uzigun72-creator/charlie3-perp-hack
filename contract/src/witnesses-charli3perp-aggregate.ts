import { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import { Ledger } from './managed/charli3perp-aggregate/contract/index.js';

export type Charli3perpAggregatePrivateState = {
  leftProofDigest?: Uint8Array;
  rightProofDigest?: Uint8Array;
};

export const charli3perpAggregateWitnesses = {
  leftProofDigest: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpAggregatePrivateState>): [
    Charli3perpAggregatePrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.leftProofDigest ?? new Uint8Array(32) },
  ],
  rightProofDigest: ({
    privateState,
  }: WitnessContext<Ledger, Charli3perpAggregatePrivateState>): [
    Charli3perpAggregatePrivateState,
    { is_some: boolean; value: Uint8Array },
  ] => [
    privateState,
    { is_some: true, value: privateState.rightProofDigest ?? new Uint8Array(32) },
  ],
};
