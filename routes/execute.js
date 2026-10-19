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
const tilt = require("../lib/tilt");

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
  const _master = await masterMt5Account(req.user.id).catch(() => null);
  const mt5Creds = _master ? { server: _master.server, accountId: _master.account_id } : null;
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

/* ---------------- MT5 credential storage (encrypted) ----------------
 * Backed by mt5_accounts; the "primary" account (is_master=1) preserves the
 * old single-account behaviour for the existing UI. */
async function masterMt5Account(userId) {
  let row = await db.get(
    "SELECT * FROM mt5_accounts WHERE user_id = ? ORDER BY is_master DESC, id ASC LIMIT 1", [userId]);
  return row || null;
}

router.post("/mt5/credentials", requireAuth, async (req, res) => {
  const { server, accountId, password } = req.body || {};
  const srv = String(server || "").slice(0, 80);
  const acct = String(accountId || "").replace(/[^0-9]/g, "").slice(0, 20);
  if (!srv || !acct || !password) {
    return res.status(400).json({ error: "server, accountId and password are required" });
  }
  try {
    const existing = await masterMt5Account(req.user.id);
    if (existing) {
      await db.run(
        "UPDATE mt5_accounts SET server=?, account_id=?, password_enc=?, is_master=1 WHERE id=? AND user_id=?",
        [srv, acct, encrypt(String(password)), existing.id, req.user.id]);
    } else {
      await db.run(
        "INSERT INTO mt5_accounts (user_id, label, server, account_id, password_enc, is_master) VALUES (?, 'Primary', ?, ?, ?, 1)",
        [req.user.id, srv, acct, encrypt(String(password))]);
    }
    // keep the legacy single-row table in sync for older clients
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
  const row = await masterMt5Account(req.user.id);
  if (!row) return res.json({ saved: false });
  res.json({ saved: true, server: row.server, accountId: row.account_id, hasPassword: true });
});

/* ---------------- MT5 multi-account manager ----------------
 * GET    /api/execute/mt5/accounts        list (no passwords, ever)
 * POST   /api/execute/mt5/accounts        {label, server, accountId, password, isMaster?}
 * DELETE /api/execute/mt5/accounts/:id
 * POST   /api/execute/mt5/accounts/:id/connect   log the bridge into this account */
function publicMt5Account(r) {
  if (!r) return null;
  return { id: r.id, label: r.label, server: r.server, accountId: r.account_id,
    isMaster: !!r.is_master, hasPassword: !!r.password_enc, created_at: r.created_at };
}

router.get("/mt5/accounts", requireAuth, async (req, res) => {
  const rows = await db.all(
    "SELECT * FROM mt5_accounts WHERE user_id = ? ORDER BY is_master DESC, id ASC", [req.user.id]);
  res.json({ accounts: rows.map(publicMt5Account) });
});

router.post("/mt5/accounts", requireAuth, async (req, res) => {
  const { label, server, accountId, password, isMaster } = req.body || {};
  const srv = String(server || "").slice(0, 80);
  const acct = String(accountId || "").replace(/[^0-9]/g, "").slice(0, 20);
  const lbl = String(label || "").slice(0, 40) || `Account ${acct.slice(-4)}`;
  if (!srv || !acct || !password) {
    return res.status(400).json({ error: "server, accountId and password are required" });
  }
  const dup = await db.get(
    "SELECT id FROM mt5_accounts WHERE user_id = ? AND server = ? AND account_id = ?",
    [req.user.id, srv, acct]);
  if (dup) return res.status(409).json({ error: "duplicate_account" });
  try {
    const enc = encrypt(String(password));
    if (isMaster) {
      await db.run("UPDATE mt5_accounts SET is_master = 0 WHERE user_id = ?", [req.user.id]);
    }
    const r = await db.run(
      "INSERT INTO mt5_accounts (user_id, label, server, account_id, password_enc, is_master) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, lbl, srv, acct, enc, isMaster ? 1 : 0]);
    const row = await db.get("SELECT * FROM mt5_accounts WHERE id = ?", [r.id]);
    res.json({ ok: true, account: publicMt5Account(row) });
  } catch (e) {
    res.status(500).json({ error: "encryption_failed" });
  }
});

router.delete("/mt5/accounts/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get("SELECT * FROM mt5_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!row) return res.status(404).json({ error: "not_found" });
  await db.run("DELETE FROM mt5_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
  // copier references must not dangle
  try {
    const cs = await db.get("SELECT * FROM copier_settings WHERE user_id = ?", [req.user.id]);
    if (cs) {
      const ids = JSON.parse(cs.mt5_account_ids || "[]").filter((x) => x !== id);
      await db.run("UPDATE copier_settings SET mt5_account_ids = ? WHERE user_id = ?",
        [JSON.stringify(ids), req.user.id]);
    }
  } catch (_e) {}
  res.json({ ok: true });
});

router.post("/mt5/accounts/:id/connect", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get("SELECT * FROM mt5_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!row || !row.password_enc) return res.status(404).json({ error: "not_found" });
  try {
    const p = await bridgePost("/api/mt5/connect", {
      server: row.server, account_id: row.account_id, password: decrypt(row.password_enc),
    });
    const data = Object.assign({}, p.data);
    delete data.password;
    res.status(p.ok ? 200 : 502).json(data);
  } catch (_e) {
    res.status(502).json({ error: "mt5_bridge_unreachable", detail: "Is the bridge running on your Windows PC?" });
  }
});

/* ---------------- Binance multi-account manager ----------------
 * The legacy api_credentials table keeps single-venue keys; binance_accounts
 * allows several key sets per venue for the trade copier. */
function publicBinanceAccount(r) {
  if (!r) return null;
  return { id: r.id, venue: r.venue, label: r.label, isMaster: !!r.is_master,
    hasKeys: true, created_at: r.created_at };
}

router.get("/binance/accounts", requireAuth, async (req, res) => {
  const rows = await db.all(
    "SELECT * FROM binance_accounts WHERE user_id = ? ORDER BY is_master DESC, id ASC", [req.user.id]);
  res.json({ accounts: rows.map(publicBinanceAccount) });
});

router.post("/binance/accounts", requireAuth, async (req, res) => {
  const { venue, label, apiKey, apiSecret, isMaster } = req.body || {};
  const v = String(venue || "");
  if (!binance.VENUES[v]) return res.status(400).json({ error: "unknown_venue" });
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "apiKey and apiSecret required" });
  const lbl = String(label || "").slice(0, 40) || v;
  try {
    if (isMaster) {
      await db.run("UPDATE binance_accounts SET is_master = 0 WHERE user_id = ? AND venue = ?", [req.user.id, v]);
    }
    const r = await db.run(
      "INSERT INTO binance_accounts (user_id, venue, label, api_key_enc, api_sec_enc, is_master) VALUES (?, ?, ?, ?, ?, ?)",
      [req.user.id, v, lbl, encrypt(String(apiKey)), encrypt(String(apiSecret)), isMaster ? 1 : 0]);
    const row = await db.get("SELECT * FROM binance_accounts WHERE id = ?", [r.id]);
    res.json({ ok: true, account: publicBinanceAccount(row) });
  } catch (e) {
    res.status(500).json({ error: "encryption_failed" });
  }
});

