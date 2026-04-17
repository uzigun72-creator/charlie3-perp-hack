/**
 * Wallet bootstrap for Midnight **undeployed** (local Docker) or **preprod** (public RPC).
 * Preprod URLs align with https://docs.midnight.network/guides/deploy-mn-app
 *
 * **Disk cache:** set `MIDNIGHT_WALLET_STATE_DIR` (optional) to store serialized shielded/dust/unshielded
 * sync state so the next run replays from disk instead of re-scanning the chain from genesis.
 * Disable with `MIDNIGHT_WALLET_STATE_DISABLE=1`. The cache file is keyed by wallet seed + network id.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import type { DefaultDustConfiguration as DustConfiguration } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { DustWallet } from "@midnight-ntwrk/wallet-sdk-dust-wallet";
import { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { ShieldedWallet } from "@midnight-ntwrk/wallet-sdk-shielded";
import type { DefaultShieldedConfiguration as ShieldedConfiguration } from "@midnight-ntwrk/wallet-sdk-shielded";
import {
  createKeystore,
  InMemoryTransactionHistoryStorage,
  PublicKey as UnshieldedPublicKey,
  type UnshieldedKeystore,
  UnshieldedWallet,
  type DefaultUnshieldedConfiguration,
} from "@midnight-ntwrk/wallet-sdk-unshielded-wallet";
import { Buffer } from "buffer";
import type { Charli3perpMidnightConfig } from "./config.js";
import { relayWsUrlFromHttpOrigin } from "./midnight_network.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

type PersistedWalletV1 = {
  v: 1;
  shielded: string;
  dust: string;
  unshielded: string;
  savedAt: string;
};

function walletStateDisabled(): boolean {
  const v = process.env.MIDNIGHT_WALLET_STATE_DISABLE?.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes";
}

function resolveWalletStateFile(seed: Buffer, networkId: string): string {
  const id = createHash("sha256").update(seed).digest("hex").slice(0, 32);
  const base =
    process.env.MIDNIGHT_WALLET_STATE_DIR?.trim() ||
    path.resolve(__dirname, "../../.midnight-wallet-state");
  return path.join(base, networkId, `${id}.json`);
}

export type WalletContext = {
  wallet: WalletFacade;
  shieldedSecretKeys: ledger.ZswapSecretKeys;
  dustSecretKey: ledger.DustSecretKey;
  unshieldedKeystore: UnshieldedKeystore;
  /**
   * When set, {@link persistMidnightWalletState} can write shielded/dust/unshielded serialized sync state
   * after `isSynced` (and after DUST registration if your flow updates dust state).
   */
  midnightWalletCache?: {
    file: string;
    shielded: { serializeState(): Promise<string> };
    dust: { serializeState(): Promise<string> };
    unshielded: { serializeState(): Promise<string> };
  };
};

/** Write serialized wallet sync state to disk (no-op if caching was disabled at init). */
export async function persistMidnightWalletState(ctx: WalletContext): Promise<void> {
  const c = ctx.midnightWalletCache;
  if (!c) return;
  const [shielded, dust, unshielded] = await Promise.all([
    c.shielded.serializeState(),
    c.dust.serializeState(),
    c.unshielded.serializeState(),
  ]);
  const payload: PersistedWalletV1 = {
    v: 1,
    shielded,
    dust,
    unshielded,
    savedAt: new Date().toISOString(),
  };
  await mkdir(path.dirname(c.file), { recursive: true });
  await writeFile(c.file, JSON.stringify(payload), "utf8");
}

