"use strict";
// Tinkerer Lab API.
// POST /api/lab/backtest        {symbol, interval, conditions[], logic, limit}
// GET  /api/lab/footprints      -> own footprints (latest first)
// POST /api/lab/footprints      {type, symbol, timeframe, price, time, dir, note}
// DELETE /api/lab/footprints/:id
// GET  /api/lab/footprint-stats -> aggregates per (type, session) + lazy outcomes
// GET  /api/lab/dna?symbol=     -> session DNA (cached 24h in db)

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const lab = require("../lib/lab");

const router = express.Router();

const INTERVALS = new Set(["1m","5m","15m","30m","1h","4h","12h","1d","1w"]);
function cleanSymbol(s) {
  return String(s || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "BTCUSDT";
}

/* ---------------- backtest ---------------- */
router.post("/backtest", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const symbol = cleanSymbol(b.symbol);
    const interval = INTERVALS.has(b.interval) ? b.interval : "1h";
    const logic = b.logic === "OR" ? "OR" : "AND";
    const conds = Array.isArray(b.conditions)
      ? b.conditions.filter((c) => c in lab.CONDITION_DEFS).slice(0, 10)
      : [];
    if (conds.length < 1) return res.status(400).json({ error: "need_conditions" });
    if (logic === "AND" && conds.length < 2)
      return res.status(400).json({ error: "and_needs_two" });
    const t0 = Date.now();
    const out = await lab.backtest({ symbol, interval, conditions: conds, logic, limit: b.limit });
    out.ms = Date.now() - t0;
    res.json(out);
  } catch (e) {
    const msg = String(e.message || "");
    if (/not_enough_data|market_data_unavailable/.test(msg))
      return res.status(502).json({ error: "market_data_unavailable" });
    console.error("[lab] backtest failed:", msg.slice(0, 200));
    res.status(500).json({ error: "backtest_failed" });
  }
});

/* ---------------- footprints ---------------- */
const FP_TYPES = new Set([
  "signal", "drawing:trendline", "drawing:hline", "drawing:fib",
  "drawing:rect", "drawing:channel", "drawing:vline", "drawing:text",
  "drawing:whatif", "manual", "star",
]);

router.get("/footprints", requireAuth, async (req, res) => {
  const rows = await db.all(
    "SELECT * FROM footprints WHERE user_id = ? ORDER BY id DESC LIMIT 200",
    [req.user.id]);
  res.json({ footprints: rows });
});

router.post("/footprints", requireAuth, async (req, res) => {
  const b = req.body || {};
  const type = FP_TYPES.has(b.type) ? b.type : "manual";
  const price = parseFloat(b.price);
  const time = parseInt(b.time, 10);
  if (!(price > 0) || !(time > 0))
    return res.status(400).json({ error: "price_time_required" });
  const dir = b.dir === "buy" || b.dir === "sell" ? b.dir : "";
  const r = await db.run(
    `INSERT INTO footprints (user_id, type, symbol, timeframe, session, price, time, dir, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [req.user.id, type, cleanSymbol(b.symbol), String(b.timeframe || "1h").slice(0, 5),
     b.session || lab.sessionOf(time), price, time, dir, String(b.note || "").slice(0, 200)]);
  res.json({ ok: true, id: r.id });
});

router.delete("/footprints/:id", requireAuth, async (req, res) => {
  const r = await db.run("DELETE FROM footprints WHERE id = ? AND user_id = ?",
    [req.params.id, req.user.id]);
  if (!r.changes) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

/* Fill outcomes lazily (max 25 per call), then aggregate. */
router.get("/footprint-stats", requireAuth, async (req, res) => {
  const pending = await db.all(
    `SELECT * FROM footprints WHERE user_id = ? AND mfe_atr IS NULL
     ORDER BY id DESC LIMIT 25`, [req.user.id]);
  for (const fp of pending) {
    try {
      const oc = await lab.footprintOutcome(fp);
      if (oc) {
        await db.run(
          "UPDATE footprints SET mfe_atr = ?, mae_atr = ?, ret_dir = ? WHERE id = ?",
          [oc.mfe_atr, oc.mae_atr, oc.ret_dir, fp.id]);
      } else {
        // mark as skipped (too old/fresh) so we don't retry forever
        await db.run("UPDATE footprints SET mfe_atr = -1 WHERE id = ?", [fp.id]);
      }
    } catch (_e) { /* one bad footprint must not break the batch */ }
  }
  const rows = await db.all(
    "SELECT type, session, dir, mfe_atr, mae_atr, ret_dir FROM footprints WHERE user_id = ? AND mfe_atr >= 0",
    [req.user.id]);
  const agg = {};
  for (const r of rows) {
    const key = `${r.type} @ ${r.session}`;
    if (!agg[key]) agg[key] = { key, type: r.type, session: r.session, n: 0, wins: 0, mfeSum: 0 };
    const a = agg[key];
    a.n++;
    const win = r.dir === "buy" ? r.ret_dir > 0 : r.dir === "sell" ? r.ret_dir < 0 : r.mfe_atr >= 1;
    if (win) a.wins++;
    a.mfeSum += r.mfe_atr || 0;
  }
  const stats = Object.values(agg).map((a) => ({
    key: a.key, type: a.type, session: a.session, n: a.n,
    winPct: Math.round((a.wins / a.n) * 100),
    avgMfeAtr: Math.round((a.mfeSum / a.n) * 100) / 100,
  })).sort((x, y) => y.n - x.n);
  res.json({ stats, total: rows.length });
});

/* ---------------- session DNA ---------------- */
router.get("/dna", requireAuth, async (req, res) => {
  try {
    const symbol = cleanSymbol(req.query.symbol);
    const cached = await db.get(
      "SELECT * FROM session_dna WHERE symbol = ? ORDER BY updated_at DESC LIMIT 3", [symbol]);
    const staleMs = 24 * 3600 * 1000;
    if (cached && Date.now() - new Date(cached.updated_at).getTime() < staleMs) {
      const rows = await db.all("SELECT * FROM session_dna WHERE symbol = ?", [symbol]);
      const sessions = {};
      for (const r of rows) {
        sessions[r.session] = {
          avg_range_atr: r.avg_range_atr, sweep_freq_per_day: r.sweep_freq_per_day,
          reversal_pct: r.reversal_pct, samples: r.samples,
        };
      }
      return res.json({ symbol, sessions, cached: true });
    }
    const dna = await lab.computeDNA(symbol);
    for (const sess of Object.keys(dna.sessions)) {
      const s = dna.sessions[sess];
      await db.run(
        `INSERT INTO session_dna (symbol, session, avg_range_atr, sweep_freq_per_day, reversal_pct, samples, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(symbol, session) DO UPDATE SET
           avg_range_atr = excluded.avg_range_atr,
           sweep_freq_per_day = excluded.sweep_freq_per_day,
           reversal_pct = excluded.reversal_pct,
           samples = excluded.samples,
           updated_at = datetime('now')`,
        [symbol, sess, s.avg_range_atr, s.sweep_freq_per_day, s.reversal_pct, s.samples]);
    }
    res.json({ ...dna, cached: false });
  } catch (e) {
    const msg = String(e.message || "");
    if (/not_enough_data|market_data_unavailable/.test(msg))
      return res.status(502).json({ error: "market_data_unavailable" });
    console.error("[lab] dna failed:", msg.slice(0, 200));
    res.status(500).json({ error: "dna_failed" });
  }
});

module.exports = router;
