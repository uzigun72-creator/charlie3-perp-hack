/**
 * Resolve `tsx` CLI and spawn split-slot workers without `npm run` (npm can serialize
 * concurrent `npm` processes on some setups via global locks).
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** `charli3perp-local-cli/` */
export const cliPackageRoot = join(__dirname, "..");
/** Monorepo root `charlie3_hack/` */
export const repoRoot = join(__dirname, "..", "..");

const require = createRequire(import.meta.url);

export function resolveTsxCliPath(): string {
  try {
    const pkgJson = require.resolve("tsx/package.json");
    return join(dirname(pkgJson), "dist", "cli.mjs");
  } catch {
    return join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
  }
}

export const splitSlotEntry = join(__dirname, "run-pipeline-split-slot.ts");

export type SpawnSplitSlotOpts = {
  env: NodeJS.ProcessEnv;
  stdio?: "inherit" | "pipe";
};

/** One worker: `node <tsx> run-pipeline-split-slot.ts` with cwd = CLI package root. */
export function spawnSplitSlotProcess(opts: SpawnSplitSlotOpts): ReturnType<typeof spawn> {
  const tsx = resolveTsxCliPath();
  return spawn(process.execPath, [tsx, splitSlotEntry], {
    cwd: cliPackageRoot,
    env: opts.env,
    stdio: opts.stdio ?? "inherit",
    shell: false,
  });
}
