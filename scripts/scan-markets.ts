/**
 * Find every Kuru market on Monad and size it up for a small market maker: taker volume, spread and
 * depth, how many makers there are and how fast the fastest one re-quotes, whether Binance trades
 * the same asset (a fair value to quote around), and what gas costs against the minimum order.
 * Any contract emitting Kuru's Trade event counts as a market.
 *
 *     bun run scripts/scan-markets.ts [hours=24]
 */
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { TRADE_TOPIC0 } from "../src/trades";
import { readBook, log10 } from "../src/book";

const HOURS = Number(process.argv[2] ?? 24);
const BLOCKS_PER_HOUR = 11_000; // measured on Monad: ~0.33 s blocks
const GAS_PER_QUOTE_UPDATE_MON = (650_000 * 102) / 1e9; // two places + two cancels, as in the backtest
const url = config.readRpcUrl;
const provider = new ethers.providers.StaticJsonRpcProvider(url, config.chainId);
const iface = new ethers.utils.Interface(OrderBookAbi.abi);
const STABLES = new Set(["USDC", "USDT", "AUSD", "USDT0", "USDC.E", "USD₮0", "USDM"]);

async function getLogsChunked(from: number, to: number, filter: object, workers = 6) {
  const starts: number[] = [];
  for (let b = from; b <= to; b += 100) starts.push(b);
  const out: any[][] = new Array(starts.length);
  let next = 0, done = 0;
  await Promise.all(Array.from({ length: workers }, async () => {
    while (next < starts.length) {
      const k = next++, b = starts[k]!;
      for (let attempt = 0; ; attempt++) {
        try {
          const logs = await rpc<any[]>("eth_getLogs", [{ ...filter, fromBlock: "0x" + b.toString(16), toBlock: "0x" + Math.min(to, b + 99).toString(16) }], url);
          if (!Array.isArray(logs)) throw new Error("empty reply");
          out[k] = logs;
          break;
        } catch (e) {
          if (attempt > 6) throw e;
          await Bun.sleep(500 * 2 ** attempt);
        }
      }
      if (++done % 500 === 0) console.log(`  ${done}/${starts.length} log chunks`);
    }
  }));
  return out.flat();
}

async function symbol(addr: string) {
  if (/^0x0{40}$/.test(addr)) return "MON";
  try {
    const hex = await rpc<string>("eth_call", [{ to: addr, data: "0x95d89b41" }, "latest"], url);
    return ethers.utils.defaultAbiCoder.decode(["string"], hex)[0] as string;
  } catch { return addr.slice(0, 8); }
}

const head = parseInt(await rpc<string>("eth_blockNumber", [], url), 16);
const from = head - Math.round(HOURS * BLOCKS_PER_HOUR);
console.log(`scanning Trade logs on every contract, blocks ${from}..${head} (~${HOURS} h)`);
const trades = await getLogsChunked(from, head, { topics: [TRADE_TOPIC0] });
const byMarket = new Map<string, any[]>();
for (const l of trades) if (!l.removed) byMarket.set(l.address.toLowerCase(), [...(byMarket.get(l.address.toLowerCase()) ?? []), l]);
console.log(`${trades.length.toLocaleString()} trade prints on ${byMarket.size} contracts\n`);

const [spot, fut] = await Promise.all([
  fetch("https://api.binance.com/api/v3/exchangeInfo").then((r) => r.json()).then((j: any) => new Set<string>(j.symbols.filter((s: any) => s.status === "TRADING").map((s: any) => s.symbol))),
  fetch("https://fapi.binance.com/fapi/v1/exchangeInfo").then((r) => r.json()).then((j: any) => new Set<string>(j.symbols.filter((s: any) => s.status === "TRADING").map((s: any) => s.symbol))),
]);
const binanceRef = (base: string) => {
  const b = base.toUpperCase().replace(/^(W|CB|ST|SH|A|G)(?=[A-Z]{3,})/, "").replace(/0$/, "").replace(/\.E$/, "");
  const cands = [b, base.toUpperCase(), b === "XAUT" ? "PAXG" : b];
  for (const c of cands) {
    if (spot.has(`${c}USDT`)) return `${c}USDT spot`;
    if (fut.has(`${c}USDT`)) return `${c}USDT perp`;
  }
  return null;
};

// MON price in USD, for markets quoted in MON
const monUsd = (await readBook(url, config.market, await Kuru.ParamFetcher.getMarketParams(provider, config.market))).mid;

