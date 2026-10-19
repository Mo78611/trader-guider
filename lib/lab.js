"use strict";
/* ============================================================================
 * Trader Guider — Tinkerer Lab engine (server-side, Node).
 * ----------------------------------------------------------------------------
 * Loads the client-side methodology detectors (methodology.js is pure math,
 * no DOM) into Node, then powers:
 *   1) Strategy Lab backtester — chunked detection + event-driven walk,
 *      simulated R-multiple trades, equity curve, per-condition stats.
 *   2) Session DNA — per-symbol per-session range/sweep/reversal stats.
 *   3) Footprint outcomes — MFE/MAE/return after N bars for logged events.
 *
 * Everything here is an analytical estimate, not financial advice.
 * ========================================================================== */

const fs = require("fs");
const path = require("path");

function loadMethodology() {
  if (global.__TGM) return global.__TGM;
  const code = fs.readFileSync(
    path.join(__dirname, "..", "public", "js", "methodology.js"), "utf8");
  const g = {};
  new Function("window", code)(g);
  if (!g.TGMethodology) throw new Error("methodology_load_failed");
  global.__TGM = g.TGMethodology;
  return global.__TGM;
}

const TF_SEC = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "1h": 3600,
  "4h": 14400, "1d": 86400, "1w": 604800 };

const CONDITION_DEFS = {
  fvg_tap:   "ICT FVG tap",
  ob_tap:    "ICT Order Block tap",
  sweep:     "Liquidity Sweep",
  vsa_climax:"VSA Climax",
  vsa_ndns:  "VSA No Demand/Supply",
  tl_break:  "Trendline Break",
  tl_retest: "Trendline Retest",
  sr_bounce: "S/R Bounce",
  bos:       "BOS / CHoCH",
  rsi_div:   "RSI Divergence",
};

function num(x) { return typeof x === "number" && isFinite(x); }

function sessionOf(timeSec) {
  const h = new Date(timeSec * 1000).getUTCHours();
  if (h < 3) return "Asia";
  if (h >= 7 && h < 10) return "London";
  if (h >= 12 && h < 15) return "New York";
  return "Off-hours";
}

