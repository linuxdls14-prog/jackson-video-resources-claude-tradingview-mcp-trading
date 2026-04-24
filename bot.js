import fs from "fs";
import https from "https";

// ─── Config ───────────────────────────────────────────────────────────────────
const BITGET_API_KEY      = process.env.BITGET_API_KEY || "";
const BITGET_SECRET_KEY   = process.env.BITGET_SECRET_KEY || "";
const BITGET_PASSPHRASE   = process.env.BITGET_PASSPHRASE || "";
const BITGET_BASE_URL     = process.env.BITGET_BASE_URL || "https://api.bitget.com";
const PORTFOLIO_VALUE_USD = parseFloat(process.env.PORTFOLIO_VALUE_USD || "100");
const MAX_TRADES_PER_DAY  = parseInt(process.env.MAX_TRADES_PER_DAY || "6");
const PAPER_TRADING       = process.env.PAPER_TRADING !== "false";
const LEVERAGE            = 3;
const THIRD_CAPITAL       = PORTFOLIO_VALUE_USD / 3; // ~33 USDT per trade slot

// ─── Strategy config ──────────────────────────────────────────────────────────
// BTC is a FILTER only — blocks crashes, never requires pumps

// Crash protection — the ONLY thing BTC is used for
const CRASH_BTC_5M          = -0.8;  // BTC drops 0.8% in 5m = danger
const CRASH_BTC_15M         = -1.2;  // BTC drops 1.2% in 15m = real crash, block everything
const CRASH_BTC_1H          = -6.0;  // BTC drops 6% in 1h = extreme crash, exit all

// Momentum mode: SOL lagging BTC (BTC as additional advantage, not requirement)
const MOMENTUM_LAG_RATIO    =  0.6;  // SOL moved less than 60% of BTC — lag confirmed
const MOMENTUM_SOL_RSI_MAX  = 80;    // RSI 80 = strength in trends, not ceiling
const MOMENTUM_TP           =  0.8;  // TP +0.8% — realistic 5m scalp

// Trailing stop — locks in profit once trade moves in our favor
const TRAIL_START           =  0.6;  // % — start trailing when PnL hits +0.6%
const TRAIL_LOCK            =  0.25; // % — lock in at least this much profit

// Pullback mode: SOL dropped harder than BTC = oversold bounce
const PULLBACK_BTC_MIN_1H   = -0.1;  // BTC pulled back at least 0.1% in 1h (much more realistic)
const PULLBACK_BTC_MAX_1H   = -2.5;  // Not a full crash
const PULLBACK_SOL_MULT     =  1.6;  // SOL dropped 1.6x more than BTC — less restrictive
const PULLBACK_SOL_RSI_MAX  = 50;    // 48.5 now enters
const PULLBACK_TP           =  1.0;  // TP +1.0%

// Continuation mode: SOL breaks above recent high
const BREAKOUT_LOOKBACK     =  4;    // Look back 4 candles (~20m)
const BREAKOUT_SOL_RSI_MIN  = 45;    // 45-75 = real continuation zone
const BREAKOUT_SOL_RSI_MAX  = 82;    // RSI 80 in SOL = trend strength, not overbought
const BREAKOUT_TP           =  0.85; // TP +0.85%
const BREAKOUT_TOLERANCE    =  0.994; // 0.6% tolerance — SOL breaks dirty

// Max hold time per mode
const MOMENTUM_MAX_MINUTES     = 45;
const CONTINUATION_MAX_MINUTES = 60;
const PULLBACK_MAX_MINUTES     = 45;
const TREND_MAX_MINUTES        = 60;

// Trend mode: price above EMA8, RSI healthy, BTC not crashing
const TREND_RSI_MIN         = 55;    // RSI above 55 = trend has momentum
const TREND_RSI_MAX         = 82;    // Not overbought
const TREND_TP              =  0.8;  // TP +0.8%

// Anti-duplicate — block entry if price too close to existing position
const MIN_ENTRY_DISTANCE    =  0.25;

// Cooldown after any exit — don't re-enter any mode for 10min
const COOLDOWN_MINUTES      = 10;

// BTC trend filter — if BTC 1h negative, only PULLBACK can enter
const BTC_TREND_MIN_1H      =  0.0;  // BTC 1h must be >= 0% for trend-following modes

// Candle timing: wait N ms after cron fires to avoid reading incomplete candle
const CANDLE_DELAY_MS       = 8000;

