"use strict";
// Binance trading endpoints (user's own keys, stored encrypted).
// Venues: binance_spot / binance_futures (TESTNET — free, no real money),
//         binance_spot_main / binance_futures_main (MAINNET — REAL money).
//
// SAFETY: mainnet orders are REJECTED server-side unless the operator sets
// BINANCE_LIVE_ENABLED=true (default "false"). DRY_RUN=true (default) also
// blocks everything. Never log keys/secrets.
//
// GET  /api/binance/account?venue=...
// POST /api/binance/order        {venue, symbol, side: BUY|SELL, type, quantity, price?}
// GET  /api/binance/positions?venue=...

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { decrypt } = require("../lib/crypto-util");
const binance = require("../lib/binance");

const router = express.Router();
const DRY_RUN = process.env.DRY_RUN !== "false";

const VENUE_LIST = Object.keys(binance.VENUES);

async function getCreds(userId, venue) {
  const row = await db.get("SELECT * FROM api_credentials WHERE user_id = ? AND venue = ?", [userId, venue]);
  if (!row) return null;
  return { apiKey: decrypt(row.api_key_enc), apiSecret: decrypt(row.api_sec_enc) };
}

function venueInfo(venue) {
  return binance.VENUES[venue] || null;
}

async function needCreds(req, res) {
  const venue = req.query.venue || (req.body && req.body.venue) || "binance_spot";
  const info = venueInfo(venue);
  if (!info) {
    res.status(400).json({ error: "unknown_venue", detail: `venue must be one of: ${VENUE_LIST.join(", ")}` });
    return null;
  }
  const creds = await getCreds(req.user.id, venue);
  if (!creds) {
    res.status(400).json({ error: "no_credentials", detail: `Save ${venue} keys first (Settings panel).` });
    return null;
  }
  return { venue, info, creds };
}

function liveBlocked(info) {
  if (info.mainnet && !binance.LIVE_ENABLED) {
    return { error: "mainnet_disabled",
      detail: "Mainnet orders are disabled server-side. Set BINANCE_LIVE_ENABLED=true to arm real trading." };
  }
  return null;
}

router.get("/account", requireAuth, async (req, res) => {
  const c = await needCreds(req, res); if (!c) return;
  try {
    const account = await c.info.client.account(c.creds);
    res.json({ venue: c.venue, mainnet: c.info.mainnet, account });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

router.get("/positions", requireAuth, async (req, res) => {
  const venue = req.query.venue || "binance_futures";
  const info = venueInfo(venue);
  if (!info) return res.status(400).json({ error: "unknown_venue" });
  const creds = await getCreds(req.user.id, venue);
  if (!creds) return res.status(400).json({ error: "no_credentials" });
  try {
    if (venue.indexOf("futures") >= 0) {
      const all = await info.client.positions(creds);
      res.json({ venue, mainnet: info.mainnet, positions: all.filter((p) => parseFloat(p.positionAmt) !== 0) });
    } else {
      const acct = await info.client.account(creds);
      const held = (acct.balances || []).filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      res.json({ venue, mainnet: info.mainnet, positions: held });
    }
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

router.post("/order", requireAuth, async (req, res) => {
  const c = await needCreds(req, res); if (!c) return;
  const blocked = liveBlocked(c.info);
  if (blocked) return res.status(403).json(blocked);
  const { symbol, side, type = "MARKET", quantity, price } = req.body || {};
  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!sym || !["BUY", "SELL"].includes(side) || !quantity) {
    return res.status(400).json({ error: "symbol, side (BUY|SELL) and quantity required" });
  }
  const params = { symbol: sym, side, type, quantity: String(quantity) };
  if (type === "LIMIT") {
    if (!price) return res.status(400).json({ error: "price required for LIMIT orders" });
    params.price = String(price);
    params.timeInForce = "GTC";
  }
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Binance ${c.venue} order NOT sent:`, sym, side, params.quantity);
    return res.json({ dryRun: true, venue: c.venue, mainnet: c.info.mainnet, order: { symbol: sym, side, type, quantity: params.quantity }, note: "DRY_RUN=true — nothing was sent." });
  }
  try {
    const result = await c.info.client.order(c.creds, params);
    res.json({ venue: c.venue, mainnet: c.info.mainnet, result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
