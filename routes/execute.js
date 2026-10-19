"use strict";
// One-click Buy/Sell panel backend.
// POST /api/execute { target: 'mt5' | 'binance', action: 'buy'|'sell', symbol, volume|quantity, sl, tp, ... }
// GET  /api/execute/status
// GET  /api/execute/mt5/positions   (proxied to the bridge — frontend stays same-origin)
// POST /api/execute/mt5/close {ticket}
// POST /api/execute/mt5/credentials {server, accountId, password}  (password encrypted at rest, never returned/logged)
// GET  /api/execute/mt5/credentials  -> {server, accountId, hasPassword} (no password)
// POST /api/execute/mt5/connect     (decrypts + forwards login to the bridge on the user's PC)
// POST /api/execute/mt5/modify {ticket, sl, tp}      (auto break-even path)
// POST /api/execute/mt5/close_partial {ticket, volume}
// Paper trade tracker (client + server, used by the Auto Trade Manager):
// POST /api/execute/paper {symbol, side, entry, sl, tp, qty, auto_be, auto_partial, bridge_ticket?, target}
// GET  /api/execute/paper            (open trades)
// POST /api/execute/paper/:id {sl?, tp?, auto_be?, auto_partial?}
// POST /api/execute/paper/:id/close
//
// SAFETY: with DRY_RUN=true (the default) NOTHING is sent anywhere — the
// request is validated and logged, and a dry-run receipt is returned.
// Binance MAINNET venues are rejected unless BINANCE_LIVE_ENABLED=true.
//
// CLOUD NOTE: the MT5 bridge is a program on the USER'S OWN PC (see
// mt5-bridge/README). A cloud deployment cannot reach it unless the user
// exposes it themselves (MT5_BRIDGE_URL). When unreachable, the panel shows
// the "connect your bridge" state instead of failing.

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { encrypt, decrypt } = require("../lib/crypto-util");
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
  // extend with login state when bridge is reachable
  if (mt5.reachable) {
    try {
      const s = await bridgeGet("/api/mt5/status");
      if (s.ok && s.data) mt5.status = s.data;
    } catch (_e) {}
  }
  const spotRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_spot'", [req.user.id]);
  const futRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_futures'", [req.user.id]);
  const spotMainRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_spot_main'", [req.user.id]);
  const futMainRow = await db.get("SELECT 1 AS x FROM api_credentials WHERE user_id=? AND venue='binance_futures_main'", [req.user.id]);
  const mt5Creds = await db.get("SELECT server, account_id FROM mt5_credentials WHERE user_id=?", [req.user.id]);
  res.json({
    dryRun: DRY_RUN,
    mt5,
    mt5Hint: mt5.reachable
      ? null
      : "MT5 bridge not connected — it runs on your own PC. See mt5-bridge/README to start it.",
    mt5Creds: mt5Creds ? { server: mt5Creds.server, accountId: mt5Creds.account_id, hasPassword: true } : null,
    binance: {
      spot_keys: !!spotRow, futures_keys: !!futRow,
      spot_main_keys: !!spotMainRow, futures_main_keys: !!futMainRow,
      testnet: true, live_enabled: binance.LIVE_ENABLED,
    },
  });
});

/* ---------------- MT5 credential storage (encrypted) ---------------- */
router.post("/mt5/credentials", requireAuth, async (req, res) => {
  const { server, accountId, password } = req.body || {};
  const srv = String(server || "").slice(0, 80);
  const acct = String(accountId || "").replace(/[^0-9]/g, "").slice(0, 20);
  if (!srv || !acct || !password) {
    return res.status(400).json({ error: "server, accountId and password are required" });
  }
  try {
    await db.run(`
      INSERT INTO mt5_credentials (user_id, server, account_id, password_enc, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(user_id) DO UPDATE SET
        server=excluded.server, account_id=excluded.account_id,
        password_enc=excluded.password_enc, updated_at=datetime('now')
    `, [req.user.id, srv, acct, encrypt(String(password))]);
  } catch (e) {
    return res.status(500).json({ error: "encryption_failed" });
  }
  // password is never returned and never logged
  res.json({ ok: true, server: srv, accountId: acct });
});

