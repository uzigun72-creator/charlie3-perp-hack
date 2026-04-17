#!/usr/bin/env npx tsx
/**
 * Interactive terminal to compose a **charli3perp order commitment** (32-byte hex) from private fields.
 * Same hash as `src/order/commitment.ts`. TTY shows **live** Charli3 ODV (Kupo/Preprod) + env-aligned
 * Cardano/Midnight strip; reference bid/ask are the aggregate index (no separate CLOB L2 in this feed).
 * Commands `submit` / `full` run the repo npm pipelines with this commitment injected.
 *
 * Usage:
 *   npx tsx scripts/c3perp-order-terminal.ts
 *   npx tsx scripts/c3perp-order-terminal.ts --once   # wizard only, then exit
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrderCommitmentInput } from "../src/order/commitment.js";
import { orderCommitmentHex } from "../src/order/commitment.js";
import { getVerifiedIndexPrice, type VerifiedIndexPrice } from "../src/charli3/price_feed.js";
import {
  clearTuiScreen,
  defaultPerpUiConfig,
  parseNum,
  renderDashboard,
  type PerpUiConfig,
} from "./perp_ui.js";
import { defaultLocalOrderbookPath, LocalOrderBookManager } from "./local_orderbook.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const localOrderBooks = new LocalOrderBookManager(defaultLocalOrderbookPath(REPO_ROOT));

function randomNonce(): string {
  return `nonce-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}

const defaults: OrderCommitmentInput = {
  pairId: "ADA-USD",
  side: "LONG",
  price: "0.256299",
  size: "100",
  leverage: 5,
  margin: "1000",
  nonce: randomNonce(),
};

let draft: OrderCommitmentInput = { ...defaults };

let perpUi: PerpUiConfig = { ...defaultPerpUiConfig };
let oracleMark: number | null = null;
let oracleDetail: VerifiedIndexPrice | null = null;
let oracleError: string | null = null;
/** Dev-only: override displayed ref price (clears with `mark clear`). Live data is Charli3 ODV. */
let midOverride: number | null = null;
/** Wall clock when we last ran Kupo fetch (success or failure). */
let lastOracleFetchMs: number | null = null;

function redraw(): void {
  clearTuiScreen();
  const localBook = localOrderBooks.snapshot(draft.pairId, 8);
  output.write(
    `${renderDashboard({
      draft,
      ui: perpUi,
      oracleMark,
      oracleError,
      midOverride,
      oracleDetail,
      lastOracleFetchMs,
      localBook,
      bookLevels: 8,
    })}\n`,
  );
}

async function pullLiveOracle(): Promise<void> {
  oracleError = null;
  lastOracleFetchMs = Date.now();
  try {
    const v = await getVerifiedIndexPrice(draft.pairId);
    oracleDetail = v;
    oracleMark = v.indexPrice;
  } catch (e) {
    oracleDetail = null;
    oracleMark = null;
    oracleError = e instanceof Error ? e.message : String(e);
  }
}

function printFields(): void {
  console.log("\nCurrent order fields:");
  console.log(`  pairId    ${draft.pairId}`);
  console.log(`  side      ${draft.side}   (LONG | SHORT)`);
  console.log(`  price     ${draft.price}`);
  console.log(`  size      ${draft.size}`);
  console.log(`  leverage  ${draft.leverage}`);
  console.log(`  margin    ${draft.margin}`);
  console.log(`  nonce     ${draft.nonce}`);
}

function commit(): string {
  return orderCommitmentHex(draft);
}

