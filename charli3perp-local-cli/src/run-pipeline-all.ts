/**
 * Full five-contract Midnight pipeline: `charli3perp-order` + matching + settlement + liquidation + proof aggregation.
 *
 * Env: same as `run-charli3perp-all.ts`, plus optional:
 * - C3PERP_BID_PREIMAGE_HEX / C3PERP_ASK_PREIMAGE_HEX (32-byte hex)
 * - C3PERP_MATCH_DIGEST_HEX
 * - C3PERP_SETTLEMENT_INITIAL_HEX / C3PERP_SETTLEMENT_PAYLOAD_HEX
 * - C3PERP_MARGIN_WITNESS_HEX / C3PERP_LIQUIDATION_THRESHOLD_HEX
 * - C3PERP_AGGREGATE_LEFT_HEX / C3PERP_AGGREGATE_RIGHT_HEX / C3PERP_AGGREGATE_INITIAL_HEX
 */
import "./load_repo_env.js";
import { Buffer } from 'buffer';
import WebSocket from 'ws';
import * as bip39 from 'bip39';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import {
  charli3perpOrderPrivateStateId,
  charli3perpMatchingPrivateStateId,
  charli3perpSettlementPrivateStateId,
  charli3perpLiquidationPrivateStateId,
  charli3perpAggregatePrivateStateId,
} from '@charli3perp/midnight-contract';
import {
  charli3perpOrderCompiledContractLocal,
  charli3perpMatchingCompiledContractLocal,
  charli3perpSettlementCompiledContractLocal,
  charli3perpLiquidationCompiledContractLocal,
  charli3perpAggregateCompiledContractLocal,
} from './charli3perp-compiled-contract.js';
import { Charli3perpMidnightConfig } from './config.js';
import {
  configureCharli3perpOrderProviders,
  configureCharli3perpMatchingProviders,
  configureCharli3perpSettlementProviders,
  configureCharli3perpLiquidationProviders,
  configureCharli3perpAggregateProviders,
} from './providers.js';
import { initWalletWithSeed, persistMidnightWalletState } from './wallet.js';
import { traderLedgerPublicKey } from './trader-key.js';
import { ensureDustReady } from './dust.js';
import { waitForWalletSyncedWithHeartbeat } from './wait_wallet_sync.js';
import { hashSingle32, hashPair32 } from './midnight-hash.js';
import { performance } from 'node:perf_hooks';
import { ensureProofServerPortReachable, printProvingFailureHints } from './proof_server_preflight.js';

(globalThis as any).WebSocket = WebSocket;

type BenchStep = { label: string; ms: number };

const benchSteps: BenchStep[] = [];

async function benchProof<T>(label: string, run: () => Promise<T>): Promise<T> {
  const t0 = performance.now();
  try {
    return await run();
  } finally {
    const ms = performance.now() - t0;
    benchSteps.push({ label, ms });
    if (process.env.C3PERP_PIPELINE_BENCH_LOG === '1') {
      console.log(`[bench] ${label}: ${ms.toFixed(1)} ms`);
    }
  }
}

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  if (h.length !== 64) throw new Error('expected 32-byte hex string');
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

function defaultHex(label: string, fallback: string): string {
  const v = process.env[label]?.trim();
  if (v && v.replace(/^0x/, '').length === 64) return v.replace(/^0x/, '');
  return fallback;
}

function logTx(label: string, pub: { txId: unknown; txHash: unknown; blockHeight?: unknown }) {
  const bh = pub.blockHeight !== undefined ? ` blockHeight=${pub.blockHeight}` : '';
  console.log(`${label}: txId=${String(pub.txId)} txHash=${String(pub.txHash)}${bh}`);
}

