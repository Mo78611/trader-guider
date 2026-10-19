"use strict";
// POST /api/auth/register  {email, password, name}
// POST /api/auth/login     {email, password}
// POST /api/auth/logout
// GET  /api/auth/me
// GET  /api/auth/firebase-config
// POST /api/auth/firebase-session {idToken, name?}
// POST /api/auth/credentials  (Binance testnet keys, encrypted at rest)

const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db");
const { setSessionCookie, clearSessionCookie, optionalAuth, requireAuth } = require("../lib/auth");
const { isFirebaseConfigured, getPublicConfig, verifyFirebaseIdToken } = require("../lib/firebase-auth-adapter");
const { encrypt } = require("../lib/crypto-util");

const router = express.Router();

function publicUser(row) {
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at };
}

async function ensureChartState(userId) {
  await db.run(
    "INSERT INTO chart_states (user_id) VALUES (?) ON CONFLICT(user_id) DO NOTHING",
    [userId]
  );
}

router.post("/register", async (req, res) => {
  const { email, password, name } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });
  if (String(password).length < 8) return res.status(400).json({ error: "password_min_8_chars" });
  const cleanEmail = String(email).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return res.status(400).json({ error: "invalid_email" });

  const existing = await db.get("SELECT id FROM users WHERE email = ?", [cleanEmail]);
  if (existing) return res.status(409).json({ error: "email_already_registered" });

  const hash = bcrypt.hashSync(String(password), 12);
  const info = await db.run(
    "INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)",
    [cleanEmail, String(name || "").slice(0, 80), hash]
  );
  const user = await db.get("SELECT * FROM users WHERE id = ?", [info.id]);
  await ensureChartState(user.id);
  setSessionCookie(res, user);
  res.json({ user: publicUser(user) });
});

router.post("/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: "email_and_password_required" });
  const user = await db.get("SELECT * FROM users WHERE email = ?", [String(email).trim().toLowerCase()]);
  if (!user || !bcrypt.compareSync(String(password), user.password_hash)) {
    return res.status(401).json({ error: "invalid_credentials" });
  }
  setSessionCookie(res, user);
  res.json({ user: publicUser(user) });
});

router.post("/logout", (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

router.get("/me", optionalAuth, async (req, res) => {
  if (!req.user) return res.json({ user: null });
  const user = await db.get("SELECT * FROM users WHERE id = ?", [req.user.id]);
  if (!user) return res.json({ user: null });
  res.json({ user: publicUser(user) });
});

// --- Firebase bridge ---
router.get("/firebase-config", (_req, res) => {
  res.json({ configured: isFirebaseConfigured(), config: getPublicConfig() });
});

router.post("/firebase-session", async (req, res) => {
  if (!isFirebaseConfigured()) {
    return res.status(400).json({ error: "firebase_not_configured" });
  }
  const { idToken, name } = req.body || {};
  if (!idToken) return res.status(400).json({ error: "idToken_required" });
  let claims;
  try {
    claims = await verifyFirebaseIdToken(idToken);
  } catch (e) {
    return res.status(401).json({ error: "firebase_token_invalid", detail: String(e.message).slice(0, 120) });
  }
  let user = await db.get("SELECT * FROM users WHERE firebase_uid = ?", [claims.uid]);
  if (!user) {
    const email = claims.email.toLowerCase();
    user = await db.get("SELECT * FROM users WHERE email = ?", [email]);
    if (user) {
      await db.run("UPDATE users SET firebase_uid = ? WHERE id = ?", [claims.uid, user.id]);
    } else {
      const info = await db.run(
        "INSERT INTO users (email, name, password_hash, firebase_uid) VALUES (?, ?, ?, ?)",
        [email, String(name || "").slice(0, 80), "firebase-managed", claims.uid]
      );
      user = await db.get("SELECT * FROM users WHERE id = ?", [info.id]);
    }
    await ensureChartState(user.id);
  }
  setSessionCookie(res, user);
  res.json({ user: publicUser(user), via: "firebase" });
});

// --- API credential storage (Binance testnet keys), per user ---
router.post("/credentials", requireAuth, async (req, res) => {
  const { venue, apiKey, apiSecret, label } = req.body || {};
  if (!["binance_spot", "binance_futures"].includes(venue)) {
    return res.status(400).json({ error: "venue must be binance_spot or binance_futures" });
  }
  if (!apiKey || !apiSecret) return res.status(400).json({ error: "apiKey_and_apiSecret_required" });
  try {
    await db.run(`
      INSERT INTO api_credentials (user_id, venue, api_key_enc, api_sec_enc, label)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id, venue) DO UPDATE SET api_key_enc=excluded.api_key_enc, api_sec_enc=excluded.api_sec_enc, label=excluded.label
    `, [req.user.id, venue, encrypt(apiKey), encrypt(apiSecret), String(label || "").slice(0, 60)]);
  } catch (e) {
    return res.status(500).json({ error: "encryption_failed", detail: String(e.message).slice(0, 160) });
  }
  res.json({ ok: true, venue });
});

router.get("/credentials", requireAuth, async (req, res) => {
  const rows = await db.all("SELECT venue, label, created_at FROM api_credentials WHERE user_id = ?", [req.user.id]);
  res.json({ venues: rows });
});

router.delete("/credentials/:venue", requireAuth, async (req, res) => {
  await db.run("DELETE FROM api_credentials WHERE user_id = ? AND venue = ?", [req.user.id, req.params.venue]);
  res.json({ ok: true });
});

module.exports = router;
