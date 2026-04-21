import fs from "fs";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────
const BITGET_API_KEY     = process.env.BITGET_API_KEY || "";
const BITGET_SECRET_KEY  = process.env.BITGET_SECRET_KEY || "";
const BITGET_PASSPHRASE  = process.env.BITGET_PASSPHRASE || "";
const BITGET_BASE_URL    = process.env.BITGET_BASE_URL || "https://api.bitget.com";
const PORTFOLIO_VALUE_USD = parseFloat(process.env.PORTFOLIO_VALUE_USD || "100");
const MAX_TRADE_SIZE_USD  = parseFloat(process.env.MAX_TRADE_SIZE_USD || "100");
const MAX_TRADES_PER_DAY  = parseInt(process.env.MAX_TRADES_PER_DAY || "3");
const PAPER_TRADING       = process.env.PAPER_TRADING !== "false";
const LEVERAGE            = 3;

// ─── Strategy thresholds ──────────────────────────────────────────────────────
const BTC_PUMP_15M    =  0.4;   // BTC must rise at least 0.4% in 15m
const BTC_PUMP_1H     =  0.8;   // BTC must rise at least 0.8% in 1h
const SOL_LAG_RATIO   =  0.5;   // SOL must have moved less than 50% of BTC
const SOL_RSI_MAX     = 75;     // Don't enter if SOL already overbought
const BTC_CRASH_15M   = -3.0;   // Emergency exit only on REAL crash: BTC drops 3% in 15m
const BTC_CRASH_1H    = -6.0;   // Emergency exit only on REAL crash: BTC drops 6% in 1h
const TAKE_PROFIT_PCT =  2.0;   // Take profit when SOL gains 2%
// NO stop loss — we hold through normal pullbacks

// ─── State files ──────────────────────────────────────────────────────────────
const LOG_FILE    = "safety-check-log.json";
const TRADES_FILE = "trades.csv";
const STATE_FILE  = "position-state.json";

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk));
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    }).on("error", reject);
  });
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pctChange(from, to) {
  return ((to - from) / from) * 100;
}

