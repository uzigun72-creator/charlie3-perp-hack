/**
 * Fail fast when `MIDNIGHT_PROOF_SERVER` points at localhost but nothing is listening
 * (typical: forgot `npm run proof-server`). Non-local URLs are not probed.
 */
import net from "node:net";

function isLocalHost(hostname: string): boolean {
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1";
}

export async function ensureProofServerPortReachable(proofServerUrl: string): Promise<void> {
  if (process.env.MIDNIGHT_SKIP_PROOF_PREFLIGHT === "1") return;

  let u: URL;
  try {
    u = new URL(proofServerUrl);
  } catch {
    return;
  }

  if (!isLocalHost(u.hostname)) return;

  const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
  if (!Number.isFinite(port) || port <= 0) return;

  const host =
    u.hostname === "localhost" ? "127.0.0.1" : u.hostname === "::1" ? "127.0.0.1" : u.hostname;

  await new Promise<void>((resolve, reject) => {
    const socket = net.connect({ port, host }, () => {
      socket.end();
      resolve();
    });
    socket.setTimeout(5000);
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("connection timeout"));
    });
    socket.on("error", reject);
  }).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Proof server not reachable at ${proofServerUrl} (${msg}).\n` +
        `  • Start local prover: from repo root run  npm run proof-server  (Docker :6300, image midnightntwrk/proof-server:8.0.3)\n` +
        `  • Then: export MIDNIGHT_PROOF_SERVER=http://127.0.0.1:6300\n` +
        `  • Or use Midnight hosted prover:  export MIDNIGHT_PROOF_SERVER=https://lace-proof-pub.preview.midnight.network  (Preview)\n` +
        `  • Skip this check: MIDNIGHT_SKIP_PROOF_PREFLIGHT=1`,
    );
  });
}

export function printProvingFailureHints(err: unknown): void {
  const s = String(err);
  if (!/prove|Proving|proof server/i.test(s)) return;
  console.error(`
If proving failed:
  1) Local Docker prover —  npm run proof-server  then  MIDNIGHT_PROOF_SERVER=http://127.0.0.1:6300
  2) Hosted Preview —  export MIDNIGHT_PROOF_SERVER=https://lace-proof-pub.preview.midnight.network  (or preprod lace URL)
  3) Match proof-server to ledger — use image  midnightntwrk/proof-server:8.0.3  (see package.json "proof-server" script)
  4) Increase timeout — some proofs need minutes; avoid killing the process early
`);
}
