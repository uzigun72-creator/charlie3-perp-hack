/**
 * From one BIP39 mnemonic, fund HD-derived "worker" wallets (default deriveKeysAt 1–5) from the
 * main identity (deriveKeysAt 0): **one** transfer tx (all unshielded + shielded legs in one recipe),
 * then DUST registration per worker.
 *
 * Receiver **addresses** are resolved from the mnemonic with HD + local shielded `getAddress` only (no indexer
 * sync). The **funder** still syncs before sending. After the tx, each worker wallet syncs for DUST + cache.
 *
 * Prereqs: `MIDNIGHT_DEPLOY_NETWORK=preview` (or `preprod`), **funder index 0** already has tNIGHT
 * (faucet). Proof server not required for funding-only.
 *
 * Env:
 * - `BIP39_MNEMONIC`
 * - `MIDNIGHT_FUNDER_INDEX` (default `0`) — must be funded
 * - `MIDNIGHT_FUND_DERIVE_INDICES` — comma-separated (default `1,2,3,4,5`)
 * - `MIDNIGHT_FUND_NIGHT_PER_RECIPIENT` — whole NIGHT per recipient per leg (default **20** when split is off or when split is on but you set this). Raw = value × 1e9. If unset **and** split is on, amount is computed from balance (see below).
 * - `MIDNIGHT_FUND_TRANSFER_AMOUNT` — if set, raw units per recipient per leg (overrides night + split)
 * - `MIDNIGHT_FUND_SPLIT_AVAILABLE` — `1` (default): when transfer is unset **and** `MIDNIGHT_FUND_NIGHT_PER_RECIPIENT` is unset, split funder balance. Set `0` to use fixed **20** NIGHT per leg (or set `MIDNIGHT_FUND_NIGHT_PER_RECIPIENT`).
 * - `MIDNIGHT_FUND_FEE_RESERVE_RAW` — raw units left on funder when splitting (default `50000000` ≈ 0.05 NIGHT) for fees.
 * - `MIDNIGHT_FUND_LEGS` — `unshielded` (default), `both`, or `shielded`. Preview faucet mostly funds **unshielded** tNIGHT.
 * - `MIDNIGHT_SYNC_TIMEOUT_MS` — abort if indexer sync hangs (e.g. `900000` = 15 min)
 * - `MIDNIGHT_WALLET_STATE_DISABLE=1` — skip disk cache if sync never completes (bad snapshot / stall)
 */
