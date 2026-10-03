import { ethers } from "ethers";
import OrderBookAbi from "@kuru-labs/kuru-sdk/abi/OrderBook.json";
const iface = new ethers.utils.Interface(OrderBookAbi.abi);
for (const n of ["getL2Book","getVaultParams","getMarketParams","bestBidAsk","placeAndExecuteMarketBuy","placeAndExecuteMarketSell"]) {
  const f = iface.getFunction(n);
  console.log(iface.getSighash(f), f.format("full"));
}
console.log("view fns:", Object.values(iface.functions).filter(f=>f.stateMutability==="view").map(f=>f.name).join(", "));
