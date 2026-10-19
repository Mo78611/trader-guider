"use strict";
// News radar + sentiment API (all free, no keys).
// GET /api/news/upcoming?asset=BTCUSDT&trend=up|down|flat
// GET /api/news/sentiment?symbol=BTCUSDT

const express = require("express");
const { getUpcomingRaw, biasFor, classify, atr14, expectedMoveText } = require("../lib/news");
const { getKlines } = require("../lib/market");
const { getSentiment, cleanSymbol } = require("../lib/sentiment");

const router = express.Router();

function cleanTrend(t) {
  t = String(t || "").toLowerCase();
  return t === "up" || t === "down" || t === "flat" ? t : null;
}

router.get("/upcoming", async (req, res) => {
  try {
    const asset = cleanSymbol(req.query.asset);
    const trend = cleanTrend(req.query.trend);
    const { events, source } = await getUpcomingRaw();

    // ATR for the volatility forecast (best effort)
    let atr = null, price = null;
    try {
      const { candles } = await getKlines(asset, "1h", 60);
      atr = atr14(candles);
      price = candles.length ? candles[candles.length - 1].close : null;
    } catch (_e) { /* forecast becomes n/a */ }

    const out = events.map((ev) => {
      const rule = classify(ev.title);
      const bias = biasFor(ev, asset, trend);
      return {
        id: ev.id, title: ev.title, time: ev.time,
        currency: ev.currency, impact: ev.impact, tier: rule.tier,
        forecast: ev.forecast, previous: ev.previous,
        bias, expectedMove: expectedMoveText(atr, price, rule.tier),
      };
    });
    res.json({ asset, trend, source, generatedAt: new Date().toISOString(), events: out });
  } catch (e) {
    res.status(502).json({ error: "news_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

router.get("/sentiment", async (req, res) => {
  try {
    const data = await getSentiment(req.query.symbol);
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: "sentiment_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
