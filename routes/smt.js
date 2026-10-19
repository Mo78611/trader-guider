"use strict";
// SMT divergence scan (ICT concept).
// GET /api/smt?base=PAXGUSDT&ref=BTCUSDT&interval=1h
// Compares swing structure of `base` against `ref` and reports divergences
// where the base makes a new extreme the reference fails to confirm.

const express = require("express");
const { getKlines } = require("../lib/market");
const { detectSMT } = require("../lib/smt");

const router = express.Router();
const INTERVALS = new Set(["1m","3m","5m","15m","30m","1h","2h","4h","6h","8h","12h","1d","3d","1w","1M"]);

function cleanSymbol(s, dflt) {
  return String(s || dflt).toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || dflt;
}

router.get("/", async (req, res) => {
  try {
    const base = cleanSymbol(req.query.base, "PAXGUSDT");
    const ref = cleanSymbol(req.query.ref, "BTCUSDT");
    const interval = INTERVALS.has(req.query.interval) ? req.query.interval : "1h";
    if (base === ref) return res.status(400).json({ error: "base and ref must differ" });
    const [b, r] = await Promise.all([
      getKlines(base, interval, 150),
      getKlines(ref, interval, 150),
    ]);
    const divergences = detectSMT(b.candles, r.candles, { lookback: 120, strength: 3 });
    res.json({
      base, ref, interval,
      baseSource: b.source, refSource: r.source,
      divergences,
      checkedAt: new Date().toISOString(),
    });
  } catch (e) {
    res.status(502).json({ error: "smt_unavailable", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
