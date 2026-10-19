"use strict";
// BLACKSITE — experimental lab API (separate from standard tools).
//   POST /api/blacksite/ghost      log an emitted signal plan
//   GET  /api/blacksite/ghosts     list signals with computed outcomes
//   GET  /api/blacksite/fracture   news-bias vs structure disagreement scan
//   POST /api/blacksite/echo       historical shape-rhyme scan
// All routes require auth. All null-safe. Estimates, not guarantees.

const express = require("express");
const db = require("../db");
const { requireAuth } = require("../lib/auth");
const { getKlines } = require("../lib/market");
const { getUpcomingRaw, biasFor, classify } = require("../lib/news");

const router = express.Router();

function num(x) { return typeof x === "number" && isFinite(x); }
function cleanSym(s) {
  return String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20);
}
function cleanTf(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4) || "1h";
}

/* ================= 1) GHOST TRADES ================= */

router.post("/ghost", requireAuth, async (req, res) => {
  try {
    const b = req.body || {};
    const symbol = cleanSym(b.symbol);
    const timeframe = cleanTf(b.timeframe);
    const direction = b.direction === "sell" ? "sell" : "buy";
    const entry = Number(b.entry), sl = Number(b.sl);
    const tp1 = Number(b.tp1), tp2 = Number(b.tp2);
    const barTime = Math.floor(Number(b.bar_time) || 0);
    const tag = String(b.tag || "").slice(0, 120);
    if (!symbol || !num(entry) || !num(sl) || !(entry > 0) || !(sl > 0) || !barTime) {
      return res.status(400).json({ error: "bad_signal" });
    }
    if (direction === "buy" ? sl >= entry : sl <= entry) {
      return res.status(400).json({ error: "bad_geometry" });
    }
    const r = await db.run(
      `INSERT INTO ghost_signals
         (user_id, symbol, timeframe, direction, entry, sl, tp1, tp2, tag, bar_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (user_id, symbol, timeframe, bar_time, direction) DO NOTHING`,
      [req.user.id, symbol, timeframe, direction, entry, sl,
       num(tp1) ? tp1 : 0, num(tp2) ? tp2 : 0, tag, barTime]
    );
    res.json({ ok: true, id: r.id, deduped: r.id == null });
  } catch (e) {
    res.status(500).json({ error: "ghost_save_failed", detail: String(e.message).slice(0, 120) });
  }
});

// Outcome engine: walk 1h bars forward from the signal bar.
// Priority per bar (conservative): SL first, then TP2, then TP1.
// Window: 72 bars (~3 days on 1h). Older than that -> "expired" (final).
const GHOST_WINDOW_BARS = 72;
const GHOST_EXPIRE_MS = 96 * 3600 * 1000; // 4 days -> outcome is final

function ghostOutcome(sig, candles) {
  const bull = sig.direction === "buy";
  const risk = bull ? sig.entry - sig.sl : sig.sl - sig.entry;
  if (!(risk > 0)) return { outcome: "invalid", r: 0 };
  const startT = Number(sig.bar_time);
  let started = false;
  let n = 0;
  for (const c of candles) {
    if (!num(c.time) || !num(c.high) || !num(c.low)) continue;
    if (!started) {
      if (c.time <= startT) continue;
      started = true;
    }
    n++;
    if (n > GHOST_WINDOW_BARS) break;
    const slHit = bull ? c.low <= sig.sl : c.high >= sig.sl;
    if (slHit) return { outcome: "sl", r: -1, at: c.time };
    if (num(sig.tp2) && sig.tp2 > 0) {
      const tp2Hit = bull ? c.high >= sig.tp2 : c.low <= sig.tp2;
      if (tp2Hit) return { outcome: "tp2", r: (bull ? sig.tp2 - sig.entry : sig.entry - sig.tp2) / risk, at: c.time };
    }
    if (num(sig.tp1) && sig.tp1 > 0) {
      const tp1Hit = bull ? c.high >= sig.tp1 : c.low <= sig.tp1;
      if (tp1Hit) return { outcome: "tp1", r: (bull ? sig.tp1 - sig.entry : sig.entry - sig.tp1) / risk, at: c.time };
    }
  }
  return { outcome: "expired", r: 0, at: null };
}

