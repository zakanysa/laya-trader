import { ethers } from "ethers";
import * as Kuru from "@kuru-labs/kuru-sdk";
const provider = new ethers.providers.StaticJsonRpcProvider("https://rpc.monad.xyz", 143);
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const t0 = Date.now();
const params = await Kuru.ParamFetcher.getMarketParams(provider, MARKET);
console.log("params", Date.now() - t0, "ms", JSON.stringify(params, (k, v) => (v?._hex ? v.toString() : v)));
for (let i = 0; i < 3; i++) {
  const t1 = Date.now();
  const book = await Kuru.OrderBook.getFormattedL2OrderBook(provider, MARKET, params);
  console.log("book", Date.now() - t1, "ms block", book.blockNumber, "asks", JSON.stringify(book.asks.slice(0, 3)), "bids", JSON.stringify(book.bids.slice(0, 3)), "vault spread", book.vaultParams?.spread?.toString());
}
const ob = new ethers.Contract(MARKET, ["function bestBidAsk() view returns (uint32,uint32)"], provider);
const t2 = Date.now(); const [bb, ba] = await ob.bestBidAsk(); console.log("bestBidAsk", Date.now() - t2, "ms", bb.toString(), ba.toString());