// ─── State files ──────────────────────────────────────────────────────────────
const LOG_FILE              = "safety-check-log.json";
const TRADES_FILE           = "trades.csv";
const STATE_MOMENTUM        = "position-momentum.json";
const STATE_PULLBACK        = "position-pullback.json";
const STATE_CONTINUATION    = "position-continuation.json";
const STATE_TREND           = "position-trend.json";
const COOLDOWN_FILE         = "cooldown.json";  // Global cooldown — blocks all entries for 10min after any exit

// ─── Helpers ──────────────────────────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch (e) { reject(e); } });
    }).on("error", reject);
  });
}

function calcEMA(closes, period) {
  if (closes.length < period) return null;
  let ema = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const k = 2 / (period + 1);
  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
}

function calcRSI(closes, period = 14) {
  if (closes.length < period + 1) return null;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gains += d; else losses += Math.abs(d);
  }
  let ag = gains / period, al = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    ag = (ag * (period - 1) + (d > 0 ? d : 0)) / period;
    al = (al * (period - 1) + (d < 0 ? Math.abs(d) : 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}

function pct(from, to) { return ((to - from) / from) * 100; }

async function getCandles(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const raw = await httpsGet(url);
  return raw.map((c) => ({
    open: parseFloat(c[1]), high: parseFloat(c[2]),
    low:  parseFloat(c[3]), close: parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// ─── GitHub state persistence ─────────────────────────────────────────────────
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_REPO  = process.env.GITHUB_REPO;

async function githubGet(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: "GET",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "User-Agent": "sol-btc-bot",
        "Accept": "application/vnd.github.v3+json",
      },
    };
    https.get(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try {
          const parsed = JSON.parse(d);
          if (parsed.content) {
            const content = Buffer.from(parsed.content, "base64").toString("utf8");
            resolve({ content, sha: parsed.sha });
          } else {
            resolve(null);
          }
        } catch { resolve(null); }
      });
    }).on("error", () => resolve(null));
  });
}

async function githubPut(path, content, sha) {
  const encoded = Buffer.from(content).toString("base64");
  const body = JSON.stringify({
    message: `state: ${path} ${new Date().toISOString().slice(0, 16)}`,
    content: encoded,
    ...(sha ? { sha } : {}),
  });
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: "PUT",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "User-Agent": "sol-btc-bot",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => {
        try { resolve(JSON.parse(d)); } catch { resolve(null); }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

async function githubDelete(path) {
  const current = await githubGet(path);
  if (!current) return;
  const body = JSON.stringify({
    message: `clear: ${path}`,
    sha: current.sha,
  });
  return new Promise((resolve) => {
    const options = {
      hostname: "api.github.com",
      path: `/repos/${GITHUB_REPO}/contents/${path}`,
      method: "DELETE",
      headers: {
        "Authorization": `token ${GITHUB_TOKEN}`,
        "User-Agent": "sol-btc-bot",
        "Accept": "application/vnd.github.v3+json",
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    };
    const req = https.request(options, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => resolve());
    });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

async function loadPos(file) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    if (!fs.existsSync(file)) return null;
    try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
  }
  const result = await githubGet(`state/${file}`);
  if (!result) return null;
  try { return JSON.parse(result.content); } catch { return null; }
}

async function savePos(file, data) {
  const content = JSON.stringify(data, null, 2);
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    fs.writeFileSync(file, content);
    return;
  }
  const current = await githubGet(`state/${file}`);
  await githubPut(`state/${file}`, content, current?.sha);
}

async function clearPos(file) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  await githubDelete(`state/${file}`);
}

async function setCooldown(file) {
  const data = JSON.stringify({ exitTime: new Date().toISOString() });
  const current = await githubGet(`state/${file}`);
  await githubPut(`state/${file}`, data, current?.sha);
}

async function isInCooldown(file) {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return false;
  const result = await githubGet(`state/${file}`);
  if (!result) return false;
  try {
    const { exitTime } = JSON.parse(result.content);
    const minutesSince = (Date.now() - new Date(exitTime).getTime()) / 60000;
    if (minutesSince < COOLDOWN_MINUTES) {
      console.log(`  ⏸️  Cooldown active — ${(COOLDOWN_MINUTES - minutesSince).toFixed(0)}min remaining`);
      return true;
    }
    // Cooldown expired — delete it
    await githubDelete(`state/${file}`);
    return false;
  } catch { return false; }
}