router.get("/ghosts", requireAuth, async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 7, 1), 90);
    const since = new Date(Date.now() - days * 86400 * 1000).toISOString();
    const rows = await db.all(
      `SELECT * FROM ghost_signals WHERE user_id = ? AND created_at >= ?
       ORDER BY created_at DESC LIMIT 300`,
      [req.user.id, since]
    );
    // group by symbol -> one klines fetch per symbol
    const bySym = {};
    for (const r of rows) (bySym[r.symbol] = bySym[r.symbol] || []).push(r);
    const out = [];
    let missedR = 0, nCounted = 0;
    for (const sym of Object.keys(bySym)) {
      let candles = [];
      try { candles = (await getKlines(sym, "1h", 500)).candles || []; } catch (_e) { /* outcomes stay open */ }
      for (const sig of bySym[sym]) {
        let outcome = sig.outcome, r = sig.outcome_r;
        const ageMs = Date.now() - new Date(sig.created_at).getTime();
        const final = outcome && (outcome !== "open");
        if (!final && candles.length) {
          const oc = ghostOutcome(sig, candles);
          const isFinal = oc.outcome !== "expired" || ageMs > GHOST_EXPIRE_MS;
          outcome = oc.outcome;
          r = Math.round(oc.r * 100) / 100;
          if (isFinal) {
            try {
              await db.run("UPDATE ghost_signals SET outcome = ?, outcome_r = ? WHERE id = ? AND user_id = ?",
                [outcome, r, sig.id, req.user.id]);
            } catch (_e) { /* best effort */ }
          }
        }
        if (outcome && outcome !== "open") {
          nCounted++;
          if (r > 0) missedR += r;
        }
        out.push({
          id: sig.id, symbol: sig.symbol, timeframe: sig.timeframe,
          direction: sig.direction, entry: sig.entry, sl: sig.sl,
          tp1: sig.tp1, tp2: sig.tp2, tag: sig.tag,
          time: sig.created_at, outcome: outcome || "open",
          r: r == null ? null : Math.round(r * 100) / 100,
        });
      }
    }
    out.sort((a, b) => new Date(b.time) - new Date(a.time));
    res.json({
      days,
      summary: { signals: nCounted, missedR: Math.round(missedR * 100) / 100 },
      signals: out,
      note: "Ghost signals are plans the engine emitted but you never executed. Missed R = profit left on the table. Experimental estimate.",
    });
  } catch (e) {
    res.status(500).json({ error: "ghosts_unavailable", detail: String(e.message).slice(0, 120) });
  }
});

/* ================= 2) FRACTURE RADAR ================= */

function klinesTrend(candles) {
  if (!candles || candles.length < 60) return null;
  const a = candles[candles.length - 51].close, b = candles[candles.length - 1].close;
  if (!(a > 0) || !num(b)) return null;
  const chg = (b - a) / a;
  if (chg > 0.005) return "up";
  if (chg < -0.005) return "down";
  return "flat";
}

router.get("/fracture", requireAuth, async (req, res) => {
  try {
    const symbol = cleanSym(req.query.symbol, "BTCUSDT");
    const { events } = await getUpcomingRaw();
    const now = Date.now();
    const upcoming = events
      .filter((e) => new Date(e.time).getTime() > now - 3600 * 1000)
      .sort((a, b) => new Date(a.time) - new Date(b.time));
    if (!upcoming.length) {
      return res.json({ symbol, fracture: false, reason: "no_event",
        message: "No high-impact news coming up. Nothing to fracture." });
    }
    // prefer the nearest tier-1 event, else the nearest event
    const t1 = upcoming.find((e) => classify(e.title).tier === 1);
    const ev = t1 || upcoming[0];
    let candles = [];
    try { candles = (await getKlines(symbol, "1h", 100)).candles || []; } catch (_e) { /* trend stays null */ }
    const trend = klinesTrend(candles);
    const bias = biasFor(ev, symbol, trend);
    const biasDir = bias.direction; // bullish | bearish | neutral
    let fracture = false, message = "";
    if ((biasDir === "bullish" || biasDir === "bearish") && bias.chance >= 65 && trend && trend !== "flat") {
      const oppose = (biasDir === "bullish" && trend === "down") ||
                     (biasDir === "bearish" && trend === "up");
      fracture = oppose;
    }
    const when = new Date(ev.time);
    const hrs = Math.max(0, (when.getTime() - now) / 3600000);
    const whenTxt = hrs < 1 ? `${Math.round(hrs * 60)} min` : `${hrs.toFixed(1)} h`;
    if (fracture) {
      message = `⚡ FRACTURE: news says ${bias.chance}% ${biasDir} but price structure is ${trend === "up" ? "breaking DOWN" : "pushing UP"}. Volatility likely — stay careful.`;
    } else if (biasDir === "neutral") {
      message = `No fracture — ${ev.title} is unclear (${bias.chance}% neutral). Wait for the news.`;
    } else {
      message = `No fracture — news (${bias.chance}% ${biasDir}) and structure (${trend || "unknown"}) point the same way.`;
    }
    res.json({
      symbol, fracture,
      event: { title: ev.title, time: ev.time, in: whenTxt, tier: classify(ev.title).tier,
               forecast: ev.forecast, previous: ev.previous },
      bias: { direction: biasDir, chance: bias.chance, text: bias.text },
      trend, message,
      note: "Experimental: disagreement between news bias and price structure often precedes sharp moves. Not a signal.",
    });
  } catch (e) {
    res.status(502).json({ error: "fracture_unavailable", detail: String(e.message).slice(0, 120) });
  }
});