async function main(): Promise<void> {
  const mnemonic = process.env.BIP39_MNEMONIC;
  if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
    console.error('Set valid BIP39_MNEMONIC');
    process.exit(1);
  }

  const config = new Charli3perpMidnightConfig();
  console.log(`Proof server: ${config.proofServer}`);
  await ensureProofServerPortReachable(config.proofServer);

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const walletCtx = await initWalletWithSeed(seed, config);

  await waitForWalletSyncedWithHeartbeat(walletCtx.wallet);

  console.log('Ensuring DUST is ready…');
  await ensureDustReady(walletCtx, { timeoutMs: 240_000 });
  console.log('DUST ready.');

  await persistMidnightWalletState(walletCtx);

  const traderSk = hexToBytes32(process.env.C3PERP_TRADER_SK_HEX ?? '03'.repeat(32));
  const traderPk = traderLedgerPublicKey(traderSk);
  const commitment = hexToBytes32(process.env.C3PERP_ORDER_COMMITMENT_HEX ?? '00'.repeat(32));
  const l1Anchor = hexToBytes32(process.env.C3PERP_L1_ANCHOR_HEX ?? 'aa'.repeat(32));

  const bidPre = hexToBytes32(defaultHex('C3PERP_BID_PREIMAGE_HEX', 'c0'.repeat(32)));
  const askPre = hexToBytes32(defaultHex('C3PERP_ASK_PREIMAGE_HEX', 'd0'.repeat(32)));
  const bidCommit = hashSingle32(bidPre);
  const askCommit = hashSingle32(askPre);
  const matchDigest = hexToBytes32(defaultHex('C3PERP_MATCH_DIGEST_HEX', 'e0'.repeat(32)));

  const settlementInitial = hexToBytes32(
    defaultHex('C3PERP_SETTLEMENT_INITIAL_HEX', '11'.repeat(32)),
  );
  const settlementPayload = hexToBytes32(
    defaultHex('C3PERP_SETTLEMENT_PAYLOAD_HEX', '22'.repeat(32)),
  );
  const settlementNext = hashPair32(settlementInitial, settlementPayload);

  const marginWitness = hexToBytes32(defaultHex('C3PERP_MARGIN_WITNESS_HEX', '33'.repeat(32)));
  const marginCommit = hashSingle32(marginWitness);
  const liqThreshold = hexToBytes32(defaultHex('C3PERP_LIQUIDATION_THRESHOLD_HEX', '44'.repeat(32)));

  const aggLeft = hexToBytes32(defaultHex('C3PERP_AGGREGATE_LEFT_HEX', '55'.repeat(32)));
  const aggRight = hexToBytes32(defaultHex('C3PERP_AGGREGATE_RIGHT_HEX', '66'.repeat(32)));
  const aggInitial = hexToBytes32(defaultHex('C3PERP_AGGREGATE_INITIAL_HEX', '00'.repeat(32)));

  // --- charli3perp-order ---
  const orderProviders = await configureCharli3perpOrderProviders(walletCtx, config);
  console.log('Deploying charli3perp-order…');
  const orderDeployed = await deployContract(orderProviders, {
    compiledContract: charli3perpOrderCompiledContractLocal,
    privateStateId: charli3perpOrderPrivateStateId,
    initialPrivateState: { traderSecretKey: new Uint8Array(traderSk) },
    args: [new Uint8Array(commitment), new Uint8Array(traderPk)],
  });
  logTx('order:deploy', orderDeployed.deployTxData.public);
  console.log('order:contractAddress=', orderDeployed.deployTxData.public.contractAddress);
  const orderCall = orderDeployed.callTx;
  logTx(
    'order:proveIntentAuthority',
    (await benchProof('order:proveIntentAuthority', () => orderCall.proveIntentAuthority())).public,
  );
  logTx(
    'order:bindCardanoAnchor',
    (await benchProof('order:bindCardanoAnchor', () => orderCall.bindCardanoAnchor(new Uint8Array(l1Anchor))))
      .public,
  );

  // --- charli3perp-matching ---
  const matchProviders = await configureCharli3perpMatchingProviders(walletCtx, config);
  console.log('Deploying charli3perp-matching…');
  const matchDeployed = await deployContract(matchProviders, {
    compiledContract: charli3perpMatchingCompiledContractLocal,
    privateStateId: charli3perpMatchingPrivateStateId,
    initialPrivateState: {
      bidPreimage: new Uint8Array(bidPre),
      askPreimage: new Uint8Array(askPre),
    },
    args: [new Uint8Array(bidCommit), new Uint8Array(askCommit)],
  });
  logTx('matching:deploy', matchDeployed.deployTxData.public);
  logTx(
    'matching:sealMatchRecord',
    (
      await benchProof('matching:sealMatchRecord', () =>
        matchDeployed.callTx.sealMatchRecord(new Uint8Array(matchDigest)),
      )
    ).public,
  );

  // --- charli3perp-settlement ---
  const settleProviders = await configureCharli3perpSettlementProviders(walletCtx, config);
  console.log('Deploying charli3perp-settlement…');
  const settleDeployed = await deployContract(settleProviders, {
    compiledContract: charli3perpSettlementCompiledContractLocal,
    privateStateId: charli3perpSettlementPrivateStateId,
    initialPrivateState: { transitionPayload: new Uint8Array(settlementPayload) },
    args: [new Uint8Array(settlementInitial)],
  });
  logTx('settlement:deploy', settleDeployed.deployTxData.public);
  logTx(
    'settlement:stepSettlementDigest',
    (
      await benchProof('settlement:stepSettlementDigest', () =>
        settleDeployed.callTx.stepSettlementDigest(new Uint8Array(settlementNext)),
      )
    ).public,
  );

  // --- charli3perp-liquidation ---
  const liqProviders = await configureCharli3perpLiquidationProviders(walletCtx, config);
  console.log('Deploying charli3perp-liquidation…');
  const liqDeployed = await deployContract(liqProviders, {
    compiledContract: charli3perpLiquidationCompiledContractLocal,
    privateStateId: charli3perpLiquidationPrivateStateId,
    initialPrivateState: { marginWitness: new Uint8Array(marginWitness) },
    args: [new Uint8Array(marginCommit)],
  });
  logTx('liquidation:deploy', liqDeployed.deployTxData.public);
  logTx(
    'liquidation:attestLiquidation',
    (
      await benchProof('liquidation:attestLiquidation', () =>
        liqDeployed.callTx.attestLiquidation(new Uint8Array(liqThreshold)),
      )
    ).public,
  );

  // --- charli3perp-aggregate ---
  const aggProviders = await configureCharli3perpAggregateProviders(walletCtx, config);
  console.log('Deploying charli3perp-aggregate…');
  const aggDeployed = await deployContract(aggProviders, {
    compiledContract: charli3perpAggregateCompiledContractLocal,
    privateStateId: charli3perpAggregatePrivateStateId,
    initialPrivateState: {
      leftProofDigest: new Uint8Array(aggLeft),
      rightProofDigest: new Uint8Array(aggRight),
    },
    args: [new Uint8Array(aggInitial)],
  });
  logTx('aggregate:deploy', aggDeployed.deployTxData.public);
  logTx(
    'aggregate:mergeProofBatch',
    (await benchProof('aggregate:mergeProofBatch', () => aggDeployed.callTx.mergeProofBatch()))
      .public,
  );

  await walletCtx.wallet.stop();
  console.log('Done. Midnight five-contract pipeline submitted.');

  const totalProveMs = benchSteps.reduce((a, s) => a + s.ms, 0);
  const benchPayload = {
    kind: 'charli3perp-pipeline-bench',
    captured_at: new Date().toISOString(),
    midnight_network: process.env.MIDNIGHT_DEPLOY_NETWORK ?? 'undeployed',
    proof_server: process.env.MIDNIGHT_PROOF_SERVER ?? 'default',
    hardware_note: process.env.BENCH_HARDWARE_NOTE ?? '',
    steps: benchSteps,
    total_zk_wall_ms: Math.round(totalProveMs * 1000) / 1000,
    sequential_zk_steps: benchSteps.length,
    sequential_proofs_per_second:
      totalProveMs > 0 ? Math.round((benchSteps.length / (totalProveMs / 1000)) * 1000) / 1000 : 0,
  };
  if (process.env.C3PERP_PIPELINE_BENCH_JSON === '1') {
    console.log(JSON.stringify(benchPayload, null, 2));
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  printProvingFailureHints(e);
  process.exit(1);
});
