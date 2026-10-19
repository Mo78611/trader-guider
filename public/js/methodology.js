"use strict";
/* ============================================================================
 * Trader Guider — Methodology detection engine (pure math over OHLCV candles).
 * ----------------------------------------------------------------------------
 * Candle: {time (sec), open, high, low, close, volume}
 * Every function is pure, guarded against empty/bad input, and returns plain
 * data — no chart calls here. Rendering lives in method-ui.js.
 *
 * Implemented systems:
 *   ICT  — FVG, Order Blocks, Liquidity Sweeps, Killzones, Premium/Discount,
 *          Market Structure (BOS/CHoCH)
 *   SMC  — same primitives, different confluence emphasis (see signals.js)
 *   VSA  — Buying/Selling Climax, No Demand/Supply, Stopping Volume,
 *          Effort-vs-Result (Wyckoff/VSA volume anomalies)
 *   Price Action — swing-clustered S/R zones, engulfing & pin-bar setups
 *   Elliott Wave — RULES-BASED APPROXIMATION of impulse (1-2-3-4-5) + ABC:
 *          wave2 < 100% retrace of wave1, wave3 not the shortest,
 *          wave4 stays out of wave1 territory. Real Elliott needs analyst
 *          judgement; treat these labels as candidates, not gospel.
 *   Classical patterns — Head & Shoulders (+inverse), Double Top/Bottom,
 *          Rising/Falling Wedge, Bull/Bear Flag (fractal-geometry based).
 *
 * Guards: dead-market filter (ATR collapse), weekend/crypto gap detection so
 * a gap bar is never treated as a breakout.
 * ========================================================================== */
