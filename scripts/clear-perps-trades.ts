/**
 * Backs up `.perps-order-index.json` and `.perps-resting-book.json` if present, then clears
 * **both** the local trade index and the off-chain resting order book.
 *
 * Usage: `npm run clear:perps-trades` from repo root (`charlie3_hack/`).
 */
import { copyFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { clearTradeIndex, indexPath } from "../perps-web/server/orderIndex.js";
import { clearRestingBook, restingBookPath } from "../perps-web/server/restingBook.js";

async function exists(p: string): Promise<boolean> {
  try {
    await readFile(p);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const idx = indexPath();
  const rest = restingBookPath();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = join(process.cwd(), ".perps-backups", stamp);
  await mkdir(dir, { recursive: true });

  if (await exists(idx)) {
    const dest = join(dir, ".perps-order-index.json");
    await copyFile(idx, dest);
    console.log("Backed up:", idx, "→", dest);
  } else {
    console.log("No existing trade index at", idx);
  }

  if (await exists(rest)) {
    const dest = join(dir, ".perps-resting-book.json");
    await copyFile(rest, dest);
    console.log("Backed up:", rest, "→", dest);
  }

  await clearTradeIndex();
  await clearRestingBook();
  console.log("Cleared trade index and resting order book. Backup dir:", dir);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
