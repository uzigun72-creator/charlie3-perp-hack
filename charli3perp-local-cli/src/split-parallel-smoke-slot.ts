/**
 * Dummy slot for `split-parallel-smoke.ts`: fixed "work" duration, logs START/END timestamps.
 */
const slot = Number.parseInt(process.argv[2] ?? "-1", 10);
const workMs = Number.parseInt(process.env.SMOKE_WORK_MS ?? "2000", 10) || 2000;

if (!Number.isInteger(slot) || slot < 0 || slot > 4) {
  console.error("usage: split-parallel-smoke-slot <0..4>");
  process.exit(1);
}

const t0 = Date.now();
console.log(`[smoke-slot ${slot}] START wallMs=${t0}`);

await new Promise<void>((r) => setTimeout(r, workMs));

const t1 = Date.now();
console.log(`[smoke-slot ${slot}] END   wallMs=${t1} elapsedMs=${t1 - t0}`);
