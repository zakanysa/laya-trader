/**
 * The rest of what the backtest needs for a market backfilled with scripts/backfill-book.ts, over
 * the span of its data/markets/<market>/book.jsonl:
 *   params.json        tick, min size, fees, symbols
 *   ref.jsonl          Binance 1-second closes {t, price} for the reference symbol (t = close time)
 *   kuru-trades.jsonl  every Trade log of the market (same format as data/backtest/kuru-trades.jsonl)
 *
 *     bun run scripts/fetch-market.ts <market> <BINANCE_SYMBOL> [--ref-only]
 */
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { TRADE_TOPIC0, TRADE_PRICE_DEC } from "../src/trades";
import { toFloat, log10 } from "../src/book";

const [market, symbol] = [process.argv[2]?.toLowerCase(), process.argv[3]?.toUpperCase()];
if (!market || !symbol) throw new Error("usage: bun run scripts/fetch-market.ts <market> <BINANCE_SYMBOL> [--ref-only]");
const dir = `data/markets/${market}`;
const lines = readFileSync(`${dir}/book.jsonl`, "utf8").trimEnd().split("\n");
const first = JSON.parse(lines[0]!), last = JSON.parse(lines.at(-1)!);
console.log(`${market}: blocks ${first.block}..${last.block}, ${new Date(first.ts).toISOString()} .. ${new Date(last.ts).toISOString()}`);

const url = config.readRpcUrl;
const p = await Kuru.ParamFetcher.getMarketParams(new ethers.providers.StaticJsonRpcProvider(url, config.chainId), market);
const tick = Number(p.tickSize.toString()) / Number(p.pricePrecision.toString());
const sizeDec = log10(p.sizePrecision);
writeFileSync(`${dir}/params.json`, JSON.stringify({ market, symbol, tick, minSize: Number(p.minSize.toString()) / 10 ** sizeDec, sizeDec, makerFeeBps: Number(p.makerFeeBps), takerFeeBps: Number(p.takerFeeBps) }, null, 2));

// Binance 1 s klines, from 40 min before the first book (fair value warm-up) to the last
rmSync(`${dir}/ref.jsonl`, { force: true });
let start = first.ts - 40 * 60_000, n = 0;
while (start < last.ts) {
  const r = await fetch(`https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1s&startTime=${start}&limit=1000`);
  if (!r.ok) { await Bun.sleep(2000); continue; }
  const k = (await r.json()) as any[];
  if (!k.length) break;
  appendFileSync(`${dir}/ref.jsonl`, k.map((x) => JSON.stringify({ t: x[6], price: Number(x[4]) })).join("\n") + "\n");
  n += k.length;
  start = k.at(-1)[0] + 1000;
  await Bun.sleep(60);
}
console.log(`ref: ${n.toLocaleString()} Binance ${symbol} 1 s closes`);
if (process.argv.includes("--ref-only")) process.exit(0);

// Kuru trades, paced to leave the RPC's 50 calls/s for a running bot
const out = `${dir}/kuru-trades.jsonl`;
rmSync(out, { force: true });
let count = 0;
for (let b = first.block - 300; b <= last.block; b += 100) {
  let logs: any[] | undefined;
  for (let attempt = 0; attempt < 8 && !Array.isArray(logs); attempt++) {
    if (attempt) await Bun.sleep(500 * 2 ** attempt);
    logs = await rpc<any[]>("eth_getLogs", [{ address: market, topics: [TRADE_TOPIC0], fromBlock: "0x" + b.toString(16), toBlock: "0x" + Math.min(last.block, b + 99).toString(16) }], url).catch(() => undefined);
  }
  if (!Array.isArray(logs)) throw new Error(`eth_getLogs ${b}: no reply`);
  let s = "";
  for (const l of logs) {
    if (l.removed) continue;
    const d = l.data.slice(2), word = (j: number) => BigInt("0x" + d.slice(j * 64, (j + 1) * 64));
    const size = toFloat(word(7), sizeDec);
    if (!size) continue;
    s += JSON.stringify({ block: parseInt(l.blockNumber, 16), tx: l.transactionHash, i: parseInt(l.logIndex, 16), taker: word(2) !== 0n ? "buy" : "sell", price: toFloat(word(3), TRADE_PRICE_DEC), size, maker: "0x" + d.slice(64 + 24, 128) }) + "\n";
    count++;
  }
  if (s) appendFileSync(out, s);
  await Bun.sleep(100); // ~10 calls a second
}
console.log(`kuru: ${count.toLocaleString()} trade prints`);
if (!existsSync(out)) writeFileSync(out, "");
