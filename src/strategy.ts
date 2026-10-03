/**
 * Two-sided market making around a fair value, built to spend little on gas.
 *
 * Quote a bid `halfSpreadBps` below fair and an ask the same distance above, shifted against the
 * position we hold (`skewBps` at the inventory cap) so fills tend to bring it back to flat. Both
 * sides go out in one transaction. A resting quote is replaced only when it matters:
 *   - at once when it has become dangerous: more than `dangerBps` closer to fair than the target,
 *     where a faster trader would take it the moment fair moves;
 *   - lazily when it has drifted `requoteBps` further from fair than the target, which only costs
 *     some fills;
 *   - when a side should appear or disappear (inventory cap, a fill, fair value lost).
 *
 * Pure functions: the live bot and the backtest call exactly the same code.
 */
export interface MakerParams {
  halfSpreadBps: number;
  requoteBps: number;
  dangerBps: number;
  size: number; // base units per order (MON on MON-USDC)
  maxInventory: number; // base units
  skewBps: number;
}

export const defaultMakerParams = (env: (k: string) => string | undefined = (k) => process.env[k]): MakerParams => ({
  halfSpreadBps: Number(env("HALF_SPREAD_BPS") ?? 8),
  requoteBps: Number(env("REQUOTE_BPS") ?? 4),
  dangerBps: Number(env("DANGER_BPS") ?? 1),
  size: Number(env("QUOTE_SIZE") ?? 500),
  maxInventory: Number(env("MAX_INVENTORY") ?? 2000),
  skewBps: Number(env("SKEW_BPS") ?? 6),
});

export interface Quotes { bid: number | null; ask: number | null }
export interface TopOfBook { bid: number; ask: number }

/** Where we want to rest now. Tick aligned, and never crossing the book (post-only would revert). */
export function targetQuotes(fair: number, book: TopOfBook, inventory: number, p: MakerParams, tick: number): Quotes {
  const skew = p.skewBps * Math.max(-1, Math.min(1, inventory / p.maxInventory));
  const units = (x: number) => x / tick;
  let bid: number | null = Math.floor(units(fair * (1 - (p.halfSpreadBps + skew) / 1e4)) + 1e-9) * tick;
  let ask: number | null = Math.ceil(units(fair * (1 + (p.halfSpreadBps - skew) / 1e4)) - 1e-9) * tick;
  bid = Math.min(bid, book.ask - tick);
  ask = Math.max(ask, book.bid + tick);
  if (inventory + p.size > p.maxInventory) bid = null;
  if (inventory - p.size < -p.maxInventory) ask = null;
  return { bid: bid === null ? null : round(bid, tick), ask: ask === null ? null : round(ask, tick) };
}

/** Does the resting pair need replacing? `resting` includes what an in-flight tx is about to place. */
export function shouldRequote(resting: Quotes, target: Quotes, fair: number, p: MakerParams): boolean {
  const bps = (x: number) => (x / fair) * 1e4;
  for (const side of ["bid", "ask"] as const) {
    const r = resting[side], t = target[side];
    if ((r === null) !== (t === null)) return true;
    if (r === null || t === null) continue;
    // positive = our resting quote is more aggressive (closer to fair) than the target
    const ahead = side === "bid" ? bps(r - t) : bps(t - r);
    if (ahead > p.dangerBps || -ahead > p.requoteBps) return true;
  }
  return false;
}

const round = (x: number, tick: number) => Number((Math.round(x / tick) * tick).toFixed(12));
