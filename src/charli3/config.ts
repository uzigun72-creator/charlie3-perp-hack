/**
 * Preprod ODV feeds — aligned with Charli3 hackathon-resources / datum-demo preprod networks.
 * @see https://github.com/Charli3-Official/hackathon-resources/tree/main/configs
 */
export interface Charli3FeedConfig {
  pairId: string;
  oracleAddress: string;
  policyId: string;
  /** C3AS NFT asset name hex (ASCII "C3AS") */
  aggregateNftNameHex: string;
}

const C3AS_HEX = Buffer.from("C3AS", "utf8").toString("hex");

/** Per datum-demo `preprod-c3-networks.yaml` — same script address, distinct minting policies per pair. */
const FEEDS: Charli3FeedConfig[] = [
  {
    pairId: "ADA-USD",
    oracleAddress: "addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu",
    policyId: "886dcb2363e160c944e63cf544ce6f6265b22ef7c4e2478dd975078e",
    aggregateNftNameHex: C3AS_HEX,
  },
  {
    pairId: "BTC-USD",
    oracleAddress: "addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu",
    policyId: "43d766bafc64c96754353e9686fac6130990a4f8568b3a2f76e2643f",
    aggregateNftNameHex: C3AS_HEX,
  },
  {
    pairId: "USDM-ADA",
    oracleAddress: "addr_test1wq3pacs7jcrlwehpuy3ryj8kwvsqzjp9z6dpmx8txnr0vkq6vqeuu",
    policyId: "fcc738fa9ae006bc8de82385ff3457a2817ccc4eaa5ce53a61334674",
    aggregateNftNameHex: C3AS_HEX,
  },
];

export function charli3KupoUrl(): string {
  const u = process.env.CHARLI3_KUPO_URL?.trim();
  return u && u.length > 0 ? u : "http://35.209.192.203:1442";
}

export function charli3MaxStalenessMs(): number {
  const raw = process.env.CHARLI3_MAX_STALENESS_MS;
  if (raw && /^\d+$/.test(raw)) return Number(raw);
  /** Preprod feeds can lag; staleness is vs aggregate `timestampMs`, not datum `expiry`. */
  return 86_400_000;
}

/** If false (set `CHARLI3_IGNORE_DATUM_EXPIRY=0`), require `Date.now() <= expiryMs` from on-chain datum. */
export function charli3IgnoreDatumExpiry(): boolean {
  return process.env.CHARLI3_IGNORE_DATUM_EXPIRY !== "0";
}

export function feedConfigForPair(pairId: string): Charli3FeedConfig {
  const f = FEEDS.find((x) => x.pairId === pairId);
  if (!f) {
    throw new Error(
      `Unknown Charli3 pairId "${pairId}". Known: ${FEEDS.map((x) => x.pairId).join(", ")}`,
    );
  }
  return f;
}

export function listFeedPairIds(): string[] {
  return FEEDS.map((f) => f.pairId);
}

/** Kupo encodes native assets as `policyId.assetNameHex` (with a dot). */
export function c3asAssetKey(policyId: string, aggregateNameHex: string): string {
  return `${policyId}.${aggregateNameHex}`;
}
