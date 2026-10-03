/**
 * Fair value for MON on Kuru: the Binance MONUSDT perpetual's last trade, scaled by the slow basis
 * between the two venues (perp vs spot, USDT vs USDC). Binance is the deeper market and Kuru follows
 * it, so this is where Kuru's mid is heading. The basis is an EMA of log(kuruMid / binance) with a
 * time constant of minutes, so Kuru's own short-lived jumps barely move it.
 *
 * Shared by the live bot (fed from the Binance WebSocket) and the backtest (fed from history).
 */
export class FairValue {
  private binance: number | null = null;
  private binanceAt = 0;
  private basis: number | null = null;
  private basisAt = 0;
  private since = 0;

  constructor(
    private tauMs = 10 * 60_000,
    /** No Binance trade for this long: no fair value, so the bot pulls its quotes. */
    private maxStaleMs = 30_000,
    /** The basis needs this much history before quoting on it. */
    private warmupMs = 5 * 60_000,
  ) {}

  onBinance(price: number, at: number) {
    this.binance = price;
    this.binanceAt = at;
  }

  /** Feed every Kuru mid. */
  onKuru(mid: number, at: number) {
    if (this.binance === null) return;
    const x = Math.log(mid / this.binance);
    if (this.basis === null) {
      this.basis = x;
      this.basisAt = this.since = at;
      return;
    }
    this.basis += (1 - Math.exp(-(at - this.basisAt) / this.tauMs)) * (x - this.basis);
    this.basisAt = at;
  }

  value(at: number): number | null {
    if (this.binance === null || this.basis === null) return null;
    if (at - this.binanceAt > this.maxStaleMs || at - this.since < this.warmupMs) return null;
    return this.binance * Math.exp(this.basis);
  }

  /** For logs and the dashboard: basis in bps, and how old the last Binance trade is. */
  status(at: number) {
    return { binance: this.binance, basisBps: this.basis === null ? null : this.basis * 1e4, staleMs: this.binance === null ? null : at - this.binanceAt };
  }
}
