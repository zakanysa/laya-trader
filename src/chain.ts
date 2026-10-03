import { config } from "./config";

/** Raw JSON-RPC call over HTTP. Defaults to the send RPC; pass `config.readRpcUrl` for reads. */
export async function rpc<T = unknown>(method: string, params: unknown[] = [], url = config.rpcUrl): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: { code: number; message: string } };
  if (json.error) throw new Error(`${method}: ${json.error.message} (${json.error.code})`);
  return json.result as T;
}

/**
 * Emits new block numbers, coalesced to the newest one.
 * Primary: WebSocket newHeads (fires when a block is Proposed).
 * Backstop: HTTP polling on the read RPC, so the loop keeps running if the socket drops.
 * A burst of heads in one tick runs the loop once, for the newest block only — never for a stale one.
 */
export function startBlockFeed(onBlock: (block: number) => void, pollMs = 150) {
  let last = 0, newest = 0, scheduled = false;
  const emit = (block: number) => {
    if (!Number.isFinite(block) || block <= last) return; // a throttled RPC can answer without a result
    last = newest = block;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => { scheduled = false; onBlock(newest); }, 0);
  };

  const poll = async () => {
    try { emit(parseInt(await rpc<string>("eth_blockNumber", [], config.readRpcUrl), 16)); } catch {}
  };
  setInterval(poll, pollMs);
  poll();

  if (!config.wsUrl) return;
  const connect = (delay = 0) =>
    setTimeout(() => {
      const ws = new WebSocket(config.wsUrl!);
      ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_subscribe", params: ["newHeads"] }));
      ws.onmessage = (e) => {
        const m = JSON.parse(String(e.data));
        if (m.method === "eth_subscription") emit(parseInt(m.params.result.number, 16));
      };
      ws.onclose = () => connect(Math.min(delay + 1000, 10_000));
      ws.onerror = () => ws.close();
    }, delay);
  connect();
}
