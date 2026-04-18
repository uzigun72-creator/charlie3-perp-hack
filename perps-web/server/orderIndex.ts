import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { OrderCommitmentInput } from "../../src/order/commitment.js";
import { orderCommitmentHex } from "../../src/order/commitment.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export type OrderIndexEntry = {
  id: string;
  /** `pending_user_l1` = Midnight done; waiting for browser-signed Charli3 + anchor. */
  status: "pending" | "pending_user_l1" | "confirmed";
  bid: OrderCommitmentInput;
  ask: OrderCommitmentInput;
  bidCommitmentHex: string;
  askCommitmentHex: string;
  /** Charli3 oracle index price (USD) captured when the pipeline completed (for P&L / basis). */
  oracleIndexPrice?: number;
  charli3PullTxHash?: string;
  settlementAnchorTxHash?: string;
  midnightBindTxHash?: string;
  /** `charli3perp-matching` — `sealMatchRecord` tx when using full Midnight pipeline. */
  midnightMatchingSealTxHash?: string;
  pipelineLogTail?: string;
  error?: string;
  createdAt: string;
  confirmedAt?: string;
};

type StoreFile = {
  version: 1;
  entries: OrderIndexEntry[];
};

function repoRoot(): string {
  return join(__dirname, "../..");
}

export function indexPath(): string {
  return join(repoRoot(), ".perps-order-index.json");
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await readFile(indexPath(), "utf8");
    const p = JSON.parse(raw) as StoreFile;
    if (p.version !== 1 || !Array.isArray(p.entries)) return { version: 1, entries: [] };
    return p;
  } catch {
    return { version: 1, entries: [] };
  }
}

async function writeStore(s: StoreFile): Promise<void> {
  await writeFile(indexPath(), JSON.stringify(s, null, 2), "utf8");
}

export async function appendPending(entry: Omit<OrderIndexEntry, "confirmedAt">): Promise<void> {
  const s = await readStore();
  s.entries.unshift(entry);
  await writeStore(s);
}

export async function updateEntry(id: string, patch: Partial<OrderIndexEntry>): Promise<void> {
  const s = await readStore();
  const i = s.entries.findIndex((e) => e.id === id);
  if (i >= 0) {
    s.entries[i] = { ...s.entries[i], ...patch };
    await writeStore(s);
  }
}

export async function listEntries(): Promise<OrderIndexEntry[]> {
  const s = await readStore();
  return s.entries;
}

/** Wipes the local confirmed/pending trade history (`.perps-order-index.json`). */
export async function clearTradeIndex(): Promise<void> {
  await writeStore({ version: 1, entries: [] });
}

export function commitmentHexes(bid: OrderCommitmentInput, ask: OrderCommitmentInput): {
  bidCommitmentHex: string;
  askCommitmentHex: string;
} {
  return {
    bidCommitmentHex: orderCommitmentHex(bid),
    askCommitmentHex: orderCommitmentHex(ask),
  };
}
