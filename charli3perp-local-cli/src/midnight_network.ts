/**
 * Midnight layer targets: local Brick Towers stack vs public **Preview** / **Preprod**.
 *
 * Preprod RPC / indexer / proof server URLs match the official matrix:
 * https://docs.midnight.network/relnotes/overview
 *
 * Deploy guide (setNetworkId, indexer v3, relay wss):
 * https://docs.midnight.network/guides/deploy-mn-app
 *
 * **Blockfrost Preview indexer** (often lower latency): set `MIDNIGHT_BLOCKFROST_PROJECT_ID` so HTTP/WSS
 * get `?project_id=…` on `https://midnight-preview.blockfrost.io/api/v0` and `…/api/v0/ws` (see
 * https://docs.blockfrost.io/midnight ). Overrides default Midnight indexer unless `MIDNIGHT_INDEXER_HTTP`
 * / `MIDNIGHT_INDEXER_WS` are set explicitly.
 */

export type MidnightDeployNetwork = "undeployed" | "preview" | "preprod";

export type MidnightNetworkEndpoints = {
  networkId: MidnightDeployNetwork;
  indexerHttp: string;
  indexerWs: string;
  /** e.g. https://rpc.preprod.midnight.network → relay uses wss:// */
  relayHttpOrigin: string;
  proofServer: string;
  dustAdditionalFeeOverhead: bigint;
  shieldedAdditionalFeeOverhead: bigint;
};

export function resolveMidnightDeployNetwork(): MidnightDeployNetwork {
  const v = (process.env.MIDNIGHT_DEPLOY_NETWORK || "undeployed").toLowerCase().trim();
  if (v === "preprod") return "preprod";
  if (v === "preview") return "preview";
  if (v === "undeployed" || v === "local") return "undeployed";
  throw new Error(
    `MIDNIGHT_DEPLOY_NETWORK must be 'undeployed', 'preview', or 'preprod' (got: ${v})`,
  );
}

/** Blockfrost Midnight Preview: GraphQL over HTTPS + subscriptions WebSocket; `project_id` in query string for SDKs without custom headers. */
function blockfrostPreviewIndexerUrls(projectId: string): { indexerHttp: string; indexerWs: string } {
  const q = `?project_id=${encodeURIComponent(projectId.trim())}`;
  return {
    indexerHttp: `https://midnight-preview.blockfrost.io/api/v0${q}`,
    indexerWs: `wss://midnight-preview.blockfrost.io/api/v0/ws${q}`,
  };
}

export function getMidnightEndpoints(net: MidnightDeployNetwork): MidnightNetworkEndpoints {
  const proofPort = Number.parseInt(process.env.PROOF_SERVER_PORT ?? "6300", 10);
  /** Default: local Docker `npm run proof-server` (midnightntwrk/proof-server:8.0.3). Override with MIDNIGHT_PROOF_SERVER or hosted Lace URL. */
  const defaultLocalProofServer = `http://127.0.0.1:${proofPort}`;

  if (net === "undeployed") {
    const indexerPort = Number.parseInt(process.env.INDEXER_PORT ?? "8088", 10);
    const nodePort = Number.parseInt(process.env.NODE_PORT ?? "9944", 10);
    // Local `yarn fund` DUST balances are far smaller than public testnets; use the same
    // scale as Preview/Preprod here (see preview `overhead` below), not 1e3 larger.
    const overhead = 300_000_000_000_000n;
    return {
      networkId: "undeployed",
      indexerHttp: `http://127.0.0.1:${indexerPort}/api/v4/graphql`,
      indexerWs: `ws://127.0.0.1:${indexerPort}/api/v4/graphql/ws`,
      relayHttpOrigin: `http://127.0.0.1:${nodePort}`,
      proofServer: process.env.MIDNIGHT_PROOF_SERVER || defaultLocalProofServer,
      dustAdditionalFeeOverhead: overhead,
      shieldedAdditionalFeeOverhead: overhead,
    };
  }

  const overhead = 300_000_000_000_000n;
  if (net === "preview") {
    const explicitHttp = process.env.MIDNIGHT_INDEXER_HTTP?.trim();
    const explicitWs = process.env.MIDNIGHT_INDEXER_WS?.trim();
    const bfPid = process.env.MIDNIGHT_BLOCKFROST_PROJECT_ID?.trim();
    const useBlockfrost =
      Boolean(bfPid) && !explicitHttp && !explicitWs;
    const bf = useBlockfrost && bfPid ? blockfrostPreviewIndexerUrls(bfPid) : null;
    return {
      networkId: "preview",
      indexerHttp:
        explicitHttp ||
        bf?.indexerHttp ||
        "https://indexer.preview.midnight.network/api/v3/graphql",
      indexerWs:
        explicitWs ||
        bf?.indexerWs ||
        "wss://indexer.preview.midnight.network/api/v3/graphql/ws",
      relayHttpOrigin:
        process.env.MIDNIGHT_NODE_RPC?.trim() ||
        (useBlockfrost && bfPid
          ? `https://rpc.midnight-preview.blockfrost.io?project_id=${encodeURIComponent(bfPid)}`
          : "https://rpc.preview.midnight.network"),
      proofServer: process.env.MIDNIGHT_PROOF_SERVER || defaultLocalProofServer,
      dustAdditionalFeeOverhead: overhead,
      shieldedAdditionalFeeOverhead: overhead,
    };
  }

  return {
    networkId: "preprod",
    indexerHttp: process.env.MIDNIGHT_INDEXER_HTTP ||
      "https://indexer.preprod.midnight.network/api/v3/graphql",
    indexerWs: process.env.MIDNIGHT_INDEXER_WS ||
      "wss://indexer.preprod.midnight.network/api/v3/graphql/ws",
    relayHttpOrigin: process.env.MIDNIGHT_NODE_RPC ||
      "https://rpc.preprod.midnight.network",
    proofServer: process.env.MIDNIGHT_PROOF_SERVER || defaultLocalProofServer,
    dustAdditionalFeeOverhead: overhead,
    shieldedAdditionalFeeOverhead: overhead,
  };
}

/** Node relay WebSocket URL (WalletFacade). */
export function relayWsUrlFromHttpOrigin(relayHttpOrigin: string): URL {
  const u = relayHttpOrigin.replace(/^http/i, (m) =>
    m.toLowerCase() === "https" ? "wss" : "ws"
  );
  return new URL(u);
}
