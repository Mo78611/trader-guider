"use strict";
// One-click Buy/Sell panel backend.
// POST /api/execute { target: 'mt5' | 'binance', action: 'buy'|'sell', symbol, volume|quantity, sl, tp, ... }
// GET  /api/execute/status
// GET  /api/execute/mt5/positions   (proxied to the bridge — frontend stays same-origin)
// POST /api/execute/mt5/close {ticket}
//
// SAFETY: with DRY_RUN=true (the default) NOTHING is sent anywhere — the
// request is validated and logged, and a dry-run receipt is returned.
//
// CLOUD NOTE: the MT5 bridge is a program on the USER'S OWN PC (see
// mt5-bridge/README). A cloud deployment cannot reach it unless the user
// exposes it themselves (MT5_BRIDGE_URL). When unreachable, the panel shows
// the "connect your bridge" state instead of failing.

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { decrypt } = require("../lib/crypto-util");
const binance = require("../lib/binance");

const router = express.Router();
const DRY_RUN = process.env.DRY_RUN !== "false";
const MT5_BRIDGE_URL = (process.env.MT5_BRIDGE_URL || "http://127.0.0.1:5001").replace(/\/$/, "");

async function credsFor(userId, venue) {
  const row = await db.get("SELECT * FROM api_credentials WHERE user_id = ? AND venue = ?", [userId, venue]);
  if (!row) return null;
  return { apiKey: decrypt(row.api_key_enc), apiSecret: decrypt(row.api_sec_enc) };
}

async function bridgeGet(path) {
  const r = await fetch(`${MT5_BRIDGE_URL}${path}`, { signal: AbortSignal.timeout(8000) });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

async function bridgePost(path, body) {
  const r = await fetch(`${MT5_BRIDGE_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, data };
}

router.get("/status", requireAuth, async (req, res) => {
  let mt5 = { reachable: false };
  try {
    const h = await bridgeGet("/api/mt5/health");
    if (h.ok) mt5 = { reachable: true, ...h.data };
  } catch (_e) { /* bridge not running */ }
  const spotRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_spot'", [req.user.id]);
  const futRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_futures'", [req.user.id]);
  res.json({
    dryRun: DRY_RUN,
    mt5,
    mt5Hint: mt5.reachable
      ? null
      : "MT5 bridge not connected — it runs on your own PC. See mt5-bridge/README to start it.",
    binance: { spot_keys: !!spotRow, futures_keys: !!futRow, testnet: true },
  });
});

// Proxied MT5 reads/writes — keeps the frontend on relative same-origin paths.
router.get("/mt5/positions", requireAuth, async (_req, res) => {
  try {
    const p = await bridgeGet("/api/mt5/positions");
    res.status(p.ok ? 200 : 502).json(p.data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable" });
  }
});

router.post("/mt5/close", requireAuth, async (req, res) => {
  const ticket = parseInt(req.body && req.body.ticket, 10);
  if (!ticket) return res.status(400).json({ error: "ticket_required" });
  try {
    const p = await bridgePost("/api/mt5/close", { ticket });
    res.status(p.ok ? 200 : 502).json(p.data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable" });
  }
});

router.post("/", requireAuth, async (req, res) => {
  const { target, action, symbol, volume, quantity, sl, tp, venue } = req.body || {};
  const act = String(action || "").toLowerCase();
  if (!["mt5", "binance"].includes(target)) return res.status(400).json({ error: "target must be mt5 or binance" });
  if (!["buy", "sell"].includes(act)) return res.status(400).json({ error: "action must be buy or sell" });

  if (target === "mt5") {
    const payload = { symbol: String(symbol || ""), action: act, volume: parseFloat(volume) || 0.01, sl: sl ?? 0, tp: tp ?? 0 };
    if (DRY_RUN) {
      console.log("[DRY_RUN] MT5 order NOT sent:", payload);
      return res.json({ dryRun: true, target, note: "DRY_RUN=true — order logged only, bridge not called.", order: payload });
    }
    try {
      const p = await bridgePost("/api/mt5/order", payload);
      return res.status(p.ok ? 200 : 502).json({ target, bridge: p.data });
    } catch (_e) {
      return res.status(502).json({ error: "mt5_bridge_unreachable", detail: "Is the bridge running on your Windows PC? See mt5-bridge/README." });
    }
  }

  // binance — default to futures testnet for the one-click panel (perpetuals)
  const v = venue === "binance_spot" ? "binance_spot" : "binance_futures";
  const creds = await credsFor(req.user.id, v);
  if (!creds) return res.status(400).json({ error: "no_credentials", detail: `Save ${v} testnet keys first.` });
  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const params = { symbol: sym, side: act.toUpperCase(), type: "MARKET", quantity: String(quantity || volume || "0.001") };
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Binance ${v} one-click NOT sent:`, params, { sl, tp });
    return res.json({ dryRun: true, target, venue: v, testnet: true, order: params, note: "DRY_RUN=true — nothing was sent." });
  }
  try {
    const client = v === "binance_futures" ? binance.futures : binance.spot;
    const result = await client.order(creds, params);
    res.json({ target, venue: v, testnet: true, result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
