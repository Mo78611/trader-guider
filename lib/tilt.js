"use strict";
/* ============================================================================
 * Trader Guider — Tilt-Lock overtrading blocker (server logic).
 * ----------------------------------------------------------------------------
 * Psychology saver: when the user hits their daily loss limit the execution
 * panel is frozen until a cooldown expires.
 *
 * Two modes:
 *   'losses'   — N consecutive losing closed trades (default 3)
 *   'drawdown' — realized day P/L worse than -X% of the configured balance
 *
 * Only paper_trades with a recorded pnl participate (trades closed through
 * the tracker with an exit price). Bridge positions closed outside the
 * tracker can't be scored — the UI says so.
 * ========================================================================== */

const db = require("../db");

const DEFAULTS = {
  mode: "losses",
  max_losses: 3,
  max_drawdown_pct: 5,
  cooldown_hours: 4,
  balance: 10000,
};

function todayUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function getSettings(userId) {
  const row = await db.get("SELECT * FROM tilt_settings WHERE user_id = ?", [userId]);
  if (!row) return Object.assign({ locked_until: null, snooze_until: null }, DEFAULTS);
  return {
    mode: row.mode === "drawdown" ? "drawdown" : "losses",
    max_losses: Math.max(1, parseInt(row.max_losses, 10) || 3),
    max_drawdown_pct: Math.max(0.5, parseFloat(row.max_drawdown_pct) || 5),
    cooldown_hours: Math.max(0.25, parseFloat(row.cooldown_hours) || 4),
    balance: Math.max(1, parseFloat(row.balance) || 10000),
    locked_until: row.locked_until || null,
    snooze_until: row.snooze_until || null,
  };
}

async function saveSettings(userId, body) {
  const mode = body.mode === "drawdown" ? "drawdown" : "losses";
  const max_losses = Math.max(1, Math.min(20, parseInt(body.max_losses, 10) || 3));
  const max_drawdown_pct = Math.max(0.5, Math.min(100, parseFloat(body.max_drawdown_pct) || 5));
  const cooldown_hours = Math.max(0.25, Math.min(72, parseFloat(body.cooldown_hours) || 4));
  const balance = Math.max(1, parseFloat(body.balance) || 10000);
  await db.run(`
    INSERT INTO tilt_settings (user_id, mode, max_losses, max_drawdown_pct, cooldown_hours, balance, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(user_id) DO UPDATE SET
      mode=excluded.mode, max_losses=excluded.max_losses,
      max_drawdown_pct=excluded.max_drawdown_pct, cooldown_hours=excluded.cooldown_hours,
      balance=excluded.balance, updated_at=datetime('now')
  `, [userId, mode, max_losses, max_drawdown_pct, cooldown_hours, balance]);
  return getSettings(userId);
}

/** Today's closed, scored trades (newest first). */
async function todayClosed(userId) {
  const day = todayUTC();
  // closed_at formats differ per dialect; the YYYY-MM-DD prefix is common to both.
  const rows = await db.all(`
    SELECT id, symbol, side, entry, exit_price, pnl, closed_at
    FROM paper_trades
    WHERE user_id = ? AND status = 'closed' AND substr(closed_at, 1, 10) = ?
    ORDER BY closed_at DESC
  `, [userId, day]);
  return rows.filter((r) => r.pnl != null && isFinite(r.pnl));
}

async function evaluate(userId) {
  const s = await getSettings(userId);
  const closed = await todayClosed(userId);
  let consecLosses = 0;
  for (const t of closed) {
    if (t.pnl < 0) consecLosses++;
    else break;
  }
  const pnlDay = closed.reduce((a, t) => a + t.pnl, 0);
  const ddPct = pnlDay < 0 ? (-pnlDay / s.balance) * 100 : 0;

  let hit = false, reason = null;
  if (s.mode === "losses" && consecLosses >= s.max_losses) {
    hit = true;
    reason = `${consecLosses} consecutive losses (limit ${s.max_losses})`;
  } else if (s.mode === "drawdown" && ddPct >= s.max_drawdown_pct) {
    hit = true;
    reason = `daily drawdown ${ddPct.toFixed(2)}% (limit ${s.max_drawdown_pct}%)`;
  }

  const now = new Date();
  let locked = false, remainingSec = 0, lockedUntil = s.locked_until;
  // Manual UNLOCK grants a 30-minute grace: the user deliberately overrode,
  // so we don't re-lock on the very next order while the day's stats still
  // show the breach. Stats keep reporting the hit honestly.
  let snoozed = false;
  if (s.snooze_until) {
    const sn = new Date(s.snooze_until);
    if (sn > now) {
      snoozed = true;
    } else {
      await db.run("UPDATE tilt_settings SET snooze_until = NULL WHERE user_id = ?", [userId]);
    }
  }
  if (lockedUntil) {
    const until = new Date(lockedUntil);
    if (until > now) {
      locked = true;
      remainingSec = Math.ceil((until - now) / 1000);
    } else {
      // expired — clear it
      await db.run("UPDATE tilt_settings SET locked_until = NULL WHERE user_id = ?", [userId]);
      lockedUntil = null;
    }
  }
  if (hit && !locked && !snoozed) {
    const until = new Date(now.getTime() + s.cooldown_hours * 3600 * 1000);
    lockedUntil = until.toISOString();
    await db.run("UPDATE tilt_settings SET locked_until = ? WHERE user_id = ?", [lockedUntil, userId]);
    locked = true;
    remainingSec = Math.ceil(s.cooldown_hours * 3600);
  }
  return {
    settings: {
      mode: s.mode, max_losses: s.max_losses, max_drawdown_pct: s.max_drawdown_pct,
      cooldown_hours: s.cooldown_hours, balance: s.balance,
    },
    locked, lockedUntil, remainingSec, reason,
    snoozed, // manual UNLOCK grace active — stats still show the breach
    stats: {
      closedToday: closed.length,
      consecLosses,
      pnlDay: Math.round(pnlDay * 100) / 100,
      drawdownPct: Math.round(ddPct * 100) / 100,
    },
  };
}

async function unlock(userId) {
  // Deliberate override: clear the freeze and grant 30 minutes of grace
  // before the (still-true) condition can re-lock.
  const snoozeUntil = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  await db.run(
    "UPDATE tilt_settings SET locked_until = NULL, snooze_until = ? WHERE user_id = ?",
    [snoozeUntil, userId]);
  return evaluate(userId);
}

module.exports = { getSettings, saveSettings, evaluate, unlock, todayUTC };
