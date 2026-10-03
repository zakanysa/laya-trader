const rpc = "https://rpc.monad.xyz";
async function bn() { const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }) }); return parseInt((await r.json()).result, 16); }
let last = 0, lastT = 0; const t0 = Date.now(); const gaps: number[] = []; const lat: number[] = [];
while (Date.now() - t0 < 4000) { const a = Date.now(); const b = await bn(); lat.push(Date.now() - a); if (b !== last) { if (last) gaps.push(Date.now() - lastT); last = b; lastT = Date.now(); } await Bun.sleep(60); }
console.log("rpc latency ms avg", Math.round(lat.reduce((x, y) => x + y, 0) / lat.length), "min", Math.min(...lat), "max", Math.max(...lat));
console.log("block gaps ms", gaps.join(","));
