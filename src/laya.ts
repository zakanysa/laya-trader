import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { config } from "./config";
import type { Book } from "./market";
import type { Decision, Model, TradeState } from "./model";
import type { TradeFeed } from "./trades";
import question from "../laya/question.json";

/**
 * Laya reads a different view of the market than Jev: compact and scale-free. Prices are bps from
 * mid and sizes are whole MON, so the numbers mean the same thing at any MON price and cost few
 * tokens. Laya cuts a long state from the end, so the strongest signals come first.
 *
 * The notebook trains on exactly this object (logged by `logLayaState`), so any change here needs
 * a new `LAYA_STATE_VERSION`, fresh data and a retrain.
 */
export const LAYA_STATE_VERSION = 1;
export const LAYA_QUESTIONS = { direction: question };

export interface LayaState {
  /** Taker prints over the horizon, in MON. */
  flow: { cvdMon: number; buyMon: number; sellMon: number; prints: number; lastSide: "buy" | "sell" | null; vwapBps: number | null };
  returnsBps: { last1: number; last5: number; last20: number; last100: number };
  imbalance: number; // -1 (all asks) .. 1 (all bids), within 1% of mid
  spreadBps: number;
  depthMon: { [band: string]: { bid: number; ask: number } };
  /** Top 5 levels each side, best first, as "bps from mid x MON". */
  bids: string[];
  asks: string[];
  /** Newest last, as "blocks ago, side, MON @ bps from mid". */
  recentTrades: string[];
  /** Mid every 5 blocks over the horizon, oldest first, in bps from the current mid. */
  pathBps: string;
  horizonBlocks: number;
}

export function buildLayaState(block: number, book: Book, mids: number[], trades: TradeFeed | null): LayaState {
  const H = config.horizonBlocks, mid = book.mid, n = mids.length;
  const bps = (p: number) => round(((p - mid) / mid) * 10_000, 1);
  const ret = (k: number) => (n > k ? round(((mids[n - 1]! - mids[n - 1 - k]!) / mids[n - 1 - k]!) * 10_000, 2) : 0);
  const t = trades?.summary(H, block);
  const depthMon: LayaState["depthMon"] = {};
  for (const [k, v] of Object.entries(book.depthBps)) depthMon[k + "bps"] = { bid: Math.round(v.bid), ask: Math.round(v.ask) };
  const lvl = ([p, s]: [number, number]) => `${bps(p).toFixed(1)} x ${Math.round(s)}`;
  return {
    flow: {
      cvdMon: Math.round(t?.cvdMon ?? 0), buyMon: Math.round(t?.buyMon ?? 0), sellMon: Math.round(t?.sellMon ?? 0),
      prints: t?.count ?? 0, lastSide: t?.lastSide ?? null, vwapBps: t?.vwap != null ? bps(t.vwap) : null,
    },
    returnsBps: { last1: ret(1), last5: ret(5), last20: ret(20), last100: ret(100) },
    imbalance: round(book.imbalance, 3),
    spreadBps: round(book.spreadBps, 1),
    depthMon,
    bids: book.levels.bids.map(lvl),
    asks: book.levels.asks.map(lvl),
    recentTrades: (trades?.recent(10) ?? []).map((p) => `${block - p.block} ${p.side} ${Math.round(p.size)} @ ${bps(p.price).toFixed(1)}`),
    pathBps: mids.slice(-H).filter((_, i, a) => (a.length - 1 - i) % 5 === 0).map((m) => bps(m).toFixed(1)).join(" "),
    horizonBlocks: H,
  };
}

let logReady = false;

/** One training row per block: the exact state Laya would see, plus the mid the notebook labels from. */
export function logLayaState(book: Book, state: LayaState) {
  if (!logReady) {
    mkdirSync("data/laya", { recursive: true });
    writeFileSync("data/laya/question.json", JSON.stringify(question, null, 2)); // travels with the dataset
    logReady = true;
  }
  const day = new Date().toISOString().slice(0, 10);
  const row = { v: LAYA_STATE_VERSION, block: book.block, ts: Date.now(), mid: book.mid, bid: book.bid, ask: book.ask, state };
  appendFileSync(`data/laya/states-${day}.jsonl`, JSON.stringify(row) + "\n");
}

interface ChoiceAnswer { choice: string; probabilities: Record<string, number> }
interface SystemOneResponse { answers: { direction: ChoiceAnswer }; usage?: { input_tokens?: number } }

/** Laya behind `laya/server.py` (or any server speaking Jev's POST /v1/systemone). */
export class LayaModel implements Model {
  readonly name = `laya ${config.layaModel}`;
  readonly usdPerMTok = 0; // self-hosted: no per-token bill

  async decide(_state: TradeState, laya: LayaState): Promise<Decision> {
    const t0 = performance.now();
    const res = await fetch(`${config.layaUrl}/v1/systemone`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(config.layaApiKey ? { authorization: `Bearer ${config.layaApiKey}` } : {}) },
      body: JSON.stringify({ model: config.layaModel, state: laya, questions: LAYA_QUESTIONS }),
      signal: AbortSignal.timeout(2000), // a hung request would otherwise hold the loop busy forever
    });
    if (!res.ok) throw new Error(`laya ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const r = (await res.json()) as SystemOneResponse;
    const a = r.answers.direction;
    const buy = a.probabilities.buy ?? 0, sell = a.probabilities.sell ?? 0;
    return {
      action: buy >= sell ? "buy" : "sell",
      probabilities: { buy, sell, hold: 0 },
      upIn10: buy,
      latencyMs: performance.now() - t0,
      inputTokens: r.usage?.input_tokens ?? 0,
    };
  }
}

const round = (x: number, d: number) => Math.round(x * 10 ** d) / 10 ** d;
