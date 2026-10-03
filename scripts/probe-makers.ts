/**
 * Who makes markets on Kuru MON-USDC, and what their quote updates cost: market params (fees, tick,
 * min size), then the last N blocks of OrderCreated events grouped by owner, with gasUsed and the
 * batchUpdate shape of a sample of their transactions.
 *
 *     bun run scripts/probe-makers.ts [blocks=3000]
 */
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
import { config } from "../src/config";
import { rpc } from "../src/chain";

const N = Number(process.argv[2] ?? 3000);
const provider = new ethers.providers.StaticJsonRpcProvider(config.readRpcUrl, config.chainId);
const iface = new ethers.utils.Interface(OrderBookAbi.abi);
const p = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
console.log("params:", Object.fromEntries(Object.entries(p).map(([k, v]) => [k, v?.toString?.() ?? v])));

const created = iface.getEvent("OrderCreated");
const topic = iface.getEventTopic(created);
console.log("OrderCreated:", created.format("full"));
const head = parseInt(await rpc<string>("eth_blockNumber", [], config.readRpcUrl), 16);
const logs: any[] = [];
for (let from = head - N; from < head; from += 100) {
  logs.push(...await rpc<any[]>("eth_getLogs", [{ address: config.market, topics: [topic], fromBlock: "0x" + from.toString(16), toBlock: "0x" + Math.min(head, from + 99).toString(16) }], config.readRpcUrl));
}
const byOwner = new Map<string, { orders: number; txs: Set<string> }>();
for (const l of logs) {
  const ev = iface.parseLog(l);
  const o = String(ev.args.owner).toLowerCase();
  const e = byOwner.get(o) ?? { orders: 0, txs: new Set() };
  e.orders++; e.txs.add(l.transactionHash);
  byOwner.set(o, e);
}
const minutes = (N * 0.3) / 60;
console.log(`\n${logs.length} orders created in ${N} blocks (~${minutes.toFixed(0)} min) by ${byOwner.size} owners:`);
for (const [o, e] of [...byOwner].sort((a, b) => b[1].txs.size - a[1].txs.size).slice(0, 8)) {
  console.log(`  ${o}  ${e.orders} orders in ${e.txs.size} txs (${(e.txs.size / minutes).toFixed(1)} tx/min)`);
  for (const h of [...e.txs].slice(-3)) {
    const [tx, r] = await Promise.all([rpc<any>("eth_getTransactionByHash", [h], config.readRpcUrl), rpc<any>("eth_getTransactionReceipt", [h], config.readRpcUrl)]);
    let shape = "?";
    try {
      const d = iface.parseTransaction({ data: tx.input });
      shape = d.name === "batchUpdate" ? `batchUpdate ${d.args[0].length} buys ${d.args[2].length} sells ${d.args[4].length} cancels` : d.name;
    } catch { shape = `to ${tx.to?.slice(0, 10)} (router/contract)`; }
    console.log(`      gasUsed ${parseInt(r.gasUsed, 16).toLocaleString()} limit ${parseInt(tx.gas, 16).toLocaleString()} | ${shape}`);
  }
}