function printBanner(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════════╗
║  ZK PERP — order terminal (ADA-USD & configured pairs)           ║
║  Off-chain intent → commitment hash → Midnight charli3perp-order      ║
╚══════════════════════════════════════════════════════════════════╝`);
}

const helpText = `
Perp UI (live networks):
  l | long          Side LONG
  s | short         Side SHORT
  oracle | refresh  Fetch latest Charli3 ODV from Kupo (matches pairId → Preprod feed)
  mark <px>|clear   Dev override of displayed ref (does not change on-chain feed)

Risk:
  mmr <bps>         Maintenance margin for liq model (e.g. 50 = 0.50%)

Order & pipelines:
  help              This text
  wizard            Prompt for all fields
  fields            Show current order draft (scrolls; screen is the dashboard)
  set <k> <v>       Set pairId | side | price | size | leverage | margin | nonce
  random            New random nonce (each new order should use a fresh nonce)
  post              Add **current draft** to the session-local order book (off-chain aggregate depth; persisted in .local-orderbook.json)
  clearbook         Clear local book for **current pairId** only
  commit            Print C3PERP_ORDER_COMMITMENT_HEX (64 hex)
  export            Print export lines (manual .env paste)
  submit | deploy   Run Midnight deploy for this draft (npm run deploy:midnight:order)
  full | e2e        Full stack: Charli3 + Midnight + Cardano (npm run trade:adausd -- all)
  reset             Defaults + new nonce
  quit | exit       Leave

Requires .env: BIP39_MNEMONIC, C3PERP_TRADER_SK_HEX, MIDNIGHT_PROOF_SERVER (e.g. :6300), Cardano vars for \`full\`; \`CHARLI3_KUPO_URL\` for live oracle (defaults to hackathon Preprod indexer).

Dashboard shows Cardano / Midnight from env (see trade-adausd-network.ts: Preprod + Preview). Charli3 ODV is one aggregate per pair; \`post\` builds a **local** depth view from your submissions (not on-chain CLOB).

TTY: colors when stdout is a TTY (disable with NO_COLOR=1). If the screen stacks duplicates after \`submit\`, the child process + readline fix + clear scrollback should help; set PERP_TUI_NO_CLEAR=1 to skip aggressive clear.
`;

async function wizardOnce(rl: readline.Interface): Promise<void> {
  console.log("\n--- Order wizard (defaults shown in brackets; press Enter to keep) ---\n");
  const ask = async (label: string, key: keyof OrderCommitmentInput, current: string) => {
    const line = (await rl.question(`${label} [${current}]: `)).trim();
    return line || current;
  };

  draft.pairId = await ask("pairId", "pairId", draft.pairId);
  let side = (await ask("side (LONG|SHORT)", "side", draft.side)).toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    console.warn("Invalid side, keeping previous.");
    side = draft.side;
  } else {
    draft.side = side as "LONG" | "SHORT";
  }
  draft.price = await ask("price (string)", "price", draft.price);
  draft.size = await ask("size (string)", "size", draft.size);
  const lev = await ask("leverage (integer)", "leverage", String(draft.leverage));
  if (lev) draft.leverage = Number.parseInt(lev, 10) || draft.leverage;
  draft.margin = await ask("margin (string)", "margin", draft.margin);
  draft.nonce = (await ask("nonce (unique per order)", "nonce", draft.nonce)).trim() || draft.nonce;
}

