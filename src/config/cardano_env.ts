export type CardanoBackend = "blockfrost" | "emulator";

export function cardanoBackend(): CardanoBackend {
  const raw = (process.env.CARDANO_BACKEND || "blockfrost").toLowerCase();
  if (raw === "emulator" || raw === "local") return "emulator";
  return "blockfrost";
}

export function blockfrostProjectId(): string {
  const id = process.env.BLOCKFROST_PROJECT_ID || process.env.BLOCKFROST_API_KEY;
  if (!id) {
    throw new Error(
      "Set BLOCKFROST_PROJECT_ID (or BLOCKFROST_API_KEY) when CARDANO_BACKEND=blockfrost",
    );
  }
  return id;
}

export function blockfrostConfig() {
  return {
    url:
      process.env.BLOCKFROST_URL ||
      "https://cardano-preprod.blockfrost.io/api/v0",
    projectId: blockfrostProjectId(),
    network: (process.env.CARDANO_NETWORK || "Preprod") as
      | "Preprod"
      | "Preview"
      | "Mainnet",
  };
}

export function walletMnemonic(): string {
  const m = process.env.WALLET_MNEMONIC?.trim();
  if (!m) throw new Error("Set WALLET_MNEMONIC (testnet wallet)");
  return m;
}

/** When true, matched trades lock `MARGIN_POOL_COLLATERAL_LOVELACE` via margin_vault → margin_pool before Midnight. */
export function cardanoCollateralViaMarginPool(): boolean {
  return process.env.CARDANO_COLLATERAL_VIA_MARGIN_POOL === "1";
}

/** Lovelace locked per trade when `CARDANO_COLLATERAL_VIA_MARGIN_POOL=1` (not derived from USD margin in v1). */
export function marginPoolCollateralLovelace(): bigint {
  const raw = process.env.MARGIN_POOL_COLLATERAL_LOVELACE?.trim();
  if (!raw) return 2_000_000n;
  return BigInt(raw);
}

/** When `1`, `POST /api/trade/submit` may use `X-Cardano-Payer: user` for client-signed Charli3 + anchor (after Midnight). */
export function allowUserPaysCardanoL1(): boolean {
  return process.env.ALLOW_USER_PAYS_CARDANO_L1 === "1";
}