/* ---------------- RSI (Wilder) ---------------- */
function rsiArr(closes, period) {
  period = period || 14;
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

/* ---------------- RSI divergence events (full-array single pass) ---------------- */
function rsiDivergences(candles, M) {
  const out = [];
  const n = candles.length;
  if (n < 60) return out;
  const rsi = rsiArr(candles.map((c) => c.close), 14);
  const sw = M.swings(candles, 3);
  const highs = sw.filter((s) => s.type === "high");
  const lows = sw.filter((s) => s.type === "low");
  for (let k = 1; k < highs.length; k++) {
    const a = highs[k - 1], b = highs[k];
    if (b.idx - a.idx > 40 || b.idx - a.idx < 4) continue;
    if (!(b.price > a.price)) continue;
    const ra = rsi[a.idx], rb = rsi[b.idx];
    if (ra == null || rb == null) continue;
    if (rb < ra - 2) out.push({ idx: b.idx, dir: "sell", kind: "rsi_div" });
  }
  for (let k = 1; k < lows.length; k++) {
    const a = lows[k - 1], b = lows[k];
    if (b.idx - a.idx > 40 || b.idx - a.idx < 4) continue;
    if (!(b.price < a.price)) continue;
    const ra = rsi[a.idx], rb = rsi[b.idx];
    if (ra == null || rb == null) continue;
    if (rb > ra + 2) out.push({ idx: b.idx, dir: "buy", kind: "rsi_div" });
  }
  return out;
}

/* ---------------- chunked detection -> fire map ----------------
 * fireMap: Map<globalBarIdx, Array<{cond, dir}>>.
 * Windows overlap (step 20, size 200); conditions are evaluated at each
 * chunk's last bar so every ~20th bar carries fresh signals. */
function detectFires(candles, conditions, M) {
  const n = candles.length;
  const fireMap = new Map();
  const W = 200, STEP = 20;
  const tfSec = 3600;

  function addFire(idx, cond, dir) {
    if (!(idx >= 0 && idx < n)) return;
    if (!fireMap.has(idx)) fireMap.set(idx, []);
    const arr = fireMap.get(idx);
    if (!arr.some((f) => f.cond === cond && f.dir === dir)) arr.push({ cond, dir });
  }

  const divs = conditions.includes("rsi_div") ? rsiDivergences(candles, M) : [];
  for (const d of divs) addFire(d.idx, "rsi_div", d.dir);

  const atrFull = M.atr(candles, 14);
  for (let e = W; e <= n; e += STEP) {
    const end = Math.min(e, n);
    const start = end - W;
    const win = candles.slice(start, end);
    let ctx = null;
    try { ctx = M.analyze(win, { tfSec, strength: 3 }); } catch (_e) { continue; }
    if (!ctx || !ctx.candles.length) continue;
    const gi = (li) => start + li; // local -> global idx
    const last = win.length - 1;
    const gLast = gi(last);
    const atr = ctx.atrVal;
    if (!num(atr) || atr <= 0) continue;
    const lc = win[last];
    if (!lc || !num(lc.close)) continue;

    const want = (c) => conditions.includes(c);

    // FVG / OB taps on the last 3 bars of the window
    if (want("fvg_tap")) {
      for (const g of ctx.fvgs) {
        if (g.mitigated >= 0 && gi(g.mitigated) <= gLast) continue;
        const bull = g.dir === "bull";
        for (let j = last; j >= Math.max(0, last - 2); j--) {
          const c = win[j];
          if (!c) continue;
          const tap = bull
            ? (c.low <= g.top && c.low >= g.bottom - 0.1 * atr)
            : (c.high >= g.bottom && c.high <= g.top + 0.1 * atr);
          if (tap) { addFire(gi(j), "fvg_tap", bull ? "buy" : "sell"); break; }
        }
      }
    }
    if (want("ob_tap")) {
      for (const ob of ctx.obs) {
        const bull = ob.dir === "bull";
        for (let j = last; j >= Math.max(0, last - 2); j--) {
          const c = win[j];
          if (!c) continue;
          const tap = bull
            ? (c.low <= ob.top && c.low >= ob.bottom - 0.1 * atr)
            : (c.high >= ob.bottom && c.high <= ob.top + 0.1 * atr);
          if (tap) { addFire(gi(j), "ob_tap", bull ? "buy" : "sell"); break; }
        }
      }
    }
    // sweeps / vsa / pa setups / structure: events near the window end
    if (want("sweep")) {
      for (const s of ctx.sweeps) {
        const gs = gi(s.idx);
        if (gLast - gs <= 4) addFire(gs, "sweep", s.dir === "bull" ? "buy" : "sell");
      }
    }
    if (want("vsa_climax") || want("vsa_ndns")) {
      for (const v of ctx.vsa) {
        const gv = gi(v.idx);
        if (gLast - gv > 4) continue;
        if (want("vsa_climax") && (v.type === "BC" || v.type === "SC"))
          addFire(gv, "vsa_climax", v.dir === "bull" ? "buy" : "sell");
        if (want("vsa_ndns") && (v.type === "ND" || v.type === "NS"))
          addFire(gv, "vsa_ndns", v.dir === "bull" ? "buy" : "sell");
      }
    }
    if (want("sr_bounce") && ctx.paSetups) {
      for (const p of ctx.paSetups) {
        const gp = gi(p.idx);
        if (gLast - gp <= 3) addFire(gp, "sr_bounce", p.dir);
      }
    }
    if (want("bos")) {
      for (const s of ctx.structure) {
        const gs = gi(s.idx);
        if (gLast - gs <= 6) addFire(gs, "bos", s.dir === "bull" ? "buy" : "sell");
      }
    }
    // trendline break / retest at the last bar
    if (want("tl_break") || want("tl_retest")) {
      for (const tl of ctx.trendlines || []) {
        const span = tl.endIdx - tl.startIdx;
        if (!(span > 0)) continue;
        const p0 = tl.points[0], p1 = tl.points[1];
        const lv = p0.price + ((p1.price - p0.price) * (last - tl.startIdx)) / span;
        if (!num(lv)) continue;
        const res = tl.type === "resistance";
        if (want("tl_break")) {
          if (res && lc.close > lv + 0.3 * atr) addFire(gLast, "tl_break", "buy");
          if (!res && lc.close < lv - 0.3 * atr) addFire(gLast, "tl_break", "sell");
        }
        if (want("tl_retest")) {
          if (!res && lc.low <= lv + 0.1 * atr && lc.close > lv && lc.close > lc.open)
            addFire(gLast, "tl_retest", "buy");
          if (res && lc.high >= lv - 0.1 * atr && lc.close < lv && lc.close < lc.open)
            addFire(gLast, "tl_retest", "sell");
        }
      }
    }
  }
  return { fireMap, atr: atrFull };
}

/* ---------------- backtest walk ---------------- */
function runBacktest(candles, conditions, logic) {
  const M = loadMethodology();
  const n = candles.length;
  const { fireMap, atr } = detectFires(candles, conditions, M);
  const swings = M.swings(candles, 3);

  function swingSL(entry, dir, i, atrV) {
    let best = null;
    for (let k = swings.length - 1; k >= 0; k--) {
      const s = swings[k];
      if (s.idx >= i || s.idx < i - 40) continue;
      if (dir === "buy" && s.type === "low" && s.price < entry) { best = s.price; break; }
      if (dir === "sell" && s.type === "high" && s.price > entry) { best = s.price; break; }
    }
    if (best == null) return dir === "buy" ? entry - 1.5 * atrV : entry + 1.5 * atrV;
    return dir === "buy" ? best - 0.2 * atrV : best + 0.2 * atrV;
  }

  const trades = [];
  const condStats = {};
  for (const c of conditions) condStats[c] = { fired: 0, wins: 0 };

  function firedNear(i, winBars) {
    const out = [];
    for (let j = Math.max(0, i - winBars); j <= i; j++) {
      const f = fireMap.get(j);
      if (f) for (const x of f) out.push({ ...x, bar: j });
    }
    return out;
  }

  for (let i = 60; i < n; i++) {
    const c = candles[i];
    if (!c || !num(c.close)) continue;
    const atrV = atr[i];
    if (!num(atrV) || atrV <= 0) continue;

    // entry logic
    let sigDir = null, sigConds = [];
    if (logic === "AND") {
      const fired = firedNear(i, 4);
      const byCond = {};
      for (const f of fired) {
        if (!byCond[f.cond] || f.bar > byCond[f.cond].bar) byCond[f.cond] = f;
      }
      const have = conditions.filter((cd) => byCond[cd]);
      if (have.length === conditions.length) {
        const dirs = new Set(have.map((cd) => byCond[cd].dir));
        if (dirs.size === 1) { sigDir = byCond[have[0]].dir; sigConds = have; }
      }
    } else {
      const fired = firedNear(i, 1);
      if (fired.length) {
        fired.sort((a, b) => b.bar - a.bar);
        const dirs = new Set(fired.map((f) => f.dir));
        if (dirs.size === 1) {
          sigDir = fired[0].dir;
          sigConds = [...new Set(fired.map((f) => f.cond))];
        }
      }
    }
    if (!sigDir) continue;

    const entry = c.close;
    const sl = swingSL(entry, sigDir, i, atrV);
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    // sanity: SL must be on the risk side
    if (sigDir === "buy" ? sl >= entry : sl <= entry) continue;
    const bull = sigDir === "buy";
    const tp1 = bull ? entry + 1.5 * risk : entry - 1.5 * risk;
    const tp2 = bull ? entry + 2.5 * risk : entry - 2.5 * risk;

    // forward scan for the exit (SL checked first — conservative)
    let exitR = null, exitJ = -1;
    for (let j = i + 1; j < Math.min(n, i + 201); j++) {
      const b = candles[j];
      if (!b || !num(b.high) || !num(b.low)) break;
      if (bull) {
        if (b.low <= sl) { exitR = -1; exitJ = j; break; }
        if (b.high >= tp2) { exitR = 2.5; exitJ = j; break; }
        if (b.high >= tp1) { exitR = 1.5; exitJ = j; break; }
      } else {
        if (b.high >= sl) { exitR = -1; exitJ = j; break; }
        if (b.low <= tp2) { exitR = 2.5; exitJ = j; break; }
        if (b.low <= tp1) { exitR = 1.5; exitJ = j; break; }
      }
    }
    if (exitR == null) continue; // never resolved inside the data — skip
    const t = {
      dir: sigDir, entry, sl, tp1, tp2,
      bar: i, time: c.time, conds: sigConds, r: exitR,
    };
    trades.push(t);
    for (const cc of sigConds) {
      condStats[cc].fired++;
      if (exitR > 0) condStats[cc].wins++;
    }
    i = exitJ; // resume after the exit bar (one trade at a time)
  }

  // stats
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0).length;
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  let peak = 0, maxDD = 0, cum = 0;
  const equity = [0];
  for (const r of rs) {
    cum += r;
    equity.push(Math.round(cum * 100) / 100);
    if (cum > peak) peak = cum;
    maxDD = Math.max(maxDD, peak - cum);
  }
  const perCondition = conditions.map((cd) => ({
    condition: cd, label: CONDITION_DEFS[cd] || cd,
    fired: condStats[cd].fired,
    wins: condStats[cd].wins,
    winRate: condStats[cd].fired
      ? Math.round((condStats[cd].wins / condStats[cd].fired) * 100) : null,
  }));
  return {
    trades: trades.length,
    wins,
    winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    avgR: Math.round(avgR * 100) / 100,
    maxDD: Math.round(maxDD * 100) / 100,
    equity,
    perCondition,
    sample: trades.slice(-50).map((t) => ({
      dir: t.dir, entry: t.entry, r: t.r, conds: t.conds,
      time: new Date(t.time * 1000).toISOString().slice(0, 16).replace("T", " "),
    })),
  };
}

