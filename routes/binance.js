"use strict";
// Binance TESTNET trading endpoints (user's own free testnet keys, stored encrypted).
// All calls go to the free testnets — no real money can move.
//
// GET  /api/binance/account?venue=binance_spot
// POST /api/binance/order        {venue, symbol, side: BUY|SELL, type: MARKET|LIMIT, quantity, price?}
// GET  /api/binance/positions?venue=binance_futures

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { decrypt } = require("../lib/crypto-util");
const binance = require("../lib/binance");

const router = express.Router();
const DRY_RUN = process.env.DRY_RUN !== "false";

async function getCreds(userId, venue) {
  const row = await db.get("SELECT * FROM api_credentials WHERE user_id = ? AND venue = ?", [userId, venue]);
  if (!row) return null;
  return { apiKey: decrypt(row.api_key_enc), apiSecret: decrypt(row.api_sec_enc) };
}

async function needCreds(req, res) {
  const venue = req.query.venue || (req.body && req.body.venue) || "binance_spot";
  if (!["binance_spot", "binance_futures"].includes(venue)) {
    res.status(400).json({ error: "venue must be binance_spot or binance_futures" });
    return null;
  }
  const creds = await getCreds(req.user.id, venue);
  if (!creds) {
    res.status(400).json({ error: "no_credentials", detail: `Save ${venue} testnet keys first (Settings panel).` });
    return null;
  }
  return { venue, creds };
}

router.get("/account", requireAuth, async (req, res) => {
  const c = await needCreds(req, res); if (!c) return;
  try {
    const client = c.venue === "binance_futures" ? binance.futures : binance.spot;
    res.json({ venue: c.venue, testnet: true, account: await client.account(c.creds) });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

router.get("/positions", requireAuth, async (req, res) => {
  const venue = req.query.venue || "binance_futures";
  const creds = await getCreds(req.user.id, venue);
  if (!creds) return res.status(400).json({ error: "no_credentials" });
  try {
    if (venue === "binance_futures") {
      const all = await binance.futures.positions(creds);
      res.json({ venue, testnet: true, positions: all.filter((p) => parseFloat(p.positionAmt) !== 0) });
    } else {
      const acct = await binance.spot.account(creds);
      const held = (acct.balances || []).filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
      res.json({ venue, testnet: true, positions: held });
    }
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

router.post("/order", requireAuth, async (req, res) => {
  const c = await needCreds(req, res); if (!c) return;
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
    console.log(`[DRY_RUN] Binance ${c.venue} order NOT sent:`, params);
    return res.json({ dryRun: true, venue: c.venue, testnet: true, order: params, note: "DRY_RUN=true — nothing was sent." });
  }
  try {
    const client = c.venue === "binance_futures" ? binance.futures : binance.spot;
    const result = await client.order(c.creds, params);
    res.json({ venue: c.venue, testnet: true, result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
