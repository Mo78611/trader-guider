"use strict";
// Public market data proxy (no auth needed, no API key needed).
// Binance public API first, Kraken public API as automatic fallback.
// GET /api/market/klines?symbol=BTCUSDT&interval=1h&limit=500
// GET /api/market/ticker?symbol=BTCUSDT

const express = require("express");
const { getKlines, getTicker, yahooRoute } = require("../lib/market");

const router = express.Router();
const INTERVALS = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);

function cleanSymbol(s) {
  return String(s || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "BTCUSDT";
}

router.get("/klines", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.query.symbol);
    const interval = INTERVALS.has(req.query.interval) ? req.query.interval : "1h";
    const limit = Math.min(Math.max(parseInt(req.query.limit || "500", 10) || 500, 1), 1000);
    const { source, candles } = await getKlines(symbol, interval, limit);
    res.json({ symbol, interval, source, candles });
  } catch (e) {
    res.status(502).json({ error: "market_data_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

router.get("/ticker", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.query.symbol);
    const t = await getTicker(symbol);
    res.json({ symbol, ...t });
  } catch (e) {
    res.status(502).json({ error: "market_data_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

/* All tradable USDT spot symbols (511+ coins) for the symbol search.
 * GET /api/market/symbols — cached 24h server-side. */
let symbolsCache = { at: 0, list: [] };
router.get("/symbols", async (req, res) => {
  try {
    if (Date.now() - symbolsCache.at < 24 * 3600 * 1000 && symbolsCache.list.length) {
      return res.json({ count: symbolsCache.list.length, symbols: symbolsCache.list, cached: true });
    }
    const r = await fetch("https://data-api.binance.vision/api/v3/exchangeInfo",
      { signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(`exchangeInfo ${r.status}`);
    const j = await r.json();
    const list = j.symbols
      .filter((s) => s.status === "TRADING" && s.quoteAsset === "USDT" && s.isSpotTradingAllowed)
      .map((s) => s.symbol)
      .sort();
    symbolsCache = { at: Date.now(), list };
    res.json({ count: list.length, symbols: list, cached: false });
  } catch (e) {
    if (symbolsCache.list.length) {
      return res.json({ count: symbolsCache.list.length, symbols: symbolsCache.list, cached: true, stale: true });
    }
    res.status(502).json({ error: "symbols_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

/* Watchlist: curated Crypto / Forex / Stocks with live prices + 24h change.
 * GET /api/market/watchlist — batch-fetched, cached 30s server-side. */
const WL_CRYPTO = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","PAXGUSDT","ARBUSDT","NEARUSDT"];
const WL_FOREX = ["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","USDCAD","NZDUSD","XAUUSD","XAGUSD","EURJPY","GBPJPY"];
const WL_STOCKS = ["AAPL","TSLA","NVDA","MSFT","AMZN","META","GOOGL","AMD","NFLX","COIN"];
const YAHOO_UA_WL = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";
let wlCache = { at: 0, data: null };

async function wlCrypto() {
  const syms = encodeURIComponent(JSON.stringify(WL_CRYPTO));
  const r = await fetch(`https://data-api.binance.vision/api/v3/ticker/24hr?symbols=${syms}`,
    { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`wl crypto ${r.status}`);
  const j = await r.json();
  const map = {};
  for (const t of j) map[t.symbol] = t;
  return WL_CRYPTO.map((s) => {
    const t = map[s];
    if (!t) return { s, label: s.replace("USDT", ""), price: null, chg: null };
    return { s, label: s.replace("USDT", ""), price: parseFloat(t.lastPrice),
             chg: parseFloat(t.priceChangePercent) };
  });
}

async function wlYahoo(userSyms) {
  const ymap = {};
  for (const s of userSyms) {
    const rt = yahooRoute(s);
    if (rt) ymap[s] = rt.y;
  }
  const ysyms = Object.values(ymap).join(",");
  if (!ysyms) return userSyms.map((s) => ({ s, label: s, price: null, chg: null }));
  const r = await fetch(`https://query1.finance.yahoo.com/v7/finance/spark?symbols=${encodeURIComponent(ysyms)}&interval=1d&range=5d`,
    { headers: { "User-Agent": YAHOO_UA_WL }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`wl yahoo ${r.status}`);
  const j = await r.json();
  const out = {};
  for (const res of (j.spark && j.spark.result) || []) {
    const meta = (res.response && res.response[0] && res.response[0].meta) || {};
    out[res.symbol] = { price: meta.regularMarketPrice ?? null,
                        chg: meta.regularMarketChangePercent ?? null };
  }
  return userSyms.map((s) => {
    const t = out[ymap[s]];
    return { s, label: s, price: t ? t.price : null, chg: t ? t.chg : null };
  });
}

router.get("/watchlist", async (req, res) => {
  try {
    if (Date.now() - wlCache.at < 30000 && wlCache.data) {
      return res.json({ ...wlCache.data, cached: true });
    }
    const [crypto, forex, stocks] = await Promise.all([
      wlCrypto().catch(() => WL_CRYPTO.map((s) => ({ s, label: s.replace("USDT", ""), price: null, chg: null }))),
      wlYahoo(WL_FOREX).catch(() => WL_FOREX.map((s) => ({ s, label: s, price: null, chg: null }))),
      wlYahoo(WL_STOCKS).catch(() => WL_STOCKS.map((s) => ({ s, label: s, price: null, chg: null }))),
    ]);
    const data = { crypto, forex, stocks };
    wlCache = { at: Date.now(), data };
    res.json({ ...data, cached: false });
  } catch (e) {
    res.status(502).json({ error: "watchlist_unavailable", detail: String(e.message).slice(0, 150) });
  }
});

/* Order-book depth for the liquidity heatmap (public, no key).
 * GET /api/market/depth?symbol=BTCUSDT&limit=100
 * Spot first, USDⓈ-M futures fallback. Cached 10s server-side. */
const depthCache = new Map(); // symbol -> {at, data}
async function fetchDepth(symbol, limit) {
  const key = symbol;
  const hit = depthCache.get(key);
  if (hit && Date.now() - hit.at < 10000) return hit.data;
  const urls = [
    // data-api.binance.vision is the geo-unrestricted mirror of the spot API
    `https://data-api.binance.vision/api/v3/depth?symbol=${symbol}&limit=${limit}`,
    `https://api.binance.com/api/v3/depth?symbol=${symbol}&limit=${limit}`,
    `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=${limit}`,
  ];
  let lastErr = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) {
        // surface Binance's error code (e.g. -1121 invalid symbol) for mapping
        let bodyTxt = "";
        try { bodyTxt = await r.text(); } catch (_e) {}
        // -1121 = invalid symbol: fail fast, don't try other hosts
        if (bodyTxt.includes("-1121") || bodyTxt.includes("Invalid symbol")) {
          const e = new Error("depth: Invalid symbol (-1121)");
          e.invalidSymbol = true;
          throw e;
        }
        lastErr = new Error(`depth ${r.status} ${bodyTxt.slice(0, 120)}`);
        continue;
      }
      const j = await r.json();
      if (j.code && j.code !== 0) {
        // -1121 = invalid symbol: fail fast with 400
        if (j.code === -1121 || String(j.msg || "").includes("Invalid symbol")) {
          const e = new Error("depth: Invalid symbol (-1121)");
          e.invalidSymbol = true;
          throw e;
        }
        lastErr = new Error(`depth: ${j.msg || j.code}`);
        continue;
      }
      const data = {
        symbol,
        lastUpdateId: j.lastUpdateId,
        bids: (j.bids || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).filter(([p, q]) => p > 0 && q > 0),
        asks: (j.asks || []).map(([p, q]) => [parseFloat(p), parseFloat(q)]).filter(([p, q]) => p > 0 && q > 0),
        source: u.includes("fapi") ? "binance-futures" : "binance-spot",
      };
      depthCache.set(key, { at: Date.now(), data });
      return data;
    } catch (e) {
      if (e.invalidSymbol) throw e; // fail-fast: don't swallow, don't retry other hosts
      lastErr = e;
    }
  }
  throw lastErr || new Error("depth_unavailable");
}

router.get("/depth", async (req, res) => {
  try {
    const symbol = cleanSymbol(req.query.symbol);
    const limit = [5, 10, 20, 50, 100, 500, 1000].includes(parseInt(req.query.limit, 10))
      ? parseInt(req.query.limit, 10) : 100;
    const data = await fetchDepth(symbol, limit);
    res.json(data);
  } catch (e) {
    // invalid symbol -> 400 (client error), anything else -> 502
    if (e.invalidSymbol || String(e.message || "").includes("-1121") ||
        String(e.message || "").includes("Invalid symbol")) {
      return res.status(400).json({ error: "invalid_symbol" });
    }
    res.status(502).json({ error: "depth_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