async function backtest({ symbol, interval, conditions, logic, limit }) {
  const { getKlines } = require("./market");
  const lim = Math.max(120, Math.min(parseInt(limit, 10) || 500, 2000));
  const { candles } = await getKlines(symbol, interval, lim);
  if (!candles || candles.length < 120) throw new Error("not_enough_data");
  const stats = runBacktest(candles, conditions, logic);
  return { symbol, interval, bars: candles.length, logic, conditions, ...stats };
}

/* ---------------- Session DNA ---------------- */
const DNA_SESSIONS = ["Asia", "London", "New York"];

async function computeDNA(symbol) {
  const M = loadMethodology();
  const { getKlines } = require("./market");
  const { candles } = await getKlines(symbol, "1h", 720); // ~30 days
  if (!candles || candles.length < 100) throw new Error("not_enough_data");
  const atrA = M.atr(candles, 14);
  const swings = M.swings(candles, 3);
  const sweeps = M.liquiditySweeps(candles, swings, atrA, 10000);

  const out = {};
  for (const sess of DNA_SESSIONS) {
    const bars = [];
    for (let i = 0; i < candles.length; i++) {
      if (sessionOf(candles[i].time) === sess) bars.push(i);
    }
    let rangeSum = 0, rangeN = 0;
    for (const i of bars) {
      const a = atrA[i];
      if (num(a) && a > 0 && num(candles[i].high) && num(candles[i].low)) {
        rangeSum += (candles[i].high - candles[i].low) / a;
        rangeN++;
      }
    }
    const sessSweeps = sweeps.filter((s) => sessionOf(s.time) === sess);
    let reversals = 0;
    for (const s of sessSweeps) {
      const a = atrA[s.idx];
      if (!num(a) || a <= 0) continue;
      const bull = s.dir === "bull";
      let rev = false;
      for (let j = s.idx + 1; j <= Math.min(candles.length - 1, s.idx + 6); j++) {
        const b = candles[j];
        if (!b) continue;
        const move = bull ? b.high - s.price : s.price - b.low;
        if (move >= a) { rev = true; break; }
      }
      if (rev) reversals++;
    }
    const days = Math.max(1, Math.round(candles.length / 24));
    out[sess] = {
      avg_range_atr: rangeN ? Math.round((rangeSum / rangeN) * 100) / 100 : null,
      sweep_freq_per_day: Math.round((sessSweeps.length / days) * 100) / 100,
      reversal_pct: sessSweeps.length
        ? Math.round((reversals / sessSweeps.length) * 100) : null,
      samples: bars.length,
    };
  }
  // live warning: current session range vs DNA
  const nowSess = sessionOf(Math.floor(Date.now() / 1000));
  let warning = null;
  if (out[nowSess] && out[nowSess].avg_range_atr) {
    const todayBars = [];
    const dayStart = Math.floor(Date.now() / 1000) - 86400;
    for (let i = candles.length - 1; i >= 0; i--) {
      if (candles[i].time < dayStart) break;
      if (sessionOf(candles[i].time) === nowSess) todayBars.push(i);
    }
    if (todayBars.length >= 2) {
      const hi = Math.max(...todayBars.map((i) => candles[i].high));
      const lo = Math.min(...todayBars.map((i) => candles[i].low));
      const lastAtr = atrA[candles.length - 1];
      if (num(lastAtr) && lastAtr > 0) {
        const ratio = (hi - lo) / lastAtr / out[nowSess].avg_range_atr;
        if (ratio >= 1.5) {
          warning = `Today's ${nowSess} is ${ratio.toFixed(1)}x its normal range — exhaustion likely.`;
        }
      }
    }
  }
  return { symbol, sessions: out, warning, computed_at: new Date().toISOString() };
}

