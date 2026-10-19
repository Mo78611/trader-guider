"use strict";
/* ============================================================================
 * Dual-dialect database: Postgres when DATABASE_URL is set, otherwise SQLite.
 * ----------------------------------------------------------------------------
 * Localhost keeps working with ZERO config (SQLite file at ./data/*.db).
 * Set DATABASE_URL (e.g. Supabase free Postgres) and the same code runs on
 * Postgres — e.g. on Render's free tier.
 *
 * App code rules (kept tiny on purpose):
 *   const db = require("../db");
 *   const row  = await db.get("SELECT * FROM users WHERE id = ?", [id]);
 *   const rows = await db.all("SELECT * FROM analyses WHERE is_public = 1", []);
 *   const r    = await db.run("INSERT INTO users (email) VALUES (?)", [email]);
 *              // r = { id, changes }  (id = new row id for INSERTs)
 *   await db.exec("CREATE TABLE ...");   // DDL / multi-statement
 *
 * Write queries with `?` placeholders and datetime('now') — both are
 * translated for Postgres (? -> $1.., datetime('now') -> NOW()).
 * Use ON CONFLICT ... DO NOTHING / DO UPDATE (valid in both dialects);
 * never use INSERT OR IGNORE (SQLite-only).
 * ============================================================================
 */

const path = require("path");
const fs = require("fs");

const DATABASE_URL = (process.env.DATABASE_URL || "").trim();
const isPostgres = Boolean(DATABASE_URL);

let pgPool = null;
let sqlite = null;

if (isPostgres) {
  const { Pool } = require("pg");
  const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
  pgPool = new Pool({
    connectionString: DATABASE_URL,
    // Hosted Postgres (Supabase etc.) needs TLS; local dev usually doesn't.
    ssl: isLocal ? false : { rejectUnauthorized: false },
    max: 5,
  });
  pgPool.on("error", (e) => console.error("[db] pg pool error:", e.message));
} else {
  const Database = require("better-sqlite3");
  const dataDir = path.join(__dirname, "data");
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
  sqlite = new Database(path.join(dataDir, "trader-guider.db"));
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
}

// --- dialect translation (SQLite -> Postgres) ---
function toPg(sql) {
  let i = 0;
  return sql
    .replace(/datetime\('now'\)/g, "NOW()")
    .replace(/\?/g, () => `$${++i}`);
}
// Tables whose INSERTs need the new id back (RETURNING id on pg).
const ID_TABLES = new Set(["users", "api_credentials", "analyses", "paper_trades",
  "mt5_accounts", "binance_accounts"]);

const db = {
  isPostgres,

  async exec(sql) {
    if (isPostgres) {
      // pg forbids multi-statement queries — split them.
      const stmts = toPg(sql).split(";").map((s) => s.trim()).filter(Boolean);
      const client = await pgPool.connect();
      try {
        for (const s of stmts) await client.query(s);
      } finally {
        client.release();
      }
    } else {
      sqlite.exec(sql);
    }
  },

  async get(sql, params = []) {
    if (isPostgres) {
      const r = await pgPool.query(toPg(sql), params);
      return r.rows[0] || null;
    }
    return sqlite.prepare(sql).get(...params) || null;
  },

  async all(sql, params = []) {
    if (isPostgres) {
      const r = await pgPool.query(toPg(sql), params);
      return r.rows;
    }
    return sqlite.prepare(sql).all(...params);
  },

  // Returns { id, changes }. id = new row id for INSERTs into id-bearing tables.
  async run(sql, params = []) {
    if (isPostgres) {
      let text = toPg(sql);
      const m = text.match(/^\s*insert\s+into\s+([a-z_]+)/i);
      if (m && ID_TABLES.has(m[1].toLowerCase()) && !/returning\b/i.test(text)) {
        text += " RETURNING id";
      }
      const r = await pgPool.query(text, params);
      return { id: r.rows[0] ? r.rows[0].id : null, changes: r.rowCount };
    }
    const info = sqlite.prepare(sql).run(...params);
    return { id: info.lastInsertRowid != null ? Number(info.lastInsertRowid) : null, changes: info.changes };
  },

  async ping() {
    if (isPostgres) {
      await pgPool.query("SELECT 1");
      return "postgres";
    }
    sqlite.prepare("SELECT 1").get();
    return "sqlite";
  },

  async close() {
    if (pgPool) await pgPool.end();
    // better-sqlite3 closes on process exit; nothing needed.
  },
};

