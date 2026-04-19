/**
 * Proves five split workers run concurrently: spawns 5 processes × `SMOKE_WORK_MS` (default 2000ms).
 * Wall time ≈ 2000ms if parallel, ≈ 10000ms if sequential.
 *
 *   npm run split-parallel-smoke -w @charli3perp/cli
 */
import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTsxCliPath, cliPackageRoot } from "./split_parallel_spawn.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const smokeSlotScript = join(__dirname, "split-parallel-smoke-slot.ts");

function spawnSmokeSlot(slot: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const tsx = resolveTsxCliPath();
    const child = spawn(process.execPath, [tsx, smokeSlotScript, String(slot)], {
      cwd: cliPackageRoot,
      env: { ...process.env },
      stdio: "inherit",
      shell: false,
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`smoke slot ${slot} exit ${code}`)),
    );
  });
}

async function main(): Promise<void> {
  const workMs = Number.parseInt(process.env.SMOKE_WORK_MS ?? "2000", 10) || 2000;
  const t0 = Date.now();
  console.log(
    `[split-parallel-smoke] spawning 5 workers (${workMs}ms fake work each) via node+tsx…`,
  );
  await Promise.all([0, 1, 2, 3, 4].map(spawnSmokeSlot));
  const wall = Date.now() - t0;
  console.log(
    `\n[split-parallel-smoke] all finished in ${wall}ms — expect ~${workMs}–${workMs + 500}ms if parallel, ~${workMs * 5}ms if sequential`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
