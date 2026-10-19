"use strict";
// Chart workspace persistence.
// GET  /api/chart/state   -> current user's saved workspace
// POST /api/chart/state   -> save workspace {symbol, timeframe, indicators, drawings, layout}

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");

const router = express.Router();

function rowToState(row) {
  return {
    symbol: row.symbol,
    timeframe: row.timeframe,
    indicators: JSON.parse(row.indicators || "[]"),
    drawings: JSON.parse(row.drawings || "[]"),
    layout: JSON.parse(row.layout || "{}"),
    updated_at: row.updated_at,
  };
}

router.get("/state", requireAuth, async (req, res) => {
  let row = await db.get("SELECT * FROM chart_states WHERE user_id = ?", [req.user.id]);
  if (!row) {
    await db.run(
      "INSERT INTO chart_states (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING",
      [req.user.id]
    );
    row = await db.get("SELECT * FROM chart_states WHERE user_id = ?", [req.user.id]);
  }
  res.json({ state: rowToState(row) });
});

router.post("/state", requireAuth, async (req, res) => {
  const { symbol, timeframe, indicators, drawings, layout } = req.body || {};
  const sym = String(symbol || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "BTCUSDT";
  const tf = String(timeframe || "1h").slice(0, 5);
  const ind = Array.isArray(indicators) ? indicators.slice(0, 30) : [];
  const drw = Array.isArray(drawings) ? drawings.slice(0, 200) : [];
  const lay = layout && typeof layout === "object" ? layout : {};
  await db.run(`
    INSERT INTO chart_states (user_id, symbol, timeframe, indicators, drawings, layout, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      symbol=excluded.symbol, timeframe=excluded.timeframe,
      indicators=excluded.indicators, drawings=excluded.drawings,
      layout=excluded.layout, updated_at=datetime('now')
  `, [req.user.id, sym, tf, JSON.stringify(ind), JSON.stringify(drw), JSON.stringify(lay)]);
  res.json({ ok: true });
});

module.exports = router;
