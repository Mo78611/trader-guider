"use strict";
/* ============================================================================
 * Trader Guider — Strategy Lab backtest Web Worker (institutional scale).
 * ----------------------------------------------------------------------------
 * Runs the FULL backtest loop off the main thread: indicator math, chunked
 * methodology detection, and the event-driven trade walk over 100k–300k
 * candles. The UI never freezes; progress is posted every 5%.
 *
 * Memory design (the anti-crash rules):
 *  - OHLCV lives in Float64Array columns (+ Float64Array time). The hot loop
 *    NEVER builds arrays of candle objects for the full dataset.
 *  - Indicator math (RSI/ATR/SMA/EMA/MACD) is written against TypedArrays.
 *  - The methodology detectors (methodology.js, pure math, no DOM) run on
 *    small 200-bar windows only — a pre-allocated pool of 200 plain objects
 *    is refilled per window, so no per-step allocation storm.
 *  - Results are capped before posting back: equity downsampled to ≤2000
 *    points, trade list capped at 500 (client paginates 50/page).
 *
 * Message protocol:
 *  in:  {type:"run", id, n, buf:{time,open,high,low,close,volume} (transferable
 *         Float64Arrays), conditions[], logic ("AND"/"OR")}
 *  out: {type:"progress", id, pct, phase}
 *        {type:"done", id, result}
 *        {type:"error", id, message}
 * ========================================================================== */

// methodology.js does `window.TGMethodology = ...` — shim so it loads here.
self.window = self;
importScripts("methodology.js");

const M = self.TGMethodology || null;

const CONDITION_DEFS = {
  fvg_tap: "ICT FVG tap", ob_tap: "ICT Order Block tap", sweep: "Liquidity Sweep",
  vsa_climax: "VSA Climax", vsa_ndns: "VSA No Demand/Supply",
  tl_break: "Trendline Break", tl_retest: "Trendline Retest",
  sr_bounce: "S/R Bounce", bos: "BOS / CHoCH", rsi_div: "RSI Divergence",
};

function num(x) { return typeof x === "number" && isFinite(x); }

function isF64(x) {
  // cross-realm safe: the Node test harness uses a different Float64Array constructor
  return !!x && typeof x.length === "number" && typeof x.set === "function" &&
    Object.prototype.toString.call(x) === "[object Float64Array]";
}

