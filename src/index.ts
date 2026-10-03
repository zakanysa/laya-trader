import { config } from "./config";
import { startBlockFeed } from "./chain";
import { Market } from "./market";
import { createModel } from "./model";
import { Trader } from "./trader";
import { log10 } from "./book";
import { startServer } from "./server";
import { MakerTrader } from "./maker";

const market = new Market();
await market.init();

if (config.strategy === "maker") {
  // Two-sided quotes around Binance's price; no model involved (src/maker.ts)
  const server = startServer(
    { model: `maker ${config.refSymbol}`, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
    () => maker.history,
  );
  const maker = new MakerTrader(market, (e) => {
    server.broadcastAny("maker", e);
    if (e.sent || e.totals.blocks % 100 === 0) {
      const q = e.sent ? e.sent.map((o) => `${o.side === "buy" ? "bid" : "ask"} ${o.price}`).join(" ") || "cancel all" : "";
      const bps = e.fair ? (((e.mid - e.fair) / e.fair) * 1e4).toFixed(1) : "-";
      console.log(`#${e.block} mid ${e.mid} fair ${e.fair?.toPrecision(7) ?? "-"} (kuru ${bps} bps)${e.sent ? ` SEND ${q}` : ""} · pos ${e.position.toPrecision(3)} · pnl $${e.pnlUsd.toFixed(2)}, without inventory $${e.hedgedPnlUsd.toFixed(2)} (gas $${e.gasUsd.toFixed(2)}) · ${e.totals.updates} updates ${e.totals.fills} fills${e.halted ? " · HALTED" : ""}`);
    }
  });
  const p = maker.params;
  console.log(`maker · ${config.dryRun ? "DRY RUN (simulated fills, gas counted)" : `LIVE wallet ${market.address}`} · market ${config.market} · ref Binance ${config.refSymbol} ${config.refVenue} · half spread ${p.halfSpreadBps} bps, requote ${p.requoteBps}, danger ${p.dangerBps}, size ${p.size}, max inventory ${p.maxInventory}, skew ${p.skewBps} · stop at -$${config.maxLossUsd} · ~${market.quoteGasMon.toFixed(4)} MON gas per update`);
  startBlockFeed((block) => maker.onBlock(block));
} else {
  const model = createModel();

  const server = startServer(
    { model: model.name, wallet: market.address, dryRun: config.dryRun, market: config.market, startedAt: Date.now() },
    () => trader.history,
  );
  const trader = new Trader(
    market,
    model,
    (e, t) => {
      server.broadcast(e);
      if (e.decision && !e.decision.late) {
        const p = e.decision.probabilities;
        const q = e.quote;
        const quote = !q ? " NO QUOTE (cap or funds on both sides)" : ` ${q.side.toUpperCase()} ${q.size} @ ${q.price.toFixed(6)}${q.capped ? " capped" : ""}${q.status === "sim" ? " (sim)" : ` cancel ${q.cancel.length} ${q.txHash}`}`;
        console.log(`#${e.block} ${e.mid.toFixed(6)} b${(p.buy * 100).toFixed(0)} s${(p.sell * 100).toFixed(0)} ${e.decision.latencyMs}ms${quote} pnl $${e.totals.pnlUsd}${t ? ` · read ${t.readMs}ms loop ${t.loopMs}ms` : ""}`);
      }
    },
    (block, fill) => {
      server.broadcastFill(block, fill);
      console.log(`#${block} FILL ${fill.side} ${fill.size} @ ${fill.price.toFixed(6)}${fill.simulated ? " (sim)" : ` order ${fill.orderId} ${fill.txHash}`}`);
    },
    (block, quote) => {
      server.broadcastQuote(block, quote);
      if (quote.status !== "placed") console.log(`#${block} ${quote.status.toUpperCase()} ${quote.side} @ ${quote.price.toFixed(6)} gas ${quote.gasMon.toFixed(6)} MON ${quote.txHash}`);
    },
  );
  trader.attachTradeFeed(log10(market.params.sizePrecision));

  console.log(`laya-trader · model=${model.name} · post-only ${config.quoteInsideTicks} tick inside the touch · horizon ${config.horizonBlocks} blocks · ${config.dryRun ? "DRY RUN" : `wallet ${market.address}`} · market ${config.market} · read ${config.readRpcUrl} · :${config.port}`);
  startBlockFeed((block) => trader.onBlock(block));
}
