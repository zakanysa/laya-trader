# Laya Trader: retrospective

**September 29 to October 3, 2026.** We forked [jarrodwatts/jev-trader](https://github.com/jarrodwatts/jev-trader), a demo bot that asks an AI for buy or sell on every 300 ms Monad block and posts an order on Kuru's on-chain order book. The goal changed twice. First it was "run it on Laya, the open-source Jev". Then it became "actually make money".

**Bottom line.** Nothing we built makes money after costs.

- **The original design loses about $16 an hour to gas.** No model can fix that.
- **Predicting 30-second direction is noise.** Every signal we tested, including the AI-model path, sat at 50–52% accuracy.
- **The one real edge was too small to trade.** On cbBTC-USDC, the best market we found, a pessimistic simulator and a 48-hour live forward test found an edge of about +$0.35 an hour. Inventory swings of ±$20–75 drowned it.

Every apparent win along the way turned out to be price luck, and the testing method caught it each time. That method is the part worth keeping.

---

## What we built

| Area | Files | What it does |
|---|---|---|
| Laya integration | `src/laya.ts`, `laya/question.json`, `laya/server.py` | A compact, scale-free market state (prices in bps from mid, about 536 tokens). A Laya model client, and an HTTP server that speaks Jev's `/v1/systemone` protocol. |
| Training data | `STATE_LOG=true` → `data/laya/` | One row per block: the exact state the model sees, plus the mid price to label from. 43 h collected (433k blocks, 91% coverage). |
| Fine-tuning | `notebooks/laya_trader_finetune_kaggle.ipynb` | A Kaggle 2×T4 notebook: time-ordered split with an embargo, baselines, a zero-shot check that confirms training tokens match inference, Laya's RLCD training with DDP, best-epoch selection, temperature calibration and a held-out test. Smoke-tested end to end on CPU; never run on Kaggle (abandoned once the economics were clear). |
| Pessimistic simulator | `src/sim.ts` | Simulates our orders on Kuru: 2-block latency, transactions that fail but still pay gas, queue position, fills only from the part of each real taker order that reaches our price, and faster traders picking off stale quotes. |
| Strategy | `src/strategy.ts`, `src/fair.ts` | Two-sided quotes around a Binance-based fair price. Re-quotes at once when a quote becomes dangerous, and lazily when it merely drifts. Leans against inventory. |
| Backtester | `scripts/backtest.ts` | Grid search on older data, evaluation on newer unseen data, stress tests (`--ref-delay`, `--pickoff`, `--latency`, `--gas`), per-window results, and `--rank hedged`. |
| Market research | `scripts/scan-markets.ts`, `backfill-book.ts`, `fetch-market.ts`, `fetch-history.ts`, `probe-makers.ts` | Finds every Kuru market, rebuilds any market's order book block by block from chain state, and downloads Kuru trades and Binance prices. Shows who the competing market makers are and how fast they update. |
| Live and dry-run maker | `src/maker.ts`, `src/binance.ts`, `STRATEGY=maker` | Two-sided `batchUpdate` quoting. The dry run uses the same simulator with live data, so it is a forward test of the backtest. Includes a stop-loss and a Binance watchdog. |
| Reporting | `scripts/maker-report.ts` | Per-run P&L, P&L without inventory, 6-hour windows, busy versus quiet hours, drawdown. |

---

## What we tried and what happened

### 1. Laya instead of Jev

- Laya swaps in for Jev mostly through configuration: `laya-serve` speaks Jev's wire protocol.
- **Latency:** on a CPU, Laya takes **750–840 ms per decision**, against a 300 ms block. Trading live needs a GPU.
- **Accuracy:** Laya's own published numbers put its base checkpoints near chance out of the box (0.36 against a 0.46 majority baseline). Any value would have to come from fine-tuning.
- **Was there a signal to learn?** On a full day of recorded data, momentum scored 50.7%, taker flow 49.9%, and the Binance–Kuru price gap 51.9%. The noise band was ±1.9 points. **There is next to nothing to learn** at a 30-second horizon, so fine-tuning was not worth the GPU time.

### 2. The original design's economics (37.7 h dry run, MON-USDC)

| | |
|---|---|
| Orders sent | 442,010 (one per block) |
| Simulated fills | 8,634 (229/h) |
| P&L before gas | −$0.38 |
| Gas if live | **$11.50–14.30/h**, about $430–540 for the run |
| Best possible spread income | $1.31/h |

Posting an order every block was the demo's selling point. It also costs about 10× the most the bot could earn.

### 3. MON-USDC strategies (31 h train, 7.5 h test, pessimistic simulator)

| Strategy | Train | Test |
|---|---|---|
| Original bot | −$16.09/h | −$17.22/h |
| Best of 360 market-making settings | −$0.99/h | −$3.79/h |
| "Profitable" lazy wide quoting | +$0.10/h | +$0.71/h, but holding MON alone earned more (MON rose 17% and 5%) |
| Taking Kuru's price when it lags Binance (90 settings) | 0 profitable | ~0 (2 trades) |

### 4. Market scan: every Kuru market (24 h)

| Market | Volume/day | Spread | Typical 5-min move | Fastest competitor |
|---|---|---|---|---|
| MON-USDC | $4.4M | 12.4 bps | 31.5 bps | 288 updates/min |
| cbBTC-USDC | $1.28M | 5.3 bps | 6.7 bps | 67/min |
| WETH-USDC | $1.16M | 5.4 bps | 6.0 bps | 72/min |
| XAUt0-USDC | $175k | 4.1 bps | 5.4 bps | 62/min |
| CETES-USDC | $828 | — | — | none |

Kuru charges **0% maker and 0% taker fees**, so gas is the only cost. Two professional market makers dominate the liquid markets. Kuru's $1.2M liquidity-incentive program reportedly ended in late August 2026.

### 5. cbBTC-USDC and WETH-USDC (22 h of order book rebuilt from chain state)

- **First pass, cbBTC:** looked like +$4.78/h on train and +$2.90/h on test, and survived every stress test.
- **Then the profit breakdown:** $76.05 of the $77.65 training profit came from **inventory riding BTC's moves**, which is luck. Ranked by P&L excluding inventory, the best cbBTC setting earned about +$0.9/h on train and +$2.9/h on test. That setting quotes 3 bps either side of fair with $200 orders, a $3k cap and 2 bps of skew. Inventory swung −$15 to −$21 on the same test.
- **WETH:** 14 of 2,304 settings were profitable excluding inventory, at about +$0.2–0.7/h.

### 6. Forward test: two 24 h dry runs on cbBTC with live data

| | Run 1 | Run 2 |
|---|---|---|
| Actually quoting | ~18 h (the Binance feed stalled for 6 h) | ~5 h, then the stop-loss halted it |
| Fills / picked off | 1,192 / 65 | 270 / 40 |
| P&L | −$9.83 | **−$56.47** |
| P&L without inventory | ≈ +$11.70 | −$3.66 |
| Worst drawdown | −$26.66 | **−$76.10** |

- **Edge:** about **+$8 over ~23 h of actual quoting (+$0.35/h)**, almost all from one overnight window. The backtest had predicted +$1–3/h.
- **What went wrong in run 2:** BTC fell 3.8%. Takers sold into our bid, and a 2-bps lean against inventory couldn't stop the position building. The stop-loss pulled quotes at −$25 but **kept the position**, and the loss kept growing.

---

## Why it didn't work

1. **Others are faster.** Kuru's professional market makers update 1–6 times a second. Through a public RPC at ~1 s round trips, we always quote with stale information, so our fills are mostly the ones a better-informed trader *wants* to give us. The Binance-leads-Kuru gap is real, but it's their edge, not ours.
2. **The cost structure.** A transaction per block costs about 10× the possible spread income. Even at around 50 updates an hour, gas is comparable to the edge.
3. **Prediction can't beat noise.** Thirty-second direction is close to a coin flip. A bigger or better model doesn't add signal that isn't in the data. Laya and Jev are text-encoder models reading numbers as text, which fits this job poorly and is slow.
4. **Inventory risk outweighs the edge.** An unhedged market maker carries the asset's price risk. With an edge of about $0.35/h and inventory swings of ±$20–75 a day, the result is decided by the market's direction. Hedging on Binance costs about 2–5 bps per side at standard futures fees, which is more than the 1–3 bps edge per fill.
5. **The markets are small.** Even a genuine edge on Kuru's cbBTC is worth a few dollars a day, and the capital at risk is thousands.
6. **The subsidy is gone.** Market making on a young venue usually pays through incentive programs, and Kuru's ended before we started.

---

## What transfers (the valuable part)

- **Assume trouble.** A simulator should assume latency, failed transactions, queue position and adversarial pick-offs. Historical trades can't show the trades your own stale quotes would have attracted, so model that explicitly.
- **Split by time, with an embargo.** Random splits leak when neighbouring samples share a future.
- **Break P&L down before believing it.** Separate the edge at fill time, inventory gains or losses measured against a fair price, and gas. Twice, an apparent profit was inventory luck: long MON in a rally, and cbBTC's +$4.78/h. Rank by P&L excluding inventory.
- **Stress-test the winner:** a delayed reference price, harsher pick-offs, slower landing, double gas, several time windows.
- **Forward-test with the same simulator before using real money.** The 48-hour dry run cut the expected edge by roughly 3–8× and exposed two production bugs: a stalled feed and a stop-loss that didn't close the position.
- **Measure the noise band.** With N independent test windows, accuracy differences under ±1.96·√(0.25/N) are noise. Overlapping windows are not independent.

---

## What could still work (ranked, with the evidence we have)

1. **Market making where the venue pays: incentive programs, points and rebates.**
   - Here the edge is the subsidy, not out-trading professionals, and that's how most retail market making on new venues makes money.
   - Watch Kuru and other new chains for programs. Then quantify reward per dollar-hour of liquidity against the adverse selection and inventory risk this repo can measure (`maker.ts`, `sim.ts`, `maker-report.ts`).
2. **Funding-rate or basis carry,** meaning hold spot and short the perpetual, *when funding is high*.
   - Speed doesn't matter, and the risks are well understood: funding turning negative, exchange risk, liquidation, about 0.3% to enter and exit.
   - **Measured on 2026-10-03, last 12 months on Binance:** BTC 3.4% a year (76% of periods positive), ETH 2.5%, SOL −1.7%, MON −2.5%. That's below stablecoin yields, so it's **not worth it now**.
   - Worth an alert, e.g. when 30-day funding goes above 15% a year. That happens in strong bull markets.
3. **Slower systematic strategies** (daily or 4-hour trend and momentum across many liquid assets).
   - Again speed is irrelevant, and Binance's free kline archive is enough to backtest.
   - Expect a risk premium, not an edge, with modest risk-adjusted returns and deep drawdowns. It's closer to investing than trading.
4. **Long-tail venues without professional market makers** (new listings, thin prediction markets).
   - There is room to be the best price, but capacity is small, and there is a reason the professionals aren't there: volume, fees or risk.
   - Check fees and competition first; `scan-markets.ts` shows the method.

What we would not try again: a model making buy/sell calls every few seconds on a thin market, or any design whose cost grows with the number of decisions.

---

## Facts and gotchas

- **Monad:**
  - ~0.3–0.33 s blocks (about 11,000 per hour).
  - Gas is charged on the gas **limit**, not on gas used.
  - Base fee was about 100 gwei plus 2 priority.
  - Block timestamps are whole seconds.
- **`rpc.monad.xyz`:**
  - 50 calls/second per client, **counting every call inside a batch**.
  - A rate-limited reply can have no result and no error. Guard for it, or a block number becomes `NaN`.
  - Historical state is kept for about **132 h (5.5 days)**. Trade logs go back months.
  - `rpc1`/`rpc2.monad.xyz` accept 30-call batches. `rpc3` and Ankr reject them, and `rpc-mainnet.monadinfra.com` blocks `eth_call`.
- **Kuru:**
  - MON-USDC, cbBTC-USDC and WETH-USDC settle through one margin account (`0x2A68…90c5`, `verifiedMarket` true for all three).
  - `batchUpdate(buyPrices, buySizes, sellPrices, sellSizes, cancelIds, postOnly)` handles both sides in one transaction. Cancelling an already-filled order **reverts the whole transaction**.
  - `Trade.price` is always 1e18-scaled. The MON-USDC minimum order is 200 MON, with a tick of 1e-6; cbBTC-USDC's tick is $0.01.
- **Binance:**
  - The public WebSocket can **stall without closing**, so add a watchdog.
  - The MONUSDT perpetual tracks Kuru MON within about 0.1% (5-minute return correlation 0.85).
  - Spot `BTCUSDT`/`ETHUSDT` 1-second klines are free through REST.
- **Repo:**
  - Upstream files have CRLF line endings.
  - `tsconfig.json` only type-checks `src/`, so check `scripts/` separately.

## Data (local only, in `data/`, which is git-ignored)

| Path | Size | Contents |
|---|---|---|
| `data/laya/states-*.jsonl` | 425 MB | 43 h of MON-USDC per-block model states and mids |
| `data/backtest/` | 25 MB | Kuru MON-USDC trades and Binance MONUSDT trades for that span |
| `data/markets/<cbBTC>/`, `<WETH>/` | 24 MB, 28 MB | Rebuilt books (every 3 blocks, ~24 h), Kuru trades, Binance 1-second prices, market params |
| `data/maker-events.jsonl`, `maker-dryrun-cbbtc*.log` | 6 MB | The forward-test runs |
| `data/events.jsonl` | 363 MB | The original bot's per-block log (safe to delete) |
