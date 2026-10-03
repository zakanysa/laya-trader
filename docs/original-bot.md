# The original directional bot

How the bot inherited from [jev-trader](https://github.com/jarrodwatts/jev-trader) works: one decision every Monad block. A model (`MODEL=mock`, `jev` or `laya`) watches the Kuru MON-USDC order book and answers buy or sell every ~300 ms. Every block posts a real post-only limit order on that side, one tick inside the touch, replacing the last one. Fills happen when a taker hits it. A small server streams every block to the dashboard in `web/`.

The economics of this design are in [RETROSPECTIVE.md](../RETROSPECTIVE.md): a transaction every block costs about 10x what the order can earn.

## Endpoints

`src/server.ts`, on `PORT` (3000):

- `GET /` snapshot: model, wallet, dryRun, latest block event
- `GET /history` last 1000 block events
- `GET /events` SSE: `snapshot` on connect, then one `block` event per block, plus `quote` and `fill` events as receipts and fills land (`maker` events in maker mode)

Every block event (see `src/trader.ts` for types):

    {
      "block": 105488269, "ts": 1789593630676,
      "mid": 0.022636, "bestBid": 0.022628, "bestAsk": 0.022644, "spreadBps": 7.07,
      "decision": { "action": "buy", "probabilities": { "buy": 0.77, "sell": 0.23, "hold": 0 }, "upIn10": 0.77, "latencyMs": 81, "late": false },
      "quote": { "side": "buy", "price": 0.022629, "size": 200, "txHash": "0x…", "gasMon": 0.0357, "cancel": [100295801], "status": "sent", "orderId": null, "capped": false },
      "fill": null,
      "resting": { "bidMon": 200, "askMon": 200 },
      "position": { "side": "short", "size": 200, "entryPrice": 0.022633, "unrealizedUsd": -0.0006, "unrealizedMon": -0.027 },
      "totals": { "blocks": 3, "decisions": 3, "quotes": 3, "fills": 1, "reverted": 0, "lateBlocks": 0, "jevUsd": 0.000004, "gasMon": 0.107, "gasUsd": 0.0024, "realizedUsd": 0, "pnlUsd": -0.003, "pnlMon": -0.13, "pnlPct": -0.003 }
    }

Every block the model is asked about the move over `HORIZON_BLOCKS` (default 100, ~30 s) and answers `buy` or `sell`. `quote` is the order that block put on the book: a post-only limit order of `TRADE_SIZE_MON` on that side, `QUOTE_INSIDE_TICKS` inside the touch (clamped to the touch when the spread is too tight), in one `batchUpdate` that also cancels everything resting (`cancel`). `hold` appears only with `decision.late: true`, when the model missed the block and nothing was posted. When the position cap (or, live, margin funds) blocks a side, the quote goes on the other side with `capped: true`, and `probabilities` still show the model's call. `resting` is our size known to be on the book after this block. `upIn10` equals the buy probability. `totals.jevUsd` is model spend whatever the model (zero for self-hosted Laya); `gasMon` counts estimated gas in a dry run too.

Live sends are fired and forgotten, so the `block` event carries the **intent**: `status: "sent"`, and `gasMon` is `gasLimit x (last known base fee + priority)`. Monad charges the gas limit, so that is the real cost whether the order lands or not. The receipt arrives a block or two later as its own event:

    event: quote
    data: { "block": 105488269, "quote": { …, "status": "placed", "orderId": 100295812, "gasMon": 0.0357 } }

`status` becomes `placed` (with the order id) or `reverted` (the book moved through the price before the tx landed, or a cancelled order had already filled). No receipt after 10 blocks gives `lost`. Fills are not in our own transactions: someone else's taker order hits our resting one, and the Trade log for it arrives via the same `eth_getLogs` poll that feeds the model:

    event: fill
    data: { "block": 105488271, "fill": { "side": "buy", "size": 200, "price": 0.022629, "txHash": "0x…", "orderId": 100295812, "simulated": false } }

`txHash` is the taker's transaction. In a dry run the quote is `status: "sim"`: the order rests for one block and a real print crossing its price fills it (`simulated: true`).

## The 300 ms budget

A decision and an order have to fit in one block, so the hot loop makes exactly two RPC round trips: one `eth_call` for the book (~18 ms on the public RPC, `READ_RPC_URL`) and one `eth_sendRawTransaction` (`RPC_URL`), which returns as soon as the tx is accepted. Nothing else is on the path: no `eth_estimateGas` (Monad charges gas on the limit, so the limit is derived once at startup), no `eth_sendRawTransactionSync` (it blocks until the tx is proposed), no gas price lookup (static type-2 fees: `MAX_FEE_GWEI` cap, 2 gwei priority; the effective price is base + priority). Receipts, the fee estimate and the vault check run off the hot path on later blocks. Measured in a dry run with the mock model: read p50 18 ms, whole loop p50 100 ms (80 ms of it the mock's inference stand-in). Self-hosted Laya needs a GPU to fit: on CPU it takes 750–840 ms per decision.

    bun run scripts/bench-read.ts     # book reader vs the SDK: exactness and latency
    bun run scripts/dry-encode.ts     # signs a buy and a sell offline, asserts the calldata matches the SDK
