// Trace every JSON-RPC call ethers makes for Market.init / readBook / execute paths.
// Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run scripts/trace-rpc.ts
import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";

const RPC = "https://rpc.monad.xyz";
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const iface = new ethers.utils.Interface(OrderBookAbi.abi);
const sel = (data: string) => { try { return iface.getFunction(data.slice(0, 10)).name; } catch { return data.slice(0, 10); } };

function instrument(p: ethers.providers.JsonRpcProvider, tag: string) {
  const orig = p.send.bind(p);
  p.send = async (method: string, params: any[]) => {
    const t = performance.now();
    let summary = "";
    if (method === "eth_call" || method === "eth_estimateGas") {
      const tx = params[0];
      summary = `to=${tx.to?.slice(0, 10)} fn=${sel(tx.data ?? "0x")} from=${tx.from?.slice(0, 10) ?? "-"} blockTag=${params[1] ?? "-"}`;
    } else if (method === "eth_getTransactionCount") summary = `addr=${params[0].slice(0, 10)} tag=${params[1]}`;
    try {
      const r = await orig(method, params);
      console.log(`[${tag}] ${method.padEnd(24)} ${(performance.now() - t).toFixed(0).padStart(4)}ms ${summary} ${typeof r === "string" ? `-> ${r.length} chars` : ""}`);
      return r;
    } catch (e: any) {
      console.log(`[${tag}] ${method.padEnd(24)} ${(performance.now() - t).toFixed(0).padStart(4)}ms ${summary} -> ERROR ${(e.error?.message ?? e.message ?? "").slice(0, 120)}`);
      throw e;
    }
  };
}

const provider = new ethers.providers.StaticJsonRpcProvider(RPC, 143);
instrument(provider, "static");
const wallet = new ethers.Wallet(ethers.Wallet.createRandom().privateKey, provider);
console.log("throwaway wallet", wallet.address);

// ---- (1) Market.init ----
console.log("\n== init: getMarketParams");
let t = performance.now();
const params = await Kuru.ParamFetcher.getMarketParams(provider, MARKET);
console.log("getMarketParams total", (performance.now() - t).toFixed(0), "ms");
console.log("\n== init: getGasPrice");
const gasPrice = await provider.getGasPrice();
console.log("gasPrice", ethers.utils.formatUnits(gasPrice, "gwei"), "gwei");
console.log("\n== init: getTransactionCount");
const nonce = await provider.getTransactionCount(wallet.address);
console.log("\n== init: usdc.allowance");
const usdc = new ethers.Contract(params.quoteAssetAddress, ["function allowance(address,address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], wallet);
const allowance = await usdc.allowance(wallet.address, MARKET);
console.log("allowance", allowance.toString());
console.log("\n== init: usdc.approve (will fail: no funds) - tracing the populate path");
try { await usdc.approve(MARKET, ethers.constants.MaxUint256, { nonce }); } catch (e: any) { console.log("approve failed as expected:", (e.reason ?? e.code ?? e.message).toString().slice(0, 100)); }

// ---- (2) Market.readBook ----
console.log("\n== readBook: getFormattedL2OrderBook x3");
for (let i = 0; i < 3; i++) {
  t = performance.now();
  const b = await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params);
  console.log(`readBook total ${(performance.now() - t).toFixed(0)}ms block=${b.blockNumber} bid=${b.bids[0]![0]} ask=${b.asks.at(-1)![0]} levels bids=${b.bids.length} asks=${b.asks.length} manual bids=${b.manualOrders.bids.length} asks=${b.manualOrders.asks.length}`);
  const v = b.vaultParams;
  console.log("  vaultParams:", JSON.stringify({ kuruAmmVault: v.kuruAmmVault, vaultBestBid: v.vaultBestBid.toString(), vaultBestAsk: v.vaultBestAsk.toString(), vaultBidOrderSize: v.vaultBidOrderSize.toString(), vaultAskOrderSize: v.vaultAskOrderSize.toString(), bidPartiallyFilledSize: v.bidPartiallyFilledSize.toString(), askPartiallyFilledSize: v.askPartiallyFilledSize.toString(), spread: v.spread.toString() }));
}

// ---- (3) Market.execute: buy then sell ----
const book = await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params);
const ask = book.asks.at(-1)![0]!, bid = book.bids[0]![0]!;
const sizeMon = 200;
const txOptions = { gasPrice, nonce };
for (const side of ["buy", "sell"] as const) {
  console.log(`\n== execute ${side}: construct tx (gasPrice+nonce supplied, no gasLimit)`);
  t = performance.now();
  try {
    const tx = side === "buy"
      ? await Kuru.IOC.constructMarketBuyTransaction(wallet, MARKET, params, (sizeMon * ask * 1.003).toFixed(6), ethers.utils.parseUnits((sizeMon * 0.995).toFixed(6), 18).toString(), false, false, txOptions)
      : await Kuru.IOC.constructMarketSellTransaction(wallet, MARKET, params, sizeMon.toFixed(4), ethers.utils.parseUnits((sizeMon * bid * 0.995).toFixed(6), 6).toString(), false, false, txOptions);
    console.log("constructed", JSON.stringify(tx, (k, v) => (v?._hex ? v.toString() : v)));
  } catch (e: any) {
    console.log(`construct failed after ${(performance.now() - t).toFixed(0)}ms:`, (e.reason ?? e.code ?? e.message).toString().slice(0, 160));
  }
  console.log(`== execute ${side}: construct tx WITH gasLimit supplied`);
  t = performance.now();
  const tx2 = side === "buy"
    ? await Kuru.IOC.constructMarketBuyTransaction(wallet, MARKET, params, (sizeMon * ask * 1.003).toFixed(6), ethers.utils.parseUnits((sizeMon * 0.995).toFixed(6), 18).toString(), false, false, { ...txOptions, gasLimit: ethers.BigNumber.from(400_000) })
    : await Kuru.IOC.constructMarketSellTransaction(wallet, MARKET, params, sizeMon.toFixed(4), ethers.utils.parseUnits((sizeMon * bid * 0.995).toFixed(6), 6).toString(), false, false, { ...txOptions, gasLimit: ethers.BigNumber.from(400_000) });
  console.log(`constructed in ${(performance.now() - t).toFixed(0)}ms (should be 0 RPC) value=${tx2.value?.toString()} gasLimit=${tx2.gasLimit?.toString()} data=${sel(tx2.data as string)}`);
  t = performance.now();
  const signed = await wallet.signTransaction({ ...tx2, chainId: 143 });
  console.log(`signTransaction ${(performance.now() - t).toFixed(1)}ms (should be 0 RPC), ${signed.length} chars`);
}

// bare eth_sendRawTransactionSync of the signed sell to see the node's response shape/timing (will be rejected: no funds)
console.log("\n== eth_sendRawTransactionSync of unfunded tx (expect error)");
t = performance.now();
const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_sendRawTransactionSync", params: [await wallet.signTransaction({ to: MARKET, data: "0x", value: 0, gasLimit: 21000, gasPrice, nonce, chainId: 143 })] }) });
console.log((performance.now() - t).toFixed(0), "ms", JSON.stringify(await res.json()).slice(0, 200));