router.get("/mt5/credentials", requireAuth, async (req, res) => {
  const row = await db.get("SELECT server, account_id FROM mt5_credentials WHERE user_id=?", [req.user.id]);
  if (!row) return res.json({ saved: false });
  res.json({ saved: true, server: row.server, accountId: row.account_id, hasPassword: true });
});

/* ---------------- MT5 bridge proxies ---------------- */
router.post("/mt5/connect", requireAuth, async (req, res) => {
  // Forward saved (or just-supplied) credentials to the bridge on the user's PC.
  let { server, accountId, password } = req.body || {};
  if (!password) {
    const row = await db.get("SELECT * FROM mt5_credentials WHERE user_id=?", [req.user.id]);
    if (!row || !row.password_enc) return res.status(400).json({ error: "no_saved_credentials", detail: "Save MT5 credentials first." });
    server = row.server; accountId = row.account_id;
    password = decrypt(row.password_enc);
  }
  try {
    const p = await bridgePost("/api/mt5/connect", { server: String(server || ""), account_id: String(accountId || ""), password: String(password || "") });
    // never echo the password back
    const data = Object.assign({}, p.data);
    delete data.password;
    res.status(p.ok ? 200 : 502).json(data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable", detail: "Is the bridge running on your Windows PC? See mt5-bridge/README." });
  }
});

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

router.post("/mt5/modify", requireAuth, async (req, res) => {
  const ticket = parseInt(req.body && req.body.ticket, 10);
  const sl = parseFloat(req.body && req.body.sl);
  const tp = req.body && req.body.tp != null ? parseFloat(req.body.tp) : undefined;
  if (!ticket || !(sl > 0)) return res.status(400).json({ error: "ticket and sl required" });
  const body = { ticket, sl };
  if (tp > 0) body.tp = tp;
  try {
    const p = await bridgePost("/api/mt5/modify", body);
    res.status(p.ok ? 200 : 502).json(p.data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable" });
  }
});

router.post("/mt5/close_partial", requireAuth, async (req, res) => {
  const ticket = parseInt(req.body && req.body.ticket, 10);
  const volume = parseFloat(req.body && req.body.volume);
  if (!ticket || !(volume > 0)) return res.status(400).json({ error: "ticket and volume required" });
  try {
    const p = await bridgePost("/api/mt5/close_partial", { ticket, volume });
    res.status(p.ok ? 200 : 502).json(p.data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable" });
  }
});

/* ---------------- Paper trade tracker ---------------- */
function paperRow(r) {
  if (!r) return null;
  return {
    id: r.id, symbol: r.symbol, side: r.side, entry: r.entry, sl: r.sl, tp: r.tp,
    qty: r.qty, status: r.status, be_moved: !!r.be_moved, partial_done: !!r.partial_done,
    auto_be: !!r.auto_be, auto_partial: !!r.auto_partial,
    bridge_ticket: r.bridge_ticket, target: r.target,
    created_at: r.created_at, closed_at: r.closed_at,
  };
}

router.post("/paper", requireAuth, async (req, res) => {
  const { symbol, side, entry, sl, tp, qty, auto_be, auto_partial, bridge_ticket, target } = req.body || {};
  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
  const sd = String(side || "").toLowerCase();
  if (!sym || !["buy", "sell"].includes(sd)) return res.status(400).json({ error: "symbol and side (buy|sell) required" });
  if (!(entry > 0)) return res.status(400).json({ error: "entry price required" });
  const r = await db.run(`
    INSERT INTO paper_trades (user_id, symbol, side, entry, sl, tp, qty, auto_be, auto_partial, bridge_ticket, target)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [req.user.id, sym, sd, entry, sl || 0, tp || 0, qty || 0,
      auto_be === false ? 0 : 1, auto_partial === false ? 0 : 1,
      bridge_ticket ? parseInt(bridge_ticket, 10) : null,
      String(target || "paper").slice(0, 20)]);
  res.json({ ok: true, id: r.id });
});

router.get("/paper", requireAuth, async (req, res) => {
  const rows = await db.all(
    "SELECT * FROM paper_trades WHERE user_id = ? AND status = 'open' ORDER BY id DESC", [req.user.id]);
  res.json({ trades: rows.map(paperRow) });
});

router.post("/paper/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { sl, tp, auto_be, auto_partial, be_moved, partial_done, qty } = req.body || {};
  const row = await db.get("SELECT * FROM paper_trades WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!row) return res.status(404).json({ error: "not_found" });
  const sets = [];
  const vals = [];
  if (sl != null && sl > 0) { sets.push("sl = ?"); vals.push(sl); }
  if (tp != null && tp > 0) { sets.push("tp = ?"); vals.push(tp); }
  if (auto_be != null) { sets.push("auto_be = ?"); vals.push(auto_be ? 1 : 0); }
  if (auto_partial != null) { sets.push("auto_partial = ?"); vals.push(auto_partial ? 1 : 0); }
  if (be_moved != null) { sets.push("be_moved = ?"); vals.push(be_moved ? 1 : 0); }
  if (partial_done != null) { sets.push("partial_done = ?"); vals.push(partial_done ? 1 : 0); }
  if (qty != null && qty >= 0) { sets.push("qty = ?"); vals.push(qty); }
  if (!sets.length) return res.json({ ok: true, trade: paperRow(row) });
  vals.push(id, req.user.id);
  await db.run(`UPDATE paper_trades SET ${sets.join(", ")} WHERE id = ? AND user_id = ?`, vals);
  const upd = await db.get("SELECT * FROM paper_trades WHERE id = ? AND user_id = ?", [id, req.user.id]);
  res.json({ ok: true, trade: paperRow(upd) });
});

router.post("/paper/:id/close", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get("SELECT * FROM paper_trades WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!row) return res.status(404).json({ error: "not_found" });
  await db.run("UPDATE paper_trades SET status='closed', closed_at=datetime('now') WHERE id = ? AND user_id = ?", [id, req.user.id]);
  res.json({ ok: true });
});

/* ---------------- One-click order entry ---------------- */
router.post("/", requireAuth, async (req, res) => {
  const { target, action, symbol, volume, quantity, sl, tp, venue } = req.body || {};
  const act = String(action || "").toLowerCase();
  if (!["mt5", "binance"].includes(target)) return res.status(400).json({ error: "target must be mt5 or binance" });
  if (!["buy", "sell"].includes(act)) return res.status(400).json({ error: "action must be buy or sell" });

  if (target === "mt5") {
    const payload = { symbol: String(symbol || ""), action: act, volume: parseFloat(volume) || 0.01, sl: sl ?? 0, tp: tp ?? 0 };
    if (DRY_RUN) {
      console.log("[DRY_RUN] MT5 order NOT sent:", { symbol: payload.symbol, action: payload.action, volume: payload.volume });
      return res.json({ dryRun: true, target, note: "DRY_RUN=true — order logged only, bridge not called.", order: payload });
    }
    try {
      const p = await bridgePost("/api/mt5/order", payload);
      return res.status(p.ok ? 200 : 502).json({ target, bridge: p.data });
    } catch (_e) {
      return res.status(502).json({ error: "mt5_bridge_unreachable", detail: "Is the bridge running on your Windows PC? See mt5-bridge/README." });
    }
  }

  // binance — resolve venue (testnet or mainnet)
  const v = String(venue || "binance_futures");
  const info = binance.VENUES[v];
  if (!info) return res.status(400).json({ error: "unknown_venue" });
  if (info.mainnet && !binance.LIVE_ENABLED) {
    return res.status(403).json({ error: "mainnet_disabled",
      detail: "Mainnet orders are disabled server-side. Set BINANCE_LIVE_ENABLED=true to arm real trading." });
  }
  const creds = await credsFor(req.user.id, v);
  if (!creds) return res.status(400).json({ error: "no_credentials", detail: `Save ${v} keys first.` });
  const sym = String(symbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const params = { symbol: sym, side: act.toUpperCase(), type: "MARKET", quantity: String(quantity || volume || "0.001") };
  if (DRY_RUN) {
    console.log(`[DRY_RUN] Binance ${v} one-click NOT sent:`, sym, params.side, params.quantity);
    return res.json({ dryRun: true, target, venue: v, mainnet: info.mainnet, order: { symbol: sym, side: params.side, type: "MARKET", quantity: params.quantity }, note: "DRY_RUN=true — nothing was sent." });
  }
  try {
    const result = await info.client.order(creds, params);
    res.json({ target, venue: v, mainnet: info.mainnet, result });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
