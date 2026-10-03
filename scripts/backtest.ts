/**
 * Replays the recorded Kuru book (data/laya/states-*.jsonl), every Kuru taker order and Binance's
 * MON trades (data/backtest/, from scripts/fetch-history.ts) through src/strategy.ts and the
 * pessimistic src/sim.ts, paying gas on every transaction.
 *
 *     bun run scripts/backtest.ts                       grid on the older data, best settings tested on the newest
 *     bun run scripts/backtest.ts --params '{"halfSpreadBps":8}'   one setting (others default), both periods
 *     bun run scripts/backtest.ts --market <addr> --mon-usd 0.034   any market from backfill-book.ts + fetch-market.ts
 *
 * Options: --split 2026-10-01T00:00Z (start of the test period; with --market, the last quarter),
 * --pickoff 5, --latency 2, --gas 650000, --mon-usd (gas is paid in MON; default: the MON-USDC mid),
 * --ref-delay 0 (see Binance this many ms late: how fragile is the edge to our own latency?)
 */
import { createReadStream, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { FairValue } from "../src/fair";
import { SimExchange, type SimBook, type SimFill, type TakerSweep } from "../src/sim";
import { defaultMakerParams, shouldRequote, targetQuotes, type MakerParams } from "../src/strategy";

const arg = (k: string, d?: string) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MARKET = arg("market")?.toLowerCase();
const DIR = MARKET ? `data/markets/${MARKET}` : null;
const TICK: number = DIR ? JSON.parse(readFileSync(`${DIR}/params.json`, "utf8")).tick : 1e-6;
const GAS_PRICE_GWEI = 102;
const REF_DELAY = Number(arg("ref-delay", "0")); // use the reference price this many ms late (robustness)
const MON_USD = arg("mon-usd") ? Number(arg("mon-usd")) : null; // null: this is MON-USDC, gas priced at its mid
const PICKOFF = Number(arg("pickoff", "5"));
const LATENCY = Number(arg("latency", "2"));
const GAS_LIMIT = Number(arg("gas", "650000")); // two places + two cancels, with the bot's headroom
const GAS_LIMIT_ONE_SIDE = 428_000; // what the original bot's estimate formula gives for one place

interface Row { block: number; ts: number; mid: number; book: SimBook; r20: number; imb: number; flow: number }

async function* lines(path: string) {
  for await (const line of createInterface({ input: createReadStream(path), crlfDelay: Infinity })) if (line) yield line;
}

async function load() {
  const rows: Row[] = [];
  const snap = (p: number) => Math.round(p / TICK) * TICK;
  if (DIR) {
    for await (const line of lines(`${DIR}/book.jsonl`)) {
      const r = JSON.parse(line);
      rows.push({ block: r.block, ts: r.ts, mid: (r.bid + r.ask) / 2, book: { bid: r.bid, ask: r.ask, bids: r.bids, asks: r.asks }, r20: 0, imb: 0, flow: 0 });
    }
  } else for (const f of readdirSync("data/laya").filter((f) => /^states-.*\.jsonl$/.test(f)).sort()) {
    for await (const line of lines(`data/laya/${f}`)) {
      let r; try { r = JSON.parse(line); } catch { continue; }
      const s = r.state, lvl = (x: string): [number, number] => { const [bps, , size] = x.split(" "); return [snap(r.mid * (1 + Number(bps) / 1e4)), Number(size)]; };
      const vol = s.flow.buyMon + s.flow.sellMon;
      rows.push({ block: r.block, ts: r.ts, mid: r.mid, book: { bid: r.bid, ask: r.ask, bids: s.bids.map(lvl), asks: s.asks.map(lvl) }, r20: s.returnsBps.last20, imb: s.imbalance, flow: vol ? s.flow.cvdMon / vol : 0 });
    }
  }
  rows.sort((a, b) => a.block - b.block);
  const dedup = rows.filter((r, i) => i === 0 || r.block !== rows[i - 1]!.block);

  const byTx = new Map<string, TakerSweep>();
  for await (const line of lines(DIR ? `${DIR}/kuru-trades.jsonl` : "data/backtest/kuru-trades.jsonl")) {
    const t = JSON.parse(line);
    const s: TakerSweep = byTx.get(t.tx) ?? { block: t.block, side: t.taker, prints: [] };
    s.prints.push([t.price, t.size]);
    byTx.set(t.tx, s);
  }
  const sweeps = new Map<number, TakerSweep[]>();
  for (const s of byTx.values()) sweeps.set(s.block, [...(sweeps.get(s.block) ?? []), s]);

  const bt: number[] = [], bp: number[] = [];
  for await (const line of lines(DIR ? `${DIR}/ref.jsonl` : "data/backtest/binance-trades.jsonl")) { const t = JSON.parse(line); bt.push(t.t); bp.push(t.price); }
  return { rows: dedup, sweeps, bt, bp };
}

type Data = Awaited<ReturnType<typeof load>>;
type Strategy = { kind: "maker"; p: MakerParams } | { kind: "everyblock" };

/** The original bot: the mock model's side, one tick inside the touch, a new order every block. */
function mockSide(r: Row): "buy" | "sell" {
  let h = (r.block * 2654435761) >>> 0; h ^= h >>> 15; h = (h * 2246822519) >>> 0; h ^= h >>> 13;
  const signal = r.r20 / 8 + r.imb * 1.5 + r.flow * 2 + ((h % 1000) / 1000 - 0.5) * 3;
  return signal >= 0 ? "buy" : "sell";
}

function run(d: Data, st: Strategy, fromTs: number, toTs: number) {
  const gasPerTx = ((st.kind === "maker" ? GAS_LIMIT : GAS_LIMIT_ONE_SIDE) * GAS_PRICE_GWEI) / 1e9;
  const sim = new SimExchange({ latencyBlocks: LATENCY, gasPerTxMon: gasPerTx, pickoffBps: PICKOFF, tick: TICK });
  const fair = new FairValue();
  const fills: (SimFill & { fair: number | null; idx: number })[] = [];
  let lastPos = 0, lastFair: number | null = null, invFair = 0;
  let bi = 0, prev = -1, posSum = 0, posMax = 0, signedSum = 0, holdPnl = 0, n = 0, first = -1, last = -1;
  const warmFrom = fromTs - 30 * 60_000; // fair value warms up on the half hour before trading starts
  for (let i = 0; i < d.rows.length; i++) {
    const r = d.rows[i]!;
    if (r.ts < warmFrom) continue;
    if (r.ts > toTs) break;
    while (bi < d.bt.length && d.bt[bi]! + REF_DELAY <= r.ts) { fair.onBinance(d.bp[bi]!, d.bt[bi]! + REF_DELAY); bi++; }
    fair.onKuru(r.mid, r.ts);
    if (r.ts < fromTs) { prev = r.block; continue; }
    if (first < 0) first = i;
    last = i;
    const F = fair.value(r.ts);
    if (prev >= 0 && r.block - prev <= 50) {
      for (let b = prev + 1; b <= r.block; b++) for (const f of sim.step(b, r.book, F, d.sweeps.get(b) ?? [])) fills.push({ ...f, fair: F, idx: i });
    } else {
      sim.step(r.block, r.book, F, []); // a gap in the recording: no trades replayed across it
    }
    prev = r.block;
    if (st.kind === "maker") {
      if (!sim.busy) {
        const target = F === null ? { bid: null, ask: null } : targetQuotes(F, r.book, sim.position, st.p, TICK);
        if (shouldRequote(sim.restingQuotes(st.p.size / 2), target, F ?? r.mid, st.p)) {
          const place = [];
          if (target.bid !== null) place.push({ side: "buy" as const, price: target.bid, size: st.p.size });
          if (target.ask !== null) place.push({ side: "sell" as const, price: target.ask, size: st.p.size });
          sim.send(r.block, place);
        }
      }
    } else {
      const side = Math.abs(sim.position + (mockSide(r) === "buy" ? 200 : -200)) > 1000 ? (mockSide(r) === "buy" ? "sell" : "buy") : mockSide(r);
      const scale = 1 / TICK, bidU = Math.round(r.book.bid * scale), askU = Math.round(r.book.ask * scale);
      let pu = side === "buy" ? bidU + 1 : askU - 1;
      if (side === "buy" && pu >= askU) pu = bidU;
      if (side === "sell" && pu <= bidU) pu = askU;
      if (!sim.busy) sim.send(r.block, [{ side, price: pu / scale, size: 200 }]);
      else { sim.gasMon += gasPerTx; sim.stats.txs++; } // the original sends every block, in flight or not
    }
    // what the inventory alone made: last block's position times this block's price change
    if (n > 0) holdPnl += lastPos * (r.mid - d.rows[i - 1]!.mid);
    // what the inventory made from Binance-based fair value moving: luck, unless positions predict the market
    if (F !== null && lastFair !== null) invFair += lastPos * (F - lastFair);
    if (F !== null) lastFair = F;
    lastPos = sim.position;
    posSum += Math.abs(sim.position); signedSum += sim.position; posMax = Math.max(posMax, Math.abs(sim.position)); n++;
  }
  if (first < 0) return null;
  const endMid = d.rows[last]!.mid, hours = (d.rows[last]!.ts - d.rows[first]!.ts) / 3.6e6;
  // edge at the fill vs fair value, and what the fill was worth 100 blocks (~30 s) later
  let edge = 0, markout = 0;
  for (const f of fills) {
    const sgn = f.side === "buy" ? 1 : -1;
    if (f.fair !== null) edge += sgn * (f.fair - f.price) * f.size;
    const later = d.rows[Math.min(last, f.idx + 100)]!.mid;
    markout += sgn * (later - f.price) * f.size;
  }
  const monUsd = MON_USD ?? endMid;
  const pnl = sim.equityUsd(endMid, monUsd);
  return {
    hours, pnl, pnlPerH: pnl / hours, gasUsd: sim.gasMon * monUsd, txPerH: sim.stats.txs / hours,
    fills: sim.stats.fills, volUsd: sim.stats.volumeMon * endMid, pickoffs: sim.stats.pickoffs, reverts: sim.stats.reverts,
    edgeUsd: edge, markoutUsd: markout, avgPos: posSum / n, maxPos: posMax, endPos: sim.position,
    avgSignedPos: signedSum / n, holdPnl, invFair, priceMovePct: (endMid / d.rows[first]!.mid - 1) * 100,
  };
}

interface TakerParams { entryBps: number; exitBps: number; maxHoldBlocks: number; sizeMon: number }

/**
 * Take Kuru's price when it lags Binance's fair value by more than `entryBps`: buy its ask when the
 * ask is that far below fair (or sell its bid when that far above), then close once Kuru is back
 * within `exitBps` of fair, or after `maxHoldBlocks` at whatever the book gives. Kuru charges no
 * taker fee. The order executes `LATENCY` blocks later against the recorded book, walking its levels
 * up to the limit; if faster traders already took the stale level, the recorded book shows it gone.
 */
function runTaker(d: Data, p: TakerParams, fromTs: number, toTs: number) {
  const gasPerTx = (350_000 * GAS_PRICE_GWEI) / 1e9;
  const fair = new FairValue();
  let pos = 0, cash = 0, gasMon = 0, txs = 0, trades = 0, entries = 0, bi = 0, opened = -1, first = -1, last = -1;
  let pending = null as { landAt: number; side: "buy" | "sell"; limit: number; size: number } | null;
  for (let i = 0; i < d.rows.length; i++) {
    const r = d.rows[i]!;
    if (r.ts < fromTs - 30 * 60_000) continue;
    if (r.ts > toTs) break;
    while (bi < d.bt.length && d.bt[bi]! + REF_DELAY <= r.ts) { fair.onBinance(d.bp[bi]!, d.bt[bi]! + REF_DELAY); bi++; }
    fair.onKuru(r.mid, r.ts);
    if (r.ts < fromTs) continue;
    if (first < 0) first = i;
    last = i;
    if (pending && r.block >= pending.landAt) {
      const levels = pending.side === "buy" ? r.book.asks : r.book.bids;
      let left = pending.size;
      for (const [price, size] of levels) {
        if (left <= 0 || (pending.side === "buy" ? price > pending.limit : price < pending.limit)) break;
        const q = Math.min(left, size);
        left -= q;
        pos += pending.side === "buy" ? q : -q;
        cash += (pending.side === "buy" ? -q : q) * price;
      }
      if (left < pending.size) trades++;
      pending = null;
    }
    const F = fair.value(r.ts);
    if (pending || F === null) continue;
    const send = (side: "buy" | "sell", limit: number, size: number) => { pending = { landAt: r.block + LATENCY, side, limit, size }; gasMon += gasPerTx; txs++; };
    if (Math.abs(pos) < 1) {
      pos = 0;
      if (r.book.ask < F * (1 - p.entryBps / 1e4)) { send("buy", F * (1 - p.entryBps / 2e4), p.sizeMon); entries++; opened = r.block; }
      else if (r.book.bid > F * (1 + p.entryBps / 1e4)) { send("sell", F * (1 + p.entryBps / 2e4), p.sizeMon); entries++; opened = r.block; }
    } else {
      const long = pos > 0, timeUp = r.block - opened > p.maxHoldBlocks;
      const back = long ? r.book.bid >= F * (1 - p.exitBps / 1e4) : r.book.ask <= F * (1 + p.exitBps / 1e4);
      if (back || timeUp) send(long ? "sell" : "buy", long ? (timeUp ? r.book.bid * 0.99 : r.book.bid) : (timeUp ? r.book.ask * 1.01 : r.book.ask), Math.abs(pos));
    }
  }
  if (first < 0) return null;
  const endMid = d.rows[last]!.mid, hours = (d.rows[last]!.ts - d.rows[first]!.ts) / 3.6e6;
  const pnl = cash + pos * endMid - gasMon * endMid;
  return `pnl $${pnl.toFixed(2).padStart(7)} ($${(pnl / hours).toFixed(3)}/h, before gas $${(pnl + gasMon * endMid).toFixed(2)}) | ${entries} signals, ${trades} trades filled, ${txs} tx, gas $${(gasMon * endMid).toFixed(2)} | open at end ${pos.toFixed(0)} MON`;
}

const fmt = (r: ReturnType<typeof run>) => !r ? "no data" :
  `pnl $${r.pnl.toFixed(2).padStart(7)} ($${r.pnlPerH.toFixed(3).padStart(6)}/h, before gas $${(r.pnl + r.gasUsd).toFixed(2)}) | gas $${r.gasUsd.toFixed(2).padStart(6)} ${r.txPerH.toFixed(0).padStart(5)} tx/h | ` +
  `${String(r.fills).padStart(4)} fills $${r.volUsd.toFixed(0).padStart(6)} vol, ${r.pickoffs} picked off, ${r.reverts} reverts | ` +
  `edge $${r.edgeUsd.toFixed(2)} markout30s $${r.markoutUsd.toFixed(2)} | pos avg ${r.avgPos.toFixed(0)} max ${r.maxPos.toFixed(0)} signed avg ${r.avgSignedPos.toFixed(0)} | ` +
  `price ${r.priceMovePct >= 0 ? "+" : ""}${r.priceMovePct.toFixed(1)}%, holding-only pnl $${r.holdPnl.toFixed(2)} | inventory vs fair $${r.invFair.toFixed(2)}, pnl without it $${(r.pnl - r.invFair).toFixed(2)}`;

const t0 = Date.now();
const d = await load();
const start = DIR ? d.rows[0]!.ts : d.rows.find((r) => r.ts > d.rows[0]!.ts && r.block - d.rows[d.rows.indexOf(r) - 1]!.block > 1000)?.ts ?? d.rows[0]!.ts; // after the first long gap
const end = d.rows.at(-1)!.ts;
// MON-USDC: the test period starts at a date; other markets: the last quarter of what was backfilled
const SPLIT = arg("split") ? Date.parse(arg("split")!) : DIR ? start + 30 * 60_000 + (end - start - 30 * 60_000) * 0.75 : Date.parse("2026-10-01T00:00:00Z");
const train = [start + 30 * 60_000, SPLIT] as const, test = [SPLIT, end] as const;
console.log(`${d.rows.length.toLocaleString()} blocks, ${d.sweeps.size.toLocaleString()} blocks with taker orders, ${d.bt.length.toLocaleString()} Binance trades, loaded in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
console.log(`train ${new Date(train[0]).toISOString()} .. ${new Date(train[1]).toISOString()} | test .. ${new Date(test[1]).toISOString()} | pick-off ${PICKOFF} bps, latency ${LATENCY} blocks, gas ${GAS_LIMIT.toLocaleString()} x ${GAS_PRICE_GWEI} gwei\n`);

if (!DIR) {
  console.log("original bot (a new one-sided order every block, mock model):");
  console.log("  train", fmt(run(d, { kind: "everyblock" }, ...train)));
  console.log("  test ", fmt(run(d, { kind: "everyblock" }, ...test)), "\n");
}

const single = arg("params");
if (process.argv.includes("--taker")) {
  const res: { p: TakerParams; s: string; pnl: number }[] = [];
  for (const entryBps of [10, 15, 20, 30, 50])
    for (const exitBps of [0, 5])
      for (const maxHoldBlocks of [100, 300, 1000])
        for (const sizeMon of [500, 2000, 5000]) {
          const p = { entryBps, exitBps, maxHoldBlocks, sizeMon };
          const s = runTaker(d, p, ...train)!;
          res.push({ p, s, pnl: Number(/pnl \$\s*(-?[\d.]+)/.exec(s)![1]) });
        }
  res.sort((a, b) => b.pnl - a.pnl);
  console.log(`taker grid: ${res.length} settings, ${res.filter((x) => x.pnl > 0).length} profitable on train`);
  for (const { p, s } of res.slice(0, 6)) {
    console.log(`  ${JSON.stringify(p)}\n    train ${s}\n    test  ${runTaker(d, p, ...test)}`);
  }
} else if (single) {
  const p = { ...defaultMakerParams(() => undefined), ...JSON.parse(single) };
  console.log("maker", JSON.stringify(p));
  console.log("  train", fmt(run(d, { kind: "maker", p }, ...train)));
  console.log("  test ", fmt(run(d, { kind: "maker", p }, ...test)));
  const windows = Number(arg("windows", "0")); // is the result steady, or a few lucky hours?
  for (let w = 0; w < windows; w++) {
    const a = train[0] + ((end - train[0]) * w) / windows, b = train[0] + ((end - train[0]) * (w + 1)) / windows;
    console.log(`  ${new Date(a).toISOString().slice(5, 16)}..${new Date(b).toISOString().slice(11, 16)}`, fmt(run(d, { kind: "maker", p }, a, b)));
  }
} else {
  const px = d.rows[0]!.mid, usd = (x: number) => Number((x / px).toPrecision(3)); // $ to base units
  const axes = {
    ...(DIR
      ? { halfSpreadBps: [1, 1.5, 2, 3, 5, 8], requoteBps: [1, 2, 4, 8], dangerBps: [0.25, 0.5, 1, 2], size: [50, 200, 1000].map(usd), maxInventory: [1000, 3000].map(usd), skewBps: [0, 2] }
      : { halfSpreadBps: [4, 6, 8, 11, 15], requoteBps: [2, 4, 8], dangerBps: [0.5, 2], size: [200, 500, 1000], maxInventory: [1000, 3000], skewBps: [0, 6] }),
    ...JSON.parse(arg("grid", "{}")!),
  };
  const grid: MakerParams[] = [];
  for (const halfSpreadBps of axes.halfSpreadBps)
    for (const requoteBps of axes.requoteBps)
      for (const dangerBps of axes.dangerBps)
        for (const size of axes.size)
          for (const maxInventory of axes.maxInventory)
            for (const skewBps of axes.skewBps)
              if (size <= maxInventory) grid.push({ halfSpreadBps, requoteBps, dangerBps, size, maxInventory, skewBps });
  const res = grid.map((p) => ({ p, r: run(d, { kind: "maker", p }, ...train)! }));
  // --rank hedged: by P&L without what inventory made from fair value moving (that part is mostly luck)
  const score = (r: NonNullable<ReturnType<typeof run>>) => (arg("rank") === "hedged" ? r.pnl - r.invFair : r.pnl);
  res.sort((a, b) => score(b.r) - score(a.r));
  const pos = res.filter((x) => score(x.r) > 0).length;
  console.log(`maker grid: ${grid.length} settings on the train period, ${pos} profitable, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
  const key = (p: MakerParams) => `half ${p.halfSpreadBps} requote ${p.requoteBps} danger ${p.dangerBps} size ${p.size} maxInv ${p.maxInventory} skew ${p.skewBps}`;
  console.log("\nbest 8 on train, then the same settings on the unseen test period:");
  for (const { p, r } of res.slice(0, 8)) {
    console.log(`  ${key(p)}`);
    console.log("    train", fmt(r));
    console.log("    test ", fmt(run(d, { kind: "maker", p }, ...test)));
  }
  console.log(`\nworst on train: ${key(res.at(-1)!.p)}\n    train ${fmt(res.at(-1)!.r)}`);
  const med = res[Math.floor(res.length / 2)]!;
  console.log(`median on train: ${key(med.p)}\n    train ${fmt(med.r)}`);
}
