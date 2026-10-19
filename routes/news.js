"use strict";
// News radar + sentiment API (all free, no keys).
// GET /api/news/upcoming?asset=BTCUSDT&trend=up|down|flat
//   Each event: exact ISO time, predictive bias (historical + technical),
//   pip volatility estimate from measured past events.
// GET /api/news/sentiment?symbol=BTCUSDT

const express = require("express");
const { getUpcomingRaw, biasFor, classify, atr14,
        historicalVol, pipsEstimate, predictiveBias } = require("../lib/news");
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

    // Recent 1h candles: ATR + 24h-range technical leg (best effort)
    let atr = null, price = null, candles = [];
    try {
      const r = await getKlines(asset, "1h", 60);
      candles = r.candles || [];
      atr = atr14(candles);
      price = candles.length ? candles[candles.length - 1].close : null;
    } catch (_e) { /* forecast becomes n/a */ }

    // Historical vol per event TYPE — computed once, shared by all events of that type
    const volByKey = new Map();
    async function volFor(key) {
      if (!volByKey.has(key)) {
        try { volByKey.set(key, await historicalVol(key, asset)); }
        catch (_e) { volByKey.set(key, null); }
      }
      return volByKey.get(key);
    }

    const out = [];
    for (const ev of events) {
      const rule = classify(ev.title);
      const vol = await volFor(rule.key);
      const est = pipsEstimate(vol, atr, price, rule.tier, asset);
      const pb = predictiveBias(ev, asset, candles, vol, trend);
      // legacy forecast-based bias kept as secondary signal
      const legacy = biasFor(ev, asset, trend);
      out.push({
        id: ev.id, title: ev.title, time: ev.time,
        currency: ev.currency, impact: ev.impact, tier: rule.tier,
        eventKey: rule.key,
        forecast: ev.forecast, previous: ev.previous,
        bias: {
          direction: pb.direction, chance: pb.chance, emoji: pb.emoji,
          text: pb.text, reasoning: pb.reasoning,
          histBullPct: pb.histBull, techBullPct: pb.techBull,
        },
        biasLegacy: legacy,
        pipsLow: est.pipsLow, pipsHigh: est.pipsHigh, pipsNote: est.pipsNote,
        expectedMove: est.text, moveSource: est.source,
      });
    }
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
