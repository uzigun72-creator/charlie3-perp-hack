import path from "node:path";
import { fileURLToPath } from "node:url";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  getMidnightEndpoints,
  resolveMidnightDeployNetwork,
  type MidnightDeployNetwork,
} from "./midnight_network.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Midnight endpoints + artifacts paths for `charli3perp-order` CLI.
 *
 * - **undeployed** — [midnight-local-network](https://github.com/bricktowers/midnight-local-network) (indexer v4 paths on localhost).
 * - **preview** / **preprod** — public Midnight (indexer **v3**); fund via https://faucet.preview.midnight.network/ or https://faucet.preprod.midnight.network/
 */
export class Charli3perpMidnightConfig {
  readonly deployNetwork: MidnightDeployNetwork;
  readonly indexer: string;
  readonly indexerWS: string;
  readonly proofServer: string;
  readonly networkId: MidnightDeployNetwork;
  readonly relayHttpOrigin: string;
  readonly dustAdditionalFeeOverhead: bigint;
  readonly shieldedAdditionalFeeOverhead: bigint;

  readonly charli3perpOrderArtifactsDir =
    process.env.MIDNIGHT_C3PERP_ORDER_ARTIFACTS_DIR ??
    path.resolve(__dirname, "../../contract/src/managed/charli3perp-order");

  readonly charli3perpMatchingArtifactsDir =
    process.env.MIDNIGHT_C3PERP_MATCHING_ARTIFACTS_DIR ??
    path.resolve(__dirname, "../../contract/src/managed/charli3perp-matching");

  readonly charli3perpSettlementArtifactsDir =
    process.env.MIDNIGHT_C3PERP_SETTLEMENT_ARTIFACTS_DIR ??
    path.resolve(__dirname, "../../contract/src/managed/charli3perp-settlement");

  readonly charli3perpLiquidationArtifactsDir =
    process.env.MIDNIGHT_C3PERP_LIQUIDATION_ARTIFACTS_DIR ??
    path.resolve(__dirname, "../../contract/src/managed/charli3perp-liquidation");

  readonly charli3perpAggregateArtifactsDir =
    process.env.MIDNIGHT_C3PERP_AGGREGATE_ARTIFACTS_DIR ??
    path.resolve(__dirname, "../../contract/src/managed/charli3perp-aggregate");

  readonly privateStateStoreName =
    process.env.MIDNIGHT_PRIVATE_STATE_STORE ?? "charli3perp-order-local-private-state";

  readonly privateStateStoreMatching =
    process.env.MIDNIGHT_PRIVATE_STATE_STORE_MATCHING ?? "charli3perp-matching-local-private-state";

  readonly privateStateStoreSettlement =
    process.env.MIDNIGHT_PRIVATE_STATE_STORE_SETTLEMENT ?? "charli3perp-settlement-local-private-state";

  readonly privateStateStoreLiquidation =
    process.env.MIDNIGHT_PRIVATE_STATE_STORE_LIQUIDATION ?? "charli3perp-liquidation-local-private-state";

  readonly privateStateStoreAggregate =
    process.env.MIDNIGHT_PRIVATE_STATE_STORE_AGGREGATE ?? "charli3perp-aggregate-local-private-state";

  constructor() {
    this.deployNetwork = resolveMidnightDeployNetwork();
    const ep = getMidnightEndpoints(this.deployNetwork);
    setNetworkId(ep.networkId);
    this.indexer = ep.indexerHttp;
    this.indexerWS = ep.indexerWs;
    this.proofServer = ep.proofServer;
    this.networkId = ep.networkId;
    this.relayHttpOrigin = ep.relayHttpOrigin;
    this.dustAdditionalFeeOverhead = ep.dustAdditionalFeeOverhead;
    this.shieldedAdditionalFeeOverhead = ep.shieldedAdditionalFeeOverhead;
  }
}

/** @deprecated Use {@link Charli3perpMidnightConfig} */
export type LocalUndeployedConfig = Charli3perpMidnightConfig;
