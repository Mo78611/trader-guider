"use strict";
// Market data with automatic fallback.
// Primary: Binance public REST (free, no key). Fallback: Kraken public REST
// (free, no key) — used when Binance is unreachable or geo-blocked (HTTP 451)
// from the machine running this server. Responses are normalized to:
//   {time (sec), open, high, low, close, volume}

const KRAKEN_MAP = {
  BTCUSDT: "XBTUSD", ETHUSDT: "ETHUSD", BNBUSDT: "BNBUSD", SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD", DOGEUSDT: "DOGEUSD", ADAUSDT: "ADAUSD", AVAXUSDT: "AVAXUSD",
  LINKUSDT: "LINKUSD", PAXGUSDT: "PAXGUSD", ARBUSDT: "ARBUSD", NEARUSDT: "NEARUSD",
  APTUSDT: "APTUSD", OPUSDT: "OPUSD",
};
const KRAKEN_TF = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120,
  "4h": 240, "6h": 360, "8h": 480, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080, "1M": 21600 };

async function binanceKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

// data-api.binance.vision: geo-unrestricted mirror of the spot API.
// Unlocks ALL Binance-listed coins (not just the Kraken-mapped subset).
async function visionKlines(symbol, interval, limit) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`vision klines ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("vision klines empty");
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

async function krakenKlines(symbol, interval, limit) {
  const pair = KRAKEN_MAP[symbol];
  if (!pair) throw new Error(`kraken: no mapping for ${symbol}`);
  const tf = KRAKEN_TF[interval] || 60;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${tf}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kraken ohlc ${res.status}`);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error(`kraken: ${j.error.join("; ")}`);
  const key = Object.keys(j.result).find((k) => k !== "last");
  const rows = j.result[key].slice(-limit);
  return rows.map((r) => ({
    time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6],
  }));
}

/* ================= Yahoo Finance: forex + stocks (free, no key) =================
 * curl-verified 2026-10-19. Base: query1.finance.yahoo.com/v8/finance/chart/{sym}
 * Symbol mapping: EURUSD -> EURUSD=X, XAUUSD -> GC=F (COMEX gold futures, label honestly),
 * stocks pass through as-is. 4h+ built by aggregating 1h bars (Yahoo has no native 4h). */
const FOREX_MAP = {
  EURUSD: "EURUSD=X", GBPUSD: "GBPUSD=X", USDJPY: "USDJPY=X", USDCHF: "USDCHF=X",
  AUDUSD: "AUDUSD=X", USDCAD: "USDCAD=X", NZDUSD: "NZDUSD=X",
  EURGBP: "EURGBP=X", EURJPY: "EURJPY=X", GBPJPY: "GBPJPY=X",
  EURAUD: "EURAUD=X", EURCAD: "EURCAD=X", GBPCHF: "GBPCHF=X",
  AUDJPY: "AUDJPY=X", CADJPY: "CADJPY=X", CHFJPY: "CHFJPY=X",
  NZDJPY: "NZDJPY=X", AUDCAD: "AUDCAD=X", AUDCHF: "AUDCHF=X",
  EURCHF: "EURCHF=X", GBPCAD: "GBPCAD=X", GBPAUD: "GBPAUD=X",
  XAUUSD: "GC=F", XAGUSD: "SI=F", // futures proxy — labelled as such on the chart
};
const STOCK_LIST = ["AAPL","TSLA","NVDA","MSFT","AMZN","META","GOOGL","GOOG","AMD","NFLX","AVGO",
  "INTC","BA","DIS","PYPL","COIN","MSTR","PLTR","SOFI","NIO","BABA","TSM","JPM","V","WMT","XOM",
  "PFE","KO","NKE","MRNA","ZM","SHOP","UBER","SNAP","RBLX","HOOD","DKNG","LCID","RIVN","F","GM",
  "T","VZ","IBM","ORCL","CRM","ADBE","QCOM","TXN","SPY","QQQ","DIA","IWM"];
const YAHOO_TF = {
  "1m": { i: "1m", range: "1d" }, "3m": { i: "1m", range: "1d", agg: 3 },
  "5m": { i: "5m", range: "5d" }, "15m": { i: "15m", range: "5d" },
  "30m": { i: "30m", range: "1mo" }, "1h": { i: "1h", range: "1mo" },
  "2h": { i: "1h", range: "3mo", agg: 2 }, "4h": { i: "1h", range: "3mo", agg: 4 },
  "6h": { i: "1h", range: "6mo", agg: 6 }, "8h": { i: "1h", range: "6mo", agg: 8 },
  "12h": { i: "1h", range: "1y", agg: 12 }, "1d": { i: "1d", range: "2y" },
  "3d": { i: "1d", range: "5y", agg: 3 }, "1w": { i: "1wk", range: "5y" }, "1M": { i: "1mo", range: "max" },
};
const yahooCache = new Map(); // "SYM|TF" -> {at, data}
const YAHOO_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

function yahooRoute(sym) {
  if (FOREX_MAP[sym]) {
    const futures = sym === "XAUUSD" || sym === "XAGUSD";
    return { y: FOREX_MAP[sym], kind: futures ? (sym === "XAUUSD" ? "gold-futures" : "silver-futures") : "forex" };
  }
  if (STOCK_LIST.includes(sym)) return { y: sym, kind: "stock" };
  // Any other non-crypto ticker (e.g. AAPL typed manually, BTC-USD) -> try Yahoo as-is
  if (!/USDT$|USDC$|BUSD$|BTC$|ETH$/.test(sym) && !KRAKEN_MAP[sym]) return { y: sym, kind: "stock" };
  return null;
}