function todayTradeCount() {
  if (!fs.existsSync(TRADES_FILE)) return 0;
  const today = new Date().toISOString().slice(0, 10);
  return fs.readFileSync(TRADES_FILE, "utf8").split("\n")
    .filter((l) => l.startsWith(today) && l.includes("Live")).length;
}

function logTrade({ date, time, side, quantity, price, mode, tag, orderId = "PAPER" }) {
  const header = "Date,Time,Exchange,Symbol,Side,Quantity,Price,TotalUSD,Fee,NetAmount,OrderID,Mode,Tag\n";
  if (!fs.existsSync(TRADES_FILE)) fs.writeFileSync(TRADES_FILE, header);
  const total = quantity * price;
  const fee   = total * 0.0006;
  const net   = side === "Buy" ? total + fee : total - fee;
  const line  = `${date},${time},BitGet,SOLUSDT,${side},${quantity.toFixed(4)},${price.toFixed(4)},${total.toFixed(4)},${fee.toFixed(4)},${net.toFixed(4)},${orderId},${mode},${tag}\n`;
  fs.appendFileSync(TRADES_FILE, line);
  // Sync to GitHub after every trade
  syncTradesToGitHub().catch((e) => console.error("  ⚠️ GitHub sync failed:", e.message));
}

// ─── Sync trades CSV to GitHub ────────────────────────────────────────────────
async function syncTradesToGitHub() {
  if (!GITHUB_TOKEN || !GITHUB_REPO) return;
  const content = fs.existsSync(TRADES_FILE)
    ? fs.readFileSync(TRADES_FILE, "utf8")
    : "Date,Time,Exchange,Symbol,Side,Quantity,Price,TotalUSD,Fee,NetAmount,OrderID,Mode,Tag\n";
  const current = await githubGet("trades.csv");
  await githubPut("trades.csv", content, current?.sha);
  console.log("  ✅ trades.csv synced to GitHub");
}

function saveLog(data) {
  fs.writeFileSync(LOG_FILE, JSON.stringify(data, null, 2));
}

// Anti-duplicate check — block if current price too close to any open position
function tooCloseToExisting(currentPrice, positions) {
  return positions.filter(Boolean).some((p) => {
    const dist = Math.abs((currentPrice - p.entryPrice) / p.entryPrice * 100);
    return dist < MIN_ENTRY_DISTANCE;
  });
}

