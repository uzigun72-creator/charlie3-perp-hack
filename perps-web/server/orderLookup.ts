import { listEntries } from "./orderIndex.js";
import { listRestingOrders } from "./restingBook.js";

export type OrderLookupEntry =
  | {
      kind: "resting";
      side: "LONG" | "SHORT";
      price: string;
      size: string;
      createdAt: string;
    }
  | {
      kind: "trade";
      status: "pending" | "pending_user_l1" | "confirmed";
      error?: string;
      createdAt: string;
      confirmedAt?: string;
    }
  | { kind: "not_found" };

/** Resolve UUIDs against the resting book and the local trade index (resting id or trade pipeline id). */
export async function lookupOrderIds(ids: string[]): Promise<Record<string, OrderLookupEntry>> {
  const unique = [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))];
  const open = await listRestingOrders();
  const entries = await listEntries();
  const out: Record<string, OrderLookupEntry> = {};

  for (const id of unique) {
    const ro = open.find((o) => o.id === id);
    if (ro) {
      out[id] = {
        kind: "resting",
        side: ro.side,
        price: ro.price,
        size: ro.size,
        createdAt: ro.createdAt,
      };
      continue;
    }
    const en = entries.find((e) => e.id === id);
    if (en) {
      out[id] = {
        kind: "trade",
        status: en.status,
        error: en.error,
        createdAt: en.createdAt,
        confirmedAt: en.confirmedAt,
      };
      continue;
    }
    out[id] = { kind: "not_found" };
  }

  return out;
}
