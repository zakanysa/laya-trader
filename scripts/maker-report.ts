/**
 * Summarise the latest maker run from data/maker-events.jsonl (a dry run or live): how long it ran,
 * updates, fills and pick-offs, P&L with and without inventory (the edge itself), and how that
 * edge splits across 6-hour windows and busy vs quiet hours. A restart begins a new run.
 *
 *     bun run scripts/maker-report.ts [--all]   (--all: every run in the file, not just the latest)
 */
import { readFileSync } from "node:fs";

interface E { block: number; ts: number; mid: number; position: number; pnlUsd: number; hedgedPnlUsd?: number; gasUsd: number; halted: boolean;
  totals: { blocks: number; updates: number; reverts: number; fills: number; volumeUsd: number; pickoffs: number } }

const events: E[] = readFileSync("data/maker-events.jsonl", "utf8").trimEnd().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
const runs: E[][] = [];
for (const e of events) {
  const run = runs.at(-1);
  if (!run || e.totals.blocks < run.at(-1)!.totals.blocks) runs.push([e]); else run.push(e);
}
const t = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
const usd = (x: number) => (Number.isNaN(x) ? "n/a" : `${x < 0 ? "-" : "+"}$${Math.abs(x).toFixed(2)}`); // n/a: runs from before hedgedPnlUsd was logged

for (const run of process.argv.includes("--all") ? runs : runs.slice(-1)) {
  const a = run[0]!, z = run.at(-1)!, hours = (z.ts - a.ts) / 3.6e6;
  const hedged = (e: E) => e.hedgedPnlUsd ?? NaN;
  console.log(`run ${t(a.ts)} .. ${t(z.ts)} (${hours.toFixed(1)} h)${z.halted ? " · HALTED by MAX_LOSS_USD" : ""}`);
  console.log(`  ${z.totals.updates} quote updates (${(z.totals.updates / hours).toFixed(0)}/h), ${z.totals.reverts} reverted · ${z.totals.fills} fills, $${z.totals.volumeUsd.toFixed(0)} traded, ${z.totals.pickoffs} picked off`);
  console.log(`  P&L ${usd(z.pnlUsd)} (${usd(z.pnlUsd / hours)}/h) · without inventory ${usd(hedged(z))} (${usd(hedged(z) / hours)}/h) · gas ${usd(-z.gasUsd)} · position now ${z.position}`);
  let peak = -Infinity, dd = 0;
  for (const e of run) { peak = Math.max(peak, e.pnlUsd); dd = Math.min(dd, e.pnlUsd - peak); }
  console.log(`  worst drawdown ${usd(dd)} · P&L range ${usd(Math.min(...run.map((e) => e.pnlUsd)))} .. ${usd(Math.max(...run.map((e) => e.pnlUsd)))}`);

  // the edge per window: change in P&L without inventory
  const windows = new Map<number, { first: E; last: E }>();
  for (const e of run) { const k = Math.floor(e.ts / (6 * 3.6e6)); const w = windows.get(k); if (!w) windows.set(k, { first: e, last: e }); else w.last = e; }
  console.log("  6-hour windows (edge = change in P&L without inventory):");
  let prev: E | null = null;
  for (const { first, last } of windows.values()) {
    const from = prev ?? first;
    console.log(`    ${t(first.ts)}  edge ${usd(hedged(last) - hedged(from))}  P&L ${usd(last.pnlUsd - from.pnlUsd)}  fills ${last.totals.fills - from.totals.fills}`);
    prev = last;
  }
  // busy (12-21 UTC: Europe and US both open) vs quiet hours
  let busy = 0, quiet = 0, busyH = 0, quietH = 0;
  for (let i = 1; i < run.length; i++) {
    const d = hedged(run[i]!) - hedged(run[i - 1]!), h = (run[i]!.ts - run[i - 1]!.ts) / 3.6e6, hr = new Date(run[i]!.ts).getUTCHours();
    if (hr >= 12 && hr < 21) { busy += d; busyH += h; } else { quiet += d; quietH += h; }
  }
  console.log(`  edge in busy hours (12-21 UTC) ${usd(busy)} over ${busyH.toFixed(1)} h · quiet hours ${usd(quiet)} over ${quietH.toFixed(1)} h\n`);
}