router.delete("/binance/accounts/:id", requireAuth, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const row = await db.get("SELECT id FROM binance_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
  if (!row) return res.status(404).json({ error: "not_found" });
  await db.run("DELETE FROM binance_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
  try {
    const cs = await db.get("SELECT * FROM copier_settings WHERE user_id = ?", [req.user.id]);
    if (cs) {
      const ids = JSON.parse(cs.binance_account_ids || "[]").filter((x) => x !== id);
      await db.run("UPDATE copier_settings SET binance_account_ids = ? WHERE user_id = ?",
        [JSON.stringify(ids), req.user.id]);
    }
  } catch (_e) {}
  res.json({ ok: true });
});

/* ---------------- Trade copier ----------------
 * GET  /api/execute/copier   -> {enabled, mt5AccountIds, binanceAccountIds}
 * POST /api/execute/copier   -> {enabled, mt5AccountIds[], binanceAccountIds[]}
 * When enabled, POST /api/execute fans the order out to the selected
 * accounts with proportional sizing (volume x slaveBalance / masterBalance).
 * Default OFF. DRY_RUN still simulates everything. */
async function copierSettings(userId) {
  const row = await db.get("SELECT * FROM copier_settings WHERE user_id = ?", [userId]);
  if (!row) return { enabled: false, mt5AccountIds: [], binanceAccountIds: [] };
  let m = [], b = [];
  try { m = JSON.parse(row.mt5_account_ids || "[]"); } catch (_e) {}
  try { b = JSON.parse(row.binance_account_ids || "[]"); } catch (_e) {}
  return { enabled: !!row.enabled, mt5AccountIds: m, binanceAccountIds: b };
}

router.get("/copier", requireAuth, async (req, res) => {
  res.json(await copierSettings(req.user.id));
});

router.post("/copier", requireAuth, async (req, res) => {
  const body = req.body || {};
  const enabled = body.enabled === true;
  const mIds = Array.isArray(body.mt5AccountIds)
    ? body.mt5AccountIds.map((x) => parseInt(x, 10)).filter((x) => x > 0) : [];
  const bIds = Array.isArray(body.binanceAccountIds)
    ? body.binanceAccountIds.map((x) => parseInt(x, 10)).filter((x) => x > 0) : [];
  // validate ownership
  for (const id of mIds) {
    const r = await db.get("SELECT id FROM mt5_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!r) return res.status(400).json({ error: "unknown_mt5_account", id });
  }
  for (const id of bIds) {
    const r = await db.get("SELECT id FROM binance_accounts WHERE id = ? AND user_id = ?", [id, req.user.id]);
    if (!r) return res.status(400).json({ error: "unknown_binance_account", id });
  }
  await db.run(`
    INSERT INTO copier_settings (user_id, enabled, mt5_account_ids, binance_account_ids, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      enabled=excluded.enabled, mt5_account_ids=excluded.mt5_account_ids,
      binance_account_ids=excluded.binance_account_ids, updated_at=datetime('now')
  `, [req.user.id, enabled ? 1 : 0, JSON.stringify(mIds), JSON.stringify(bIds)]);
  res.json(Object.assign({ ok: true }, await copierSettings(req.user.id)));
});

/** Ask the bridge to log into an account and return its balance. Never logs the password. */
async function bridgeAccountBalance(acctRow) {
  const p = await bridgePost("/api/mt5/connect", {
    server: acctRow.server,
    account_id: acctRow.account_id,
    password: decrypt(acctRow.password_enc),
  });
  if (!p.ok || !p.data || !p.data.account) {
    throw new Error(`bridge login failed for ${acctRow.label || acctRow.account_id}`);
  }
  const bal = parseFloat(p.data.account.balance);
  if (!(bal > 0)) throw new Error(`no balance for ${acctRow.label || acctRow.account_id}`);
  return bal;
}

function roundVolume(v) {
  // typical broker step 0.01; clamp to a sane band
  return Math.max(0.01, Math.min(500, Math.round(v * 100) / 100));
}

/* ---------------- MT5 bridge proxies ---------------- */
router.post("/mt5/connect", requireAuth, async (req, res) => {
  // Forward saved (or just-supplied) credentials to the bridge on the user's PC.
  let { server, accountId, password } = req.body || {};
  if (!password) {
    const row = await masterMt5Account(req.user.id);
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
  // Score the trade when an exit price is supplied (feeds the tilt-lock).
  const exit = parseFloat(req.body && req.body.exit_price);
  let pnl = null;
  if (exit > 0 && row.entry > 0) {
    const diff = row.side === "buy" ? exit - row.entry : row.entry - exit;
    pnl = diff * (row.qty || 0);
    await db.run(
      "UPDATE paper_trades SET status='closed', closed_at=datetime('now'), exit_price=?, pnl=? WHERE id = ? AND user_id = ?",
      [exit, Math.round(pnl * 100) / 100, id, req.user.id]);
  } else {
    await db.run("UPDATE paper_trades SET status='closed', closed_at=datetime('now') WHERE id = ? AND user_id = ?", [id, req.user.id]);
  }
  // Re-evaluate tilt-lock immediately — a fresh loss can trigger the freeze.
  let tiltState = null;
  try { tiltState = await tilt.evaluate(req.user.id); } catch (_e) {}
  res.json({ ok: true, pnl, tilt: tiltState ? { locked: tiltState.locked, remainingSec: tiltState.remainingSec } : null });
});

/* ---------------- Tilt-Lock overtrading blocker ----------------
 * GET  /api/execute/tilt          -> settings + lock state + today's stats
 * POST /api/execute/tilt          -> {mode, max_losses, max_drawdown_pct, cooldown_hours, balance}
 * POST /api/execute/tilt/unlock   -> {confirm: "UNLOCK"} (deliberate friction)
 * The one-click route above also enforces the lock server-side (423). */
router.get("/tilt", requireAuth, async (req, res) => {
  try {
    res.json(await tilt.evaluate(req.user.id));
  } catch (e) {
    res.status(500).json({ error: "tilt_failed", detail: String(e.message).slice(0, 120) });
  }
});

router.post("/tilt", requireAuth, async (req, res) => {
  try {
    const settings = await tilt.saveSettings(req.user.id, req.body || {});
    const state = await tilt.evaluate(req.user.id);
    res.json(Object.assign({ ok: true }, state, { settings }));
  } catch (e) {
    res.status(500).json({ error: "tilt_save_failed", detail: String(e.message).slice(0, 120) });
  }
});

router.post("/tilt/unlock", requireAuth, async (req, res) => {
  if (String((req.body || {}).confirm || "").toUpperCase() !== "UNLOCK") {
    return res.status(400).json({ error: "confirm_required",
      detail: 'Type UNLOCK to deliberately override the tilt-lock.' });
  }
  try {
    const state = await tilt.unlock(req.user.id);
    res.json(Object.assign({ ok: true, unlocked: true }, state));
  } catch (e) {
    res.status(500).json({ error: "tilt_unlock_failed" });
  }
});

/* ---------------- One-click order entry ---------------- */
router.post("/", requireAuth, async (req, res) => {
  const { target, action, symbol, volume, quantity, sl, tp, venue } = req.body || {};
  const act = String(action || "").toLowerCase();
  if (!["mt5", "binance"].includes(target)) return res.status(400).json({ error: "target must be mt5 or binance" });
  if (!["buy", "sell"].includes(act)) return res.status(400).json({ error: "action must be buy or sell" });

  // TILT-LOCK gate: frozen panel can't be bypassed via the API.
  try {
    const t = await tilt.evaluate(req.user.id);
    if (t.locked) {
      return res.status(423).json({ error: "tilt_locked",
        detail: `Tilt-Lock active (${t.reason || "loss limit hit"}). Trading frozen to protect capital.`,
        remainingSec: t.remainingSec, lockedUntil: t.lockedUntil });
    }
  } catch (_e) { /* tilt check must never block on its own failure */ }

  if (target === "mt5") {
    const sym = String(symbol || "");
    const vol = parseFloat(volume) || 0.01;
    const orderSL = sl ?? 0, orderTP = tp ?? 0;
    // Trade copier: fan out to selected slave accounts with proportional size.
    const wantCopy = req.body.copy === true;
    let copyIds = [];
    if (wantCopy) {
      try {
        const cs = await copierSettings(req.user.id);
        if (cs.enabled) copyIds = cs.mt5AccountIds || [];
      } catch (_e) {}
    }

    if (DRY_RUN) {
      console.log("[DRY_RUN] MT5 order NOT sent:", { symbol: sym, action: act, volume: vol });
      const copies = [];
      for (const id of copyIds) {
        const a = await db.get("SELECT account_id, label FROM mt5_accounts WHERE id = ? AND user_id = ?",
          [id, req.user.id]);
        if (a) copies.push({ accountId: a.account_id, label: a.label, dryRun: true,
          volume: vol, note: "DRY_RUN — copy simulated, nothing sent" });
      }
      return res.json({ dryRun: true, target,
        note: "DRY_RUN=true — order logged only, bridge not called.",
        order: { symbol: sym, action: act, volume: vol, sl: orderSL, tp: orderTP }, copies });
    }

    async function sendToAccount(acctRow, volume) {
      // account context makes the bridge (re-)login to that account first
      return bridgePost("/api/mt5/order", {
        symbol: sym, action: act, volume, sl: orderSL, tp: orderTP,
        account: { server: acctRow.server, account_id: acctRow.account_id,
                   password: decrypt(acctRow.password_enc) },
      });
    }

    try {
      const master = await masterMt5Account(req.user.id);
      let masterReceipt;
      if (master) {
        const p = await sendToAccount(master, vol);
        masterReceipt = { ok: p.ok, data: p.data };
        if (!p.ok) return res.status(502).json({ target, error: "master_order_failed", bridge: p.data });
      } else {
        // no saved account: legacy behaviour — bridge's currently logged-in terminal account
        const p = await bridgePost("/api/mt5/order",
          { symbol: sym, action: act, volume: vol, sl: orderSL, tp: orderTP });
        return res.status(p.ok ? 200 : 502).json({ target, bridge: p.data });
      }

      const copies = [];
      const slaveIds = copyIds.filter((id) => id !== master.id);
      if (slaveIds.length) {
        let masterBal = 0;
        try { masterBal = await bridgeAccountBalance(master); } catch (_e) { /* equal-size fallback */ }
        for (const id of slaveIds) {
          const a = await db.get("SELECT * FROM mt5_accounts WHERE id = ? AND user_id = ?",
            [id, req.user.id]);
          if (!a || !a.password_enc) { copies.push({ accountDbId: id, ok: false, error: "account_not_found" }); continue; }
          try {
            let v = vol;
            if (masterBal > 0) {
              const bal = await bridgeAccountBalance(a);
              v = roundVolume(vol * bal / masterBal);
            }
            const p = await sendToAccount(a, v);
            const d = Object.assign({}, p.data || {});
            copies.push({ accountId: a.account_id, label: a.label, ok: p.ok, volume: v,
              ticket: d.ticket || d.deal || null,
              error: p.ok ? undefined : (d.error || d.detail || "bridge_error") });
          } catch (e) {
            copies.push({ accountId: a.account_id, label: a.label, ok: false,
              error: String(e.message).slice(0, 120) });
          }
        }
        console.log(`[copier] master ${master.account_id} -> ${copies.filter((c) => c.ok).length}/${copies.length} copies ok`);
      }
      return res.json({ target, bridge: masterReceipt.data, copies });
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

  // Trade copier for Binance: same order on each selected account of this venue
  // (equal quantity — testnet balances are play money; MT5 path is proportional).
  const wantCopy = req.body.copy === true;
  let binCopyIds = [];
  if (wantCopy) {
    try {
      const cs = await copierSettings(req.user.id);
      if (cs.enabled) {
        const rows = await db.all(
          "SELECT id FROM binance_accounts WHERE user_id = ? AND venue = ?", [req.user.id, v]);
        const own = new Set(rows.map((r) => r.id));
        binCopyIds = (cs.binanceAccountIds || []).filter((id) => own.has(id));
      }
    } catch (_e) {}
  }
  async function binanceCopies() {
    const copies = [];
    for (const id of binCopyIds) {
      const a = await db.get("SELECT * FROM binance_accounts WHERE id = ? AND user_id = ?",
        [id, req.user.id]);
      if (!a) { copies.push({ accountDbId: id, ok: false, error: "account_not_found" }); continue; }
      const c = { apiKey: decrypt(a.api_key_enc), apiSecret: decrypt(a.api_sec_enc) };
      if (DRY_RUN) {
        copies.push({ accountId: id, label: a.label, dryRun: true, quantity: params.quantity,
          note: "DRY_RUN — copy simulated" });
        continue;
      }
      try {
        const r = await info.client.order(c, params);
        copies.push({ accountId: id, label: a.label, ok: true, orderId: r.orderId || null });
      } catch (e) {
        copies.push({ accountId: id, label: a.label, ok: false,
          error: String(e.message).slice(0, 120) });
      }
    }
    return copies;
  }

  if (DRY_RUN) {
    console.log(`[DRY_RUN] Binance ${v} one-click NOT sent:`, sym, params.side, params.quantity);
    const copies = await binanceCopies();
    return res.json({ dryRun: true, target, venue: v, mainnet: info.mainnet, order: { symbol: sym, side: params.side, type: "MARKET", quantity: params.quantity }, note: "DRY_RUN=true — nothing was sent.", copies });
  }
  try {
    const result = await info.client.order(creds, params);
    const copies = await binanceCopies();
    res.json({ target, venue: v, mainnet: info.mainnet, result, copies });
  } catch (e) {
    res.status(e.status || 502).json({ error: "binance_error", detail: String(e.message).slice(0, 200) });
  }
});

module.exports = router;