function spawnNpm(args: string[], commitmentHex: string): Promise<number | null> {
  const merged: NodeJS.ProcessEnv = {
    ...process.env,
    C3PERP_ORDER_COMMITMENT_HEX: commitmentHex,
    MIDNIGHT_DEPLOY_NETWORK: process.env.MIDNIGHT_DEPLOY_NETWORK || "preview",
    MIDNIGHT_PROOF_SERVER: process.env.MIDNIGHT_PROOF_SERVER || "http://127.0.0.1:6300",
  };
  return new Promise((resolve, reject) => {
    const child = spawn("npm", args, {
      cwd: REPO_ROOT,
      env: merged,
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

async function runPipeline(
  rl: readline.Interface,
  mode: "midnight" | "full",
): Promise<void> {
  const hex = commit();
  console.log(`\nCommitment: C3PERP_ORDER_COMMITMENT_HEX=${hex}`);
  const q =
    mode === "full"
      ? "\nRun FULL stack (oracle + Midnight + Cardano)? Can take 15–40+ min. [y/N] "
      : "\nRun Midnight deploy (sync + DUST + charli3perp-order + ZK)? [y/N] ";
  const ok = (await rl.question(q)).trim().toLowerCase();
  if (ok !== "y" && ok !== "yes") {
    console.log("Cancelled.");
    return;
  }
  console.log("");
  rl.pause();
  let code: number | null = -1;
  try {
    code =
      mode === "full"
        ? await spawnNpm(["run", "trade:adausd", "--", "all"], hex)
        : await spawnNpm(["run", "deploy:midnight:order"], hex);
  } finally {
    rl.resume();
  }
  if (code !== 0) {
    console.error(`\nPipeline exited with code ${code}`);
  } else {
    console.log("\n[pipeline] Finished OK — refreshing ODV from Kupo…");
    await pullLiveOracle();
  }
}

async function repl(): Promise<void> {
  const rl = readline.createInterface({ input, output });
  const once = process.argv.includes("--once");

  if (once) {
    printBanner();
    console.log("Wizard-only mode (--once).\n");
    await wizardOnce(rl);
    printFields();
    const h = commit();
    console.log("\nC3PERP_ORDER_COMMITMENT_HEX=" + h);
    console.log("\nAdd that line to .env, then deploy on Midnight Preview:");
    console.log("  source scripts/trade-env.sh && npm run deploy:midnight:order\n");
    rl.close();
    return;
  }

  await pullLiveOracle();

  for (;;) {
    redraw();
    const line = (await rl.question("perp> ")).trim();
    if (!line) continue;
    const [cmd, ...rest] = line.split(/\s+/);
    const c = cmd.toLowerCase();

    if (c === "quit" || c === "exit" || c === "q") break;
    if (c === "help" || c === "?") {
      clearTuiScreen();
      console.log(helpText);
      await rl.question("(press Enter to return to dashboard) ");
      continue;
    }
    if (c === "l" || c === "long") {
      draft.side = "LONG";
      continue;
    }
    if (c === "s" || c === "short") {
      draft.side = "SHORT";
      continue;
    }
    if (c === "oracle" || c === "refresh") {
      await pullLiveOracle();
      continue;
    }
    if (c === "mark") {
      const arg = rest.join(" ").trim().toLowerCase();
      if (!arg || arg === "clear" || arg === "off") {
        midOverride = null;
      } else {
        const px = parseNum(arg);
        if (!Number.isFinite(px) || px <= 0) {
          clearTuiScreen();
          console.error("mark: need positive number or `clear`");
          await rl.question("(press Enter) ");
        } else {
          midOverride = px;
        }
      }
      continue;
    }
    if (c === "mmr" && rest.length >= 1) {
      const bps = Number.parseInt(rest[0]!, 10);
      if (Number.isFinite(bps) && bps > 0 && bps < 100_000) {
        perpUi = { ...perpUi, maintenanceBps: bps };
      } else {
        clearTuiScreen();
        console.error("mmr: need bps 1–99999");
        await rl.question("(press Enter) ");
      }
      continue;
    }
    if (c === "fields") {
      clearTuiScreen();
      printFields();
      await rl.question("(press Enter) ");
      continue;
    }
    if (c === "reset") {
      draft = { ...defaults, nonce: randomNonce() };
      perpUi = { ...defaultPerpUiConfig };
      oracleMark = null;
      oracleDetail = null;
      oracleError = null;
      midOverride = null;
      lastOracleFetchMs = null;
      continue;
    }
    if (c === "random") {
      draft.nonce = randomNonce();
      continue;
    }
    if (c === "post") {
      const r = localOrderBooks.post(draft.pairId, draft);
      if (!r.ok) {
        clearTuiScreen();
        console.error(`post: ${r.error}`);
        await rl.question("(press Enter) ");
      }
      continue;
    }
    if (c === "clearbook") {
      localOrderBooks.clear(draft.pairId);
      continue;
    }
    if (c === "commit") {
      clearTuiScreen();
      const h = commit();
      console.log("\nC3PERP_ORDER_COMMITMENT_HEX=" + h + "\n");
      await rl.question("(press Enter) ");
      continue;
    }
    if (c === "export") {
      clearTuiScreen();
      const h = commit();
      console.log(
        [
          "",
          "export C3PERP_ORDER_COMMITMENT_HEX=" + h,
          "# Or run `submit` / `full` in this terminal to pipeline without pasting.",
          "",
        ].join("\n"),
      );
      await rl.question("(press Enter) ");
      continue;
    }
    if (c === "deploy" || c === "submit") {
      await runPipeline(rl, "midnight");
      continue;
    }
    if (c === "full" || c === "e2e") {
      await runPipeline(rl, "full");
      continue;
    }
    if (c === "set" && rest.length >= 2) {
      const key = rest[0] as keyof OrderCommitmentInput;
      const value = rest.slice(1).join(" ").trim();
      if (!(key in draft)) {
        clearTuiScreen();
        console.error("Unknown field:", key);
        await rl.question("(press Enter) ");
        continue;
      }
      if (key === "leverage") {
        draft.leverage = Number.parseInt(value, 10);
        if (Number.isNaN(draft.leverage)) {
          clearTuiScreen();
          console.error("leverage must be an integer");
          await rl.question("(press Enter) ");
          draft.leverage = defaults.leverage;
        }
      } else if (key === "side") {
        const u = value.toUpperCase();
        if (u !== "LONG" && u !== "SHORT") {
          clearTuiScreen();
          console.error("side must be LONG or SHORT");
          await rl.question("(press Enter) ");
          continue;
        }
        draft.side = u as "LONG" | "SHORT";
      } else {
        (draft as Record<string, unknown>)[key] = value;
      }
      if (key === "pairId") {
        midOverride = null;
        await pullLiveOracle();
      }
      continue;
    }
    if (c === "wizard") {
      clearTuiScreen();
      await wizardOnce(rl);
      midOverride = null;
      await pullLiveOracle();
      continue;
    }

    clearTuiScreen();
    console.log("Unknown command. Type `help`.");
    await rl.question("(press Enter) ");
  }

  rl.close();
  clearTuiScreen();
  console.log("Bye.");
}

repl().catch((e) => {
  console.error(e);
  process.exit(1);
});