async function getCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await httpsGet(url);
  return raw.map((c) => ({
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try { return JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); }
    catch { return null; }
  }
  return null;
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function clearState() {
  if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
}

function todayTradeCount() {
  if (!fs.existsSync(TRADES_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  const lines  = fs.readFileSync(TRADES_FILE, "utf8").split("\n");
  return lines.filter((l) => l.startsWith(today) && l.includes("Live")).length;
}

function logTrade({ date, time, side, quantity, price, mode, orderId = "PAPER" }) {
  const header = "Date,Time,Exchange,Symbol,Side,Quantity,Price,TotalUSD,Fee,NetAmount,OrderID,Mode\n";
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, header);
  const total = quantity * price;
  const fee   = total * 0.0006;
  const net   = side === "Buy" ? total + fee : total - fee;
  const line  = `${date},${time},BitGet,SOLUSDT,${side},${quantity.toFixed(4)},${price.toFixed(4)},${total.toFixed(4)},${fee.toFixed(4)},${net.toFixed(4)},${orderId},${mode}\n`;
  fs.appendFileSync(TRADES_FILE, line);
}

function saveLog(data) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
  console.log("  Decision log saved → safety-check-log.json");
}

// ─── BitGet futures order ─────────────────────────────────────────────────────
async function placeBitgetOrder(side, quantity) {
  if (PAPER_TRADING) {
    console.log(`  📄 PAPER MODE — would place ${side} ${quantity.toFixed(4)} SOLUSDT`);
    return { orderId: "PAPER-" + Date.now() };
  }
  const crypto    = await import("crypto");
  const timestamp = Date.now().toString();
  const body      = JSON.stringify({
    symbol:      "SOLUSDT",
    productType: "USDT-FUTURES",
    marginMode:  "isolated",
    marginCoin:  "USDT",
    size:        quantity.toString(),
    side:        side === "Buy" ? "buy" : "sell",
    orderType:   "market",
    leverage:    LEVERAGE.toString(),
  });
  const prehash = timestamp + "POST" + "/api/v2/mix/order/place-order" + body;
  const sign    = crypto.default.createHmac("sha256", BITGET_SECRET_KEY).update(prehash).digest("base64");
  return new Promise((resolve, reject) => {
    const u       = new URL(BITGET_BASE_URL + "/api/v2/mix/order/place-order");
    const options = {
      hostname: u.hostname,
      path:     u.pathname,
      method:   "POST",
      headers: {
        "Content-Type":      "application/json",
        "ACCESS-KEY":        BITGET_API_KEY,
        "ACCESS-SIGN":       sign,
        "ACCESS-TIMESTAMP":  timestamp,
        "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
      },
    };
    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  console.log("\n══════════════════════════════════════════════");
  console.log(`  SOL/BTC Lag Strategy — ${date} ${time} UTC`);
  console.log(`  Mode: ${PAPER_TRADING ? "📄 PAPER" : "🔴 LIVE"} | Leverage: ${LEVERAGE}x | Capital: $${PORTFOLIO_VALUE_USD}`);
  console.log("══════════════════════════════════════════════\n");

  // ── Fetch market data ──────────────────────────────────────────────────────
  console.log("📡 Fetching market data from Binance...");
  const [btc15m, btc1h, sol5m, sol1h] = await Promise.all([
    getCandles("BTCUSDT", "15m", 25),
    getCandles("BTCUSDT", "1h",  25),
    getCandles("SOLUSDT", "5m",  50),
    getCandles("SOLUSDT", "1h",  25),
  ]);

  const btcPrice = btc15m[btc15m.length - 1].close;
  const solPrice = sol5m[sol5m.length - 1].close;

  // % changes — compare last closed candle vs candle N periods ago
  const btcChange15m = pctChange(btc15m[btc15m.length - 2].open, btcPrice);
  const btcChange1h  = pctChange(btc1h[btc1h.length - 2].open,  btcPrice);
  const solChange15m = pctChange(sol5m[sol5m.length - 4].close,  solPrice);  // ~15m via 5m candles
  const solChange1h  = pctChange(sol1h[sol1h.length - 2].open,   solPrice);

  // Volume — is BTC volume above its 20-period average?
  const btcVolumes = btc15m.slice(0, -1).map((c) => c.volume);
  const avgBtcVol  = btcVolumes.reduce((a, b) => a + b, 0) / btcVolumes.length;
  const lastBtcVol = btc15m[btc15m.length - 1].volume;
  const volumeOk   = lastBtcVol > avgBtcVol;

  // RSI(14) on SOL 5m
  const solCloses = sol5m.map((c) => c.close);
  const solRSI    = calcRSI(solCloses, 14);

  console.log("── Market Data ───────────────────────────────────────────");
  console.log(`  BTC:  $${btcPrice.toFixed(2)}  | 15m: ${btcChange15m.toFixed(2)}%  | 1h: ${btcChange1h.toFixed(2)}%`);
  console.log(`  SOL:  $${solPrice.toFixed(4)} | 15m: ${solChange15m.toFixed(2)}%  | 1h: ${solChange1h.toFixed(2)}%`);
  console.log(`  SOL RSI(14) 5m: ${solRSI ? solRSI.toFixed(1) : "N/A"}`);
  console.log(`  BTC Vol vs Avg: ${lastBtcVol.toFixed(0)} vs ${avgBtcVol.toFixed(0)} → ${volumeOk ? "✅ Above avg" : "⚠️ Below avg"}`);

  // ── Check open position ────────────────────────────────────────────────────
  const position = loadState();

  if (position) {
    const hoursOpen = (now - new Date(position.entryTime)) / 3600000;
    const pnlPct    = pctChange(position.entryPrice, solPrice);

    console.log("\n── Open Position ─────────────────────────────────────────");
    console.log(`  Entry: $${position.entryPrice.toFixed(4)} | Now: $${solPrice.toFixed(4)}`);
    console.log(`  PnL: ${pnlPct.toFixed(2)}% (${(pnlPct * LEVERAGE).toFixed(2)}% with ${LEVERAGE}x) | Open: ${hoursOpen.toFixed(1)}h`);

    let exitReason = null;

    // ONLY exit on: real BTC crash OR take profit — NO stop loss
    if (btcChange15m <= BTC_CRASH_15M)
      exitReason = `🚨 REAL CRASH — BTC dropped ${btcChange15m.toFixed(2)}% in 15m — emergency exit`;
    else if (btcChange1h <= BTC_CRASH_1H)
      exitReason = `🚨 REAL CRASH — BTC dropped ${btcChange1h.toFixed(2)}% in 1h — emergency exit`;
    else if (pnlPct >= TAKE_PROFIT_PCT)
      exitReason = `✅ Take profit hit: SOL +${pnlPct.toFixed(2)}% — exiting`;

    if (exitReason) {
      console.log(`\n  EXIT: ${exitReason}`);
      try {
        const order = await placeBitgetOrder("Sell", position.quantity);
        logTrade({ date, time, side: "Sell", quantity: position.quantity, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", orderId: order?.orderId });
        console.log("  Trade logged → trades.csv");
      } catch (e) {
        console.error("  ❌ Exit order failed:", e.message);
      }
      clearState();
      saveLog({ action: "EXIT", reason: exitReason, pnlPct, solPrice, btcChange15m, btcChange1h, timestamp: now.toISOString() });
    } else {
      console.log("  ⏳ Holding — no exit conditions met");
      saveLog({ action: "HOLD", pnlPct, solPrice, btcChange15m, btcChange1h, hoursOpen, timestamp: now.toISOString() });
    }
    return;
  }

  // ── Entry safety check ─────────────────────────────────────────────────────
  console.log("\n── Safety Check ──────────────────────────────────────────");

  const lagRatio = btcChange15m > 0 ? solChange15m / btcChange15m : 999;

  const conditions = [
    {
      label:    `BTC 15m above +${BTC_PUMP_15M}% — BTC pumping`,
      required: `> ${BTC_PUMP_15M}%`,
      actual:   `${btcChange15m.toFixed(2)}%`,
      pass:     btcChange15m >= BTC_PUMP_15M,
    },
    {
      label:    `BTC 1h above +${BTC_PUMP_1H}% — sustained move`,
      required: `> ${BTC_PUMP_1H}%`,
      actual:   `${btcChange1h.toFixed(2)}%`,
      pass:     btcChange1h >= BTC_PUMP_1H,
    },
    {
      label:    `SOL lagging — moved < ${SOL_LAG_RATIO * 100}% of BTC`,
      required: `lag ratio < ${SOL_LAG_RATIO}`,
      actual:   `ratio: ${lagRatio.toFixed(2)}`,
      pass:     lagRatio < SOL_LAG_RATIO,
    },
    {
      label:    "SOL 1h change less than BTC 1h (lag on 1h too)",
      required: "SOL 1h < BTC 1h",
      actual:   `SOL: ${solChange1h.toFixed(2)}% vs BTC: ${btcChange1h.toFixed(2)}%`,
      pass:     solChange1h < btcChange1h,
    },
    {
      label:    "BTC volume above 20-period avg (move is real)",
      required: "above avg",
      actual:   volumeOk ? "above avg" : "below avg",
      pass:     volumeOk,
    },
    {
      label:    `SOL RSI(14) below ${SOL_RSI_MAX} (not overbought)`,
      required: `< ${SOL_RSI_MAX}`,
      actual:   solRSI ? solRSI.toFixed(1) : "N/A",
      pass:     solRSI !== null && solRSI < SOL_RSI_MAX,
    },
    {
      label:    "BTC not in real crash (protection — pullbacks OK)",
      required: `15m > ${BTC_CRASH_15M}% and 1h > ${BTC_CRASH_1H}%`,
      actual:   `15m: ${btcChange15m.toFixed(2)}% | 1h: ${btcChange1h.toFixed(2)}%`,
      pass:     btcChange15m > BTC_CRASH_15M && btcChange1h > BTC_CRASH_1H,
    },
    {
      label:    `Daily trade limit (max ${MAX_TRADES_PER_DAY}/day)`,
      required: `< ${MAX_TRADES_PER_DAY}`,
      actual:   `${todayTradeCount()} trades today`,
      pass:     todayTradeCount() < MAX_TRADES_PER_DAY,
    },
  ];

  const failed = conditions.filter((c) => !c.pass);
  const allPass = failed.length === 0;

  conditions.forEach((c) => {
    const icon = c.pass ? "✅" : "🚫";
    console.log(`  ${icon} ${c.label}`);
    if (!c.pass) console.log(`     Required: ${c.required} | Actual: ${c.actual}`);
  });

  if (!allPass) {
    console.log("\n🚫 TRADE BLOCKED");
    console.log("  Failed conditions:");
    failed.forEach((c) => console.log(`  - ${c.label}`));
    saveLog({ action: "SKIP", failed: failed.map((c) => c.label), btcChange15m, btcChange1h, solChange15m, solChange1h, lagRatio, solRSI, timestamp: now.toISOString() });
    return;
  }

  // ── Execute entry ──────────────────────────────────────────────────────────
  console.log("\n✅ ALL CONDITIONS PASSED — entering long SOLUSDT");

  const positionSizeUSD = Math.min(PORTFOLIO_VALUE_USD * LEVERAGE, MAX_TRADE_SIZE_USD * LEVERAGE);
  const quantity        = positionSizeUSD / solPrice;

  console.log(`  Size: $${positionSizeUSD.toFixed(2)} (${LEVERAGE}x) = ${quantity.toFixed(4)} SOL @ $${solPrice.toFixed(4)}`);
  console.log(`  Stop loss: $${(solPrice * (1 - STOP_LOSS_PCT / 100)).toFixed(4)} (-${STOP_LOSS_PCT}%)`);

  try {
    const order   = await placeBitgetOrder("Buy", quantity);
    const orderId = order?.orderId || "UNKNOWN";

    saveState({ entryPrice: solPrice, entryTime: now.toISOString(), quantity, orderId, btcChangeAtEntry: { "15m": btcChange15m, "1h": btcChange1h } });
    logTrade({ date, time, side: "Buy", quantity, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", orderId });
    saveLog({ action: "ENTRY", solPrice, btcPrice, btcChange15m, btcChange1h, lagRatio, quantity, positionSizeUSD, orderId, timestamp: now.toISOString() });

    console.log(`  ✅ Order placed — ${PAPER_TRADING ? "PAPER" : "LIVE"}`);
    console.log("  Trade logged → trades.csv");
  } catch (e) {
    console.error("  ❌ Entry order failed:", e.message);
  }
}

main().catch((e) => {
  console.error("Bot error:", e);
  process.exit(1);
});
