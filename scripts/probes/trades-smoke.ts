import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "../src/config";
import { rpc } from "../src/chain";
import { log10 } from "../src/book";
import { TradeFeed } from "../src/trades";

const url = "https://rpc.monad.xyz";
const provider = new ethers.providers.StaticJsonRpcProvider(url, config.chainId);
const params = await Kuru.ParamFetcher.getMarketParams(provider, config.market);
// Trade.price is 1e18-scaled on-chain (not pricePrecision, which is 1e8 here); TradeFeed defaults priceDec to 18.
const sizeDec = log10(params.sizePrecision); // MON-USDC: 10
console.log(`market ${config.market} pricePrecision=${params.pricePrecision} sizeDec=${sizeDec}`);

const feed = new TradeFeed({ market: config.market, url, sizeDec });
const block = parseInt(await rpc<string>("eth_blockNumber", [], url), 16);
// Warm up over a wider window: the feed chunks into 100-block eth_getLogs calls (public RPC limit).
const LOOKBACK = Number(process.env.LOOKBACK ?? 1000);
let t0 = performance.now();
await feed.poll(block - LOOKBACK + 20);
await feed.poll(block);
console.log(`block ${block} lookback ${LOOKBACK} polled in ${(performance.now() - t0).toFixed(0)}ms lastBlock=${feed.lastBlock}`);
console.log("summary(100):", feed.summary(100, block));
console.log(`summary(${LOOKBACK}):`, feed.summary(LOOKBACK, block));
console.log("recent(5):", feed.recent(5));