// ─── BitGet order ─────────────────────────────────────────────────────────────
async function placeOrder(side, quantity, tag) {
  if (PAPER_TRADING) {
    console.log(`  📄 PAPER [${tag}] — would ${side} ${quantity.toFixed(4)} SOLUSDT`);
    return { orderId: "PAPER-" + Date.now() };
  }
  const crypto    = await import("crypto");
  const timestamp = Date.now().toString();
  const body      = JSON.stringify({
    symbol: "SOLUSDT", productType: "USDT-FUTURES",
    marginMode: "isolated", marginCoin: "USDT",
    size: quantity.toString(),
    side: side === "Buy" ? "buy" : "sell",
    orderType: "market", leverage: LEVERAGE.toString(),
  });
  const sign = crypto.default
    .createHmac("sha256", BITGET_SECRET_KEY)
    .update(timestamp + "POST" + "/api/v2/mix/order/place-order" + body)
    .digest("base64");
  return new Promise((resolve, reject) => {
    const u = new URL(BITGET_BASE_URL + "/api/v2/mix/order/place-order");
    const req = https.request({
      hostname: u.hostname, path: u.pathname, method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ACCESS-KEY": BITGET_API_KEY, "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp, "ACCESS-PASSPHRASE": BITGET_PASSPHRASE,
      },
    }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ─── Handle open position ─────────────────────────────────────────────────────
async function handlePosition(pos, stateFile, tag, tp, maxMinutes, solPrice, btcChange15m, btcChange1h, now) {
  const hoursOpen   = (now - new Date(pos.entryTime)) / 3600000;
  const minutesOpen = hoursOpen * 60;
  const pnlPct      = pct(pos.entryPrice, solPrice);
  const date        = now.toISOString().slice(0, 10);
  const time        = now.toISOString().slice(11, 19);

  console.log(`\n── Position [${tag}] ──────────────────────────────────────`);
  console.log(`  Entry: $${pos.entryPrice.toFixed(4)} | Now: $${solPrice.toFixed(4)}`);
  console.log(`  PnL: ${pnlPct.toFixed(2)}% (${(pnlPct * LEVERAGE).toFixed(2)}% levered) | Open: ${minutesOpen.toFixed(0)}min | TP: +${tp}% | Max: ${maxMinutes}min`);

  let exitReason = null;

  // Trailing stop — once PnL hits TRAIL_START, protect TRAIL_LOCK minimum
  const trailingStop = pnlPct >= TRAIL_START ? pnlPct - TRAIL_LOCK : null;
  if (trailingStop !== null) {
    console.log(`  🔒 Trailing active — locked: +${trailingStop.toFixed(2)}% | current: +${pnlPct.toFixed(2)}%`);
  }

  if (btcChange15m <= CRASH_BTC_15M)
    exitReason = `🚨 CRASH — BTC ${btcChange15m.toFixed(2)}% in 15m`;
  else if (btcChange1h <= CRASH_BTC_1H)
    exitReason = `🚨 CRASH — BTC ${btcChange1h.toFixed(2)}% in 1h`;
  else if (pnlPct >= tp)
    exitReason = `✅ Take profit +${pnlPct.toFixed(2)}%`;
  else if (trailingStop !== null && pnlPct <= trailingStop)
    exitReason = `🔒 Trailing stop — locked +${trailingStop.toFixed(2)}%, now at +${pnlPct.toFixed(2)}%`;
  else if (minutesOpen >= maxMinutes)
    exitReason = `⏰ Max hold ${maxMinutes}min reached (PnL: ${pnlPct.toFixed(2)}%) — freeing capital`;

  if (exitReason) {
    console.log(`  EXIT: ${exitReason}`);
    const isMaxHold = exitReason.includes("Max hold");
    try {
      const order = await placeOrder("Sell", pos.quantity, tag);
      logTrade({ date, time, side: "Sell", quantity: pos.quantity, price: solPrice,
        mode: PAPER_TRADING ? "Paper" : "Live", tag, orderId: order?.orderId });
      console.log("  Logged → trades.csv");
    } catch (e) { console.error("  ❌ Exit failed:", e.message); }
    await clearPos(stateFile);
    // Set global cooldown after any exit
    await savePos(COOLDOWN_FILE, { lastCloseTime: Date.now() });
    console.log(`  ⏸️  Cooldown set — no new entries for ${COOLDOWN_MINUTES}min`);
    return true;
  }
  console.log("  ⏳ Holding");
  return false;
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  // Wait for last candle to fully close before reading data
  await new Promise((r) => setTimeout(r, CANDLE_DELAY_MS));

  const now  = new Date();
  const date = now.toISOString().slice(0, 10);
  const time = now.toISOString().slice(11, 19);

  console.log("\n══════════════════════════════════════════════════════");
  console.log(`  SOL/BTC Dual Mode — ${date} ${time} UTC`);
  console.log(`  Mode: ${PAPER_TRADING ? "📄 PAPER" : "🔴 LIVE"} | ${LEVERAGE}x | $${PORTFOLIO_VALUE_USD} ($${THIRD_CAPITAL.toFixed(0)}/slot)`);
  console.log("══════════════════════════════════════════════════════\n");

  console.log("📡 Fetching Binance data...");
  const [btc5m, btc15m, btc1h, sol5m, sol1h] = await Promise.all([
    getCandles("BTCUSDT", "5m",  10),
    getCandles("BTCUSDT", "15m", 25),
    getCandles("BTCUSDT", "1h",  25),
    getCandles("SOLUSDT", "5m",  50),
    getCandles("SOLUSDT", "1h",  25),
  ]);

  const btcPrice     = btc5m[btc5m.length - 1].close;
  const solPrice     = sol5m[sol5m.length - 1].close;
  const btcChange5m  = pct(btc5m[btc5m.length - 2].open,  btcPrice);
  const btcChange15m = pct(btc15m[btc15m.length - 2].open, btcPrice);
  const btcChange1h  = pct(btc1h[btc1h.length - 2].open,  btcPrice);
  const solChange15m = pct(sol5m[sol5m.length - 4].close,  solPrice);
  const solChange1h  = pct(sol1h[sol1h.length - 2].open,   solPrice);
  const solCloses    = sol5m.map((c) => c.close);
  const solRSI       = calcRSI(solCloses, 14);
  const solEMA8      = calcEMA(solCloses, 8);
  const solBtcDiff1h = solChange1h - btcChange1h;

  console.log("── Market ────────────────────────────────────────────────");
  console.log(`  BTC: $${btcPrice.toFixed(2)} | 5m: ${btcChange5m.toFixed(2)}% | 15m: ${btcChange15m.toFixed(2)}% | 1h: ${btcChange1h.toFixed(2)}%`);
  console.log(`  SOL: $${solPrice.toFixed(4)} | 15m: ${solChange15m.toFixed(2)}% | 1h: ${solChange1h.toFixed(2)}%`);
  console.log(`  SOL vs BTC diff 1h: ${solBtcDiff1h.toFixed(2)}% | SOL RSI: ${solRSI ? solRSI.toFixed(1) : "N/A"}`);

  // ── Handle existing positions ──────────────────────────────────────────────
  console.log("📂 Loading position state from GitHub...");
  const [posMomentum, posPullback, posContinuation, posTrend] = await Promise.all([
    loadPos(STATE_MOMENTUM),
    loadPos(STATE_PULLBACK),
    loadPos(STATE_CONTINUATION),
    loadPos(STATE_TREND),
  ]);
  if (posMomentum)     await handlePosition(posMomentum,     STATE_MOMENTUM,     "MOMENTUM",     MOMENTUM_TP,  MOMENTUM_MAX_MINUTES,     solPrice, btcChange15m, btcChange1h, now);
  if (posPullback)     await handlePosition(posPullback,     STATE_PULLBACK,     "PULLBACK",     PULLBACK_TP,  PULLBACK_MAX_MINUTES,     solPrice, btcChange15m, btcChange1h, now);
  if (posContinuation) await handlePosition(posContinuation, STATE_CONTINUATION, "CONTINUATION", BREAKOUT_TP,  CONTINUATION_MAX_MINUTES, solPrice, btcChange15m, btcChange1h, now);
  if (posTrend)        await handlePosition(posTrend,        STATE_TREND,        "TREND",        TREND_TP,     TREND_MAX_MINUTES,        solPrice, btcChange15m, btcChange1h, now);

  // Reload state after potential exits
  const [hasM, hasP, hasC, hasT] = await Promise.all([
    loadPos(STATE_MOMENTUM).then(Boolean),
    loadPos(STATE_PULLBACK).then(Boolean),
    loadPos(STATE_CONTINUATION).then(Boolean),
    loadPos(STATE_TREND).then(Boolean),
  ]);

  // ── Crash guard — only thing BTC is used for ──────────────────────────────
  if (btcChange5m <= CRASH_BTC_5M || btcChange15m <= CRASH_BTC_15M || btcChange1h <= CRASH_BTC_1H) {
    console.log(`\n🚨 CRASH DETECTED — no new entries`);
    console.log(`   BTC 5m: ${btcChange5m.toFixed(2)}% | 15m: ${btcChange15m.toFixed(2)}% | 1h: ${btcChange1h.toFixed(2)}%`);
    saveLog({ action: "CRASH_GUARD", btcChange5m, btcChange15m, btcChange1h, timestamp: now.toISOString() });
    return;
  }

  // BTC trend filter
  const btcTrendBullish = btcChange1h >= BTC_TREND_MIN_1H;
  if (!btcTrendBullish) {
    console.log(`\n⚠️  BTC 1h negative (${btcChange1h.toFixed(2)}%) — only PULLBACK allowed`);
  }

  console.log("\n── Entry Check ───────────────────────────────────────────");

  // ⏳ Global cooldown check
  const cooldownData = await loadPos(COOLDOWN_FILE);
  if (cooldownData?.lastCloseTime) {
    const minutesSinceClose = (Date.now() - cooldownData.lastCloseTime) / 60000;
    if (minutesSinceClose < COOLDOWN_MINUTES) {
      console.log(`  ⏳ Cooldown activo (${minutesSinceClose.toFixed(1)}min / ${COOLDOWN_MINUTES}min) — no new entries`);
      return;
    }
    // Expired — clean it up
    await clearPos(COOLDOWN_FILE);
  }

  // ── MOMENTUM MODE ──────────────────────────────────────────────────────────
  if (!hasM) {
    if (!btcTrendBullish) {
      console.log("\n  [MOMENTUM] Skipped — BTC 1h negative");
    } else {
    const lagRatio = btcChange15m > 0 ? solChange15m / btcChange15m : 999;
    const lagAdvantage = btcChange15m > 0 && lagRatio < MOMENTUM_LAG_RATIO; // bonus signal, not required
    const mConds = [
      { label: "SOL underperforming BTC on 1h (lag signal)",  pass: solBtcDiff1h < -0.1,                                             actual: `${solBtcDiff1h.toFixed(2)}%`,      required: "< -0.1%" },
      { label: `SOL RSI below ${MOMENTUM_SOL_RSI_MAX}`,       pass: solRSI !== null && solRSI < MOMENTUM_SOL_RSI_MAX,                 actual: solRSI?.toFixed(1) || "N/A",        required: `< ${MOMENTUM_SOL_RSI_MAX}` },
      { label: "SOL RSI above 35 (not crashed)",              pass: solRSI !== null && solRSI > 35,                                   actual: solRSI?.toFixed(1) || "N/A",        required: "> 35" },
      { label: "Daily limit OK",                              pass: todayTradeCount() < MAX_TRADES_PER_DAY,                           actual: `${todayTradeCount()} today`,       required: `< ${MAX_TRADES_PER_DAY}` },
    ];
    if (lagAdvantage) console.log(`  ℹ️  BTC lag bonus: SOL moved only ${(lagRatio * 100).toFixed(0)}% of BTC in 15m`);
    const mFailed = mConds.filter((c) => !c.pass);
    console.log("\n  [MOMENTUM] BTC up, SOL lagging:");
    mConds.forEach((c) => {
      console.log(`    ${c.pass ? "✅" : "🚫"} ${c.label}`);
      if (!c.pass) console.log(`       Need: ${c.required} | Got: ${c.actual}`);
    });
    if (mFailed.length === 0) {
      const openPositions = [await loadPos(STATE_PULLBACK), await loadPos(STATE_CONTINUATION), await loadPos(STATE_TREND)];
      if (tooCloseToExisting(solPrice, openPositions)) {
        console.log(`  🚫 MOMENTUM blocked — price too close to existing position (< ${MIN_ENTRY_DISTANCE}%)`);
      } else {
        const qty = (THIRD_CAPITAL * LEVERAGE) / solPrice;
        console.log(`  ✅ MOMENTUM ENTRY @ $${solPrice.toFixed(4)} | ${qty.toFixed(4)} SOL | TP: +${MOMENTUM_TP}%`);
        try {
          const order = await placeOrder("Buy", qty, "MOMENTUM");
          await savePos(STATE_MOMENTUM, { entryPrice: solPrice, entryTime: now.toISOString(), quantity: qty, orderId: order?.orderId, mode: "MOMENTUM" });
          logTrade({ date, time, side: "Buy", quantity: qty, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", tag: "MOMENTUM", orderId: order?.orderId });
        } catch (e) { console.error("  ❌ Momentum entry failed:", e.message); }
      }
    } else {
      console.log(`  🚫 MOMENTUM blocked — ${mFailed.length} failed`);
    }
    } // end btcTrendBullish else
  } else {
    console.log("\n  [MOMENTUM] Already in trade");
  }

  // ── PULLBACK MODE ──────────────────────────────────────────────────────────
  if (!hasP) {
    const solDroppedHarder = btcChange1h < 0 && solChange1h < btcChange1h * PULLBACK_SOL_MULT;
    const pConds = [
      { label: `BTC 1h pullback (${PULLBACK_BTC_MAX_1H}% to ${PULLBACK_BTC_MIN_1H}%)`, pass: btcChange1h <= PULLBACK_BTC_MIN_1H && btcChange1h >= PULLBACK_BTC_MAX_1H, actual: `${btcChange1h.toFixed(2)}%`, required: `between ${PULLBACK_BTC_MAX_1H}% and ${PULLBACK_BTC_MIN_1H}%` },
      { label: `SOL dropped ${PULLBACK_SOL_MULT}x harder than BTC`,                    pass: solDroppedHarder, actual: `SOL ${solChange1h.toFixed(2)}% vs BTC ${btcChange1h.toFixed(2)}%`, required: `SOL < BTC × ${PULLBACK_SOL_MULT}` },
      { label: `SOL RSI oversold (< ${PULLBACK_SOL_RSI_MAX})`,                         pass: solRSI !== null && solRSI < PULLBACK_SOL_RSI_MAX, actual: solRSI?.toFixed(1) || "N/A", required: `< ${PULLBACK_SOL_RSI_MAX}` },
      { label: "Daily limit OK",                                                         pass: todayTradeCount() < MAX_TRADES_PER_DAY, actual: `${todayTradeCount()} today`, required: `< ${MAX_TRADES_PER_DAY}` },
    ];
    const pFailed = pConds.filter((c) => !c.pass);
    console.log("\n  [PULLBACK] BTC pulled back, SOL oversold:");
    pConds.forEach((c) => {
      console.log(`    ${c.pass ? "✅" : "🚫"} ${c.label}`);
      if (!c.pass) console.log(`       Need: ${c.required} | Got: ${c.actual}`);
    });
    if (pFailed.length === 0) {
      const openPositions = [await loadPos(STATE_MOMENTUM), await loadPos(STATE_CONTINUATION), await loadPos(STATE_TREND)];
      if (tooCloseToExisting(solPrice, openPositions)) {
        console.log(`  🚫 PULLBACK blocked — price too close to existing position (< ${MIN_ENTRY_DISTANCE}%)`);
      } else {
        const qty = (THIRD_CAPITAL * LEVERAGE) / solPrice;
        console.log(`  ✅ PULLBACK ENTRY @ $${solPrice.toFixed(4)} | ${qty.toFixed(4)} SOL | TP: +${PULLBACK_TP}%`);
        try {
          const order = await placeOrder("Buy", qty, "PULLBACK");
          await savePos(STATE_PULLBACK, { entryPrice: solPrice, entryTime: now.toISOString(), quantity: qty, orderId: order?.orderId, mode: "PULLBACK" });
          logTrade({ date, time, side: "Buy", quantity: qty, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", tag: "PULLBACK", orderId: order?.orderId });
        } catch (e) { console.error("  ❌ Pullback entry failed:", e.message); }
      }
    } else {
      console.log(`  🚫 PULLBACK blocked — ${pFailed.length} failed`);
    }
  } else {
    console.log("\n  [PULLBACK] Already in trade");
  }

  // ── CONTINUATION MODE ─────────────────────────────────────────────────────
  if (!hasC) {
    if (!btcTrendBullish) {
      console.log("\n  [CONTINUATION] Skipped — BTC 1h negative");
    } else {
    const recentHighs  = sol5m.slice(-BREAKOUT_LOOKBACK - 1, -1).map((c) => c.high);
    const highestHigh  = Math.max(...recentHighs);
    const isBreakout   = solPrice >= highestHigh * BREAKOUT_TOLERANCE;
    const distToHigh   = ((highestHigh - solPrice) / highestHigh) * 100;

    const cConds = [
      { label: `SOL at/above high of last ${BREAKOUT_LOOKBACK} candles (±0.2%)`, pass: isBreakout, actual: `$${solPrice.toFixed(4)} vs high $${highestHigh.toFixed(4)} (${distToHigh.toFixed(2)}% away)`, required: `>= high × ${BREAKOUT_TOLERANCE}` },
      { label: `SOL RSI between ${BREAKOUT_SOL_RSI_MIN} and ${BREAKOUT_SOL_RSI_MAX}`,  pass: solRSI !== null && solRSI >= BREAKOUT_SOL_RSI_MIN && solRSI < BREAKOUT_SOL_RSI_MAX, actual: solRSI?.toFixed(1) || "N/A", required: `${BREAKOUT_SOL_RSI_MIN}–${BREAKOUT_SOL_RSI_MAX}` },
      { label: "BTC not crashing",                                                   pass: btcChange5m > CRASH_BTC_5M,                             actual: `${btcChange5m.toFixed(2)}%`, required: `> ${CRASH_BTC_5M}%` },
      { label: "Daily limit OK",                                                     pass: todayTradeCount() < MAX_TRADES_PER_DAY,                 actual: `${todayTradeCount()} today`,  required: `< ${MAX_TRADES_PER_DAY}` },
    ];
    const cFailed = cConds.filter((c) => !c.pass);
    console.log("\n  [CONTINUATION] SOL breaking above recent high:");
    cConds.forEach((c) => {
      console.log(`    ${c.pass ? "✅" : "🚫"} ${c.label}`);
      if (!c.pass) console.log(`       Need: ${c.required} | Got: ${c.actual}`);
    });
    if (cFailed.length === 0) {
      const openPositions = [await loadPos(STATE_MOMENTUM), await loadPos(STATE_PULLBACK), await loadPos(STATE_TREND)];
      if (tooCloseToExisting(solPrice, openPositions)) {
        console.log(`  🚫 CONTINUATION blocked — price too close to existing position (< ${MIN_ENTRY_DISTANCE}%)`);
      } else {
        const qty = (THIRD_CAPITAL * LEVERAGE) / solPrice;
        console.log(`  ✅ CONTINUATION ENTRY @ $${solPrice.toFixed(4)} | ${qty.toFixed(4)} SOL | TP: +${BREAKOUT_TP}%`);
        try {
          const order = await placeOrder("Buy", qty, "CONTINUATION");
          await savePos(STATE_CONTINUATION, { entryPrice: solPrice, entryTime: now.toISOString(), quantity: qty, orderId: order?.orderId, mode: "CONTINUATION" });
          logTrade({ date, time, side: "Buy", quantity: qty, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", tag: "CONTINUATION", orderId: order?.orderId });
        } catch (e) { console.error("  ❌ Continuation entry failed:", e.message); }
      }
    } else {
      console.log(`  🚫 CONTINUATION blocked — ${cFailed.length} failed`);
    }
    } // end btcTrendBullish else
  } else {
    console.log("\n  [CONTINUATION] Already in trade");
  }

  // ── TREND MODE ────────────────────────────────────────────────────────────
  if (!hasT) {
    if (!btcTrendBullish) {
      console.log("\n  [TREND] Skipped — BTC 1h negative");
    } else {
    const aboveEMA8 = solEMA8 !== null && solPrice > solEMA8;
    const tConds = [
      { label: "SOL price above EMA8 (uptrend)",          pass: aboveEMA8,                                                          actual: `$${solPrice.toFixed(4)} vs EMA8 $${solEMA8?.toFixed(4) || "N/A"}`, required: "price > EMA8" },
      { label: `SOL RSI between ${TREND_RSI_MIN} and ${TREND_RSI_MAX}`, pass: solRSI !== null && solRSI >= TREND_RSI_MIN && solRSI <= TREND_RSI_MAX, actual: solRSI?.toFixed(1) || "N/A", required: `${TREND_RSI_MIN}–${TREND_RSI_MAX}` },
      { label: "BTC not crashing",                        pass: btcChange5m > CRASH_BTC_5M,                                         actual: `${btcChange5m.toFixed(2)}%`,  required: `> ${CRASH_BTC_5M}%` },
      { label: "Daily limit OK",                          pass: todayTradeCount() < MAX_TRADES_PER_DAY,                              actual: `${todayTradeCount()} today`,  required: `< ${MAX_TRADES_PER_DAY}` },
    ];
    const tFailed = tConds.filter((c) => !c.pass);
    console.log("\n  [TREND] Price above EMA8, RSI healthy:");
    tConds.forEach((c) => {
      console.log(`    ${c.pass ? "✅" : "🚫"} ${c.label}`);
      if (!c.pass) console.log(`       Need: ${c.required} | Got: ${c.actual}`);
    });
    if (tFailed.length === 0) {
      const openPositions = [await loadPos(STATE_MOMENTUM), await loadPos(STATE_PULLBACK), await loadPos(STATE_CONTINUATION)];
      if (tooCloseToExisting(solPrice, openPositions)) {
        console.log(`  🚫 TREND blocked — price too close to existing position (< ${MIN_ENTRY_DISTANCE}%)`);
      } else {
        const qty = (THIRD_CAPITAL * LEVERAGE) / solPrice;
        console.log(`  ✅ TREND ENTRY @ $${solPrice.toFixed(4)} | ${qty.toFixed(4)} SOL | TP: +${TREND_TP}%`);
        try {
          const order = await placeOrder("Buy", qty, "TREND");
          await savePos(STATE_TREND, { entryPrice: solPrice, entryTime: now.toISOString(), quantity: qty, orderId: order?.orderId, mode: "TREND" });
          logTrade({ date, time, side: "Buy", quantity: qty, price: solPrice, mode: PAPER_TRADING ? "Paper" : "Live", tag: "TREND", orderId: order?.orderId });
        } catch (e) { console.error("  ❌ Trend entry failed:", e.message); }
      }
    } else {
      console.log(`  🚫 TREND blocked — ${tFailed.length} failed`);
    }
    } // end btcTrendBullish else
  } else {
    console.log("\n  [TREND] Already in trade");
  }

  saveLog({ btcPrice, solPrice, btcChange5m, btcChange15m, btcChange1h, solChange15m, solChange1h, solBtcDiff1h, solRSI, solEMA8, hasM, hasP, hasC, hasT, timestamp: now.toISOString() });
}

main().catch((e) => { console.error("Bot error:", e); process.exit(1); });
