"use strict";
// Analysis Hub.
// POST /api/analysis            {title, body, symbol, timeframe, chart_state, snapshot, is_public}
// GET  /api/analysis            -> public gallery (latest first)
// GET  /api/analysis/mine       -> current user's analyses
// GET  /api/analysis/:id        -> single (public or own)
// DELETE /api/analysis/:id      -> own only

const express = require("express");
const db = require("../db");
const { requireAuth, optionalAuth } = require("../lib/auth");

const router = express.Router();

async function withAuthor(row) {
  const a = await db.get("SELECT id, name, email FROM users WHERE id = ?", [row.user_id]);
  const snap = row.snapshot;
  let tags = [];
  try { const t = JSON.parse(row.tags || "[]"); if (Array.isArray(t)) tags = t.filter((x) => typeof x === "string").slice(0, 20); } catch (_e) {}
  return {
    id: row.id, title: row.title, body: row.body, symbol: row.symbol,
    timeframe: row.timeframe, chart_state: JSON.parse(row.chart_state || "{}"),
    has_snapshot: !!snap, snapshot: snap || null,
    is_public: !!row.is_public, created_at: row.created_at, tags,
    author: a ? { id: a.id, name: a.name || a.email.split("@")[0] } : null,
  };
}

function cleanTags(input) {
  if (!Array.isArray(input)) return [];
  const out = [];
  for (const t of input) {
    const s = "#" + String(t || "").replace(/[^A-Za-z0-9_]/g, "").slice(0, 28);
    if (s.length > 1 && out.indexOf(s) < 0) out.push(s);
    if (out.length >= 20) break;
  }
  return out;
}

router.post("/", requireAuth, async (req, res) => {
  const { title, body, symbol, timeframe, chart_state, snapshot, is_public, tags } = req.body || {};
  if (!title || !String(title).trim()) return res.status(400).json({ error: "title_required" });
  const snap = snapshot ? String(snapshot) : null;
  if (snap && snap.length > 2_500_000) return res.status(413).json({ error: "snapshot_too_large" });
  const info = await db.run(`
    INSERT INTO analyses (user_id, title, body, symbol, timeframe, chart_state, snapshot, is_public, tags)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    req.user.id,
    String(title).slice(0, 140),
    String(body || "").slice(0, 20000),
    String(symbol || "").slice(0, 20),
    String(timeframe || "").slice(0, 5),
    JSON.stringify(chart_state || {}).slice(0, 200000),
    snap,
    is_public === false || is_public === 0 ? 0 : 1,
    JSON.stringify(cleanTags(tags)),
  ]);
  res.json({ ok: true, id: info.id });
});

router.get("/", optionalAuth, async (req, res) => {
  const rows = await db.all("SELECT * FROM analyses WHERE is_public = 1 ORDER BY id DESC LIMIT 100");
  res.json({ analyses: await Promise.all(rows.map(withAuthor)) });
});

router.get("/mine", requireAuth, async (req, res) => {
  const rows = await db.all("SELECT * FROM analyses WHERE user_id = ? ORDER BY id DESC LIMIT 100", [req.user.id]);
  res.json({ analyses: await Promise.all(rows.map(withAuthor)) });
});

router.get("/:id", optionalAuth, async (req, res) => {
  const row = await db.get("SELECT * FROM analyses WHERE id = ?", [req.params.id]);
  if (!row) return res.status(404).json({ error: "not_found" });
  if (!row.is_public && (!req.user || req.user.id !== row.user_id)) {
    return res.status(403).json({ error: "private" });
  }
  res.json({ analysis: await withAuthor(row) });
});

router.delete("/:id", requireAuth, async (req, res) => {
  const info = await db.run("DELETE FROM analyses WHERE id = ? AND user_id = ?", [req.params.id, req.user.id]);
  if (!info.changes) return res.status(404).json({ error: "not_found" });
  res.json({ ok: true });
});

module.exports = router;
