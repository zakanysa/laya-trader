/**
 * Download what the backtest replays, for the span covered by data/laya/states-*.jsonl:
 *   data/backtest/kuru-trades.jsonl    every Kuru MON-USDC Trade log (eth_getLogs, 100 blocks a call)
 *   data/backtest/binance-trades.jsonl Binance MONUSDT perpetual aggTrades (public REST, no key)
 * Re-running resumes: each file is extended from where it stops.
 *
 *     bun run scripts/fetch-history.ts
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { TRADE_TOPIC0, TRADE_PRICE_DEC } from "../src/trades";
import { toFloat } from "../src/book";

const SIZE_DEC = 10; // log10(sizePrecision) on MON-USDC
const OUT = "data/backtest";
mkdirSync(OUT, { recursive: true });

/** First and last block/ts in the collected states, read from the ends of the first and last file. */
function stateSpan() {
  const files = readdirSync("data/laya").filter((f) => /^states-.*\.jsonl$/.test(f)).sort();
  if (!files.length) throw new Error("no data/laya/states-*.jsonl; collect with STATE_LOG=true first");
  const first = JSON.parse(readFileSync(`data/laya/${files[0]}`, "utf8").split("\n", 1)[0]!);
  const tail = readFileSync(`data/laya/${files.at(-1)}`, "utf8").trimEnd().split("\n");
  const last = JSON.parse(tail.at(-1)!);
  return { fromBlock: first.block as number, toBlock: last.block as number, fromTs: first.ts as number, toTs: last.ts as number };
}

function lastLine(path: string): any | null {
  if (!existsSync(path)) return null;
  const lines = readFileSync(path, "utf8").trimEnd().split("\n");
  return lines.at(-1) ? JSON.parse(lines.at(-1)!) : null;
}

async function kuruTrades(fromBlock: number, toBlock: number) {
  const path = `${OUT}/kuru-trades.jsonl`;
  const done = lastLine(path)?.block ?? fromBlock - 1;
  const chunks: number[] = [];
  for (let b = Math.max(fromBlock, done + 1); b <= toBlock; b += 100) chunks.push(b);
  console.log(`kuru: ${chunks.length} getLogs calls for blocks ${chunks[0] ?? "-"}..${toBlock}`);
  const WORKERS = 6, BATCH = 60;
  for (let i = 0; i < chunks.length; i += BATCH) {
    const batch = chunks.slice(i, i + BATCH);
    const results: any[][] = new Array(batch.length);
    let next = 0;
    await Promise.all(Array.from({ length: WORKERS }, async () => {
      while (next < batch.length) {
        const k = next++, from = batch[k]!;
        for (let attempt = 0; ; attempt++) {
          try {
            const logs = await rpc<any[]>("eth_getLogs", [{ address: config.market, topics: [TRADE_TOPIC0], fromBlock: "0x" + from.toString(16), toBlock: "0x" + Math.min(toBlock, from + 99).toString(16) }], config.readRpcUrl);
            if (!Array.isArray(logs)) throw new Error(`eth_getLogs ${from}: empty reply`); // a throttled RPC can answer with no result and no error
            results[k] = logs;
            break;
          } catch (e) {
            if (attempt > 6) throw e;
            await Bun.sleep(500 * 2 ** attempt);
          }
        }
      }
    }));
    let out = "";
    for (const logs of results) for (const l of logs) {
      if (l.removed) continue;
      const d = l.data.slice(2), word = (j: number) => BigInt("0x" + d.slice(j * 64, (j + 1) * 64));
      const size = toFloat(word(7), SIZE_DEC);
      if (size === 0) continue;
      // isBuy is the TAKER's side: true = someone bought from an ask
      out += JSON.stringify({ block: parseInt(l.blockNumber, 16), tx: l.transactionHash, i: parseInt(l.logIndex, 16), taker: word(2) !== 0n ? "buy" : "sell", price: toFloat(word(3), TRADE_PRICE_DEC), size, maker: "0x" + d.slice(64 + 24, 128) }) + "\n";
    }
    if (out) appendFileSync(path, out);
    if ((i / BATCH) % 10 === 0) console.log(`  kuru ${Math.min(i + BATCH, chunks.length)}/${chunks.length}`);
  }
}

async function binanceTrades(fromTs: number, toTs: number) {
  const path = `${OUT}/binance-trades.jsonl`;
  const prev = lastLine(path);
  const get = async (q: string) => {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(`https://fapi.binance.com/fapi/v1/aggTrades?symbol=MONUSDT&limit=1000&${q}`);
      if (r.ok) return (await r.json()) as { a: number; p: string; q: string; T: number; m: boolean }[];
      if (attempt > 6) throw new Error(`binance ${r.status} ${await r.text()}`);
      await Bun.sleep(1000 * 2 ** attempt);
    }
  };
  // a few minutes before the first state so the basis tracker has history from the start
  let fromId = prev ? prev.id + 1 : (await get(`startTime=${fromTs - 15 * 60_000}&endTime=${fromTs - 14 * 60_000}`))[0]?.a;
  if (fromId === undefined) throw new Error("binance: no trades at the start of the span");
  let n = 0;
  for (;;) {
    const rows = await get(`fromId=${fromId}`);
    if (!rows.length) break;
    // m = buyer is the maker, so the taker sold
    appendFileSync(path, rows.map((t) => JSON.stringify({ id: t.a, t: t.T, price: Number(t.p), size: Number(t.q), taker: t.m ? "sell" : "buy" })).join("\n") + "\n");
    fromId = rows.at(-1)!.a + 1;
    n += rows.length;
    if (n % 50_000 < 1000) console.log(`  binance ${n.toLocaleString()} trades, up to ${new Date(rows.at(-1)!.T).toISOString()}`);
    if (rows.at(-1)!.T > toTs + 60_000) break;
    await Bun.sleep(120); // well inside the 2400 weight/min limit (20 per call)
  }
}

const span = stateSpan();
console.log(`states span blocks ${span.fromBlock}..${span.toBlock}, ${new Date(span.fromTs).toISOString()} .. ${new Date(span.toTs).toISOString()}`);
await Promise.all([kuruTrades(span.fromBlock - 400, span.toBlock + 200), binanceTrades(span.fromTs, span.toTs)]);
console.log("done");