window.TGMethodology = (function () {
  "use strict";

  function okArr(c) { return Array.isArray(c) && c.length > 0; }
  function num(x) { return typeof x === "number" && isFinite(x); }

  /* ---------------- ATR (uses TGIndicators when available) ---------------- */
  function atrArray(candles, period) {
    try {
      if (window.TGIndicators && typeof window.TGIndicators.atr === "function")
        return window.TGIndicators.atr(candles, period);
    } catch (_e) { /* fall through to local */ }
    period = period || 14;
    const out = new Array(candles.length).fill(null);
    if (!okArr(candles) || candles.length < period + 1) return out;
    const trs = [0];
    for (let i = 1; i < candles.length; i++) {
      const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
      if (!num(h) || !num(l) || !num(pc)) { trs.push(0); continue; }
      trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    }
    let prev = 0;
    for (let i = 1; i <= period; i++) prev += trs[i];
    prev /= period;
    out[period] = prev;
    for (let i = period + 1; i < candles.length; i++) {
      prev = (prev * (period - 1) + trs[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  function smaArr(vals, period) {
    const out = new Array(vals.length).fill(null);
    if (!okArr(vals) || vals.length < period) return out;
    let sum = 0;
    for (let i = 0; i < vals.length; i++) {
      const v = num(vals[i]) ? vals[i] : 0;
      sum += v;
      if (i >= period) sum -= (num(vals[i - period]) ? vals[i - period] : 0);
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function emaArr(vals, period) {
    const out = new Array(vals.length).fill(null);
    if (!okArr(vals) || vals.length < period) return out;
    const k = 2 / (period + 1);
    let prev = 0;
    for (let i = 0; i < period; i++) prev += num(vals[i]) ? vals[i] : 0;
    prev /= period;
    out[period - 1] = prev;
    for (let i = period; i < vals.length; i++) {
      const v = num(vals[i]) ? vals[i] : prev;
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  function lastValid(arr) {
    if (!okArr(arr)) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (num(arr[i])) return arr[i];
    return null;
  }

  function linSlope(pts) {
    // least-squares slope of [{x,y}]
    const n = pts.length;
    if (n < 2) return NaN;
    let sx = 0, sy = 0, sxy = 0, sxx = 0;
    for (const p of pts) { sx += p.x; sy += p.y; sxy += p.x * p.y; sxx += p.x * p.x; }
    const den = n * sxx - sx * sx;
    if (!den) return NaN;
    return (n * sxy - sx * sy) / den;
  }

  /* ---------------- Fractal swing pivots ---------------- */
  function swings(candles, strength) {
    strength = strength || 3;
    const out = [];
    if (!okArr(candles) || candles.length < strength * 2 + 1) return out;
    for (let i = strength; i < candles.length - strength; i++) {
      const c = candles[i];
      if (!c || !num(c.high) || !num(c.low)) continue;
      let isHigh = true, isLow = true;
      for (let j = 1; j <= strength; j++) {
        const l = candles[i - j], r = candles[i + j];
        if (!l || !r || !num(l.high) || !num(r.high)) { isHigh = isLow = false; break; }
        if (l.high >= c.high || r.high >= c.high) isHigh = false;
        if (l.low <= c.low || r.low <= c.low) isLow = false;
        if (!isHigh && !isLow) break;
      }
      if (isHigh) out.push({ idx: i, time: c.time, price: c.high, type: "high" });
      else if (isLow) out.push({ idx: i, time: c.time, price: c.low, type: "low" });
    }
    return out;
  }

  /* ---------------- Market structure: BOS / CHoCH ---------------- */
  function marketStructure(candles, swingsArr) {
    const ev = [];
    if (!okArr(swingsArr)) return ev;
    let lastHigh = null, lastLow = null, trend = 0; // 1 bull, -1 bear
    for (const s of swingsArr) {
      const c = candles[s.idx];
      if (!c || !num(c.close)) continue;
      if (s.type === "high") {
        if (lastHigh && c.close > lastHigh.price) {
          ev.push({ idx: s.idx, time: s.time, price: s.price,
            type: trend === -1 ? "CHoCH" : "BOS", dir: "bull" });
          trend = 1;
        }
        lastHigh = s;
      } else {
        if (lastLow && c.close < lastLow.price) {
          ev.push({ idx: s.idx, time: s.time, price: s.price,
            type: trend === 1 ? "CHoCH" : "BOS", dir: "bear" });
          trend = -1;
        }
        lastLow = s;
      }
    }
    return ev;
  }

  /* ---------------- Fair Value Gaps ---------------- */
  function fvgs(candles, atrA, maxKeep) {
    const out = [];
    if (!okArr(candles) || candles.length < 3) return out;
    for (let i = 2; i < candles.length; i++) {
      const a = candles[i - 2], c = candles[i];
      if (!a || !c || !num(a.high) || !num(a.low) || !num(c.high) || !num(c.low)) continue;
      if (c.low > a.high) {
        out.push({ idx: i, time: c.time, top: c.low, bottom: a.high, dir: "bull", mitigated: -1 });
      } else if (c.high < a.low) {
        out.push({ idx: i, time: c.time, top: a.low, bottom: c.high, dir: "bear", mitigated: -1 });
      }
    }
    for (const g of out) {
      for (let j = g.idx + 1; j < candles.length; j++) {
        const c = candles[j];
        if (!c || !num(c.low) || !num(c.high)) continue;
        if (g.dir === "bull" && c.low <= g.bottom) { g.mitigated = j; break; }
        if (g.dir === "bear" && c.high >= g.top) { g.mitigated = j; break; }
      }
    }
    return out.filter((g) => g.mitigated < 0).slice(-(maxKeep || 10));
  }

  /* ---------------- Order Blocks ---------------- */
  function orderBlocks(candles, swingsArr, atrA, maxKeep) {
    const out = [];
    const n = candles.length;
    if (n < 10 || !okArr(atrA)) return out;
    for (let i = 5; i < n - 1; i++) {
      const c = candles[i];
      const atr = atrA[i];
      if (!c || !num(atr) || atr <= 0) continue;
      if (!num(c.open) || !num(c.close) || !num(c.high) || !num(c.low)) continue;
      const body = Math.abs(c.close - c.open);
      if (body < 1.5 * atr) continue; // displacement leg required
      const bull = c.close > c.open;
      // must break a nearby swing within a few bars
      let broke = false;
      for (const s of swingsArr) {
        if (s.idx < i - 10 || s.idx > i + 3) continue;
        const cc = candles[Math.min(s.idx + 3, n - 1)];
        if (!cc || !num(cc.close)) continue;
        if (bull && s.type === "high" && cc.close > s.price) { broke = true; break; }
        if (!bull && s.type === "low" && cc.close < s.price) { broke = true; break; }
      }
      if (!broke) continue;
      for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
        const pc = candles[j];
        if (!pc || !num(pc.open) || !num(pc.close)) continue;
        const opp = bull ? pc.close < pc.open : pc.close > pc.open;
        if (opp && num(pc.high) && num(pc.low)) {
          out.push({ idx: j, time: pc.time, top: pc.high, bottom: pc.low, dir: bull ? "bull" : "bear" });
          break;
        }
      }
    }
    // dedupe near-duplicates, keep recent
    const seen = [];
    for (const ob of out) {
      const dup = seen.some((s) => Math.abs(s.idx - ob.idx) < 4 && s.dir === ob.dir);
      if (!dup) seen.push(ob);
    }
    return seen.slice(-(maxKeep || 6));
  }

  /* ---------------- Liquidity sweeps ---------------- */
  function liquiditySweeps(candles, swingsArr, atrA, maxKeep) {
    const out = [];
    const n = candles.length;
    if (!okArr(swingsArr) || !okArr(atrA)) return out;
    for (const s of swingsArr) {
      const atr = atrA[s.idx];
      if (!num(atr) || atr <= 0) continue;
      const look = Math.min(n - 1, s.idx + 10);
      for (let j = s.idx + 1; j <= look; j++) {
        const c = candles[j];
        if (!c || !num(c.high) || !num(c.low) || !num(c.close)) continue;
        if (s.type === "high" && c.high > s.price + 0.2 * atr && c.close < s.price) {
          // buy-side liquidity raided, rejected lower → bearish
          out.push({ idx: j, time: c.time, price: c.high, dir: "bear", swept: s.price, kind: "buy-side" });
          break;
        }
        if (s.type === "low" && c.low < s.price - 0.2 * atr && c.close > s.price) {
          // sell-side liquidity raided, reclaimed higher → bullish
          out.push({ idx: j, time: c.time, price: c.low, dir: "bull", swept: s.price, kind: "sell-side" });
          break;
        }
      }
    }
    return out.slice(-(maxKeep || 8));
  }

  /* ---------------- Premium / Discount dealing range ---------------- */
  function premiumDiscount(candles, swingsArr, lookback) {
    lookback = lookback || 120;
    const n = candles.length;
    if (!okArr(swingsArr)) return null;
    const rel = swingsArr.filter((s) => s.idx >= n - lookback);
    const highs = rel.filter((s) => s.type === "high");
    const lows = rel.filter((s) => s.type === "low");
    if (!highs.length || !lows.length) return null;
    const rh = Math.max.apply(null, highs.map((s) => s.price));
    const rl = Math.min.apply(null, lows.map((s) => s.price));
    if (!(num(rh) && num(rl) && rh > rl)) return null;
    return { high: rh, low: rl, eq: (rh + rl) / 2 };
  }

  /* ---------------- Killzones (UTC sessions) ---------------- */
  const SESSIONS = [
    { name: "ASIA", start: 0, end: 3 },
    { name: "LONDON", start: 7, end: 10 },
    { name: "NEW YORK", start: 12, end: 15 },
  ];
  function killzones(candles) {
    const out = [];
    if (!okArr(candles)) return out;
    const seen = new Set();
    const cutoff = candles[candles.length - 1].time - 14 * 86400; // last ~14 days only
    for (const c of candles) {
      if (!num(c.time) || c.time < cutoff) continue;
      const d = new Date(c.time * 1000);
      const hr = d.getUTCHours() + d.getUTCMinutes() / 60;
      const day = Math.floor(c.time / 86400);
      for (const s of SESSIONS) {
        if (hr >= s.start && hr < s.start + 0.5) {
          const key = day + ":" + s.name;
          if (!seen.has(key)) { seen.add(key); out.push({ time: c.time, name: s.name }); }
        }
      }
    }
    return out.slice(-30);
  }

  /* ---------------- VSA / Wyckoff volume anomalies ---------------- */
  function vsaSignals(candles, atrA) {
    const out = [];
    const n = candles.length;
    if (n < 30 || !okArr(atrA)) return out;
    const vols = candles.map((c) => (num(c.volume) ? c.volume : 0));
    const vma = smaArr(vols, 20);
    const ema20 = emaArr(candles.map((c) => c.close), 20);
    for (let i = 20; i < n; i++) {
      const c = candles[i], atr = atrA[i], vm = vma[i];
      if (!c || !num(atr) || atr <= 0 || !num(vm) || vm <= 0) continue;
      if (!num(c.open) || !num(c.close) || !num(c.high) || !num(c.low)) continue;
      const spread = c.high - c.low;
      if (spread <= 0) continue;
      const body = Math.abs(c.close - c.open);
      const relVol = (num(c.volume) ? c.volume : 0) / vm;
      const up = c.close > c.open, down = c.close < c.open;
      const narrow = spread < 0.7 * atr;
      const tiny = spread < 0.5 * atr;
      const e = ema20[i];
      const uptrend = num(e) && c.close > e;
      const downtrend = num(e) && c.close < e;
      const rallied = i >= 25 && num(candles[i - 5].close) && c.close > candles[i - 5].close;
      const declined = i >= 25 && num(candles[i - 5].close) && c.close < candles[i - 5].close;
      const push = (type, label, dir) => out.push({ idx: i, time: c.time, type, label, dir });
      if (up && relVol > 2 && narrow && rallied) push("BC", "Buying Climax", "bear");
      else if (down && relVol > 2 && narrow && declined) push("SC", "Selling Climax", "bull");
      else if (up && relVol < 0.7 && narrow && uptrend) push("ND", "No Demand", "bear");
      else if (down && relVol < 0.7 && narrow && downtrend) push("NS", "No Supply", "bull");
      else if (down && relVol > 2 && body < 0.4 * spread && declined) push("STPV", "Stopping Volume", "bull");
      else if (relVol > 1.8 && tiny) push("EvR", "Effort vs Result", up ? "bear" : "bull");
    }
    return out.slice(-12);
  }

  /* ---------------- Price-action S/R zones (swing clusters) ---------------- */
  function srZones(candles, swingsArr, atrA) {
    const out = [];
    const atr = lastValid(atrA);
    if (!num(atr) || atr <= 0 || !okArr(swingsArr)) return out;
    const tol = 0.3 * atr;
    for (const dir of ["high", "low"]) {
      const pts = swingsArr.filter((s) => s.type === dir).map((s) => ({ price: s.price, idx: s.idx }));
      pts.sort((a, b) => a.price - b.price);
      const clusters = [];
      for (const p of pts) {
        const cl = clusters[clusters.length - 1];
        if (cl && p.price - cl.max <= tol) { cl.pts.push(p); if (p.price > cl.max) cl.max = p.price; }
        else clusters.push({ pts: [p], max: p.price });
      }
      for (const cl of clusters) {
        if (cl.pts.length < 2) continue;
        const prices = cl.pts.map((p) => p.price);
        const mid = prices.reduce((a, b) => a + b, 0) / prices.length;
        out.push({
          top: mid + tol / 2, bottom: mid - tol / 2,
          dir: dir === "high" ? "resistance" : "support",
          touches: cl.pts.length,
        });
      }
    }
    // most recent first
    return out.slice(-6);
  }

  /* Price-action candle setups at zones (display + signal use) */
  function paSetups(candles, zones, atrVal, lookback) {
    const out = [];
    const n = candles.length;
    if (!okArr(zones) || !num(atrVal) || atrVal <= 0 || n < 3) return out;
    const start = Math.max(1, n - (lookback || 30));
    for (let j = start; j < n; j++) {
      const c = candles[j], p = candles[j - 1];
      if (!c || !p || !num(c.open) || !num(c.close) || !num(p.open) || !num(p.close)) continue;
      const body = Math.abs(c.close - c.open);
      if (body <= 0) continue;
      const lowerWick = Math.min(c.open, c.close) - c.low;
      const upperWick = c.high - Math.max(c.open, c.close);
      const bullEng = p.close < p.open && c.close > c.open && c.close > p.open && c.open < p.close;
      const bearEng = p.close > p.open && c.close < c.open && c.close < p.open && c.open > p.close;
      const hammer = lowerWick > 2 * body && upperWick < body && body > 0.1 * atrVal;
      const shooter = upperWick > 2 * body && lowerWick < body && body > 0.1 * atrVal;
      const bull = bullEng || hammer, bear = bearEng || shooter;
      if (!bull && !bear) continue;
      const extreme = bull ? c.low : c.high;
      const zone = zones.find((z) =>
        (bull ? z.dir === "support" : z.dir === "resistance") &&
        extreme >= z.bottom - 0.3 * atrVal && extreme <= z.top + 0.3 * atrVal);
      if (!zone) continue;
      out.push({ idx: j, time: c.time, dir: bull ? "buy" : "sell",
        kind: bullEng || bearEng ? "engulfing" : "pin", zone });
    }
    return out;
  }

  /* ---------------- Auto trendlines (least-squares through swing pivots) ----
   * A valid trendline needs:
   *   - at least 3 swing pivots touching the line within 0.25×ATR,
   *   - the line to span at least 20 bars,
   *   - resistance = through swing HIGHS (descending or near-flat),
   *     support    = through swing LOWS  (ascending  or near-flat).
   * Returns [{type, slope, points:[{time,price}], touches, startIdx, endIdx}] */
  function trendlines(candles, swingsArr, atrA) {
    const out = [];
    const n = candles.length;
    const atr = lastValid(atrA);
    if (!num(atr) || atr <= 0 || !okArr(swingsArr) || n < 25) return out;
    const tol = 0.25 * atr;
    for (const mode of ["high", "low"]) {
      const pivs = swingsArr.filter((s) => s.type === mode && s.idx >= n - 90);
      if (pivs.length < 3) continue;
      // try fits: use the earliest pivot as anchor and extend
      for (let a = 0; a < pivs.length - 2; a++) {
        const subset = pivs.slice(a);
        const xs = subset.map((s) => s.idx);
        const ys = subset.map((s) => s.price);
        const slope = linSlope(subset.map((s) => ({ x: s.idx, y: s.price })));
        if (!num(slope)) continue;
        // direction sanity: resistance should not rise steeply, support should not fall steeply
        const perBar = atr / 40;
        if (mode === "high" && slope > perBar) continue;
        if (mode === "low" && slope < -perBar) continue;
        // count touches: |price - line(idx)| <= tol
        const x0 = xs[0], y0 = ys[0];
        let touches = 0;
        for (let k = 0; k < subset.length; k++) {
          const lineY = y0 + slope * (xs[k] - x0);
          if (Math.abs(ys[k] - lineY) <= tol) touches++;
        }
        const span = xs[xs.length - 1] - xs[0];
        if (touches >= 3 && span >= 20) {
          const t1 = candles[xs[0]].time, t2 = candles[xs[xs.length - 1]].time;
          const p1 = y0, p2 = y0 + slope * span;
          out.push({
            type: mode === "high" ? "resistance" : "support",
            slope,
            touches,
            startIdx: xs[0], endIdx: xs[xs.length - 1],
            points: [{ time: t1, price: p1 }, { time: t2, price: p2 }],
            // value of the line at the last bar (for signal math)
            lastValue: y0 + slope * ((n - 1) - xs[0]),
          });
          break; // one line per side is enough
        }
      }
    }
    return out;
  }

  /* ---------------- Classical chart patterns ---------------- */
  function spansGap(pivots, gaps) {
    if (!gaps || !gaps.size) return false;
    const first = pivots[0].idx, last = pivots[pivots.length - 1].idx;
    for (const g of gaps) if (g > first && g <= last) return true;
    return false;
  }

  function headShoulders(swingsArr, atrVal, gaps, maxKeep) {
    const out = [];
    if (!okArr(swingsArr) || !num(atrVal) || atrVal <= 0) return out;
    for (let k = 0; k + 6 < swingsArr.length; k++) {
      const w = swingsArr.slice(k, k + 7);
      const types = w.map((s) => s.type).join(",");
      const bearish = types === "low,high,low,high,low,high,low";
      const bullish = types === "high,low,high,low,high,low,high";
      if (!bearish && !bullish) continue;
      if (spansGap(w, gaps)) continue;
      const P = w.map((s) => s.price);
      // normalize: for bullish (inverse H&S) flip so "head" logic is identical
      const Q = bullish ? P.map((p) => -p) : P;
      const H1 = Q[1], H2 = Q[3], H3 = Q[5];
      if (!(H2 > H1 && H2 > H3)) continue;
      if (Math.abs(H1 - H3) > 0.35 * atrVal) continue; // shoulder symmetry
      if (H2 - Math.min(Q[2], Q[4]) < 1.0 * atrVal) continue; // meaningful size
      out.push({ type: bullish ? "ihs" : "hs", label: bullish ? "Inv. H&S" : "Head & Shoulders",
        dir: bullish ? "bull" : "bear", pivots: w, neckline: [w[2], w[4]] });
    }
    return out.slice(-(maxKeep || 2));
  }

  function doubleTopsBottoms(candles, swingsArr, atrVal, gaps, maxKeep) {
    const out = [];
    const n = candles.length;
    if (!okArr(swingsArr) || !num(atrVal) || atrVal <= 0) return out;
    for (const mode of ["top", "bottom"]) {
      const pivs = swingsArr.filter((s) => s.type === (mode === "top" ? "high" : "low"));
      for (let i = 0; i + 1 < pivs.length; i++) {
        const a = pivs[i], b = pivs[i + 1];
        if (b.idx - a.idx < 5) continue;
        if (Math.abs(a.price - b.price) > 0.3 * atrVal) continue;
        if (spansGap([a, b], gaps)) continue;
        const mid = swingsArr.find((s) =>
          s.type === (mode === "top" ? "low" : "high") && s.idx > a.idx && s.idx < b.idx);
        if (!mid) continue;
        let confirmed = -1;
        for (let j = b.idx + 1; j < Math.min(n, b.idx + 12); j++) {
          const c = candles[j];
          if (!c || !num(c.close)) continue;
          if (mode === "top" && c.close < mid.price) { confirmed = j; break; }
          if (mode === "bottom" && c.close > mid.price) { confirmed = j; break; }
        }
        out.push({ type: mode === "top" ? "dt" : "db",
          label: mode === "top" ? "Double Top" : "Double Bottom",
          dir: mode === "top" ? "bear" : "bull",
          pivots: [a, mid, b], neck: mid.price, confirmed });
      }
    }
    return out.slice(-(maxKeep || 3));
  }

  function wedges(candles, swingsArr, atrVal) {
    const out = [];
    const n = candles.length;
    if (!okArr(swingsArr) || !num(atrVal) || atrVal <= 0) return out;
    const win = Math.min(60, n);
    const rel = swingsArr.filter((s) => s.idx >= n - win);
    const highs = rel.filter((s) => s.type === "high");
    const lows = rel.filter((s) => s.type === "low");
    if (highs.length < 2 || lows.length < 2) return out;
    const sH = linSlope(highs.map((s) => ({ x: s.idx, y: s.price })));
    const sL = linSlope(lows.map((s) => ({ x: s.idx, y: s.price })));
    if (!num(sH) || !num(sL)) return out;
    const perBar = atrVal / 50; // slope significance threshold
    if (sH < -perBar && sH < sL) {
      out.push({ type: "wedge", label: "Falling Wedge", dir: "bull", highs, lows });
    } else if (sL > perBar && sH > 0 && sH < sL) {
      out.push({ type: "wedge", label: "Rising Wedge", dir: "bear", highs, lows });
    }
    return out;
  }

  function flags(candles, atrVal) {
    const out = [];
    const n = candles.length;
    if (n < 30 || !num(atrVal) || atrVal <= 0) return out;
    for (let i = Math.max(0, n - 45); i < n - 20; i++) {
      for (let poleLen = 5; poleLen <= 10; poleLen++) {
        const pe = i + poleLen;
        if (pe + 6 >= n) continue;
        const a = candles[i], b = candles[pe];
        if (!a || !b || !num(a.close) || !num(b.close)) continue;
        const move = b.close - a.close;
        if (Math.abs(move) < 2.5 * atrVal) continue;
        const bull = move > 0;
        for (let cl = 5; cl <= 14 && pe + cl < n; cl++) {
          const seg = candles.slice(pe + 1, pe + 1 + cl);
          if (seg.some((c) => !c || !num(c.high) || !num(c.low) || !num(c.close))) continue;
          const hi = Math.max.apply(null, seg.map((c) => c.high));
          const lo = Math.min.apply(null, seg.map((c) => c.low));
          if (hi - lo > 1.2 * atrVal) continue; // too wide for a flag
          const slope = linSlope(seg.map((c, k) => ({ x: k, y: c.close })));
          if (!num(slope)) continue;
          const driftOk = bull ? slope <= atrVal / 200 : slope >= -atrVal / 200;
          if (!driftOk) continue;
          out.push({ type: "flag", label: bull ? "Bull Flag" : "Bear Flag", dir: bull ? "bull" : "bear",
            pole: [a, b], flag: seg });
          i = n; // one flag max per scan; keep it simple
          break;
        }
      }
    }
    return out.slice(-1);
  }

  function classicalPatterns(candles, swingsArr, atrVal, gaps) {
    return {
      hs: headShoulders(swingsArr, atrVal, gaps, 2),
      dbl: doubleTopsBottoms(candles, swingsArr, atrVal, gaps, 3),
      wedge: wedges(candles, swingsArr, atrVal),
      flag: flags(candles, atrVal),
    };
  }

  /* ---------------- Elliott Wave (rules-based approximation) ---------------- */
  function elliott(candles, swingsArr, atrVal, gaps) {
    const out = [];
    if (!okArr(swingsArr) || !num(atrVal) || atrVal <= 0) return out;
    function scan(bearish) {
      const found = [];
      const want = bearish
        ? "high,low,high,low,high,low,high,low,high"
        : "low,high,low,high,low,high,low,high,low";
      for (let k = 0; k + 8 < swingsArr.length; k++) {
        const w = swingsArr.slice(k, k + 9);
        if (w.map((s) => s.type).join(",") !== want) continue;
        if (spansGap(w, gaps)) continue;
        const P = w.map((s) => bearish ? -s.price : s.price);
        const L0 = P[0], H1 = P[1], L1 = P[2], H2 = P[3], L2 = P[4], H3 = P[5];
        const len1 = H1 - L0, len3 = H2 - L1, len5 = H3 - L2;
        if (len1 < 0.5 * atrVal || len3 < 0.5 * atrVal || len5 < 0.5 * atrVal) continue;
        if (!(L1 > L0)) continue;                    // wave 2 retraces < 100% of wave 1
        if (len3 < Math.min(len1, len5) * 0.85) continue; // wave 3 not the shortest
        if (!(L2 > H1)) continue;                    // wave 4 outside wave 1 territory
        // A-B-C correction: next 3 pivots after the impulse top
        let corr = null;
        const rest = swingsArr.slice(k + 9, k + 12);
        if (rest.length === 3) {
          const rt = rest.map((s) => s.type).join(",");
          const wantC = bearish ? "low,high,low" : "high,low,high";
          if (rt === wantC) corr = rest;
        }
        found.push({ pivots: w, corr, bearish });
      }
      return found.slice(-1);
    }
    for (const f of scan(false).concat(scan(true))) {
      const labels = [];
      const names = ["1", "2", "3", "4", "5"];
      const wavePivots = [f.pivots[1], f.pivots[2], f.pivots[3], f.pivots[4], f.pivots[5]];
      wavePivots.forEach((p, i) => labels.push({ idx: p.idx, time: p.time, price: p.price, label: names[i] }));
      if (f.corr) {
        ["A", "B", "C"].forEach((nm, i) => {
          const p = f.corr[i];
          labels.push({ idx: p.idx, time: p.time, price: p.price, label: nm });
        });
      }
      out.push({ bearish: f.bearish, labels,
        dir: f.bearish ? "bear" : "bull",
        startIdx: f.pivots[0].idx, endIdx: f.pivots[5].idx });
    }
    return out.slice(-2);
  }

  /* ---------------- Guards: dead market + time gaps ---------------- */
  function deadMarket(candles) {
    if (!okArr(candles) || candles.length < 60) return false;
    const a = atrArray(candles, 14).filter((v) => num(v));
    if (a.length < 50) return false;
    const recent = a.slice(-50);
    const mean = recent.reduce((x, y) => x + y, 0) / recent.length;
    return a[a.length - 1] < 0.3 * mean;
  }

  function timeGaps(candles, tfSec) {
    const gaps = new Set();
    if (!okArr(candles) || candles.length < 3) return gaps;
    const deltas = [];
    for (let i = 1; i < candles.length; i++) {
      const d = candles[i].time - candles[i - 1].time;
      if (num(d) && d > 0) deltas.push(d);
    }
    if (!deltas.length) return gaps;
    const sorted = deltas.slice().sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)] || tfSec || 3600;
    const thresh = Math.max(2.5 * med, 2 * (tfSec || 0));
    for (let i = 1; i < candles.length; i++) {
      if (num(candles[i].time) && num(candles[i - 1].time) &&
          candles[i].time - candles[i - 1].time > thresh) gaps.add(i);
    }
    return gaps;
  }

  /* ---------------- One-shot analysis (convenience) ---------------- */
  function analyze(candles, opts) {
    opts = opts || {};
    const atrA = atrArray(candles, 14);
    const atrVal = lastValid(atrA);
    const sw = swings(candles, opts.strength || 3);
    const gaps = timeGaps(candles, opts.tfSec || 3600);
    return {
      candles, atr: atrA, atrVal, swings: sw, gaps,
      dead: deadMarket(candles),
      structure: marketStructure(candles, sw),
      fvgs: fvgs(candles, atrA, 10),
      obs: orderBlocks(candles, sw, atrA, 6),
      sweeps: liquiditySweeps(candles, sw, atrA, 8),
      pd: premiumDiscount(candles, sw, 120),
      killzones: killzones(candles),
      vsa: vsaSignals(candles, atrA),
      srZones: srZones(candles, sw, atrA),
      paSetups: null, // filled below (needs srZones)
      patterns: classicalPatterns(candles, sw, atrVal, gaps),
      elliott: elliott(candles, sw, atrVal, gaps),
      trendlines: trendlines(candles, sw, atrA),
    };
  }

  // paSetups needs srZones — wire after analyze builds zones
  const _analyze = analyze;
  analyze = function (candles, opts) {
    const ctx = _analyze(candles, opts);
    try {
      ctx.paSetups = paSetups(candles, ctx.srZones, ctx.atrVal, 30);
    } catch (_e) { ctx.paSetups = []; }
    return ctx;
  };

  return {
    atr: atrArray, lastValid, sma: smaArr, ema: emaArr,
    swings, marketStructure, fvgs, orderBlocks, liquiditySweeps,
    premiumDiscount, killzones, vsaSignals, srZones, paSetups, trendlines,
    headShoulders, doubleTopsBottoms, wedges, flags, classicalPatterns,
    elliott, deadMarket, timeGaps, analyze,
  };
})();