/* ================= Typed-array indicators (Wilder where it matters) ================= */
function taRSI(close, period) {
  period = period || 14;
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period + 1) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) {
    const d = close[i] - close[i - 1];
    if (d > 0) g += d; else l -= d;
  }
  g /= period; l /= period;
  out[period] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = period + 1; i < n; i++) {
    const d = close[i] - close[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function taATR(high, low, close, period) {
  period = period || 14;
  const n = close.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period + 1) return out;
  let atr = 0;
  for (let i = 1; i <= period; i++) {
    atr += Math.max(high[i] - low[i],
      Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
  }
  atr /= period;
  out[period] = atr;
  for (let i = period + 1; i < n; i++) {
    const tr = Math.max(high[i] - low[i],
      Math.abs(high[i] - close[i - 1]), Math.abs(low[i] - close[i - 1]));
    atr = (atr * (period - 1) + tr) / period;
    out[i] = atr;
  }
  return out;
}

function taSMA(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function taEMA(values, period) {
  const n = values.length;
  const out = new Float64Array(n).fill(NaN);
  if (n < period) return out;
  const k = 2 / (period + 1);
  let prev = 0;
  for (let j = 0; j < period; j++) prev += values[j];
  prev /= period;
  out[period - 1] = prev;
  for (let i = period; i < n; i++) {
    prev = values[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

function taMACD(close, fast, slow, signal) {
  fast = fast || 12; slow = slow || 26; signal = signal || 9;
  const ef = taEMA(close, fast), es = taEMA(close, slow);
  const n = close.length;
  const macd = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(ef[i]) && !isNaN(es[i])) macd[i] = ef[i] - es[i];
  }
  // signal line: EMA over macd values, skipping NaN warmup
  const sig = new Float64Array(n).fill(NaN);
  const k = 2 / (signal + 1);
  let prev = null, cnt = 0;
  for (let i = 0; i < n; i++) {
    if (isNaN(macd[i])) continue;
    cnt++;
    if (cnt <= signal) {
      prev = (prev == null ? 0 : prev) + macd[i];
      if (cnt === signal) { prev /= signal; sig[i] = prev; }
    } else {
      prev = macd[i] * k + prev * (1 - k);
      sig[i] = prev;
    }
  }
  const hist = new Float64Array(n).fill(NaN);
  for (let i = 0; i < n; i++) {
    if (!isNaN(macd[i]) && !isNaN(sig[i])) hist[i] = macd[i] - sig[i];
  }
  return { macd, sig, hist };
}

/* ================= Typed-array fractal swings (matches M.swings semantics) ================= */
function taSwings(high, low, strength) {
  const s = strength || 3;
  const n = high.length;
  const idx = [], type = [], price = []; // type: 1 = high, 0 = low
  for (let i = s; i < n - s; i++) {
    const h = high[i], l = low[i];
    if (!num(h) || !num(l)) continue;
    let isH = true, isL = true;
    for (let j = 1; j <= s; j++) {
      const lh = high[i - j], rh = high[i + j], ll = low[i - j], rl = low[i + j];
      if (!num(lh) || !num(rh) || !num(ll) || !num(rl)) { isH = isL = false; break; }
      if (lh >= h || rh >= h) isH = false;
      if (ll <= l || rl <= l) isL = false;
      if (!isH && !isL) break;
    }
    if (isH) { idx.push(i); type.push(1); price.push(h); }
    else if (isL) { idx.push(i); type.push(0); price.push(l); }
  }
  return { idx: Int32Array.from(idx), type: Uint8Array.from(type), price: Float64Array.from(price) };
}

/* ================= Engine state (module-level, reset per run) ================= */
let T = null, O = null, H = null, L = null, C = null, V = null, N = 0;
let post = null; // progress poster for the active run

// Pre-allocated 200-object window pool for M.analyze (no per-step allocation storm)
const WIN = 200;
const winPool = [];
for (let i = 0; i < WIN; i++) winPool.push({ time: 0, open: 0, high: 0, low: 0, close: 0, volume: 0 });
function fillWindow(start, len) {
  for (let j = 0; j < len; j++) {
    const o = winPool[j], i = start + j;
    o.time = T[i]; o.open = O[i]; o.high = H[i]; o.low = L[i]; o.close = C[i]; o.volume = V[i];
  }
  return winPool.slice(0, len);
}

/* ================= RSI divergences (typed-array single pass) ================= */
function rsiDivergences(rsi, sw) {
  const out = [];
  const m = sw.idx.length;
  if (m < 2) return out;
  // Faithful port of lib/lab.js: walk consecutive same-type swings
  let lastH = -1, lastL = -1;
  for (let k = 0; k < m; k++) {
    const i = sw.idx[k];
    if (i < 60) continue;
    const ri = rsi[i];
    if (!num(ri)) continue;
    if (sw.type[k] === 1) {
      if (lastH >= 0) {
        const a = sw.idx[lastH], b = i;
        if (b - a <= 40 && b - a >= 4 && sw.price[k] > sw.price[lastH]) {
          const ra = rsi[a];
          if (num(ra) && ri < ra - 2) out.push({ idx: b, dir: "sell", kind: "rsi_div" });
        }
      }
      lastH = k;
    } else {
      if (lastL >= 0) {
        const a = sw.idx[lastL], b = i;
        if (b - a <= 40 && b - a >= 4 && sw.price[k] < sw.price[lastL]) {
          const ra = rsi[a];
          if (num(ra) && ri > ra + 2) out.push({ idx: b, dir: "buy", kind: "rsi_div" });
        }
      }
      lastL = k;
    }
  }
  return out;
}

/* ================= Chunked detection -> fire map =================
 * Mirrors lib/lab.js detectFires semantics: 200-bar windows, step 20,
 * conditions evaluated at each window's end. Full-array passes (ATR/RSI/
 * swings) use TypedArrays; M.analyze runs on the 200-bar object window. */
function detectFires(conditions, onTick) {
  const fireMap = new Map();
  const W = WIN;
  // Adaptive step: full density for small runs, sparser evaluation for deep
  // history (same detection logic — fewer evaluation points, honest tradeoff).
  const STEP = N > 50000 ? 100 : N > 20000 ? 50 : 20;
  const tfSec = 3600;

  function addFire(idx, cond, dir) {
    if (!(idx >= 0 && idx < N)) return;
    let arr = fireMap.get(idx);
    if (!arr) { arr = []; fireMap.set(idx, arr); }
    for (const f of arr) if (f.cond === cond && f.dir === dir) return;
    arr.push({ cond, dir });
  }

  const atrFull = taATR(H, L, C, 14);
  const swFull = taSwings(H, L, 3);

  if (conditions.includes("rsi_div")) {
    const rsi = taRSI(C, 14);
    for (const d of rsiDivergences(rsi, swFull)) addFire(d.idx, "rsi_div", d.dir);
  }

  const want = (c) => conditions.includes(c);
  const total = Math.max(1, Math.floor((N - W) / STEP));
  let done = 0, lastPct = -1;

  for (let e = W; e <= N; e += STEP) {
    const end = Math.min(e, N);
    const start = end - W;
    const win = fillWindow(start, end - start);
    let ctx = null;
    try { ctx = M.analyze(win, { tfSec, strength: 3 }); } catch (_e) { /* skip window */ }
    done++;
    const pct = Math.floor((done / total) * 100);
    if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onTick(pct, "detect"); }
    if (!ctx || !ctx.candles.length) continue;
    const gi = (li) => start + li;
    const last = win.length - 1;
    const gLast = gi(last);
    const atr = ctx.atrVal;
    if (!num(atr) || atr <= 0) continue;
    const lc = win[last];
    if (!lc || !num(lc.close)) continue;

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
  return { fireMap, atr: atrFull, swings: swFull };
}

/* ================= Backtest walk ================= */
function swingSL(entry, dir, i, atrV, sw) {
  let best = null;
  for (let k = sw.idx.length - 1; k >= 0; k--) {
    const si = sw.idx[k];
    if (si >= i || si < i - 40) continue;
    if (dir === "buy" && sw.type[k] === 0 && sw.price[k] < entry) { best = sw.price[k]; break; }
    if (dir === "sell" && sw.type[k] === 1 && sw.price[k] > entry) { best = sw.price[k]; break; }
  }
  if (best == null) return dir === "buy" ? entry - 1.5 * atrV : entry + 1.5 * atrV;
  return dir === "buy" ? best - 0.2 * atrV : best + 0.2 * atrV;
}

function runBacktest(conditions, logic, onTick) {
  const { fireMap, atr, swings } = detectFires(conditions, onTick);
  const trades = [];
  const condStats = {};
  for (const c of conditions) condStats[c] = { fired: 0, wins: 0 };

  function firedNear(i, winBars) {
    const out = [];
    for (let j = Math.max(0, i - winBars); j <= i; j++) {
      const f = fireMap.get(j);
      if (f) for (const x of f) out.push({ cond: x.cond, dir: x.dir, bar: j });
    }
    return out;
  }

  let lastPct = -1;
  for (let i = 60; i < N; i++) {
    if (i % 2000 === 0) {
      const pct = Math.floor((i / N) * 100);
      if (pct !== lastPct && pct % 5 === 0) { lastPct = pct; onTick(pct, "walk"); }
    }
    const close = C[i];
    if (!num(close)) continue;
    const atrV = atr[i];
    if (!num(atrV) || atrV <= 0) continue;

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
        const dirs = new Set(fired.map((f) => f.dir));
        if (dirs.size === 1) {
          fired.sort((a, b) => b.bar - a.bar);
          sigDir = fired[0].dir;
          sigConds = [...new Set(fired.map((f) => f.cond))];
        }
      }
    }
    if (!sigDir) continue;

    const entry = close;
    const sl = swingSL(entry, sigDir, i, atrV, swings);
    const risk = Math.abs(entry - sl);
    if (!(risk > 0)) continue;
    if (sigDir === "buy" ? sl >= entry : sl <= entry) continue;
    const bull = sigDir === "buy";
    const tp1 = bull ? entry + 1.5 * risk : entry - 1.5 * risk;
    const tp2 = bull ? entry + 2.5 * risk : entry - 2.5 * risk;

    let exitR = null, exitJ = -1;
    for (let j = i + 1; j < Math.min(N, i + 201); j++) {
      const h = H[j], l = L[j];
      if (!num(h) || !num(l)) break;
      if (bull) {
        if (l <= sl) { exitR = -1; exitJ = j; break; }
        if (h >= tp2) { exitR = 2.5; exitJ = j; break; }
        if (h >= tp1) { exitR = 1.5; exitJ = j; break; }
      } else {
        if (h >= sl) { exitR = -1; exitJ = j; break; }
        if (l <= tp2) { exitR = 2.5; exitJ = j; break; }
        if (l <= tp1) { exitR = 1.5; exitJ = j; break; }
      }
    }
    if (exitR == null) continue;
    trades.push({ dir: sigDir, entry, sl, tp1, tp2, bar: i, time: T[i], conds: sigConds, r: exitR });
    for (const cc of sigConds) {
      condStats[cc].fired++;
      if (exitR > 0) condStats[cc].wins++;
    }
    i = exitJ;
  }

  // stats
  const rs = trades.map((t) => t.r);
  const wins = rs.filter((r) => r > 0).length;
  const avgR = rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
  let peak = 0, maxDD = 0, cum = 0;
  const equityFull = [0];
  for (const r of rs) {
    cum += r;
    equityFull.push(Math.round(cum * 100) / 100);
    if (cum > peak) peak = cum;
    maxDD = Math.max(maxDD, peak - cum);
  }
  // VIRTUALIZATION: downsample equity to ≤2000 points for the SVG
  const equity = downsample(equityFull, 2000);
  const perCondition = conditions.map((cd) => ({
    condition: cd, label: CONDITION_DEFS[cd] || cd,
    fired: condStats[cd].fired, wins: condStats[cd].wins,
    winRate: condStats[cd].fired ? Math.round((condStats[cd].wins / condStats[cd].fired) * 100) : null,
  }));
  const fmtT = (t) => new Date(t * 1000).toISOString().slice(0, 16).replace("T", " ");
  const lite = (t) => ({ dir: t.dir, entry: t.entry, r: t.r, conds: t.conds, time: fmtT(t.time) });
  return {
    trades: trades.length, wins,
    winRate: trades.length ? Math.round((wins / trades.length) * 100) : 0,
    avgR: Math.round(avgR * 100) / 100,
    maxDD: Math.round(maxDD * 100) / 100,
    equity, perCondition,
    sample: trades.slice(-50).map(lite),
    recentTrades: trades.slice(-500).reverse().map(lite), // client paginates 50/page
  };
}

function downsample(arr, maxPts) {
  if (arr.length <= maxPts) return arr;
  const out = [];
  const step = (arr.length - 1) / (maxPts - 1);
  for (let i = 0; i < maxPts; i++) out.push(arr[Math.round(i * step)]);
  return out;
}

/* ================= Message handler ================= */
self.onmessage = function (e) {
  const msg = e.data || {};
  if (msg.type !== "run") return;
  const id = msg.id;
  const t0 = Date.now();
  try {
    if (!M) throw new Error("methodology engine failed to load in worker");
    const b = msg.buf || {};
    const req = ["time", "open", "high", "low", "close", "volume"];
    for (const k of req) {
      if (!isF64(b[k])) throw new Error("bad candle buffers (need Float64Array)");
    }
    N = b.time.length;
    if (N < 120) throw new Error("not_enough_data: need at least 120 bars, got " + N);
    T = b.time; O = b.open; H = b.high; L = b.low; C = b.close; V = b.volume;
    const conditions = (msg.conditions || []).filter((c) => CONDITION_DEFS[c]);
    if (!conditions.length) throw new Error("need_conditions");
    const logic = msg.logic === "OR" ? "OR" : "AND";

    post = (pct, phase) => self.postMessage({ type: "progress", id, pct, phase });
    post(2, "indicators");
    const result = runBacktest(conditions, logic, (pct, phase) => {
      // map detect 0-100 -> 5-70, walk 0-100 -> 70-100
      const mapped = phase === "detect" ? 5 + Math.round(pct * 0.65) : 70 + Math.round(pct * 0.3);
      post(mapped, phase);
    });
    result.bars = N;
    result.ms = Date.now() - t0;
    self.postMessage({ type: "done", id, result });
  } catch (err) {
    self.postMessage({ type: "error", id, message: String((err && err.message) || err).slice(0, 300) });
  } finally {
    // release big buffers for the next run
    T = O = H = L = C = V = null; N = 0; post = null;
  }
};

// Expose pure pieces for the Node test harness (harmless in the real worker).
self.__BT = { taRSI, taATR, taSMA, taEMA, taMACD, taSwings, downsample, runBacktest: null };
