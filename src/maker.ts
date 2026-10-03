/**
 * The maker strategy (STRATEGY=maker), live or as a dry run.
 *
 * Every block: read the book, update fair value (Binance trades arrive on their own WebSocket),
 * account for fills, and, when no quote update is in flight, compare where we rest with where
 * src/strategy.ts wants us. One batchUpdate goes out only when shouldRequote says so.
 *
 * Live: our orders are known from receipts (OrderCreated / OrdersCanceled) and fills from Trade
 * logs where we are the maker. Dry run: src/sim.ts plays the exchange, fed with the same live Kuru
 * taker orders and Binance price, and charges the gas each update would cost, exactly as the
 * backtest does. So a dry run is a forward test of the backtest's numbers.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import * as Kuru from "@kuru-labs/kuru-sdk";
import { config } from "./config";
import { readBook } from "./book";
import type { Book, Market, Side } from "./market";
import { FairValue } from "./fair";
import { startBinanceFeed } from "./binance";
import { SimExchange, type SimBook, type SimPlace, type TakerSweep } from "./sim";
import { defaultMakerParams, shouldRequote, targetQuotes, type MakerParams, type Quotes } from "./strategy";
import { TradeFeed } from "./trades";

export interface MakerEvent {
  block: number;
  ts: number;
  mid: number;
  bid: number;
  ask: number;
  fair: number | null;
  /** Where our quotes rest (or will, once an update in flight lands). */
  resting: Quotes;
  /** The update sent this block, if any. */
  sent: SimPlace[] | null;
  position: number; // base units
  pnlUsd: number; // marked at the mid, gas included
  /** pnlUsd without what the inventory made from fair value moving: the edge itself, which inventory luck can hide. */
  hedgedPnlUsd: number;
  gasUsd: number;
  totals: { blocks: number; updates: number; reverts: number; fills: number; volumeUsd: number; pickoffs: number };
  halted: boolean;
}

interface Order { side: Side; price: number; remaining: number }

export class MakerTrader {
  readonly history: MakerEvent[] = [];
  readonly params: MakerParams = defaultMakerParams();
  private fair = new FairValue();
  private sim: SimExchange | null;
  private trades: TradeFeed;
  private busy = false;
  private halted = false;
  private blocks = 0;
  private monUsd: number | null = null;
  private monParams: Kuru.MarketParams | null = null;
  private lastMark: number | null = null;
  private invFair = 0;
  // live bookkeeping; a dry run's lives in the simulator
  private orders = new Map<number, Order>();
  private inflight: { hash: string; block: number } | null = null;
  private live = { position: 0, cash: 0, gasMon: 0, updates: 0, reverts: 0, fills: 0, volumeUsd: 0 };

  constructor(private market: Market, private onEvent: (e: MakerEvent) => void) {
    this.sim = market.wallet ? null : new SimExchange({ latencyBlocks: 2, gasPerTxMon: market.quoteGasMon, pickoffBps: 3, tick: market.tick });
    this.trades = new TradeFeed({ market: config.market, url: config.readRpcUrl, sizeDec: market.sizeDecimals, maker: market.address });
    startBinanceFeed((price, at) => this.fair.onBinance(price, at), config.refSymbol, config.refVenue);
    mkdirSync("data", { recursive: true });
  }

  private get position() { return this.sim ? this.sim.position : this.live.position; }

  async onBlock(block: number) {
    this.blocks++;
    if (this.busy) return; // still handling the previous block
    this.busy = true;
    try {
      if (this.blocks % config.refreshBlocks === 1) this.refresh().catch(() => {});
      if (this.inflight) await this.confirm(block);
      const book = await this.market.readBook();
      const now = Date.now();
      this.fair.onKuru(book.mid, now);
      const fair = this.fair.value(now);
      // inventory P&L, marked at fair value (or Kuru's mid while there is none, so an outage is not counted as edge)
      const mark = fair ?? book.mid;
      if (this.lastMark !== null) this.invFair += this.position * (mark - this.lastMark); // before this block's fills
      this.lastMark = mark;
      await this.trades.poll(block); // fills must be known before deciding
      this.applyTrades(block, book, fair);
      if (!this.halted && this.pnlUsd(book.mid) < -config.maxLossUsd) {
        this.halted = true;
        console.log(`#${block} HALT: down more than $${config.maxLossUsd}, pulling every quote`);
      }
      let sent: SimPlace[] | null = null;
      if (!this.inflight && !this.sim?.busy) {
        const want = fair === null || this.halted ? { bid: null, ask: null } : this.affordable(targetQuotes(fair, book, this.position, this.params, this.market.tick), book);
        if (shouldRequote(this.resting(), want, fair ?? book.mid, this.params)) sent = await this.send(block, want);
      }
      this.emit(block, book, fair, sent);
    } catch (e) {
      console.error(`block ${block}:`, (e as Error).message);
    } finally {
      this.busy = false;
    }
  }

