#!/usr/bin/env npx tsx
/**
 * Charli3perp — unified CLI: oracle feeds, order commitments, Midnight deploy/ZK, Cardano anchors, E2E trade.
 *
 *   npm run perp -- help
 *   npm run perp -- oracle prices
 *   npm run perp -- order commit --pair ADA-USD --side LONG --price 0.25 --size 100 --leverage 5 --margin 1000
 *   npm run perp -- midnight run-all
 *   npm run perp -- trade adausd all
 */
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { OrderCommitmentInput } from "../src/order/commitment.js";
import { orderCommitmentHex } from "../src/order/commitment.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function runProcess(
  command: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: opts.cwd ?? ROOT,
      env: { ...process.env, ...opts.env },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code) => resolve(code));
  });
}

async function runExit0(command: string, args: string[], opts?: { cwd?: string }): Promise<void> {
  const code = await runProcess(command, args, opts);
  if (code !== 0) process.exit(code ?? 1);
}

function npxTsx(scriptRelativeToScripts: string, args: string[] = []): Promise<void> {
  return runExit0("npx", ["tsx", path.join(ROOT, "scripts", scriptRelativeToScripts), ...args]);
}

function npmWorkspace(script: string, workspace = "@charli3perp/cli"): Promise<void> {
  return runExit0("npm", ["run", script, "-w", workspace], { cwd: ROOT });
}

function printMainHelp(): void {
  console.log(`Charli3perp — unified CLI

Usage:
  npm run perp -- <group> <command> [args]

Groups:
  oracle        Charli3 ODV: list feeds, prices, funding, liquidation risk (Kupo)
  order         Build order commitment hash; interactive order terminal
  midnight      Deploy / run-all / run-pipeline / fund local (Midnight.js)
  cardano       Preprod: Charli3 pull tx, settlement anchor
  trade         Charli3 + Midnight Preview + Cardano (orchestrator)
  demo          Preprod risk + funding demo (single pair)
  wallet        Print Midnight or Cardano receive addresses
  bench         proof / srs microbenches (dev)

Examples:
  npm run perp -- oracle prices ADA-USD
  npm run perp -- order commit --pair ADA-USD --side SHORT --price 0.30 --size 50 --leverage 3 --margin 500
  npm run perp -- order terminal
  npm run perp -- midnight run-all
  npm run perp -- cardano pull
  npm run perp -- trade adausd all --dry-run

Env: see .env.example and docs/live-run.md (BIP39_MNEMONIC, WALLET_MNEMONIC, BLOCKFROST_*, MIDNIGHT_*, C3PERP_*).
`);
}

function printOracleHelp(): void {
  console.log(`perp oracle — Charli3 ODV (Preprod)

  npm run perp -- oracle list
  npm run perp -- oracle prices [PAIR ...]
  npm run perp -- oracle funding [PAIR ...]
  npm run perp -- oracle risk [--demo]
`);
}

function printOrderHelp(): void {
  console.log(`perp order

  npm run perp -- order commit --pair <id> --side LONG|SHORT --price <s> --size <s> \\
      --leverage <n> --margin <s> [--nonce <s>]
      Print C3PERP_ORDER_COMMITMENT_HEX (64 hex).

  npm run perp -- order terminal [--once]   Interactive REPL (same as npm run order:terminal)
`);
}

function printMidnightHelp(): void {
  console.log(`perp midnight

  npm run perp -- midnight deploy          Deploy charli3perp-order only
  npm run perp -- midnight run-all       Deploy + prove intent + bind Cardano anchor
  npm run perp -- midnight run-pipeline  Full five-contract pipeline (heavy)
  npm run perp -- midnight fund-local [mnemonic words...]   Undeployed local genesis fund + DUST

Set MIDNIGHT_DEPLOY_NETWORK (undeployed | preview | preprod), BIP39_MNEMONIC, C3PERP_* hex, MIDNIGHT_PROOF_SERVER as needed.
`);
}

function printCardanoHelp(): void {
  console.log(`perp cardano

  npm run perp -- cardano pull              Submit Charli3 oracle reference tx (Preprod)
  npm run perp -- cardano anchor <settlementId> <orderCommitmentHex64> [midnightTxUtf8]
`);
}

function printTradeHelp(): void {
  console.log(`perp trade

  npm run perp -- trade adausd [all|oracle|midnight|cardano] [--dry-run]

  Full path: Charli3 ADA-USD → Midnight Preview → Cardano Preprod.
`);
}

function printWalletHelp(): void {
  console.log(`perp wallet

  npm run perp -- wallet midnight-address   tNIGHT receive (BIP39_MNEMONIC, MIDNIGHT_DEPLOY_NETWORK)
  npm run perp -- wallet cardano-address    Base address (WALLET_MNEMONIC, Cardano env)
`);
}

