import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
const url = process.argv[2]!;
const provider = new ethers.providers.JsonRpcBatchProvider(url, 143);
let calls: string[] = [];
const orig = provider.send.bind(provider);
provider.send = (m: string, p: any[]) => { calls.push(m); return orig(m, p); };
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const params = await Kuru.ParamFetcher.getMarketParams(provider, MARKET);
calls = [];
for (let i = 0; i < 4; i++) { const t = Date.now(); await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params); console.log("read", Date.now() - t, "ms", "calls:", calls.join(",")); calls = []; }
