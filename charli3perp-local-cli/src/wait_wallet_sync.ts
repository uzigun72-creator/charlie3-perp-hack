/**
 * Wait until {@link WalletFacade} reports synced, with periodic console hints (Preview can take minutes).
 *
 * Env:
 * - `MIDNIGHT_SYNC_TIMEOUT_MS` — if set (e.g. `900000` = 15 min), abort with an error instead of hanging forever.
 *   After timeout, retry with `MIDNIGHT_WALLET_STATE_DISABLE=1` or delete `.midnight-wallet-state/<network>/`.
 */
import type { FacadeState, WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";
import { Subscription } from "rxjs";

const HEARTBEAT_MS = 30_000;

function parseSyncTimeoutMs(): number | undefined {
  const raw = process.env.MIDNIGHT_SYNC_TIMEOUT_MS?.trim();
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function bi(n: bigint): string {
  return n.toString();
}

/** One-line sync progress from indexer-driven wallet layers (shielded / unshielded / dust). */
export function formatFacadeSyncProgress(s: FacadeState): string {
  const sh = s.shielded.progress;
  const un = s.unshielded.progress;
  const du = s.dust.progress;
  const shGap = sh.highestIndex > sh.appliedIndex ? bi(sh.highestIndex - sh.appliedIndex) : "0";
  const duGap = du.highestIndex > du.appliedIndex ? bi(du.highestIndex - du.appliedIndex) : "0";
  const unGap =
    un.highestTransactionId > un.appliedId ? bi(un.highestTransactionId - un.appliedId) : "0";
  return (
    `facade.isSynced=${s.isSynced} | ` +
    `shielded applied=${bi(sh.appliedIndex)} highest=${bi(sh.highestIndex)} gap=${shGap} connected=${sh.isConnected} | ` +
    `unshielded applied=${bi(un.appliedId)} highest=${bi(un.highestTransactionId)} gap=${unGap} connected=${un.isConnected} | ` +
    `dust applied=${bi(du.appliedIndex)} highest=${bi(du.highestIndex)} gap=${duGap} connected=${du.isConnected}`
  );
}

export async function waitForWalletSyncedWithHeartbeat(wallet: WalletFacade): Promise<void> {
  const timeoutMs = parseSyncTimeoutMs();
  console.log(
    "Waiting for wallet sync…" +
      (timeoutMs ? ` (MIDNIGHT_SYNC_TIMEOUT_MS=${timeoutMs})` : ""),
  );
  let done = false;
  let latest: FacadeState | undefined;
  let lastProgressLine = "";
  let unchangedHeartbeats = 0;
  const sub = new Subscription();
  sub.add(
    wallet.state().subscribe({
      next: (s) => {
        latest = s;
      },
    }),
  );

  const iv = setInterval(() => {
    if (done) return;
    if (latest) {
      const line = formatFacadeSyncProgress(latest);
      if (line === lastProgressLine) {
        unchangedHeartbeats += 1;
      } else {
        unchangedHeartbeats = 0;
        lastProgressLine = line;
      }
      const stall =
        unchangedHeartbeats >= 2
          ? " | STALL: no indexer progress ~60s+ — set MIDNIGHT_WALLET_STATE_DISABLE=1 or rm -rf .midnight-wallet-state/<network>/ then retry."
          : "";
      console.log(
        "[midnight wallet] Still syncing — " +
          line +
          stall +
          " | If `connected=false` or gap never shrinks: fix indexer WS/HTTP (Preview) or use a VPN.",
      );
    } else {
      console.log(
        "[midnight wallet] Still syncing (no FacadeState yet — connecting to indexer…). " +
          "If this never completes: check WebSockets to indexer + rpc.preview.midnight.network.",
      );
    }
  }, HEARTBEAT_MS);

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const syncPromise = wallet.waitForSyncedState();

  try {
    if (timeoutMs) {
      await Promise.race([
        syncPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            const snap = latest ? formatFacadeSyncProgress(latest) : "no FacadeState yet";
            reject(
              new Error(
                `[midnight wallet] Sync timed out after ${timeoutMs}ms (MIDNIGHT_SYNC_TIMEOUT_MS). Last: ${snap}. ` +
                  `Fix: export MIDNIGHT_WALLET_STATE_DISABLE=1 and retry (ignores disk cache), or delete ` +
                  `.midnight-wallet-state/<networkId>/ for this wallet, then rerun. Confirm indexer + WS reach Preview.`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
    } else {
      await syncPromise;
    }
  } finally {
    done = true;
    if (timeoutId !== undefined) clearTimeout(timeoutId);
    clearInterval(iv);
    sub.unsubscribe();
  }
  if (latest) {
    console.log("[midnight wallet] Synced. " + formatFacadeSyncProgress(latest));
  } else {
    console.log("Synced.");
  }
}
