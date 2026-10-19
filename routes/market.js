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

module.exports = router;
