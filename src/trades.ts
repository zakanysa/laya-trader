/**
 * Recent trade prints for a Kuru order book, via eth_getLogs on the `Trade` event.
 *
 * Trade(uint40 orderId, address makerAddress, bool isBuy, uint256 price, uint96 updatedSize,
 *       address takerAddress, address txOrigin, uint96 filledSize)  — all fields non-indexed.
 * `isBuy` is the TAKER (aggressor) side: the SDK's reconcileTradeEvent treats isBuy as
 * "trader is buying, AMM/maker is selling (ask side)".
 *
 * Scaling, verified against the live book (event price 0.021953 vs book mid 0.02197, size 22600 =
 * a visible L2 level): `price` is 1e18-scaled REGARDLESS of market pricePrecision (the SDK's
 * reconcileTradeEvent also uses formatUnits(price, 18)); `filledSize` is scaled by sizePrecision.
 * On MON-USDC log10(pricePrecision) is 8, so do NOT pass that as priceDec.
 *
 * The same logs tell us when one of OUR resting orders was hit: `makerAddress` is us. Those are
 * collected separately as maker fills (with `updatedSize` so a fully filled order can be dropped).
 */
import { rpc } from "./chain";
import { toFloat } from "./book";

export const TRADE_EVENT_SIG = "Trade(uint40,address,bool,uint256,uint96,address,address,uint96)";
/** keccak256(TRADE_EVENT_SIG) — precomputed with ethers.utils.id. */
export const TRADE_TOPIC0 = "0xf16924fba1c18c108912fcacaac7450c98eb3f2d8c0a3cdf3df7066c08f21581";

/** `side` is the taker's; `tx` groups the prints of one taker order. */
export interface TradePrint { block: number; price: number; size: number; side: "buy" | "sell"; tx: string }

/** One of our resting orders got hit. `side` is OUR side (the maker's): a taker buy fills our ask, so side is "sell". */
export interface MakerFill { block: number; txHash: string; orderId: number; price: number; size: number; updatedSize: number; side: "buy" | "sell" }

export interface TradeSummary {
  count: number;
  buyMon: number;
  sellMon: number;
  /** taker buy volume minus taker sell volume (MON) */
  cvdMon: number;
  vwap: number | null;
  lastPrice: number | null;
  lastSide: "buy" | "sell" | null;
}

interface RawLog { blockNumber: string; logIndex: string; transactionHash: string; data: string; removed?: boolean }

/** Trade.price is a 1e18 fixed-point number on every Kuru market. */
export const TRADE_PRICE_DEC = 18;
const RING = 500;
const FIRST_LOOKBACK = 300;
/** rpc.monad.xyz rejects eth_getLogs spans > 100 blocks ("eth_getLogs is limited to a 100 range", -32614). */
const MAX_RANGE = 100;
/** Never replay more than this many blocks in one poll (10 sequential getLogs calls at MAX_RANGE). */
const MAX_CATCHUP = 1000;

export class TradeFeed {
  private readonly market: string;
  private readonly url: string;
  private readonly priceDec: number;
  private readonly sizeDec: number;
  private readonly maker: string | null;
  private trades: TradePrint[] = [];
  private fresh: TradePrint[] = []; // appended since the last drainPrints()
  private fills: MakerFill[] = []; // appended since the last drainFills()
  private inFlight = false;
  lastBlock = 0;

  /**
   * `sizeDec` = log10(sizePrecision) (10 on MON-USDC). `priceDec` defaults to 18; override only if
   * Kuru changes the event. `maker` is our wallet: Trade logs with that makerAddress become fills.
   */
  constructor(opts: { market: string; url: string; sizeDec: number; priceDec?: number; maker?: string | null }) {
    this.market = opts.market;
    this.url = opts.url;
    this.priceDec = opts.priceDec ?? TRADE_PRICE_DEC;
    this.sizeDec = opts.sizeDec;
    this.maker = opts.maker?.toLowerCase() ?? null;
  }

