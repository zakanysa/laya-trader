/**
 * A deliberately pessimistic model of our orders on Kuru, shared by the backtest and the live dry
 * run so both judge a strategy the same way.
 *
 * - A transaction lands `latencyBlocks` after it is sent and every transaction pays gas, landed or
 *   reverted. Until it lands, the orders it replaces stay on the book and can still be hit.
 * - The whole transaction reverts if a new order would cross the book (post-only) or if it cancels
 *   an order that has already filled completely; the old orders then stay.
 * - A new order rests from the block after it lands. It is first in its price level only if that
 *   level was empty, otherwise it queues behind everything already there.
 * - Taker fills come from real Kuru taker orders: of each one, we get only the part that would have
 *   reached our price (its prints below our bid, or above our ask), plus prints at our exact price
 *   when we were first in the level.
 * - Faster traders take any quote that is more than `pickoffBps` on the wrong side of fair value,
 *   all of it, at our price. Historical prints cannot show trades our own stale quotes would have
 *   attracted, so without this the model would flatter slow quoting.
 */
import type { Side } from "./market";
import type { Quotes } from "./strategy";

export interface SimOrder { id: number; side: Side; price: number; size: number; remaining: number; liveFrom: number; first: boolean }
export interface SimPlace { side: Side; price: number; size: number }
export interface SimFill { block: number; side: Side; price: number; size: number; orderId: number; pickoff: boolean }
/** One taker order as its Trade logs show it: the taker's side and each price level it took. */
export interface TakerSweep { block: number; side: Side; prints: [price: number, size: number][] }
export interface SimBook { bid: number; ask: number; bids: [number, number][]; asks: [number, number][] }
export interface SimOptions { latencyBlocks: number; gasPerTxMon: number; pickoffBps: number; tick: number }

export class SimExchange {
  readonly orders = new Map<number, SimOrder>();
  position = 0; // MON
  cash = 0; // USDC
  gasMon = 0;
  readonly stats = { txs: 0, reverts: 0, fills: 0, pickoffs: 0, volumeMon: 0 };
  private inflight: { landAt: number; cancel: number[]; place: SimPlace[] } | null = null;
  private nextId = 1;

  constructor(readonly opts: SimOptions) {}

  get busy() { return this.inflight !== null; }

  /** The quotes that will rest once the in-flight tx lands (or rest now). Orders below `minRemaining` count as gone. */
  restingQuotes(minRemaining = 0): Quotes {
    let live = [...this.orders.values()].filter((o) => o.remaining >= minRemaining);
    let places: SimPlace[] = [];
    if (this.inflight) {
      const cancel = new Set(this.inflight.cancel);
      live = live.filter((o) => !cancel.has(o.id));
      places = this.inflight.place;
    }
    const all = [...live.map((o) => ({ side: o.side, price: o.price })), ...places];
    const bids = all.filter((o) => o.side === "buy").map((o) => o.price);
    const asks = all.filter((o) => o.side === "sell").map((o) => o.price);
    return { bid: bids.length ? Math.max(...bids) : null, ask: asks.length ? Math.min(...asks) : null };
  }

  /** Replace everything we have with `place`. Cancels every order we know of, as the live bot does. */
  send(block: number, place: SimPlace[]) {
    this.inflight = { landAt: block + this.opts.latencyBlocks, cancel: [...this.orders.keys()], place };
    this.gasMon += this.opts.gasPerTxMon;
    this.stats.txs++;
  }

  /** Advance one block: this block's taker orders and pick-offs hit what rests, then the in-flight tx lands. */
  step(block: number, book: SimBook, fair: number | null, sweeps: TakerSweep[]): SimFill[] {
    const fills: SimFill[] = [];
    for (const s of sweeps) this.matchSweep(s, fills);
    if (fair !== null) this.pickoffs(block, fair, fills);
    if (this.inflight && this.inflight.landAt <= block) this.land(block, book);
    return fills;
  }

  /** Gas is paid in MON: on MON-USDC `monUsd` is the mid itself, elsewhere pass MON's price. */
  equityUsd(mid: number, monUsd = mid) {
    return this.cash + this.position * mid - this.gasMon * monUsd;
  }

  private land(block: number, book: SimBook) {
    const tx = this.inflight!;
    this.inflight = null;
    const crosses = tx.place.some((p) => (p.side === "buy" ? p.price >= book.ask : p.price <= book.bid));
    const filledAway = tx.cancel.some((id) => !this.orders.has(id));
    if (crosses || filledAway) { this.stats.reverts++; return; }
    for (const id of tx.cancel) this.orders.delete(id);
    const half = this.opts.tick / 2;
    for (const p of tx.place) {
      const levels = p.side === "buy" ? book.bids : book.asks;
      const better = p.side === "buy" ? p.price > book.bid : p.price < book.ask;
      const occupied = levels.some(([price]) => Math.abs(price - p.price) < half);
      const known = levels.length > 0 && (p.side === "buy" ? p.price >= levels.at(-1)![0] : p.price <= levels.at(-1)![0]);
      const id = this.nextId++;
      this.orders.set(id, { id, ...p, remaining: p.size, liveFrom: block + 1, first: better || (known && !occupied) });
    }
  }

  private matchSweep(s: TakerSweep, fills: SimFill[]) {
    const ours = [...this.orders.values()]
      .filter((o) => o.side !== s.side && o.liveFrom <= s.block && o.remaining > 0)
      .sort((a, b) => (s.side === "sell" ? b.price - a.price : a.price - b.price)); // best for the taker first
    const half = this.opts.tick / 2;
    let used = 0; // what our better-priced orders already took from this taker order
    for (const o of ours) {
      // what of this taker order would have reached our price: prints strictly past it, and at it if we were first
      let reach = 0;
      for (const [price, size] of s.prints) {
        const past = s.side === "sell" ? price < o.price - half : price > o.price + half;
        const at = Math.abs(price - o.price) < half;
        if (past || (at && o.first)) reach += size;
      }
      const size = Math.min(o.remaining, Math.max(0, reach - used));
      if (size > 1e-9) { this.fill(o, size, s.block, false, fills); used += size; }
    }
  }

  private pickoffs(block: number, fair: number, fills: SimFill[]) {
    const edge = this.opts.pickoffBps / 1e4;
    for (const o of this.orders.values()) {
      if (o.liveFrom > block || o.remaining <= 0) continue;
      if ((o.side === "buy" && o.price > fair * (1 + edge)) || (o.side === "sell" && o.price < fair * (1 - edge))) {
        this.fill(o, o.remaining, block, true, fills);
      }
    }
  }

  private fill(o: SimOrder, size: number, block: number, pickoff: boolean, fills: SimFill[]) {
    o.remaining -= size;
    if (o.remaining <= 1e-9) this.orders.delete(o.id);
    this.position += o.side === "buy" ? size : -size;
    this.cash += (o.side === "buy" ? -size : size) * o.price;
    this.stats.fills++;
    this.stats.volumeMon += size;
    if (pickoff) this.stats.pickoffs++;
    fills.push({ block, side: o.side, price: o.price, size, orderId: o.id, pickoff });
  }
}