/* ================= 3) ECHO MAPPER ================= */

function pearson(a, b) {
  const n = a.length;
  if (n !== b.length || n < 5) return 0;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma, dbb = b[i] - mb;
    sab += da * dbb; saa += da * da; sbb += dbb * dbb;
  }
  if (!(saa > 0) || !(sbb > 0)) return 0;
  return sab / Math.sqrt(saa * sbb);
}

router.post("/echo", requireAuth, async (req, res) => {
  try {
    const symbol = cleanSym((req.body || {}).symbol, "BTCUSDT");
    const LEN = 30, MIN_R = 0.85, MAX_MATCHES = 5;
    const { candles } = await getKlines(symbol, "1h", 1000);
    if (!candles || candles.length < LEN + 60) {
      return res.status(502).json({ error: "not_enough_history" });
    }
    const closes = candles.map((c) => c.close).filter(num);
    const pattern = closes.slice(-LEN);
    const matches = [];
    // slide over history, excluding the last LEN+10 bars (the pattern's own neighborhood)
    for (let i = 0; i + LEN + 10 < closes.length - 10; i++) {
      const win = closes.slice(i, i + LEN);
      const r = pearson(pattern, win);
      if (r >= MIN_R) {
        const endC = closes[i + LEN - 1];
        const fwd = closes[i + LEN + 9];
        const next10 = endC > 0 && num(fwd) ? ((fwd - endC) / endC) * 100 : null;
        matches.push({ idx: i, time: candles[i + LEN - 1].time, r: Math.round(r * 1000) / 1000, next10Pct: next10 == null ? null : Math.round(next10 * 100) / 100 });
      }
    }
    // dedupe overlapping windows: keep best r per 30-bar neighborhood
    matches.sort((a, b) => b.r - a.r);
    const kept = [];
    for (const m of matches) {
      if (kept.length >= MAX_MATCHES) break;
      if (kept.some((k) => Math.abs(k.idx - m.idx) < LEN)) continue;
      kept.push(m);
    }
    kept.sort((a, b) => b.time - a.time);
    const ups = kept.filter((m) => m.next10Pct != null && m.next10Pct > 0).length;
    const downs = kept.filter((m) => m.next10Pct != null && m.next10Pct < 0).length;
    const avg = kept.length
      ? kept.reduce((a, m) => a + (m.next10Pct || 0), 0) / kept.length : 0;
    const dirTxt = ups > downs ? `${ups}× up` : downs > ups ? `${downs}× down` : "mixed";
    res.json({
      symbol, interval: "1h", patternBars: LEN, minR: MIN_R,
      matches: kept.map((m) => ({ time: new Date(m.time * 1000).toISOString(), r: m.r, next10Pct: m.next10Pct })),
      summary: kept.length
        ? `This shape happened ${kept.length}× before — ${dirTxt} (${avg >= 0 ? "+" : ""}${avg.toFixed(2)}% avg next 10 bars).`
        : "No strong rhymes found in history (r ≥ 0.85). Try another symbol or timeframe.",
      note: "Experimental shape-matching. Past rhymes are not future guarantees.",
    });
  } catch (e) {
    res.status(502).json({ error: "echo_unavailable", detail: String(e.message).slice(0, 120) });
  }
});

module.exports = router;
