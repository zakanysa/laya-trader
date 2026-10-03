/**
 * Rebuild a Kuru market's order book for every past block, by calling getL2Book (and the AMM vault's
 * params, when the vault is live) at each block. The public RPC keeps about 5.5 days of state, so
 * this is how to get backtest data for a market nobody recorded. Writes
 *   data/markets/<market>/book.jsonl   {block, ts, bid, ask, bids:[[price,size]x5], asks:[...]}
 * where ts is interpolated from block timestamps sampled every 1,000 blocks. Resumes if re-run.
 *
 *     bun run scripts/backfill-book.ts <market address> [hours=24] [stride=1]
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { SEL_GET_L2_BOOK, SEL_GET_VAULT_PARAMS, buildBook, decodeVaultParams, readVaultParams, vaultActive } from "../src/book";

const market = process.argv[2]?.toLowerCase();
if (!market) throw new Error("usage: bun run scripts/backfill-book.ts <market> [hours] [stride]");
const HOURS = Number(process.argv[3] ?? 24), STRIDE = Number(process.argv[4] ?? 1);
const url = config.readRpcUrl;
const dir = `data/markets/${market}`;
mkdirSync(dir, { recursive: true });
const out = `${dir}/book.jsonl`;

const params = await Kuru.ParamFetcher.getMarketParams(new ethers.providers.StaticJsonRpcProvider(url, config.chainId), market);
const vault = vaultActive(await readVaultParams(url, market));
const head = parseInt(await rpc<string>("eth_blockNumber", [], url), 16);
let from = head - Math.round(HOURS * 11_000);
if (existsSync(out)) {
  const last = readFileSync(out, "utf8").trimEnd().split("\n").at(-1);
  if (last) from = JSON.parse(last).block + STRIDE;
}
from -= from % STRIDE;
console.log(`${market}: blocks ${from}..${head} every ${STRIDE}, vault ${vault ? "live" : "off"}`);

// block timestamps every 1,000 blocks, interpolated in between
const stamps = new Map<number, number>();
const stamp = async (b: number) => {
  const k = Math.floor(b / 1000) * 1000;
  for (const x of [k, k + 1000]) if (!stamps.has(x)) {
    const blk = await rpc<any>("eth_getBlockByNumber", ["0x" + Math.min(x, head).toString(16), false], url);
    stamps.set(x, parseInt(blk.timestamp, 16) * 1000);
  }
  const t0 = stamps.get(k)!, t1 = stamps.get(k + 1000)!;
  return Math.round(t0 + ((t1 - t0) * (b - k)) / 1000);
};

const call = (id: number, data: string, tag: string) => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: market, data }, tag] });
// rpc.monad.xyz allows 50 calls a second per client and counts every call inside a batch. A running
// bot uses ~13 of them (block polling, a book read and a trade-log poll per block), so stay well under.
const RATE = Number(process.env.BACKFILL_RATE ?? 30), BATCH = 30;
const blocks: number[] = [];
for (let b = from; b <= head; b += STRIDE) blocks.push(b);
let oldestMissing = 0, emptySides = 0, failed = 0, started = Date.now();

/** Book lines for these blocks, retrying calls the RPC rate-limited. */
async function fetchBooks(batch: number[]): Promise<string> {
  const lines = new Map<number, string>();
  let todo = batch;
  for (let round = 0; todo.length && round < 8; round++) {
    if (round) await Bun.sleep(1000 * round);
    const body = todo.flatMap((b, i) => [call(i * 2, SEL_GET_L2_BOOK, "0x" + b.toString(16)), ...(vault ? [call(i * 2 + 1, SEL_GET_VAULT_PARAMS, "0x" + b.toString(16))] : [])]);
    let res: any[];
    try {
      res = await (await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json() as any[];
      if (!Array.isArray(res)) continue;
    } catch { continue; }
    const byId = new Map(res.map((r) => [r.id, r]));
    const retry: number[] = [];
    for (const [i, b] of todo.entries()) {
      const l2 = byId.get(i * 2), v = byId.get(i * 2 + 1);
      const err = l2?.error?.message ?? v?.error?.message ?? "";
      if (l2?.result && (!vault || v?.result)) {
        try {
          const book = buildBook(l2.result, params, vault ? decodeVaultParams(v.result) : undefined);
          lines.set(b, JSON.stringify({ block: b, ts: await stamp(b), bid: book.bid, ask: book.ask, bids: book.levels.bids, asks: book.levels.asks }) + "\n");
        } catch { emptySides++; }
      } else if (/not available|not found/i.test(err)) {
        oldestMissing = Math.max(oldestMissing, b);
      } else {
        retry.push(b); // rate limited, or no reply for this call
      }
    }
    todo = retry;
  }
  failed += todo.length;
  return batch.map((b) => lines.get(b) ?? "").join("");
}

for (let i = 0; i < blocks.length; i += BATCH) {
  const t0 = Date.now();
  const batch = blocks.slice(i, i + BATCH);
  appendFileSync(out, await fetchBooks(batch));
  const wait = (batch.length * (vault ? 2 : 1) * 1000) / RATE - (Date.now() - t0);
  if (wait > 0) await Bun.sleep(wait);
  if ((i / BATCH) % 250 === 0) {
    const rate = (i + batch.length) / ((Date.now() - started) / 1000);
    console.log(`  ${(i + batch.length).toLocaleString()}/${blocks.length.toLocaleString()} blocks, ${failed} unreadable, ETA ${((blocks.length - i) / rate / 60).toFixed(0)} min`);
  }
}
if (oldestMissing) console.log(`state before block ${oldestMissing + 1} is pruned on this RPC; those blocks were skipped`);
console.log(`done: ${out} (${emptySides} blocks with an empty side, ${failed} unreadable after retries)`);