const created = iface.getEventTopic("OrderCreated");
const rows: any[] = [];
for (const [addr, logs] of byMarket) {
  let p: Kuru.MarketParams;
  try { p = await Kuru.ParamFetcher.getMarketParams(provider, addr); } catch { continue; } // not a Kuru order book
  const [base, quote] = await Promise.all([symbol(p.baseAssetAddress), symbol(p.quoteAssetAddress)]);
  const quoteUsd = STABLES.has(quote.toUpperCase()) ? 1 : quote === "MON" || quote === "WMON" ? monUsd : null;
  const sizeDec = log10(p.sizePrecision);
  let volQ = 0, n = 0;
  const makers = new Map<string, number>(), takers = new Set<string>();
  const prices: [number, number][] = [];
  for (const l of logs) {
    const d = l.data.slice(2), word = (j: number) => BigInt("0x" + d.slice(j * 64, (j + 1) * 64));
    const price = Number(word(3)) / 1e18, size = Number(word(7)) / 10 ** sizeDec;
    if (!size) continue;
    n++;
    volQ += price * size;
    const maker = "0x" + d.slice(64 + 24, 128);
    makers.set(maker, (makers.get(maker) ?? 0) + price * size);
    takers.add("0x" + d.slice(6 * 64 + 24, 7 * 64));
    prices.push([parseInt(l.blockNumber, 16), price]);
  }
  // typical 5-minute move, from the last trade price in each 5-minute bucket
  const buckets = new Map<number, number>();
  for (const [b, px] of prices) buckets.set(Math.floor(b / (BLOCKS_PER_HOUR / 12)), px);
  const series = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  const moves = series.slice(1).map((x, i) => Math.abs(Math.log(x / series[i]!)) * 1e4).sort((a, b) => a - b);
  let book = null;
  try { book = await readBook(url, addr, p); } catch {}
  // competition: who placed orders in the last ~10 minutes, and how often
  const recent = await getLogsChunked(head - 2000, head, { address: addr, topics: [created] }, 4);
  const owners = new Map<string, Set<string>>();
  for (const l of recent) { const o = iface.parseLog(l).args.owner.toLowerCase(); owners.set(o, (owners.get(o) ?? new Set()).add(l.transactionHash)); }
  const fastest = Math.max(0, ...[...owners.values()].map((s) => s.size)) / (2000 / BLOCKS_PER_HOUR * 60);
  const topShare = volQ ? Math.max(...makers.values()) / volQ : 0;
  const minOrderUsd = quoteUsd && book ? (Number(p.minSize.toString()) / 10 ** sizeDec) * book.mid * quoteUsd : null;
  rows.push({
    market: `${base}-${quote}`, addr,
    volUsdDay: quoteUsd ? (volQ * quoteUsd * 24) / HOURS : null, tradesDay: Math.round((n * 24) / HOURS), takers: takers.size,
    spreadBps: book?.spreadBps ?? null,
    depth50Usd: book && quoteUsd ? (book.depthBps["50"]!.bid + book.depthBps["50"]!.ask) * book.mid * quoteUsd : null,
    move5mBps: moves.length ? moves[Math.floor(moves.length / 2)] : null,
    makers: makers.size, topMakerShare: topShare, quoters10m: owners.size, fastestTxPerMin: fastest,
    minOrderUsd, gasPerUpdateBpsOfMin: minOrderUsd ? ((GAS_PER_QUOTE_UPDATE_MON * monUsd) / minOrderUsd) * 1e4 : null,
    fees: `${p.makerFeeBps}/${p.takerFeeBps}`, ref: binanceRef(base),
  });
}

rows.sort((a, b) => (b.volUsdDay ?? 0) - (a.volUsdDay ?? 0));
const f = (x: number | null, d = 0) => (x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d }));
console.log("market".padEnd(16), "vol $/day".padStart(11), "trades/d".padStart(8), "takers".padStart(6), "spread".padStart(7), "depth±50bp$".padStart(11), "5m move".padStart(7),
  "makers".padStart(6), "top%".padStart(5), "quoters".padStart(7), "fastest/min".padStart(11), "min $".padStart(7), "gas%min".padStart(7), "fees", " binance ref");
for (const r of rows) {
  console.log(r.market.padEnd(16), f(r.volUsdDay).padStart(11), f(r.tradesDay).padStart(8), f(r.takers).padStart(6), f(r.spreadBps, 1).padStart(7), f(r.depth50Usd).padStart(11), f(r.move5mBps, 1).padStart(7),
    f(r.makers).padStart(6), f(r.topMakerShare * 100).padStart(5), f(r.quoters10m).padStart(7), f(r.fastestTxPerMin, 1).padStart(11), f(r.minOrderUsd, 2).padStart(7), f(r.gasPerUpdateBpsOfMin === null ? null : r.gasPerUpdateBpsOfMin / 100, 2).padStart(7), r.fees.padStart(4), "", r.ref ?? "-", "", r.addr);
}
await Bun.write("data/backtest/markets.json", JSON.stringify(rows, null, 2));
console.log("\nspread and depth are a snapshot now; gas%min = one two-sided quote update as % of a minimum-size order");
