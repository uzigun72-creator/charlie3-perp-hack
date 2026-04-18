/// <reference types="vite/client" />

interface Window {
  cardano?: Record<string, { enable: () => Promise<unknown> }>;
}

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_BIP39_MNEMONIC?: string;
  readonly VITE_BLOCKFROST_PROJECT_ID?: string;
  readonly VITE_BLOCKFROST_URL?: string;
  /** When `"1"`, Trade tab can send `X-Cardano-Payer: user` (requires API `ALLOW_USER_PAYS_CARDANO_L1=1`). */
  readonly VITE_USER_PAYS_CARDANO?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