function parseNamedArgs(argv: string[]): { flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[name] = next;
        i++;
      } else {
        flags[name] = "true";
      }
    } else {
      positional.push(a);
    }
  }
  return { flags, positional };
}

async function cmdOrderCommit(flags: Record<string, string>): Promise<void> {
  const pairId = flags.pair ?? flags.pairId ?? "ADA-USD";
  const side = (flags.side ?? "LONG").toUpperCase();
  if (side !== "LONG" && side !== "SHORT") {
    console.error("--side must be LONG or SHORT");
    process.exit(1);
  }
  const input: OrderCommitmentInput = {
    pairId,
    side: side as "LONG" | "SHORT",
    price: flags.price ?? "0",
    size: flags.size ?? "0",
    leverage: Number.parseInt(flags.leverage ?? "1", 10) || 1,
    margin: flags.margin ?? "0",
    nonce: flags.nonce ?? `cli-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
  };
  const hex = orderCommitmentHex(input);
  console.log("");
  console.log("# Order fields:", JSON.stringify(input, null, 2));
  console.log("");
  console.log(`export C3PERP_ORDER_COMMITMENT_HEX=${hex}`);
  console.log("");
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const [g0, g1, ...tail] = argv;

  if (!g0 || g0 === "help" || g0 === "-h" || g0 === "--help") {
    printMainHelp();
    return;
  }

  const g = g0.toLowerCase();

  if (g === "oracle") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printOracleHelp();
      return;
    }
    await npxTsx("charli3-pairs-cli.ts", [c, ...tail]);
    return;
  }

  if (g === "order") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printOrderHelp();
      return;
    }
    if (c === "terminal") {
      await npxTsx("c3perp-order-terminal.ts", tail);
      return;
    }
    if (c === "commit") {
      const { flags } = parseNamedArgs(tail);
      await cmdOrderCommit(flags);
      return;
    }
    console.error(`Unknown: perp order ${g1 ?? ""}`);
    printOrderHelp();
    process.exit(1);
  }

  if (g === "midnight") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printMidnightHelp();
      return;
    }
    if (c === "deploy") {
      await npmWorkspace("deploy");
      return;
    }
    if (c === "run-all") {
      await npmWorkspace("run-all");
      return;
    }
    if (c === "run-pipeline") {
      await npmWorkspace("run-pipeline");
      return;
    }
    if (c === "fund-local") {
      const extra = tail.length ? tail : [];
      await runExit0("npm", ["run", "fund-local-undeployed", "-w", "@charli3perp/cli", "--", ...extra], {
        cwd: ROOT,
      });
      return;
    }
    console.error(`Unknown: perp midnight ${g1 ?? ""}`);
    printMidnightHelp();
    process.exit(1);
  }

  if (g === "cardano") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printCardanoHelp();
      return;
    }
    if (c === "pull") {
      await npxTsx("cardano-charli3-pull.ts", tail);
      return;
    }
    if (c === "anchor") {
      await npxTsx("cardano-anchor-settlement.ts", tail);
      return;
    }
    console.error(`Unknown: perp cardano ${g1 ?? ""}`);
    printCardanoHelp();
    process.exit(1);
  }

  if (g === "trade") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printTradeHelp();
      return;
    }
    if (c === "adausd") {
      await npxTsx("trade-adausd-network.ts", tail);
      return;
    }
    console.error(`Unknown: perp trade ${g1 ?? ""}`);
    printTradeHelp();
    process.exit(1);
  }

  if (g === "demo") {
    const c = (g1 ?? "preprod-live").toLowerCase();
    if (c === "preprod-live") {
      await npxTsx("demo-preprod-live.ts", tail);
      return;
    }
    console.error("Usage: npm run perp -- demo preprod-live");
    process.exit(1);
  }

  if (g === "wallet") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "help" || c === "-h" || c === "--help") {
      printWalletHelp();
      return;
    }
    if (c === "midnight-address") {
      await runExit0("npm", ["run", "print-midnight-address", "-w", "@charli3perp/cli"], {
        cwd: ROOT,
      });
      return;
    }
    if (c === "cardano-address") {
      await npxTsx("print-cardano-preprod-address.ts", tail);
      return;
    }
    console.error(`Unknown: perp wallet ${g1 ?? ""}`);
    printWalletHelp();
    process.exit(1);
  }

  if (g === "bench") {
    const c = (g1 ?? "help").toLowerCase();
    if (c === "proofs" || c === "proof") {
      await runExit0("npm", ["run", "bench"], { cwd: ROOT });
      return;
    }
    if (c === "srs") {
      await runExit0("npm", ["run", "bench:srs"], { cwd: ROOT });
      return;
    }
    console.log(`perp bench

  npm run perp -- bench proofs   (npm run bench)
  npm run perp -- bench srs      (npm run bench:srs)
`);
    return;
  }

  console.error(`Unknown group: ${g0}\n`);
  printMainHelp();
  process.exit(1);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