import "./load_repo_env.js";
import { Buffer } from "buffer";
import * as bip39 from "bip39";
import * as ledger from "@midnight-ntwrk/ledger-v8";
import * as rx from "rxjs";
import type { CombinedTokenTransfer, TokenTransfer, WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { ShieldedAddress, UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";
import { Charli3perpMidnightConfig } from "./config.js";
import {
  deriveMidnightReceiveAddressesFromSeed,
  initWalletWithSeed,
  persistMidnightWalletState,
  type WalletContext,
} from "./wallet.js";
import { ensureDustReady } from "./dust.js";
import { waitForWalletSyncedWithHeartbeat } from "./wait_wallet_sync.js";

/** Midnight NIGHT: 1e9 raw = 1 NIGHT (matches typical faucet / wallet balance display). */
const NIGHT_RAW_SCALE = 1_000_000_000n;
/** Fixed per-leg amount when not using balance split (`MIDNIGHT_FUND_NIGHT_PER_RECIPIENT` unset). */
const DEFAULT_NIGHT_PER_RECIPIENT = 20n;

function splitAvailableFromEnv(): boolean {
  const v = process.env.MIDNIGHT_FUND_SPLIT_AVAILABLE?.trim().toLowerCase();
  if (v === "0" || v === "false" || v === "no" || v === "off") return false;
  return true;
}

/** Fixed amount from env, or `null` = resolve after sync (split balance). */
function resolveFixedTransferAmountPerLegFromEnv(): bigint | null {
  const rawOverride = process.env.MIDNIGHT_FUND_TRANSFER_AMOUNT?.trim();
  if (rawOverride) {
    try {
      return BigInt(rawOverride);
    } catch {
      console.error("MIDNIGHT_FUND_TRANSFER_AMOUNT must be an integer raw amount (bigint string).");
      process.exit(2);
    }
  }
  const nightExplicit = process.env.MIDNIGHT_FUND_NIGHT_PER_RECIPIENT?.trim();
  if (splitAvailableFromEnv() && !nightExplicit) {
    return null;
  }
  const night = nightExplicit ?? String(DEFAULT_NIGHT_PER_RECIPIENT);
  if (!/^\d+$/.test(night)) {
    console.error(
      "MIDNIGHT_FUND_NIGHT_PER_RECIPIENT must be a non-negative integer string (whole NIGHT), e.g. 20",
    );
    process.exit(2);
  }
  return BigInt(night) * NIGHT_RAW_SCALE;
}

function feeReserveRaw(): bigint {
  const raw = process.env.MIDNIGHT_FUND_FEE_RESERVE_RAW?.trim() || "50000000";
  try {
    return BigInt(raw);
  } catch {
    console.error("MIDNIGHT_FUND_FEE_RESERVE_RAW must be an integer raw amount.");
    process.exit(2);
  }
}

/** Per output when splitting: `(pool − reserve) / recipients` (integer division); `both` uses min of pools. */
async function computeSplitAmountPerLeg(
  wallet: WalletFacade,
  recipients: number,
  legs: FundLegsMode,
): Promise<bigint> {
  const st = await rx.firstValueFrom(wallet.state().pipe(rx.filter((s) => s.isSynced), rx.take(1)));
  const reserve = feeReserveRaw();
  const rawU = ledger.unshieldedToken().raw;
  const rawS = ledger.shieldedToken().raw;
  const un = st.unshielded.balances[rawU] ?? 0n;
  const sh = st.shielded.balances[rawS] ?? 0n;
  const n = BigInt(recipients);
  const perUn = un > reserve ? (un - reserve) / n : 0n;
  const perSh = sh > reserve ? (sh - reserve) / n : 0n;
  let amt: bigint;
  if (legs === "unshielded") {
    amt = perUn;
  } else if (legs === "shielded") {
    amt = perSh;
  } else {
    amt = perUn < perSh ? perUn : perSh;
  }
  if (amt <= 0n) {
    console.error(
      `[midnight-fund-derived] split: not enough balance after reserve ${reserve} (unshielded=${un} shielded=${sh}, ${recipients} recipients, legs=${legs}). Top up or set MIDNIGHT_FUND_NIGHT_PER_RECIPIENT / MIDNIGHT_FUND_TRANSFER_AMOUNT.`,
    );
    process.exit(3);
  }
  console.log(
    `[midnight-fund-derived] split available → ${amt} raw per recipient per leg (${nightHumanLabel(amt)}); reserve=${reserve} raw`,
  );
  return amt;
}

function nightHumanLabel(raw: bigint): string {
  const whole = raw / NIGHT_RAW_SCALE;
  const frac = raw % NIGHT_RAW_SCALE;
  if (frac === 0n) return `${whole} NIGHT`;
  const fracStr = frac.toString().padStart(9, "0").replace(/0+$/, "");
  return `${whole}.${fracStr} NIGHT`;
}

type FundLegsMode = "both" | "unshielded" | "shielded";

function parseFundLegsMode(): FundLegsMode {
  const v = (process.env.MIDNIGHT_FUND_LEGS ?? "unshielded").trim().toLowerCase();
  if (v === "unshielded" || v === "u" || v === "tnight") return "unshielded";
  if (v === "shielded" || v === "s") return "shielded";
  return "both";
}

/** Log raw NIGHT balances and whether they cover `recipients × amount` per leg (fees extra). */
async function logFunderNightBalancesAndPreflight(
  wallet: WalletFacade,
  recipients: number,
  transferAmount: bigint,
  legs: FundLegsMode,
): Promise<void> {
  const st = await rx.firstValueFrom(wallet.state().pipe(rx.filter((s) => s.isSynced), rx.take(1)));
  const rawU = ledger.unshieldedToken().raw;
  const rawS = ledger.shieldedToken().raw;
  const un = st.unshielded.balances[rawU] ?? 0n;
  const sh = st.shielded.balances[rawS] ?? 0n;
  const n = BigInt(recipients);
  const need = n * transferAmount;
  console.log(
    `[midnight-fund-derived] funder NIGHT: unshielded=${un} (${nightHumanLabel(un)}) | shielded=${sh} (${nightHumanLabel(
      sh,
    )}) | need ${need} raw per active leg kind (${nightHumanLabel(need)}) = ${recipients}×${transferAmount} + fees | legs=${legs}`,
  );
  const needU = legs === "shielded" ? 0n : need;
  const needS = legs === "unshielded" ? 0n : need;
  if (needU > 0n && un < needU) {
    console.error(
      `[midnight-fund-derived] unshielded ${un} < ${needU} required — top up tNIGHT (faucet), or lower MIDNIGHT_FUND_NIGHT_PER_RECIPIENT / MIDNIGHT_FUND_TRANSFER_AMOUNT / fewer indices.`,
    );
    process.exit(3);
  }
  if (needS > 0n && sh < needS) {
    console.error(
      `[midnight-fund-derived] shielded ${sh} < ${needS} required for shielded legs. Preview faucet is mostly unshielded — run with MIDNIGHT_FUND_LEGS=unshielded or acquire shielded NIGHT first.`,
    );
    process.exit(3);
  }
}

function mnemonicFromEnv(): string {
  const m = process.env.BIP39_MNEMONIC?.trim();
  if (!m || !bip39.validateMnemonic(m)) {
    console.error("Set valid BIP39_MNEMONIC for the same seed used in production.");
    process.exit(2);
  }
  return m;
}

function parseIndices(): number[] {
  const raw = process.env.MIDNIGHT_FUND_DERIVE_INDICES?.trim() || "1,2,3,4,5";
  const parts = raw.split(",").map((s) => Number.parseInt(s.trim(), 10));
  const out = parts.filter((n) => Number.isFinite(n) && n > 0);
  if (out.length === 0) {
    console.error("MIDNIGHT_FUND_DERIVE_INDICES must list positive integers (e.g. 1,2,3,4,5)");
    process.exit(2);
  }
  return out;
}

async function transferFromFunder(
  sender: WalletContext,
  outputs: CombinedTokenTransfer[],
): Promise<string> {
  const recipe = await sender.wallet.transferTransaction(
    outputs,
    {
      shieldedSecretKeys: sender.shieldedSecretKeys,
      dustSecretKey: sender.dustSecretKey,
    },
    {
      ttl: new Date(Date.now() + 30 * 60 * 1000),
      payFees: true,
    },
  );
  const signedTx = await sender.wallet.signUnprovenTransaction(recipe.transaction, (payload) =>
    sender.unshieldedKeystore.signData(payload),
  );
  const finalizedTx = await sender.wallet.finalizeTransaction(signedTx);
  return sender.wallet.submitTransaction(finalizedTx);
}

async function main(): Promise<void> {
  const config = new Charli3perpMidnightConfig();
  if (config.deployNetwork === "undeployed") {
    console.warn(
      "[midnight-fund-derived] For undeployed use fund-local-undeployed.ts (genesis). This script targets Preview/Preprod.",
    );
  }

  const mnemonic = mnemonicFromEnv();
  const seed = Buffer.from(await bip39.mnemonicToSeed(mnemonic));
  const funderIndex = Math.max(
    0,
    Number.parseInt(process.env.MIDNIGHT_FUNDER_INDEX ?? "0", 10) || 0,
  );
  const indices = parseIndices();
  const fundLegs = parseFundLegsMode();
  const fixedAmountPerLeg = resolveFixedTransferAmountPerLegFromEnv();

  console.log("[midnight-fund-derived] starting funder wallet…");
  const funder = await initWalletWithSeed(seed, config, { deriveKeyIndex: funderIndex });
  await waitForWalletSyncedWithHeartbeat(funder.wallet);
  console.log("[midnight-fund-derived] funder synced.");

  const transferAmount =
    fixedAmountPerLeg !== null ? fixedAmountPerLeg : await computeSplitAmountPerLeg(funder.wallet, indices.length, fundLegs);

  console.log(
    `[midnight-fund-derived] network=${config.networkId} funder deriveKeysAt(${funderIndex}) → indices ${indices.join(
      ",",
    )} amount=${transferAmount} raw (${nightHumanLabel(transferAmount)}) per recipient per leg legs=${fundLegs} (single tx)`,
  );

  const net = config.networkId;

  console.log("[midnight-fund-derived] deriving worker addresses from seed (no receiver sync)…");
  const unshieldedLegs: TokenTransfer<UnshieldedAddress>[] = [];
  const shieldedLegs: TokenTransfer<ShieldedAddress>[] = [];
  const addressRows: { deriveKeysAt: number; unshielded: string; shielded: string }[] = [];

  for (const idx of indices) {
    const derived = await deriveMidnightReceiveAddressesFromSeed(seed, config, idx);
    addressRows.push({ deriveKeysAt: idx, unshielded: derived.unshieldedStr, shielded: derived.shieldedStr });
    unshieldedLegs.push({
      amount: transferAmount,
      receiverAddress: derived.unshieldedDecoded,
      type: ledger.unshieldedToken().raw,
    });
    shieldedLegs.push({
      amount: transferAmount,
      receiverAddress: derived.shieldedDecoded,
      type: ledger.shieldedToken().raw,
    });
  }

  console.log("[midnight-fund-derived] Worker addresses:");
  for (const row of addressRows) {
    console.log(
      `  deriveKeysAt(${row.deriveKeysAt}) unshielded=${row.unshielded} shielded=${row.shielded}`,
    );
  }
  console.log("[midnight-fund-derived] addresses (JSON):", JSON.stringify({ networkId: net, workers: addressRows }));

  await logFunderNightBalancesAndPreflight(funder.wallet, indices.length, transferAmount, fundLegs);

  const outputs: CombinedTokenTransfer[] = [];
  if (fundLegs === "both" || fundLegs === "unshielded") {
    outputs.push({ type: "unshielded", outputs: unshieldedLegs });
  }
  if (fundLegs === "both" || fundLegs === "shielded") {
    outputs.push({ type: "shielded", outputs: shieldedLegs });
  }

  let txHash: string;
  try {
    txHash = await transferFromFunder(funder, outputs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("InsufficientFunds") || msg.includes("Insufficient funds")) {
      console.error(
        "[midnight-fund-derived] Transfer failed (insufficient funds). Raise MIDNIGHT_FUND_FEE_RESERVE_RAW slightly, " +
          "or set a fixed MIDNIGHT_FUND_TRANSFER_AMOUNT lower than split; ensure MIDNIGHT_FUND_LEGS=unshielded if shielded is empty.",
      );
    }
    throw e;
  }
  console.log(`[midnight-fund-derived] single funding tx submitted: ${txHash}`);

  for (const idx of indices) {
    console.log(`\n[midnight-fund-derived] --- worker deriveKeysAt(${idx}) post-fund ---`);
    const ctx = await initWalletWithSeed(seed, config, { deriveKeyIndex: idx });
    await waitForWalletSyncedWithHeartbeat(ctx.wallet);
    await rx.firstValueFrom(
      ctx.wallet.state().pipe(rx.filter((s) => s.unshielded.availableCoins.length > 0), rx.take(1)),
    );
    console.log("[midnight-fund-derived] receiver sees unshielded UTXOs; registering DUST…");
    await ensureDustReady(ctx, { timeoutMs: 300_000 });
    await persistMidnightWalletState(ctx);
    await ctx.wallet.stop();
    console.log(`[midnight-fund-derived] worker ${idx} done.`);
  }

  await persistMidnightWalletState(funder);
  await funder.wallet.stop();
  console.log("\n[midnight-fund-derived] All workers funded + DUST. Done.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