async function ensureSchema() {
  if (isPostgres) {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            SERIAL PRIMARY KEY,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        firebase_uid  TEXT UNIQUE,
        created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS chart_states (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL DEFAULT 'BTCUSDT',
        timeframe  TEXT NOT NULL DEFAULT '1h',
        indicators TEXT NOT NULL DEFAULT '[]',
        drawings   TEXT NOT NULL DEFAULT '[]',
        layout     TEXT NOT NULL DEFAULT '{}',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS api_credentials (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        venue       TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        api_sec_enc TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, venue)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        symbol      TEXT NOT NULL DEFAULT '',
        timeframe   TEXT NOT NULL DEFAULT '',
        chart_state TEXT NOT NULL DEFAULT '{}',
        snapshot    TEXT,
        is_public   INTEGER NOT NULL DEFAULT 1,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS mt5_credentials (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        server      TEXT NOT NULL DEFAULT '',
        account_id  TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL DEFAULT '',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol      TEXT NOT NULL DEFAULT '',
        side        TEXT NOT NULL DEFAULT 'buy',
        entry       DOUBLE PRECISION NOT NULL DEFAULT 0,
        sl          DOUBLE PRECISION NOT NULL DEFAULT 0,
        tp          DOUBLE PRECISION NOT NULL DEFAULT 0,
        qty         DOUBLE PRECISION NOT NULL DEFAULT 0,
        status      TEXT NOT NULL DEFAULT 'open',
        be_moved    INTEGER NOT NULL DEFAULT 0,
        partial_done INTEGER NOT NULL DEFAULT 0,
        auto_be     INTEGER NOT NULL DEFAULT 1,
        auto_partial INTEGER NOT NULL DEFAULT 1,
        bridge_ticket BIGINT,
        target      TEXT NOT NULL DEFAULT 'paper',
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at   TIMESTAMPTZ
      );
      CREATE TABLE IF NOT EXISTS mt5_accounts (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label       TEXT NOT NULL DEFAULT '',
        server      TEXT NOT NULL DEFAULT '',
        account_id  TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL DEFAULT '',
        is_master   INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS binance_accounts (
        id          SERIAL PRIMARY KEY,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        venue       TEXT NOT NULL DEFAULT '',
        label       TEXT NOT NULL DEFAULT '',
        api_key_enc TEXT NOT NULL,
        api_sec_enc TEXT NOT NULL,
        is_master   INTEGER NOT NULL DEFAULT 0,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS copier_settings (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled     INTEGER NOT NULL DEFAULT 0,
        mt5_account_ids TEXT NOT NULL DEFAULT '[]',
        binance_account_ids TEXT NOT NULL DEFAULT '[]',
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tilt_settings (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        mode        TEXT NOT NULL DEFAULT 'losses',
        max_losses  INTEGER NOT NULL DEFAULT 3,
        max_drawdown_pct DOUBLE PRECISION NOT NULL DEFAULT 5,
        cooldown_hours DOUBLE PRECISION NOT NULL DEFAULT 4,
        balance     DOUBLE PRECISION NOT NULL DEFAULT 10000,
        locked_until TIMESTAMPTZ,
        snooze_until TIMESTAMPTZ,
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    // Migration: exit_price/pnl on paper_trades for the tilt-lock loss tracker.
    await db.exec("ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS exit_price DOUBLE PRECISION");
    await db.exec("ALTER TABLE paper_trades ADD COLUMN IF NOT EXISTS pnl DOUBLE PRECISION");
    // Migration: manual-unlock snooze on tilt_settings (UNLOCK = 30 min grace).
    await db.exec("ALTER TABLE tilt_settings ADD COLUMN IF NOT EXISTS snooze_until TIMESTAMPTZ");
    // Migration: mt5_credentials (single) -> mt5_accounts (multi). Keeps old table.
    await db.exec(`
      INSERT INTO mt5_accounts (user_id, label, server, account_id, password_enc, is_master)
      SELECT user_id, 'Primary', server, account_id, password_enc, 1 FROM mt5_credentials mc
      WHERE NOT EXISTS (SELECT 1 FROM mt5_accounts ma WHERE ma.user_id = mc.user_id)
    `);
    // Migration: voice-journal tags on analyses (added 2026-10-19).
    await db.exec("ALTER TABLE analyses ADD COLUMN IF NOT EXISTS tags TEXT NOT NULL DEFAULT '[]'");
  } else {
    await db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        email         TEXT UNIQUE NOT NULL,
        name          TEXT NOT NULL DEFAULT '',
        password_hash TEXT NOT NULL,
        created_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS chart_states (
        user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        symbol     TEXT NOT NULL DEFAULT 'BTCUSDT',
        timeframe  TEXT NOT NULL DEFAULT '1h',
        indicators TEXT NOT NULL DEFAULT '[]',
        drawings   TEXT NOT NULL DEFAULT '[]',
        layout     TEXT NOT NULL DEFAULT '{}',
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS api_credentials (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        venue       TEXT NOT NULL,
        api_key_enc TEXT NOT NULL,
        api_sec_enc TEXT NOT NULL,
        label       TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(user_id, venue)
      );
      CREATE TABLE IF NOT EXISTS analyses (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        title       TEXT NOT NULL,
        body        TEXT NOT NULL DEFAULT '',
        symbol      TEXT NOT NULL DEFAULT '',
        timeframe   TEXT NOT NULL DEFAULT '',
        chart_state TEXT NOT NULL DEFAULT '{}',
        snapshot    TEXT,
        is_public   INTEGER NOT NULL DEFAULT 1,
        tags        TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS mt5_credentials (
        user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        server       TEXT NOT NULL DEFAULT '',
        account_id   TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL DEFAULT '',
        updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS paper_trades (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        symbol       TEXT NOT NULL DEFAULT '',
        side         TEXT NOT NULL DEFAULT 'buy',
        entry        REAL NOT NULL DEFAULT 0,
        sl           REAL NOT NULL DEFAULT 0,
        tp           REAL NOT NULL DEFAULT 0,
        qty          REAL NOT NULL DEFAULT 0,
        status       TEXT NOT NULL DEFAULT 'open',
        be_moved     INTEGER NOT NULL DEFAULT 0,
        partial_done INTEGER NOT NULL DEFAULT 0,
        auto_be      INTEGER NOT NULL DEFAULT 1,
        auto_partial INTEGER NOT NULL DEFAULT 1,
        bridge_ticket INTEGER,
        target       TEXT NOT NULL DEFAULT 'paper',
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        closed_at    TEXT
      );
      CREATE TABLE IF NOT EXISTS mt5_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        label        TEXT NOT NULL DEFAULT '',
        server       TEXT NOT NULL DEFAULT '',
        account_id   TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL DEFAULT '',
        is_master    INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS binance_accounts (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        venue        TEXT NOT NULL DEFAULT '',
        label        TEXT NOT NULL DEFAULT '',
        api_key_enc  TEXT NOT NULL,
        api_sec_enc  TEXT NOT NULL,
        is_master    INTEGER NOT NULL DEFAULT 0,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS copier_settings (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        enabled     INTEGER NOT NULL DEFAULT 0,
        mt5_account_ids TEXT NOT NULL DEFAULT '[]',
        binance_account_ids TEXT NOT NULL DEFAULT '[]',
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE TABLE IF NOT EXISTS tilt_settings (
        user_id     INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        mode        TEXT NOT NULL DEFAULT 'losses',
        max_losses  INTEGER NOT NULL DEFAULT 3,
        max_drawdown_pct REAL NOT NULL DEFAULT 5,
        cooldown_hours REAL NOT NULL DEFAULT 4,
        balance     REAL NOT NULL DEFAULT 10000,
        locked_until TEXT,
        snooze_until TEXT,
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Migration: exit_price/pnl on paper_trades for the tilt-lock loss tracker.
    const pcols = (await db.all(`PRAGMA table_info(paper_trades)`)).map((c) => c.name);
    if (!pcols.includes("exit_price")) {
      await db.exec("ALTER TABLE paper_trades ADD COLUMN exit_price REAL");
    }
    if (!pcols.includes("pnl")) {
      await db.exec("ALTER TABLE paper_trades ADD COLUMN pnl REAL");
    }
    // Migration: manual-unlock snooze on tilt_settings (UNLOCK = 30 min grace).
    const tcols = (await db.all(`PRAGMA table_info(tilt_settings)`)).map((c) => c.name);
    if (!tcols.includes("snooze_until")) {
      await db.exec("ALTER TABLE tilt_settings ADD COLUMN snooze_until TEXT");
    }
    // Migration: mt5_credentials (single) -> mt5_accounts (multi). Keeps old table.
    await db.exec(`
      INSERT INTO mt5_accounts (user_id, label, server, account_id, password_enc, is_master)
      SELECT user_id, 'Primary', server, account_id, password_enc, 1 FROM mt5_credentials mc
      WHERE NOT EXISTS (SELECT 1 FROM mt5_accounts ma WHERE ma.user_id = mc.user_id)
    `);
    // Migration: link local users to Firebase accounts (added 2026-10-19).
    // SQLite cannot ADD COLUMN with UNIQUE, so uniqueness comes from the index.
    const cols = (await db.all(`PRAGMA table_info(users)`)).map((c) => c.name);
    if (!cols.includes("firebase_uid")) {
      await db.exec("ALTER TABLE users ADD COLUMN firebase_uid TEXT");
    }
    await db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid)");
    // Migration: voice-journal tags on analyses (added 2026-10-19).
    const acols = (await db.all(`PRAGMA table_info(analyses)`)).map((c) => c.name);
    if (!acols.includes("tags")) {
      await db.exec("ALTER TABLE analyses ADD COLUMN tags TEXT NOT NULL DEFAULT '[]'");
    }
  }
}

db.ensureSchema = ensureSchema;
module.exports = db;