/* ---------------- Footprint outcomes ---------------- */
async function footprintOutcome(fp) {
  const M = loadMethodology();
  const { getKlines } = require("./market");
  const tfSec = TF_SEC[fp.timeframe] || 3600;
  const { candles } = await getKlines(fp.symbol, fp.timeframe, 1000);
  if (!candles || !candles.length) return null;
  let idx = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].time >= fp.time) { idx = i; break; }
  }
  if (idx < 0 || idx > candles.length - 12) return null; // too old or too fresh
  const atrA = M.atr(candles, 14);
  const atr = atrA[idx] || (candles[idx].high - candles[idx].low) || 1;
  const K = Math.max(4, Math.min(96, Math.round(86400 / tfSec)));
  const end = Math.min(candles.length - 1, idx + K);
  let mfe = 0, mae = 0;
  for (let j = idx; j <= end; j++) {
    const b = candles[j];
    const up = b.high - fp.price, dn = fp.price - b.low;
    if (fp.dir === "buy") { mfe = Math.max(mfe, up); mae = Math.max(mae, dn); }
    else if (fp.dir === "sell") { mfe = Math.max(mfe, dn); mae = Math.max(mae, up); }
    else { mfe = Math.max(mfe, up, dn); }
  }
  return {
    mfe_atr: Math.round((mfe / atr) * 100) / 100,
    mae_atr: Math.round((mae / atr) * 100) / 100,
    ret_dir: Math.sign(candles[end].close - fp.price),
  };
}