  /**
   * Fetch Trade logs from lastBlock+1..block (first call: last 300 blocks) and append, in chunks of
   * MAX_RANGE. lastBlock advances per chunk, so a mid-way failure keeps what was fetched and retries
   * the rest next time. Never throws; drops the call if a poll is already in flight.
   */
  async poll(block: number): Promise<void> {
    if (this.inFlight) return;
    let from = this.lastBlock === 0 ? Math.max(1, block - FIRST_LOOKBACK + 1) : this.lastBlock + 1;
    if (from > block) return;
    if (block - from + 1 > MAX_CATCHUP) from = block - MAX_CATCHUP + 1;
    const first = this.lastBlock === 0;
    this.inFlight = true;
    try {
      while (from <= block) {
        const to = Math.min(block, from + MAX_RANGE - 1);
        const logs = await rpc<RawLog[]>("eth_getLogs", [{
          address: this.market,
          topics: [TRADE_TOPIC0],
          fromBlock: "0x" + from.toString(16),
          toBlock: "0x" + to.toString(16),
        }], this.url);
        // getLogs returns in block/logIndex order; keep newest last.
        for (const log of logs) {
          if (log.removed) continue;
          const t = this.decode(log, !first); // the warm-up window predates our orders: no fills from it
          if (t) { this.trades.push(t); this.fresh.push(t); }
        }
        if (this.trades.length > RING) this.trades.splice(0, this.trades.length - RING);
        this.lastBlock = to;
        from = to + 1;
      }
    } catch {
      // lastBlock stays at the last fully fetched chunk; next poll retries from there
    } finally {
      this.inFlight = false;
    }
  }

  private decode(log: RawLog, collectFills: boolean): TradePrint | null {
    const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
    if (data.length < 64 * 8) return null;
    const word = (i: number) => BigInt("0x" + data.slice(i * 64, (i + 1) * 64));
    // 0 orderId, 1 makerAddress, 2 isBuy, 3 price, 4 updatedSize, 5 takerAddress, 6 txOrigin, 7 filledSize
    const isBuy = word(2) !== 0n;
    const price = toFloat(word(3), this.priceDec);
    const size = toFloat(word(7), this.sizeDec);
    if (size === 0) return null;
    const block = parseInt(log.blockNumber, 16);
    if (collectFills && this.maker && "0x" + data.slice(64 + 24, 128) === this.maker) {
      this.fills.push({
        block, txHash: log.transactionHash, orderId: Number(word(0)), price, size,
        updatedSize: toFloat(word(4), this.sizeDec), side: isBuy ? "sell" : "buy",
      });
    }
    return { block, price, size, side: isBuy ? "buy" : "sell", tx: log.transactionHash };
  }

  summary(lastBlocks: number, currentBlock: number): TradeSummary {
    const minBlock = currentBlock - lastBlocks;
    let count = 0, buyMon = 0, sellMon = 0, notional = 0;
    let lastPrice: number | null = null, lastSide: "buy" | "sell" | null = null;
    for (const t of this.trades) {
      if (t.block <= minBlock) continue;
      count++;
      if (t.side === "buy") buyMon += t.size; else sellMon += t.size;
      notional += t.size * t.price;
      lastPrice = t.price; lastSide = t.side;
    }
    const vol = buyMon + sellMon;
    return { count, buyMon, sellMon, cvdMon: buyMon - sellMon, vwap: vol > 0 ? notional / vol : null, lastPrice, lastSide };
  }

  /** Newest last. */
  recent(n: number): TradePrint[] {
    return this.trades.slice(-n);
  }

  /** Prints appended since the last call (oldest first). Used to simulate maker fills in a dry run. */
  drainPrints(): TradePrint[] {
    const out = this.fresh; this.fresh = []; return out;
  }

  /** Our maker fills since the last call (oldest first). */
  drainFills(): MakerFill[] {
    const out = this.fills; this.fills = []; return out;
  }
}
