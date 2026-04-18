/**
 * Spawn Midnight CLI maintenance tasks (fund derived wallets, parallel pipelines) from the API.
 * Protected by `PERPS_ADMIN_SECRET` (Bearer or X-Perps-Admin-Secret).
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "hono";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

export function adminSecretConfigured(): boolean {
  return Boolean(process.env.PERPS_ADMIN_SECRET?.trim());
}

/** Returns JSON Response if unauthorized or misconfigured; `null` if OK. */
export function assertAdminAuth(c: Context): Response | null {
  const secret = process.env.PERPS_ADMIN_SECRET?.trim();
  if (!secret) {
    return c.json({ error: "PERPS_ADMIN_SECRET is not set on the API" }, 503);
  }
  const auth = c.req.header("Authorization")?.trim();
  const bearer = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const header = c.req.header("X-Perps-Admin-Secret")?.trim();
  if (bearer === secret || header === secret) {
    return null;
  }
  return c.json({ error: "Unauthorized" }, 401);
}

export type MidnightJobKind = "fund-derived" | "parallel-cli";

export type MidnightJobRecord = {
  id: string;
  kind: MidnightJobKind;
  status: "running" | "completed" | "failed";
  startedAt: string;
  endedAt?: string;
  exitCode: number | null;
  pid?: number;
  logTail: string;
};

const jobs = new Map<string, MidnightJobRecord>();
const MAX_JOBS = 30;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const entries = [...jobs.entries()].sort((a, b) =>
    a[1].startedAt < b[1].startedAt ? -1 : 1,
  );
  while (entries.length > MAX_JOBS) {
    jobs.delete(entries.shift()![0]);
  }
}

function spawnNpmCliJob(
  kind: MidnightJobKind,
  npmScript: "fund-derived-wallets" | "parallel-cli",
  extraEnv: Record<string, string>,
): MidnightJobRecord {
  const id = randomUUID();
  const record: MidnightJobRecord = {
    id,
    kind,
    status: "running",
    startedAt: new Date().toISOString(),
    exitCode: null,
    logTail: "",
  };
  jobs.set(id, record);
  pruneJobs();

  let buf = "";
  const append = (chunk: Buffer) => {
    buf += chunk.toString();
    if (buf.length > 96_000) {
      buf = buf.slice(-96_000);
    }
    record.logTail = buf;
  };

  const child = spawn("npm", ["run", npmScript, "-w", "@charli3perp/cli"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  });
  record.pid = child.pid;

  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  child.on("close", (code) => {
    record.exitCode = code;
    record.status = code === 0 ? "completed" : "failed";
    record.endedAt = new Date().toISOString();
    record.logTail = buf.slice(-32_000);
  });
  child.on("error", (err) => {
    record.status = "failed";
    record.exitCode = -1;
    record.endedAt = new Date().toISOString();
    record.logTail = (buf + "\n" + String(err)).slice(-32_000);
  });

  return record;
}

const PARALLEL_SCRIPTS = new Set(["run-all", "run-pipeline"]);

export function startFundDerivedJob(body: {
  funderIndex?: number;
  indices?: number[];
  transferAmount?: string;
}): MidnightJobRecord {
  const extra: Record<string, string> = {};
  if (body.funderIndex !== undefined && Number.isFinite(body.funderIndex)) {
    extra.MIDNIGHT_FUNDER_INDEX = String(Math.max(0, Math.floor(body.funderIndex)));
  }
  if (body.indices && body.indices.length > 0) {
    const list = body.indices.filter((n) => Number.isFinite(n) && n > 0);
    if (list.length > 0) {
      extra.MIDNIGHT_FUND_DERIVE_INDICES = list.join(",");
    }
  }
  if (body.transferAmount?.trim()) {
    extra.MIDNIGHT_FUND_TRANSFER_AMOUNT = body.transferAmount.trim();
  }
  return spawnNpmCliJob("fund-derived", "fund-derived-wallets", extra);
}

export function startParallelCliJob(body: {
  count?: number;
  offset?: number;
  script?: string;
}): { ok: true; job: MidnightJobRecord } | { ok: false; error: string } {
  const script = (body.script ?? "run-all").trim();
  if (!PARALLEL_SCRIPTS.has(script)) {
    return {
      ok: false,
      error: `script must be one of: ${[...PARALLEL_SCRIPTS].join(", ")}`,
    };
  }
  const count = body.count !== undefined ? Math.max(1, Math.floor(body.count)) : undefined;
  const offset = body.offset !== undefined ? Math.max(0, Math.floor(body.offset)) : undefined;
  const extra: Record<string, string> = { MIDNIGHT_PARALLEL_SCRIPT: script };
  if (count !== undefined) {
    extra.MIDNIGHT_PARALLEL_COUNT = String(count);
  }
  if (offset !== undefined) {
    extra.MIDNIGHT_PARALLEL_OFFSET = String(offset);
  }
  return { ok: true, job: spawnNpmCliJob("parallel-cli", "parallel-cli", extra) };
}

export function getMidnightJob(id: string): MidnightJobRecord | undefined {
  return jobs.get(id);
}

export function listMidnightJobs(limit: number): MidnightJobRecord[] {
  const n = Math.min(50, Math.max(1, limit));
  return [...jobs.values()]
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
    .slice(0, n);
}

export function midnightSetupSnapshot(): Record<string, unknown> {
  return {
    adminConfigured: adminSecretConfigured(),
    midnightDeriveKeyIndex: process.env.MIDNIGHT_DERIVE_KEY_INDEX?.trim() || "0",
    midnightRunMode: process.env.MIDNIGHT_RUN_MODE?.trim() || "full-pipeline",
    proofServer: process.env.MIDNIGHT_PROOF_SERVER || "http://127.0.0.1:6300",
    fundDerived: {
      env: {
        MIDNIGHT_FUNDER_INDEX: process.env.MIDNIGHT_FUNDER_INDEX?.trim() || "0",
        MIDNIGHT_FUND_DERIVE_INDICES: process.env.MIDNIGHT_FUND_DERIVE_INDICES?.trim() || "1,2,3,4,5",
        MIDNIGHT_FUND_TRANSFER_AMOUNT: process.env.MIDNIGHT_FUND_TRANSFER_AMOUNT?.trim() || "(default in CLI)",
      },
      npmScript: "fund-derived-wallets",
    },
    parallelCli: {
      env: {
        MIDNIGHT_PARALLEL_COUNT: process.env.MIDNIGHT_PARALLEL_COUNT?.trim() || "5",
        MIDNIGHT_PARALLEL_OFFSET: process.env.MIDNIGHT_PARALLEL_OFFSET?.trim() || "1",
        MIDNIGHT_PARALLEL_SCRIPT: process.env.MIDNIGHT_PARALLEL_SCRIPT?.trim() || "run-all",
      },
      npmScript: "parallel-cli",
    },
    auth: {
      header: "Authorization: Bearer <PERPS_ADMIN_SECRET> or X-Perps-Admin-Secret: <same>",
    },
    note:
      "BIP39_MNEMONIC must be set (repo-root .env) so workers share the same seed as the CLI. Parallel runs need a proof server that can handle concurrent load.",
  };
}
