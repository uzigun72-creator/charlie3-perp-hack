/**
 * Wait until {@link WalletFacade} reports synced, with periodic console hints (Preview can take minutes).
 */
import type { WalletFacade } from "@midnight-ntwrk/wallet-sdk-facade";

const HEARTBEAT_MS = 30_000;

export async function waitForWalletSyncedWithHeartbeat(wallet: WalletFacade): Promise<void> {
  console.log("Waiting for wallet sync…");
  let done = false;
  const iv = setInterval(() => {
    if (done) return;
    console.log(
      "[midnight wallet] Still syncing (normal on first run or after cache restore). " +
        "If this never completes: check WebSockets to indexer + rpc.preview.midnight.network, " +
        "or retry with MIDNIGHT_WALLET_STATE_DISABLE=1 / remove .midnight-wallet-state/<network>/.",
    );
  }, HEARTBEAT_MS);

  try {
    await wallet.waitForSyncedState();
  } finally {
    done = true;
    clearInterval(iv);
  }
  console.log("Synced.");
}