export async function initWalletWithSeed(
  seed: Buffer,
  midnight: Charli3perpMidnightConfig,
): Promise<WalletContext> {
  const hdWallet = HDWallet.fromSeed(Uint8Array.from(seed));

  if (hdWallet.type !== "seedOk") {
    throw new Error("Failed to initialize HDWallet");
  }

  const derivationResult = hdWallet.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);

  if (derivationResult.type !== "keysDerived") {
    throw new Error("Failed to derive keys");
  }

  hdWallet.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(derivationResult.keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(derivationResult.keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(
    derivationResult.keys[Roles.NightExternal],
    midnight.networkId,
  );

  const baseConfiguration: ShieldedConfiguration & DustConfiguration = {
    networkId: midnight.networkId,
    costParameters: {
      additionalFeeOverhead: midnight.shieldedAdditionalFeeOverhead,
      feeBlocksMargin: 5,
    },
    indexerClientConnection: {
      indexerHttpUrl: midnight.indexer,
      indexerWsUrl: midnight.indexerWS,
    },
  };

  const unshieldedConfiguration: DefaultUnshieldedConfiguration = {
    ...baseConfiguration,
    txHistoryStorage: new InMemoryTransactionHistoryStorage(),
  };

  const dustParams = ledger.LedgerParameters.initialParameters().dust;
  const dustBase = {
    ...baseConfiguration,
    costParameters: {
      additionalFeeOverhead: midnight.dustAdditionalFeeOverhead,
      feeBlocksMargin: 5,
    },
  };

  const stateFile = walletStateDisabled() ? null : resolveWalletStateFile(seed, midnight.networkId);

  let persisted: PersistedWalletV1 | null = null;
  if (stateFile) {
    try {
      const raw = await readFile(stateFile, "utf8");
      const p = JSON.parse(raw) as Partial<PersistedWalletV1>;
      if (
        p.v === 1 &&
        typeof p.shielded === "string" &&
        typeof p.dust === "string" &&
        typeof p.unshielded === "string"
      ) {
        persisted = p as PersistedWalletV1;
      }
    } catch {
      persisted = null;
    }
  }

  let shieldedWallet = ShieldedWallet(baseConfiguration).startWithSecretKeys(shieldedSecretKeys);
  let dustWallet = DustWallet(dustBase).startWithSecretKey(dustSecretKey, dustParams);
  let unshieldedWallet = UnshieldedWallet(unshieldedConfiguration).startWithPublicKey(
    UnshieldedPublicKey.fromKeyStore(unshieldedKeystore),
  );

  if (persisted) {
    try {
      shieldedWallet = ShieldedWallet(baseConfiguration).restore(persisted.shielded);
      dustWallet = DustWallet(dustBase).restore(persisted.dust);
      unshieldedWallet = UnshieldedWallet(unshieldedConfiguration).restore(persisted.unshielded);
      console.log(
        "[midnight wallet] Restored sync state from",
        path.relative(process.cwd(), stateFile!),
        "(saved",
        persisted.savedAt,
        ")",
      );
      console.log(
        "[midnight wallet] Still connecting to indexer/RPC and applying blocks since that snapshot — wait for Synced.",
      );
    } catch (e) {
      console.warn(
        "[midnight wallet] Cache unreadable or incompatible; performing full chain sync:",
        e instanceof Error ? e.message : e,
      );
      shieldedWallet = ShieldedWallet(baseConfiguration).startWithSecretKeys(shieldedSecretKeys);
      dustWallet = DustWallet(dustBase).startWithSecretKey(dustSecretKey, dustParams);
      unshieldedWallet = UnshieldedWallet(unshieldedConfiguration).startWithPublicKey(
        UnshieldedPublicKey.fromKeyStore(unshieldedKeystore),
      );
    }
  }

  const relayURL = relayWsUrlFromHttpOrigin(midnight.relayHttpOrigin);
  const provingServerUrl = new URL(midnight.proofServer);

  const facade: WalletFacade = await WalletFacade.init({
    configuration: {
      ...baseConfiguration,
      relayURL,
      provingServerUrl,
      txHistoryStorage: new InMemoryTransactionHistoryStorage(),
    },
    shielded: async () => shieldedWallet,
    unshielded: async () => unshieldedWallet,
    dust: async () => dustWallet,
  });
  await facade.start(shieldedSecretKeys, dustSecretKey);

  const midnightWalletCache =
    stateFile !== null
      ? {
          file: stateFile,
          shielded: shieldedWallet,
          dust: dustWallet,
          unshielded: unshieldedWallet,
        }
      : undefined;

  return {
    wallet: facade,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    midnightWalletCache,
  };
}
