/**
 * Run multiple CLI pipelines in parallel — each with a different `MIDNIGHT_DERIVE_KEY_INDEX` and
 * isolated private-state store name so deploy/ZK state does not collide.
 *
 * Env:
 * - `MIDNIGHT_PARALLEL_COUNT` — how many processes (default `5`)
 * - `MIDNIGHT_PARALLEL_OFFSET` — first derive index (default `1`, i.e. indices 1..N)
 * - `MIDNIGHT_PARALLEL_SCRIPT` — npm script in this package (default `run-all`)
 * - `MIDNIGHT_PARALLEL_BENCH_JSON=1` — print a JSON summary (wall clock + per-worker timings)
 * - `BIP39_MNEMONIC`, `C3PERP_*`, `MIDNIGHT_DEPLOY_NETWORK`, etc. are inherited; each child also gets
 *   `MIDNIGHT_DERIVE_KEY_INDEX` and `MIDNIGHT_PRIVATE_STATE_STORE` suffixed by index.
 *
 * Workers must already be funded + DUST (`midnight-fund-derived-wallets`). Proof server must handle
 * concurrent proving or you will see queueing / timeouts.
 *
 * **Benchmark:** each child logs `[pipeline-bench]` when `C3PERP_PIPELINE_BENCH_LOG=1` (see `run-pipeline`).
 * This parent logs batch wall time and per-worker duration after all exit.
 */
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export type ParallelChildResult = {
  deriveIndex: number;
  exitCode: number | null;
  durationMs: number;
};

function runChild(
  env: NodeJS.ProcessEnv,
  npmScript: string,
  deriveIndex: number,
): Promise<ParallelChildResult> {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn("npm", ["run", npmScript, "-w", "@charli3perp/cli"], {
      cwd: ROOT,
      env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        deriveIndex,
        exitCode: code,
        durationMs: performance.now() - t0,
      });
    });
  });
}

async function main(): Promise<void> {
  const count = Math.max(1, Number.parseInt(process.env.MIDNIGHT_PARALLEL_COUNT ?? "5", 10) || 5);
  const offset = Math.max(0, Number.parseInt(process.env.MIDNIGHT_PARALLEL_OFFSET ?? "1", 10) || 1);
  const npmScript = (process.env.MIDNIGHT_PARALLEL_SCRIPT ?? "run-all").trim();

  console.log(
    `[midnight-parallel] spawning ${count}× npm run ${npmScript} with MIDNIGHT_DERIVE_KEY_INDEX ${offset}…${offset + count - 1}`,
  );

  const tasks: Promise<ParallelChildResult>[] = [];
  for (let i = 0; i < count; i++) {
    const deriveIndex = offset + i;
    const childEnv = {
      ...process.env,
      MIDNIGHT_DERIVE_KEY_INDEX: String(deriveIndex),
      MIDNIGHT_PRIVATE_STATE_STORE: `charli3perp-order-parallel-${deriveIndex}`,
      MIDNIGHT_PRIVATE_STATE_STORE_MATCHING: `charli3perp-matching-parallel-${deriveIndex}`,
      MIDNIGHT_PRIVATE_STATE_STORE_SETTLEMENT: `charli3perp-settlement-parallel-${deriveIndex}`,
      MIDNIGHT_PRIVATE_STATE_STORE_LIQUIDATION: `charli3perp-liquidation-parallel-${deriveIndex}`,
      MIDNIGHT_PRIVATE_STATE_STORE_AGGREGATE: `charli3perp-aggregate-parallel-${deriveIndex}`,
    };
    tasks.push(runChild(childEnv, npmScript, deriveIndex));
  }

  const wallT0 = performance.now();
  const results = await Promise.all(tasks);
  const wallMs = performance.now() - wallT0;

  const slowest = results.reduce((a, r) => (r.durationMs > a.durationMs ? r : a), results[0]);
  const ok = results.every((r) => r.exitCode === 0);

  console.log(
    `[midnight-parallel-bench] batch_wall_ms=${wallMs.toFixed(0)} workers=${count} script=${npmScript} ok=${ok}`,
  );
  for (const r of results) {
    console.log(
      `[midnight-parallel-bench] deriveKeysAt(${r.deriveIndex}) exit=${r.exitCode} duration_ms=${r.durationMs.toFixed(0)}`,
    );
  }
  if (results.length > 0) {
    console.log(
      `[midnight-parallel-bench] slowest_worker deriveKeysAt(${slowest.deriveIndex}) duration_ms=${slowest.durationMs.toFixed(0)}`,
    );
  }
  if (ok && wallMs > 0) {
    const pipelinesPerSec = count / (wallMs / 1000);
    const pipelinesPerMin = pipelinesPerSec * 60;
    console.log(
      `[midnight-parallel-bench] throughput_wall ${pipelinesPerSec.toFixed(3)} pipelines/s (${pipelinesPerMin.toFixed(1)} /min) for this parallel batch — limited by slowest worker + proof-server contention`,
    );
  }

  if (process.env.MIDNIGHT_PARALLEL_BENCH_JSON === "1") {
    console.log(
      JSON.stringify(
        {
          kind: "midnight-parallel-bench",
          captured_at: new Date().toISOString(),
          midnight_parallel_script: npmScript,
          count,
          offset,
          batch_wall_ms: Math.round(wallMs * 1000) / 1000,
          all_ok: ok,
          workers: results.map((r) => ({
            derive_key_index: r.deriveIndex,
            exit_code: r.exitCode,
            duration_ms: Math.round(r.durationMs * 1000) / 1000,
          })),
          slowest_derive_key_index: slowest?.deriveIndex,
          slowest_duration_ms: slowest ? Math.round(slowest.durationMs * 1000) / 1000 : null,
        },
        null,
        2,
      ),
    );
  }

  if (!ok) {
    throw new Error(
      `[midnight-parallel] one or more children exited non-zero: ${results.map((r) => r.exitCode).join(",")}`,
    );
  }
  console.log("[midnight-parallel] all children exited 0.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
