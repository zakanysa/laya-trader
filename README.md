# Laya Trader

**Can a small bot make money trading on an on-chain order book?** This project started as a fork of [jev-trader](https://github.com/jarrodwatts/jev-trader), a demo where an AI model makes a buy or sell call on every 300 ms [Monad](https://monad.xyz) block and posts an order on Kuru's on-chain order book. The fork swapped TypeSafe's closed Jev model for [Laya](https://github.com/NandhaKishorM/laya), its open-weights alternative. When the goal became making money, it turned into a measured study of whether any strategy here survives real costs.

**The answer was no.** The evidence:

| Approach | Result |
|---|---|
| The original design (a new order every block) | **−$16/h** in simulation: gas costs ~10x what the orders can earn |
| An AI predicting 30-second direction (Jev, Laya) | Not worth training: the signals it would learn from (momentum, taker flow, even Binance's lead) scored 50–52%, inside the noise |
| Market making around Binance's price, MON-USDC | 0 of 360 settings profitable after gas |
| Same, on the best Kuru market (cbBTC-USDC) | +$0.35/h of edge in a 48 h live forward test, swamped by ±$20–75 inventory swings: **no-go** |

Twice, a strategy looked profitable and wasn't: once by holding MON in a 17% rally, once by riding BTC's moves. Both were caught by breaking P&L down into the edge at the fill and what inventory did. The methods that caught them are the useful output here. **[RETROSPECTIVE.md](RETROSPECTIVE.md) has the full story, the numbers, and what might work instead.**

## What's in it

| Part | Where |
|---|---|
| Laya as a drop-in for Jev: a compact market state, a Jev-compatible model server, a client | `src/laya.ts`, `laya/` |
| A data collector and a Kaggle notebook that fine-tunes Laya with a time-ordered split, baselines and calibration | `STATE_LOG=true`, `notebooks/` |
| A deliberately pessimistic exchange simulator: latency, reverts, queue position, gas, faster traders picking off stale quotes | `src/sim.ts` |
| Two-sided market making around a Binance-based fair value, re-quoting only when needed | `src/strategy.ts`, `src/fair.ts` |
| A backtester: tuned on older data, tested on newer, stress tests, ranked by P&L without inventory luck | `scripts/backtest.ts` |
| Market research: scan every Kuru market, rebuild any order book from chain state, fetch Kuru and Binance history | `scripts/scan-markets.ts`, `backfill-book.ts`, `fetch-market.ts`, `fetch-history.ts`, `probe-makers.ts` |
| A live or dry-run market maker (the dry run is a forward test using the same simulator), with reporting | `STRATEGY=maker`, `src/maker.ts`, `scripts/maker-report.ts` |

Bun and TypeScript throughout, ethers v5 and the Kuru SDK on Monad, Python for Laya and the notebook, Next.js for the inherited dashboard in `web/`.

## Running it

Experimental research code, not financial advice. Without `PRIVATE_KEY` everything below is a dry run: real market data, simulated fills, no wallet. The live maker path has not been run with real funds.

    bun install
    bun run start                         # the original directional bot, mock model, dry run

### Models: mock, Jev, Laya

`MODEL=mock` (default) is a momentum stand-in. `MODEL=jev` with `TYPESAFE_AI_API_KEY` uses Jev. `MODEL=laya` talks to a self-hosted Laya:

    STATE_LOG=true bun run start                              # 1. collect training rows to data/laya/ (~250 MB/day)
    # 2. upload data/laya/ to Kaggle, run notebooks/laya_trader_finetune_kaggle.ipynb on GPU T4 x2
    pip install -r laya/requirements.txt
    LAYA_CHECKPOINT=./laya-trader python laya/server.py       # 3. serve it (needs a GPU to fit a 300 ms block)
    MODEL=laya bun run start

`laya/question.json` is the one question both the bot and the notebook use. Changing it, or the state in `src/laya.ts` (bump `LAYA_STATE_VERSION`), means fresh data and retraining.

### Research tools

    bun run scripts/scan-markets.ts 24                        # every Kuru market: volume, spread, competition, Binance reference
    bun run scripts/backfill-book.ts <market> 24 3            # rebuild its book every 3 blocks (public RPC keeps ~5.5 days)
    bun run scripts/fetch-market.ts <market> BTCUSDT          # its Kuru trades + Binance 1 s prices
    bun run scripts/backtest.ts --market <market> --mon-usd 0.034 --pickoff 3 --rank hedged
    bun run scripts/backtest.ts --market <market> --mon-usd 0.034 --params '{...}' --windows 6 --ref-delay 2000
    bun run scripts/backtest.ts                                # MON-USDC from the collected data (needs fetch-history.ts first)

`rpc.monad.xyz` allows 50 calls a second, counting each call in a batch. Run backfills against `READ_RPC_URL=https://rpc1.monad.xyz` so a running bot keeps its share.

### Maker mode

    STRATEGY=maker MARKET=0x40c49f171202f91ff5d2fae34c22dd2bfdd22af0 REF_SYMBOL=BTCUSDT REF_VENUE=spot \
    HALF_SPREAD_BPS=3 REQUOTE_BPS=8 DANGER_BPS=2 QUOTE_SIZE=0.00239 MAX_INVENTORY=0.0359 SKEW_BPS=2 \
    MAX_LOSS_USD=25 bun run start
    bun run scripts/maker-report.ts                            # P&L, P&L without inventory, windows, busy vs quiet hours

Two-sided post-only quotes around Binance's price, sent in one `batchUpdate` and replaced only when they drift or become dangerous. Live, the wallet needs MON for gas and margin in both assets (`MARGIN_BASE`, `MARGIN_QUOTE`). `MAX_LOSS_USD` pulls every quote but **does not close the position**. In the forward test the loss kept running to −$76 after a −$25 stop, so fix that before any live use.

## How it fits together

    src/config.ts     env
    src/chain.ts      block feed (WebSocket newHeads + polling backstop), raw RPC
    src/book.ts       one-eth_call order book reader (getL2Book, AMM vault)
    src/market.ts     Kuru: batchUpdate (one side or both), margin deposits, nonce, receipts
    src/trades.ts     Trade-log feed: everyone's prints, and our fills
    src/model.ts      directional models: mock, Jev, Laya (src/laya.ts)
    src/trader.ts     directional loop: one order per block
    src/maker.ts      maker loop: live, or dry run on src/sim.ts
    src/strategy.ts   where to quote, and when to re-quote
    src/fair.ts       fair value: Binance price x slow Kuru basis
    src/binance.ts    Binance trade stream, with a stall watchdog
    src/sim.ts        pessimistic exchange simulator (shared by backtest and dry run)
    src/server.ts     snapshot, history, SSE for the dashboard

The original bot's event format and its 300 ms latency budget are documented in [docs/original-bot.md](docs/original-bot.md), and the upstream product spec in [docs/upstream-spec.md](docs/upstream-spec.md).

## Credits

Built on [jev-trader](https://github.com/jarrodwatts/jev-trader) by Jarrod Watts (MIT). [Laya](https://huggingface.co/convaiinnovations/laya) by Convai Innovations (Apache 2.0). Market data from Kuru on Monad and Binance's public APIs. Licensed MIT, see [LICENSE](LICENSE).
