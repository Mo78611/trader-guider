"use strict";
// Public market data proxy (no auth needed, no API key needed).
// Binance public API first, Kraken public API as automatic fallback.
// GET /api/market/klines?symbol=BTCUSDT&interval=1h&limit=500
// GET /api/market/ticker?symbol=BTCUSDT

const express = require("express");
const { getKlines, getTicker } = require("../lib/market");

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
