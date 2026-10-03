const env = (key: string, fallback?: string) => process.env[key] ?? fallback;
const num = (key: string) => (env(key) ? Number(env(key)) : undefined);

export const config = {
  rpcUrl: env("RPC_URL", "https://rpc.monad.xyz")!, // sends, receipts, nonce, gas estimation
  readRpcUrl: env("READ_RPC_URL", "https://rpc.monad.xyz")!, // book reads + eth_blockNumber polling + trade logs
  wsUrl: env("WS_URL"), // optional; polling backstop always runs
  chainId: 143,
  market: env("MARKET", "0x065C9d28E428A0db40191a54d33d5b7c71a9C394")!, // Kuru MON-USDC
  /** Kuru MarginAccount this market settles against (slot 73 of the OrderBook proxy; verifiedMarket(market) is true). */
  marginAccount: env("MARGIN_ACCOUNT", "0x2A68ba1833cDf93fa9Da1EEbd7F46242aD8E90c5")!,
  privateKey: env("PRIVATE_KEY"),
  dryRun: env("DRY_RUN") === "true" || !env("PRIVATE_KEY"),
  tradeSizeMon: Number(env("TRADE_SIZE_MON", "200")), // Kuru MON-USDC minimum order is 200 MON
  maxPositionMon: Number(env("MAX_POSITION_MON", "1000")),
  bankrollUsd: Number(env("BANKROLL_USD", "100")), // used for pnlPct
  /** Quote this many ticks inside the touch (0 = join the best bid/ask). Never crosses: clamps to the touch when the spread is too tight. */
  quoteInsideTicks: Number(env("QUOTE_INSIDE_TICKS", "1")),
  /** Startup deposits into the Kuru margin account, topped up to these balances. Limit orders draw from margin, not the wallet. */
  marginMon: Number(env("MARGIN_MON", "600")),
  marginUsdc: Number(env("MARGIN_USDC", "20")),
  // Monad charges gas on the LIMIT, so never estimate per block: estimate once at init (or override) and hardcode.
  gasLimit: num("GAS_LIMIT"),
  gasLimitFallback: 350_000, // batchUpdate: one cancel + one post-only place measured at ~282k for the place alone
  // EIP-1559 type-2 only. Effective price = base + priority, so a high static cap is free.
  maxFeeGwei: Number(env("MAX_FEE_GWEI", "400")),
  priorityFeeGwei: Number(env("PRIORITY_FEE_GWEI", "2")), // Monad hardcodes eth_maxPriorityFeePerGas at 2
  pendingBlocks: 10, // give up on a tx with no receipt after this many blocks
  refreshBlocks: 200, // how often to refresh the fee estimate, margin balances and the vault check
  horizonBlocks: Number(env("HORIZON_BLOCKS", "100")), // the model is asked about the move over this many blocks (~30 s)
  model: env("MODEL", "mock") as "mock" | "jev" | "laya",
  jevModelId: env("JEV_MODEL_ID", "jev-latest")!,
  jevUsdPerMTok: 0.042,
  /** laya/server.py (or any server speaking Jev's POST /v1/systemone). */
  layaUrl: env("LAYA_URL", "http://127.0.0.1:8000")!,
  layaModel: env("LAYA_MODEL", "laya-trader")!, // a label for logs and the dashboard; the server decides which checkpoint runs
  layaApiKey: env("LAYA_API_KEY"),
  /**
   * "directional": the original bot, one side every block from the model's buy/sell call.
   * "maker": two-sided quotes around Binance's price (src/strategy.ts), re-sent only when needed.
   */
  strategy: env("STRATEGY", "directional") as "directional" | "maker",
  /** Binance symbol and venue the maker prices from: MONUSDT perp for MON-USDC, BTCUSDT / ETHUSDT spot for cbBTC / WETH. */
  refSymbol: env("REF_SYMBOL", "MONUSDT")!,
  refVenue: env("REF_VENUE", "futures") as "futures" | "spot",
  /** Maker: stop quoting (and cancel everything) once the run is down this much. */
  maxLossUsd: Number(env("MAX_LOSS_USD", "25")),
  /** Maker: margin top-ups in the market's own base and quote assets. */
  marginBase: num("MARGIN_BASE"),
  marginQuote: num("MARGIN_QUOTE"),
  /** Kuru MON-USDC, read now and then for MON's price: gas is paid in MON whatever the market. */
  monMarket: "0x065C9d28E428A0db40191a54d33d5b7c71a9C394",
  /** Log the Laya view of every block to data/laya/ as training data for the fine-tuning notebook. */
  stateLog: env("STATE_LOG") === "true",
  port: Number(env("PORT", "3000")),
  historySize: 1000,
};
