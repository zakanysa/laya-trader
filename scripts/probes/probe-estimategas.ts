// Does eth_estimateGas accept the SDK's hardcoded gasPrice=1 gwei (below Monad's ~100 gwei base fee) from a funded account?
const RPC = "https://rpc.monad.xyz";
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const post = async (method: string, params: unknown[]) => (await (await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) })).json()) as any;
const blk = await post("eth_getBlockByNumber", ["latest", true]);
console.log("block", parseInt(blk.result.number, 16), "baseFeePerGas", parseInt(blk.result.baseFeePerGas, 16) / 1e9, "gwei, txs", blk.result.transactions.length);
const froms: string[] = [...new Set(blk.result.transactions.map((t: any) => t.from as string))].slice(0, 5) as string[];
for (const from of froms) {
  const bal = Number(BigInt((await post("eth_getBalance", [from, "latest"])).result)) / 1e18;
  if (bal < 1) continue;
  const r1 = await post("eth_estimateGas", [{ from, to: MARKET, data: "0xb4de8b70", gasPrice: "0x3b9aca00" }]);
  const r2 = await post("eth_estimateGas", [{ from, to: MARKET, data: "0xb4de8b70" }]);
  console.log(`from=${from.slice(0, 10)} bal=${bal.toFixed(2)} MON  gasPrice=1gwei -> ${JSON.stringify(r1.result ?? r1.error)}   no gasPrice -> ${JSON.stringify(r2.result ?? r2.error)}`);
  break;
}
