// Probe: does rpc.monad.xyz accept JSON-RPC batches? Does eth_estimateGas accept the SDK's 1 gwei gasPrice from a funded account?
// Raw fetch latency of getL2Book vs bestBidAsk. Run: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun run scripts/probe-rpc-caps.ts
const RPC = "https://rpc.monad.xyz";
const MARKET = "0x065C9d28E428A0db40191a54d33d5b7c71a9C394";
const VAULT = "0x838c2d3fD4DB5eB2F185cbE7697fbaAce52b34d7";
const post = async (body: unknown) => { const t = performance.now(); const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); const j = await r.json(); return { ms: performance.now() - t, j }; };
const call = (id: number, data: string, tag: string | number = "latest") => ({ jsonrpc: "2.0", id, method: "eth_call", params: [{ to: MARKET, data }, tag] });

// batch of two eth_calls
for (let i = 0; i < 3; i++) {
  const { ms, j } = await post([call(1, "0x46fdfbb1"), call(2, "0x88bb4f60")]);
  console.log(`batch(getL2Book,getVaultParams) ${ms.toFixed(0)}ms isArray=${Array.isArray(j)} lens=${Array.isArray(j) ? j.map((x: any) => x.result?.length ?? JSON.stringify(x.error)).join(",") : JSON.stringify(j).slice(0, 200)}`);
}
// single getL2Book raw
for (let i = 0; i < 5; i++) { const { ms, j } = await post(call(1, "0x46fdfbb1")); console.log(`raw getL2Book ${ms.toFixed(0)}ms len=${j.result?.length}`); }
// bestBidAsk raw
for (let i = 0; i < 3; i++) { const { ms, j } = await post(call(1, "0xb4de8b70")); const r = j.result as string; console.log(`raw bestBidAsk ${ms.toFixed(0)}ms bid=${BigInt("0x" + r.slice(2, 66))} ask=${BigInt("0x" + r.slice(66, 130))}`); }
// estimateGas with 1 gwei gas price from a funded account (the market contract itself holds MON; also the vault)
for (const from of [MARKET, VAULT]) {
  const { ms, j } = await post({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ from, to: MARKET, value: "0x0", data: "0xb4de8b70", gasPrice: "0x3b9aca00" }] });
  console.log(`estimateGas from=${from.slice(0, 10)} gasPrice=1gwei ${ms.toFixed(0)}ms ->`, JSON.stringify(j).slice(0, 160));
  const b = await post({ jsonrpc: "2.0", id: 1, method: "eth_getBalance", params: [from, "latest"] });
  console.log(`  balance ${Number(BigInt(b.j.result)) / 1e18} MON`);
}
// estimateGas with explicit gasPrice below base fee vs none
const { j: noGp } = await post({ jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ from: MARKET, to: MARKET, data: "0xb4de8b70" }] });
console.log("estimateGas no gasPrice ->", JSON.stringify(noGp).slice(0, 120));
// block time sanity: two eth_blockNumber 300ms apart
const b1 = await post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }); await new Promise(r => setTimeout(r, 1000)); const b2 = await post({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] });
console.log("blocks in ~1s:", parseInt(b2.j.result, 16) - parseInt(b1.j.result, 16));
