/**
 * Deploy `charli3perp-order`, run ZK circuits: `proveIntentAuthority`, `bindCardanoAnchor`.
 *
 * Env: `MIDNIGHT_DEPLOY_NETWORK` (`undeployed` | `preview` | `preprod`), `BIP39_MNEMONIC`,
 * `C3PERP_TRADER_SK_HEX`, `C3PERP_ORDER_COMMITMENT_HEX`,
 * optional `C3PERP_L1_ANCHOR_HEX` (32-byte hex binding Cardano settlement metadata digest).
 */
import "./load_repo_env.js";
import { Buffer } from 'buffer';
import * as bip39 from 'bip39';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { charli3perpOrderPrivateStateId } from '@charli3perp/midnight-contract';
import { charli3perpOrderCompiledContractLocal } from './charli3perp-compiled-contract.js';
import { Charli3perpMidnightConfig } from './config.js';
import { configureCharli3perpOrderProviders } from './providers.js';
import { deriveKeyIndexFromEnv, initWalletWithSeed, persistMidnightWalletState } from './wallet.js';
import { traderLedgerPublicKey } from './trader-key.js';
import { ensureDustReady } from './dust.js';
import { waitForWalletSyncedWithHeartbeat } from './wait_wallet_sync.js';
import { ensureProofServerPortReachable, printProvingFailureHints } from './proof_server_preflight.js';

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  if (h.length !== 64) throw new Error('expected 32-byte hex string');
  return Uint8Array.from(Buffer.from(h, 'hex'));
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
  const walletCtx = await initWalletWithSeed(seed, config, { deriveKeyIndex: deriveKeyIndexFromEnv() });

  await waitForWalletSyncedWithHeartbeat(walletCtx.wallet);

  console.log('Ensuring DUST is ready…');
  await ensureDustReady(walletCtx, { timeoutMs: 240_000 });
  console.log('DUST ready.');

  await persistMidnightWalletState(walletCtx);

  const traderSk = hexToBytes32(process.env.C3PERP_TRADER_SK_HEX ?? '03'.repeat(32));
  const traderPk = traderLedgerPublicKey(traderSk);
  const commitment = hexToBytes32(process.env.C3PERP_ORDER_COMMITMENT_HEX ?? '00'.repeat(32));
  const l1Anchor = hexToBytes32(process.env.C3PERP_L1_ANCHOR_HEX ?? 'aa'.repeat(32));

  const providers = await configureCharli3perpOrderProviders(walletCtx, config);

  console.log('Deploying charli3perp-order…');
  const deployed = await deployContract(providers, {
    compiledContract: charli3perpOrderCompiledContractLocal,
    privateStateId: charli3perpOrderPrivateStateId,
    initialPrivateState: {
      traderSecretKey: new Uint8Array(traderSk),
    },
    args: [new Uint8Array(commitment), new Uint8Array(traderPk)],
  });

  const deployPub = deployed.deployTxData.public;
  logTx('deploy', deployPub);
  console.log('Contract address:', deployPub.contractAddress);

  const { callTx } = deployed;

  logTx('proveIntentAuthority (ZK)', (await callTx.proveIntentAuthority()).public);
  logTx('bindCardanoAnchor (ZK + L1 anchor)', (await callTx.bindCardanoAnchor(new Uint8Array(l1Anchor))).public);

  console.log('[midnight wallet] Saving sync state after order pipeline…');
  await persistMidnightWalletState(walletCtx);

  console.log('Done. Charli3perp order circuits submitted.');
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  printProvingFailureHints(e);
  process.exit(1);
});