/* ---------------- Deep history pipeline (institutional scale) ----------------
 * Paginates backward through Binance spot klines (1000/request, endTime
 * cursor) via the geo-unrestricted vision mirror. One call fetches up to
 * 10 pages (10k candles); the client loops with the returned nextEndTime
 * cursor for honest progress ("Fetching 45,000 / 100,000…").
 * HONEST LIMITATION: deep history only works for crypto. Forex/stocks go
 * through Yahoo (short ranges) — those return deep:false with a plain note. */
const VISION_KLINES = "https://data-api.binance.vision/api/v3/klines";
const BINANCE_KLINES = "https://api.binance.com/api/v3/klines";
const DEEP_PAGE = 1000;
const DEEP_PAGES_PER_CALL = 10;
const DEEP_MAX = 300000;

function isCryptoSymbol(sym) {
  return /USDT$|USDC$|BUSD$|FDUSD$|TUSD$|BTC$|ETH$|BNB$/i.test(sym || "");
}

function normCandle(r) {
  return {
    time: Math.floor(r[0] / 1000),
    open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  };
}

async function fetchKlinesPage(symbol, interval, endTime) {
  const q = `symbol=${symbol}&interval=${interval}&limit=${DEEP_PAGE}` +
    (endTime ? `&endTime=${endTime}` : "");
  const urls = [`${VISION_KLINES}?${q}`, `${BINANCE_KLINES}?${q}`];
  let lastErr = null;
  for (const u of urls) {
    try {
      const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) { lastErr = new Error(`klines ${res.status}`); continue; }
      const rows = await res.json();
      if (!Array.isArray(rows)) { lastErr = new Error("klines bad shape"); continue; }
      return rows.map(normCandle).filter((c) =>
        isFinite(c.time) && isFinite(c.open) && isFinite(c.high) &&
        isFinite(c.low) && isFinite(c.close));
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("klines_unavailable");
}

/* Fetch up to `limit` candles ending at `endTime` (ms; omit = now).
 * Returns { candles (oldest→newest), nextEndTime (ms|null), done, deep, note? } */
async function fetchDeep({ symbol, interval, limit, endTime }) {
  const lim = Math.max(1000, Math.min(parseInt(limit, 10) || 10000, DEEP_PAGES_PER_CALL * DEEP_PAGE));
  if (!isCryptoSymbol(symbol)) {
    // Honest fallback: forex/stocks via Yahoo have short ranges — no deep history.
    const { getKlines } = require("./market");
    const { candles } = await getKlines(symbol, interval, 1000);
    return {
      candles: candles || [], nextEndTime: null, done: true, deep: false,
      note: "Deep history is available for crypto only — forex/stocks use short-range Yahoo data. Showing all available bars.",
    };
  }
  const pages = Math.ceil(lim / DEEP_PAGE);
  let cursor = endTime ? parseInt(endTime, 10) : null;
  const all = [];
  let done = false;
  for (let p = 0; p < pages; p++) {
    const rows = await fetchKlinesPage(symbol, interval, cursor);
    if (!rows.length) { done = true; break; }
    // prepend (we walk backward); Binance returns oldest→newest per page
    for (let i = rows.length - 1; i >= 0; i--) all.unshift(rows[i]);
    if (rows.length < DEEP_PAGE) { done = true; break; } // hit exchange history start
    cursor = rows[0].time * 1000 - 1; // next page ends just before this page's oldest bar
    // stop if we've reached the absolute cap
    if (all.length >= DEEP_MAX) { done = true; break; }
  }
  // de-dupe by time (page boundaries can overlap by 1 bar)
  const seen = new Set();
  const candles = [];
  for (const c of all) {
    if (seen.has(c.time)) continue;
    seen.add(c.time);
    candles.push(c);
  }
  const trimmed = candles.slice(-lim); // oldest→newest, at most lim
  return {
    candles: trimmed, nextEndTime: done ? null : cursor, done, deep: true,
    fetched: trimmed.length,
  };
}

module.exports = {
  CONDITION_DEFS, TF_SEC, sessionOf, loadMethodology,
  runBacktest, backtest, computeDNA, footprintOutcome, rsiArr,
  fetchDeep, isCryptoSymbol, DEEP_MAX,
};
