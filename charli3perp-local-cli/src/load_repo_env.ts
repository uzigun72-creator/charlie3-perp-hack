/**
 * Load repo-root `.env` so `npm run run-all -w @charli3perp/cli` from `charlie3_hack/`
 * picks up `BIP39_MNEMONIC` etc. without `source .env`.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRootEnv = path.resolve(here, "../../.env");
config({ path: repoRootEnv });