  /** Dry run: real Kuru taker orders since the last poll replay against the simulator. Live: our maker fills. */
  private applyTrades(block: number, book: Book, fair: number | null) {
    const prints = this.trades.drainPrints();
    if (this.sim) {
      const sweeps = new Map<string, TakerSweep>();
      for (const p of prints) {
        const s = sweeps.get(p.tx) ?? { block: p.block, side: p.side, prints: [] };
        s.prints.push([p.price, p.size]);
        sweeps.set(p.tx, s);
      }
      const byBlock = new Map<number, TakerSweep[]>();
      for (const s of sweeps.values()) byBlock.set(s.block, [...(byBlock.get(s.block) ?? []), s]);
      const sb: SimBook = { bid: book.bid, ask: book.ask, bids: book.levels.bids, asks: book.levels.asks };
      for (const b of [...byBlock.keys()].sort((x, y) => x - y)) this.logFills(this.sim.step(b, sb, fair, byBlock.get(b)!));
      this.logFills(this.sim.step(block, sb, fair, []));
      return;
    }
    for (const f of this.trades.drainFills()) {
      const o = this.orders.get(f.orderId);
      if (f.updatedSize <= 0) this.orders.delete(f.orderId);
      else if (o) o.remaining = f.updatedSize;
      this.live.position += f.side === "buy" ? f.size : -f.size;
      this.live.cash += (f.side === "buy" ? -f.size : f.size) * f.price;
      this.live.fills++;
      this.live.volumeUsd += f.size * f.price;
      console.log(`#${f.block} FILL ${f.side} ${f.size} @ ${f.price} order ${f.orderId} · position ${this.live.position}`);
    }
  }

  private logFills(fills: { block: number; side: Side; price: number; size: number; pickoff: boolean }[]) {
    for (const f of fills) console.log(`#${f.block} FILL ${f.side} ${f.size} @ ${f.price}${f.pickoff ? " (picked off)" : ""} (sim) · position ${this.sim!.position.toPrecision(4)}`);
  }

  /** Where we rest, counting only orders with at least half their size left. */
  private resting(): Quotes {
    if (this.sim) return this.sim.restingQuotes(this.params.size / 2);
    const live = [...this.orders.values()].filter((o) => o.remaining >= this.params.size / 2);
    const bids = live.filter((o) => o.side === "buy").map((o) => o.price), asks = live.filter((o) => o.side === "sell").map((o) => o.price);
    return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
  }

  /** Live: drop a side the margin account cannot fund (what our own cancelled orders release counts). */
  private affordable(q: Quotes, _book: Book): Quotes {
    if (this.sim) return q;
    let quote = this.market.margin.usdc, base = this.market.margin.mon;
    for (const o of this.orders.values()) { if (o.side === "buy") quote += o.remaining * o.price; else base += o.remaining; }
    return { bid: q.bid !== null && quote >= this.params.size * q.bid ? q.bid : null, ask: q.ask !== null && base >= this.params.size ? q.ask : null };
  }

  private async send(block: number, q: Quotes): Promise<SimPlace[] | null> {
    const place: SimPlace[] = [];
    if (q.bid !== null) place.push({ side: "buy", price: q.bid, size: this.params.size });
    if (q.ask !== null) place.push({ side: "sell", price: q.ask, size: this.params.size });
    if (this.sim) {
      this.sim.send(block, place);
      return place;
    }
    const cancel = [...this.orders.keys()];
    if (!place.length && !cancel.length) return null;
    const hash = await this.market.sendQuotes(place, cancel);
    this.inflight = { hash, block };
    this.live.updates++;
    this.live.gasMon += this.market.quoteGasMon; // Monad charges the limit, landed or reverted
    return place;
  }

  private async confirm(block: number) {
    const r = await this.market.quotesReceipt(this.inflight!.hash);
    if (!r) {
      if (block - this.inflight!.block > 30) {
        console.warn(`#${block} update ${this.inflight!.hash} has no receipt after 30 blocks; if it lands later its orders are not tracked`);
        this.inflight = null;
      }
      return;
    }
    if (r.ok) {
      for (const id of r.canceled) this.orders.delete(id);
      for (const o of r.created) this.orders.set(o.id, { side: o.side, price: o.price, remaining: o.size });
    } else {
      this.live.reverts++; // the book moved through a price, or a cancelled order had filled; the old orders stay
    }
    this.inflight = null;
  }

  /** Fee estimate and margin balances (Market.refresh), and MON's price for valuing gas. */
  private async refresh() {
    await this.market.refresh();
    if (config.market.toLowerCase() === config.monMarket.toLowerCase()) return;
    this.monParams ??= await Kuru.ParamFetcher.getMarketParams(this.market.provider, config.monMarket);
    this.monUsd = (await readBook(config.readRpcUrl, config.monMarket, this.monParams)).mid;
  }

  private pnlUsd(mid: number) {
    const monUsd = config.market.toLowerCase() === config.monMarket.toLowerCase() ? mid : this.monUsd ?? 0;
    if (this.sim) return this.sim.equityUsd(mid, monUsd);
    return this.live.cash + this.live.position * mid - this.live.gasMon * monUsd;
  }

  private emit(block: number, book: Book, fair: number | null, sent: SimPlace[] | null) {
    const monUsd = config.market.toLowerCase() === config.monMarket.toLowerCase() ? book.mid : this.monUsd ?? 0;
    const s = this.sim;
    const totals = s
      ? { blocks: this.blocks, updates: s.stats.txs, reverts: s.stats.reverts, fills: s.stats.fills, volumeUsd: s.stats.volumeMon * book.mid, pickoffs: s.stats.pickoffs }
      : { blocks: this.blocks, updates: this.live.updates, reverts: this.live.reverts, fills: this.live.fills, volumeUsd: this.live.volumeUsd, pickoffs: 0 };
    const e: MakerEvent = {
      block, ts: Date.now(), mid: book.mid, bid: book.bid, ask: book.ask, fair, resting: this.resting(), sent,
      position: this.position, pnlUsd: this.pnlUsd(book.mid), hedgedPnlUsd: this.pnlUsd(book.mid) - this.invFair, gasUsd: (s ? s.gasMon : this.live.gasMon) * monUsd, totals, halted: this.halted,
    };
    this.history.push(e);
    if (this.history.length > config.historySize) this.history.shift();
    if (sent || this.blocks % 100 === 0) appendFileSync("data/maker-events.jsonl", JSON.stringify(e) + "\n");
    this.onEvent(e);
  }
}