function aggregate(candles, n) {
  if (!n || n <= 1) return candles;
  const out = [];
  for (let i = 0; i < candles.length; i += n) {
    const chunk = candles.slice(i, i + n);
    if (!chunk.length) continue;
    out.push({
      time: chunk[0].time,
      open: chunk[0].open,
      high: Math.max(...chunk.map((c) => c.high)),
      low: Math.min(...chunk.map((c) => c.low)),
      close: chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
    });
  }
  return out;
}

async function yahooKlines(route, interval, limit) {
  const key = route.y + "|" + interval;
  const hit = yahooCache.get(key);
  if (hit && Date.now() - hit.at < 60000) return hit.data;
  const tf = YAHOO_TF[interval] || YAHOO_TF["1h"];
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(route.y)}?interval=${tf.i}&range=${tf.range}`;
  const res = await fetch(url, { headers: { "User-Agent": YAHOO_UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("yahoo: no data" + (j && j.chart && j.chart.error ? ` (${j.chart.error.description || ""})` : ""));
  const ts = r.timestamp || [], q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  let candles = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (c == null) continue;
    candles.push({
      time: ts[i], open: +(q.open[i] ?? c), high: +(q.high[i] ?? c),
      low: +(q.low[i] ?? c), close: +c, volume: +(q.volume[i] || 0),
    });
  }
  if (!candles.length) throw new Error("yahoo: empty bars");
  candles = aggregate(candles, tf.agg).slice(-limit);
  const data = { source: "yahoo", kind: route.kind, candles };
  yahooCache.set(key, { at: Date.now(), data });
  return data;
}

async function yahooTicker(route) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(route.y)}?interval=1d&range=2d`;
  const res = await fetch(url, { headers: { "User-Agent": YAHOO_UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`yahoo ticker ${res.status}`);
  const j = await res.json();
  const r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r) throw new Error("yahoo ticker: no data");
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const closes = (q.close || []).filter((c) => c != null);
  if (!closes.length) throw new Error("yahoo ticker: empty");
  const last = closes[closes.length - 1], prev = closes.length > 1 ? closes[closes.length - 2] : last;
  return { lastPrice: String(last),
           priceChangePercent: prev ? String(((last - prev) / prev) * 100) : null,
           highPrice: null, lowPrice: null, volume: null, source: "yahoo" };
}

async function getKlines(symbol, interval, limit) {
  const yr = yahooRoute(symbol);
  if (yr) return yahooKlines(yr, interval, limit);
  const errs = [];
  try {
    return { source: "binance", candles: await binanceKlines(symbol, interval, limit) };
  } catch (e1) { errs.push(`binance: ${e1.message}`); }
  try {
    return { source: "binance-vision", candles: await visionKlines(symbol, interval, limit) };
  } catch (e2) { errs.push(`vision: ${e2.message}`); }
  try {
    return { source: "kraken", candles: await krakenKlines(symbol, interval, limit) };
  } catch (e3) { errs.push(`kraken: ${e3.message}`); }
  throw new Error(`market_data_unavailable (${errs.join("; ")})`);
}

async function binanceTicker(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`binance ticker ${res.status}`);
  const t = await res.json();
  return { lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent,
           highPrice: t.highPrice, lowPrice: t.lowPrice, volume: t.volume, source: "binance" };
}

async function visionTicker(symbol) {
  const res = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbol=${symbol}`,
    { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`vision ticker ${res.status}`);
  const t = await res.json();
  return { lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent,
           highPrice: t.highPrice, lowPrice: t.lowPrice, volume: t.volume, source: "binance-vision" };
}

async function krakenTicker(symbol) {
  const pair = KRAKEN_MAP[symbol];
  if (!pair) throw new Error(`kraken: no mapping for ${symbol}`);
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!res.ok) throw new Error(`kraken ticker ${res.status}`);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error(`kraken: ${j.error.join("; ")}`);
  const key = Object.keys(j.result)[0];
  const t = j.result[key];
  const last = parseFloat(t.c[0]), open24 = parseFloat(t.o);
  return { lastPrice: String(last),
           priceChangePercent: open24 ? String(((last - open24) / open24) * 100) : null,
           highPrice: t.h[1], lowPrice: t.l[1], volume: t.v[1], source: "kraken" };
}

async function getTicker(symbol) {
  const yr = yahooRoute(symbol);
  if (yr) {
    try { return await yahooTicker(yr); }
    catch (e) { throw new Error(`ticker_unavailable (yahoo: ${e.message})`); }
  }
  try { return await binanceTicker(symbol); }
  catch (e1) {
    try { return await visionTicker(symbol); }
    catch (e2) {
      try { return await krakenTicker(symbol); }
      catch (e3) { throw new Error(`ticker_unavailable (binance: ${e1.message}; vision: ${e2.message}; kraken: ${e3.message})`); }
    }
  }
}

module.exports = { getKlines, getTicker, KRAKEN_MAP };
