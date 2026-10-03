/**
 * Live Binance trades over the public WebSocket (no key): the MONUSDT perpetual by default, or a spot
 * pair such as BTCUSDT. Each trade is reported with the local receive time, which is what the fair
 * value's staleness check compares against. Reconnects with backoff when the socket closes, and
 * also when it goes quiet for `staleMs`: a long-lived connection can stall without ever closing
 * (it did, for six hours, on the first cbBTC dry run). Binance also drops every connection after 24 h.
 */
export function startBinanceFeed(onTrade: (price: number, at: number) => void, symbol = "monusdt", venue: "futures" | "spot" = "futures", staleMs = 30_000) {
  const host = venue === "spot" ? "wss://stream.binance.com:9443" : "wss://fstream.binance.com";
  let delay = 0, lastMessage = Date.now();
  let current: WebSocket | null = null;
  const connect = () =>
    setTimeout(() => {
      lastMessage = Date.now();
      const ws = new WebSocket(`${host}/ws/${symbol.toLowerCase()}@aggTrade`);
      current = ws;
      ws.onmessage = (e) => {
        lastMessage = Date.now();
        const m = JSON.parse(String(e.data));
        if (m.e !== "aggTrade") return;
        delay = 0;
        onTrade(Number(m.p), Date.now());
      };
      ws.onclose = () => {
        if (current !== ws) return; // the watchdog already replaced it
        current = null;
        delay = Math.min(delay + 1000, 10_000);
        connect();
      };
      ws.onerror = () => ws.close();
    }, delay);
  setInterval(() => {
    if (!current || Date.now() - lastMessage < staleMs) return;
    console.warn(`binance ${symbol}: nothing for ${Math.round((Date.now() - lastMessage) / 1000)} s, reconnecting`);
    const stalled = current;
    current = null;
    try { stalled.close(); } catch {}
    delay = 0;
    connect();
  }, 5_000);
  connect();
}
