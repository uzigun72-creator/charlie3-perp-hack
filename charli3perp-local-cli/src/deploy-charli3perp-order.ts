/**
 * Deploy `charli3perp-order` to Midnight (**undeployed** local Docker or **preprod** public RPC).
 *
 * Env:
 * - `MIDNIGHT_DEPLOY_NETWORK` – `undeployed` (default), `preview`, or `preprod`.
 * - `BIP39_MNEMONIC` – funded on the selected Midnight network.
 * - `C3PERP_TRADER_SK_HEX` – 64 hex chars (32 bytes) private seed for ZK trader proofs.
 * - `C3PERP_ORDER_COMMITMENT_HEX` – 64 hex chars; defaults to `00…`.
 */
import "./load_repo_env.js";
import { Buffer } from 'buffer';
import WebSocket from 'ws';
import * as bip39 from 'bip39';
import { deployContract } from '@midnight-ntwrk/midnight-js-contracts';
import { charli3perpOrderPrivateStateId, Charli3perpOrder } from '@charli3perp/midnight-contract';
import { charli3perpOrderCompiledContractLocal } from './charli3perp-compiled-contract.js';
import { Charli3perpMidnightConfig } from './config.js';
import { configureCharli3perpOrderProviders } from './providers.js';
import { initWalletWithSeed, persistMidnightWalletState } from './wallet.js';
import { traderLedgerPublicKey } from './trader-key.js';
import { waitForWalletSyncedWithHeartbeat } from './wait_wallet_sync.js';
import { ensureProofServerPortReachable, printProvingFailureHints } from './proof_server_preflight.js';

(globalThis as any).WebSocket = WebSocket;

function hexToBytes32(hex: string): Uint8Array {
  const h = hex.replace(/^0x/, '');
  if (h.length !== 64) throw new Error('expected 32-byte hex string');
  return Uint8Array.from(Buffer.from(h, 'hex'));
}

async function main(): Promise<void> {
  const mnemonic = process.env.BIP39_MNEMONIC;
  if (!mnemonic || !bip39.validateMnemonic(mnemonic)) {
    console.error('Set valid BIP39_MNEMONIC (fund via midnight-local-network)');
    process.exit(1);
  }

  const config = new Charli3perpMidnightConfig();
  console.log(`Proof server: ${config.proofServer}`);
  await ensureProofServerPortReachable(config.proofServer);

  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const walletCtx = await initWalletWithSeed(seed, config);

  await waitForWalletSyncedWithHeartbeat(walletCtx.wallet);

  await persistMidnightWalletState(walletCtx);

  const traderSk = hexToBytes32(process.env.C3PERP_TRADER_SK_HEX ?? '03'.repeat(32));
  const traderPk = traderLedgerPublicKey(traderSk);
  const commitment = hexToBytes32(process.env.C3PERP_ORDER_COMMITMENT_HEX ?? '00'.repeat(32));

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

  const pub = deployed.deployTxData.public;
  console.log('Deployed charli3perp-order at:', pub.contractAddress);

  if (!('initialContractState' in pub) || !pub.initialContractState) {
    throw new Error('deploy result missing initialContractState');
  }
  try {
    const ledger = Charli3perpOrder.ledger(pub.initialContractState.data);
    const oc = ledger.orderCommitment as unknown;
    const hexPrefix = Buffer.from(oc as Uint8Array).toString('hex').slice(0, 16);
    console.log('Ledger snapshot: orderCommitment (hex prefix)=', hexPrefix, '…');
  } catch {
    console.log('Deployed; ledger parse skipped (check generated contract typings).');
  }
}

main().catch((e) => {
  console.error(e);
  printProvingFailureHints(e);
  process.exit(1);
});
