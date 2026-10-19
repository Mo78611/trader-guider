/* ============================================================================
 * TGAutoDraw — Elite Auto-Drawing Engine: "Chart Patterns + Trendlines + S/R"
 * 100% automated. Zero manual drawing. Strict fractal/pivot math.
 *
 * Pipeline per render:
 *   candles -> ATR -> fractal pivots -> trendlines (touch-validated)
 *           -> S/R zones (ATR-clustered) -> classical patterns
 *           -> breakout scan -> on-chart commentary overlay
 *
 * Rendered through method-ui's rc (line/marker) + a live HTML overlay
 * positioned via chart.timeScale().timeToCoordinate() /
 * candleSeries.priceToCoordinate() — floats near the live candle.
 * ========================================================================== */
window.TGAutoDraw = (function () {
  "use strict";

  /* ================= MATH CORE ================= */

  function num(x) { return typeof x === "number" && isFinite(x); }

  function calcATR(candles, p) {
    p = p || 14;
    if (candles.length < p + 1) return 0;
    let sum = 0;
    for (let i = candles.length - p; i < candles.length; i++) {
      const c = candles[i], pc = candles[i - 1];
      const tr = Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
      sum += tr;
    }
    return sum / p;
  }

  /* Strict N-bar fractal pivots.
   * Pivot high at i: high[i] is the unique max of highs[i-N..i+N].
   * Pivot low at i:  low[i]  is the unique min of lows[i-N..i+N].
   * N=2 (5-bar) default — strict enough to kill noise, loose enough for 1h/15m. */
  function findPivots(candles, N) {
    N = N || 2;
    const out = [];
    for (let i = N; i < candles.length - N; i++) {
      let isH = true, isL = true;
      const h = candles[i].high, l = candles[i].low;
      for (let k = i - N; k <= i + N; k++) {
        if (k === i) continue;
        if (candles[k].high > h) { isH = false; }
        if (candles[k].low < l) { isL = false; }
        if (!isH && !isL) break;
      }
      // strict: must be strictly greater/less than immediate neighbours
      if (isH && h > candles[i - 1].high && h > candles[i + 1].high)
        out.push({ idx: i, time: candles[i].time, price: h, type: "high" });
      else if (isL && l < candles[i - 1].low && l < candles[i + 1].low)
        out.push({ idx: i, time: candles[i].time, price: l, type: "low" });
    }
    return out;
  }

  function lineValue(p1, p2, idx) {
    // p1, p2: {idx, price} — linear interpolation/extrapolation
    if (p2.idx === p1.idx) return p1.price;
    const slope = (p2.price - p1.price) / (p2.idx - p1.idx);
    return p1.price + slope * (idx - p1.idx);
  }

  /* Trendlines: every pivot pair of same type -> candidate line.
   * Validation: >=3 touches (wick within 0.25*ATR of the line),
   * min length 15 bars, no excessive piercing (max 2 closes through the line).
   * Keeps the top 3 per side by (touches, length) score. */
  function buildTrendlines(candles, pivots, atrVal) {
    const out = [];
    if (!(atrVal > 0)) return out;
    const tol = 0.25 * atrVal;
    for (const side of ["high", "low"]) {
      const ps = pivots.filter((p) => p.type === side);
      const cands = [];
      for (let a = 0; a < ps.length; a++) {
        for (let b = a + 1; b < ps.length; b++) {
          const p1 = ps[a], p2 = ps[b];
          const len = p2.idx - p1.idx;
          if (len < 15 || len > 250) continue;
          let touches = 0, pierces = 0;
          for (let i = p1.idx; i <= Math.min(p2.idx + 10, candles.length - 1); i++) {
            const lv = lineValue(p1, p2, i);
            const wick = side === "high" ? candles[i].high : candles[i].low;
            const close = candles[i].close;
            if (Math.abs(wick - lv) <= tol) touches++;
            // a close through the line = pierce (invalidates)
            if (side === "high" ? close > lv + tol : close < lv - tol) pierces++;
            if (pierces > 2) break;
          }
          if (touches >= 3 && pierces <= 2) {
            const slope = (p2.price - p1.price) / len;
            cands.push({ p1, p2, touches, len, slope, pierces,
              type: side === "high" ? "resistance" : "support",
              score: touches * 10 + len * 0.1 - pierces * 5 });
          }
        }
      }
      cands.sort((x, y) => y.score - x.score);
      // de-dupe: drop lines nearly identical to a better one
      const kept = [];
      for (const c of cands) {
        let dup = false;
        for (const k of kept) {
          const mid = Math.floor((c.p1.idx + c.p2.idx) / 2);
          if (Math.abs(lineValue(c.p1, c.p2, mid) - lineValue(k.p1, k.p2, mid)) < 0.5 * atrVal) { dup = true; break; }
        }
        if (!dup) kept.push(c);
        if (kept.length >= 3) break;
      }
      out.push(...kept);
    }
    return out;
  }

  /* S/R zones: cluster pivot prices within 0.5*ATR.
   * Zone = [min, max] of cluster; strength = touches + recency weight. */
  function buildZones(pivots, atrVal, lastIdx) {
    const out = [];
    if (!(atrVal > 0) || !pivots.length) return out;
    const band = 0.5 * atrVal;
    for (const side of ["high", "low"]) {
      const ps = pivots.filter((p) => p.type === side).sort((a, b) => a.price - b.price);
      const clusters = [];
      for (const p of ps) {
        const c = clusters[clusters.length - 1];
        if (c && p.price - c.max <= band) {
          c.max = Math.max(c.max, p.price); c.min = Math.min(c.min, p.price);
          c.pivots.push(p);
        } else {
          clusters.push({ min: p.price, max: p.price, pivots: [p] });
        }
      }
      for (const c of clusters) {
        if (c.pivots.length < 2) continue;
        const recency = c.pivots[c.pivots.length - 1].idx;
        const ageBars = lastIdx - recency;
        if (ageBars > 200) continue; // stale zones die
        const strength = c.pivots.length * 10 + Math.max(0, 20 - ageBars * 0.1);
        out.push({
          top: c.max + 0.1 * atrVal, bottom: Math.max(0, c.min - 0.1 * atrVal),
          dir: side === "high" ? "resistance" : "support",
          touches: c.pivots.length, strength,
          mid: (c.max + c.min) / 2, lastTouch: recency,
        });
      }
    }
    out.sort((a, b) => b.strength - a.strength);
    return out.slice(0, 6);
  }

  /* ================= CLASSICAL PATTERNS =================
   * All patterns are built from the fractal pivot sequence — no eyeballing.
   * Each returns {name, dir, pivots, neckline, target, confidence, label}. */

  function detectTriangles(candles, pivots, atrVal) {
    const out = [];
    if (!(atrVal > 0)) return out;
    const highs = pivots.filter((p) => p.type === "high");
    const lows = pivots.filter((p) => p.type === "low");
    // need >= 2 upper pivots + >= 2 lower pivots, alternating, within 120 bars
    for (let hi = 0; hi + 1 < highs.length; hi++) {
      for (let lo = 0; lo + 1 < lows.length; lo++) {
        const uh1 = highs[hi], uh2 = highs[hi + 1];
        const ll1 = lows[lo], ll2 = lows[lo + 1];
        const start = Math.min(uh1.idx, ll1.idx), end = Math.max(uh2.idx, ll2.idx);
        if (end - start > 150 || end - start < 25) continue;
        // must interleave in time
        const seq = [uh1, ll1, uh2, ll2].sort((a, b) => a.idx - b.idx);
        if (!(seq[0] === uh1 || seq[0] === ll1)) continue;
        const upSlope = (uh2.price - uh1.price) / (uh2.idx - uh1.idx);
        const loSlope = (ll2.price - ll1.price) / (ll2.idx - ll1.idx);
        // "flat" = total drift across the pivot span < 0.4*ATR (strict horizontal)
        const upFlat = Math.abs(uh2.price - uh1.price) < 0.4 * atrVal;
        const loFlat = Math.abs(ll2.price - ll1.price) < 0.4 * atrVal;
        // converging?
        const wStart = lineValue(uh1, uh2, start) - lineValue(ll1, ll2, start);
        const wEnd = lineValue(uh1, uh2, end) - lineValue(ll1, ll2, end);
        if (!(wEnd > 0 && wEnd < wStart * 0.75)) continue;
        let name = null, dir = null;
        if (upFlat && loSlope > 0) { name = "Ascending Triangle"; dir = "bull"; }
        else if (loFlat && upSlope < 0) { name = "Descending Triangle"; dir = "bear"; }
        else if (upSlope < 0 && loSlope > 0) { name = "Symmetrical Triangle"; dir = "both"; }
        else continue;
        // apex projection
        const apexIdx = end + Math.round(wEnd / Math.max(1e-9, (wStart - wEnd) / Math.max(1, end - start)));
        const height = wStart;
        out.push({ name, dir, kind: "triangle",
          upper: [uh1, uh2], lower: [ll1, ll2],
          startIdx: start, endIdx: end, apexIdx,
          target: dir === "bull" ? uh1.price + height : dir === "bear" ? ll1.price - height : null,
          height, confidence: 72,
          label: name.toUpperCase() });
      }
    }
    return out.slice(0, 3);
  }

  function detectWedges(candles, pivots, atrVal) {
    const out = [];
    if (!(atrVal > 0)) return out;
    const highs = pivots.filter((p) => p.type === "high");
    const lows = pivots.filter((p) => p.type === "low");
    for (let hi = 0; hi + 1 < highs.length; hi++) {
      for (let lo = 0; lo + 1 < lows.length; lo++) {
        const uh1 = highs[hi], uh2 = highs[hi + 1];
        const ll1 = lows[lo], ll2 = lows[lo + 1];
        const start = Math.min(uh1.idx, ll1.idx), end = Math.max(uh2.idx, ll2.idx);
        if (end - start > 150 || end - start < 25) continue;
        const upSlope = (uh2.price - uh1.price) / (uh2.idx - uh1.idx);
        const loSlope = (ll2.price - ll1.price) / (ll2.idx - ll1.idx);
        const sameDir = (upSlope > 0 && loSlope > 0) || (upSlope < 0 && loSlope < 0);
        if (!sameDir) continue;
        const wStart = lineValue(uh1, uh2, start) - lineValue(ll1, ll2, start);
        const wEnd = lineValue(uh1, uh2, end) - lineValue(ll1, ll2, end);
        if (!(wEnd > 0 && wEnd < wStart * 0.7)) continue; // converging
        const rising = upSlope > 0;
        out.push({ name: rising ? "Rising Wedge" : "Falling Wedge",
          dir: rising ? "bear" : "bull", kind: "wedge",
          upper: [uh1, uh2], lower: [ll1, ll2],
          startIdx: start, endIdx: end,
          target: rising ? ll1.price - wStart : uh1.price + wStart,
          height: wStart, confidence: 70,
          label: (rising ? "RISING WEDGE" : "FALLING WEDGE") });
      }
    }
    return out.slice(0, 3);
  }

  function detectHeadShoulders(pivots, atrVal) {
    const out = [];
    if (!(atrVal > 0)) return out;
    const tol = 0.35 * atrVal;
    // need 3 highs (L, H, R) separated by 2 lows (neckline points)
    const highs = pivots.filter((p) => p.type === "high");
    const lows = pivots.filter((p) => p.type === "low");
    // bullish = inverse H&S on lows; bearish = H&S on highs
    function scan(peaks, valleys, bull) {
      for (let i = 0; i + 2 < peaks.length; i++) {
        const L = peaks[i], H = peaks[i + 1], R = peaks[i + 2];
        // valleys between them
        const v1 = valleys.find((v) => v.idx > L.idx && v.idx < H.idx);
        const v2 = valleys.find((v) => v.idx > H.idx && v.idx < R.idx);
        if (!v1 || !v2) continue;
        if (H.idx - L.idx > 80 || R.idx - H.idx > 80) continue;
        const headTaller = bull ? H.price < L.price - tol && H.price < R.price - tol
                                : H.price > L.price + tol && H.price > R.price + tol;
        if (!headTaller) continue;
        const shouldersSym = Math.abs(L.price - R.price) <= tol * 1.5;
        if (!shouldersSym) continue;
        const neck = (v1.price + v2.price) / 2;
        const height = Math.abs(H.price - neck);
        if (height < atrVal * 0.8) continue;
        const last = R;
        out.push({ name: bull ? "Inverse Head & Shoulders" : "Head & Shoulders",
          dir: bull ? "bull" : "bear", kind: "hs",
          upper: null, lower: null,
          neckline: { p1: v1, p2: v2, price: neck },
          startIdx: L.idx, endIdx: R.idx,
          target: bull ? neck + height : neck - height,
          height, confidence: 78,
          label: bull ? "INV H&S" : "H&S",
          headIdx: H.idx, headPrice: H.price });
      }
    }
    scan(highs, lows, false);
    scan(lows, highs, true);
    return out.slice(0, 2);
  }

  function detectDouble(candles, pivots, atrVal) {
    const out = [];
    if (!(atrVal > 0)) return out;
    const tol = 0.3 * atrVal;
    for (const side of ["high", "low"]) {
      const ps = pivots.filter((p) => p.type === side);
      for (let i = 0; i + 1 < ps.length; i++) {
        const a = ps[i], b = ps[i + 1];
        const sep = b.idx - a.idx;
        if (sep < 10 || sep > 100) continue;
        if (Math.abs(a.price - b.price) > tol) continue;
        // valley/peak between them must retrace >= 0.5*ATR
        let extreme = side === "high" ? Infinity : -Infinity;
        for (let k = a.idx + 1; k < b.idx; k++) {
          if (side === "high") extreme = Math.min(extreme, candles[k].low);
          else extreme = Math.max(extreme, candles[k].high);
        }
        const depth = Math.abs(a.price - extreme);
        if (depth < 0.5 * atrVal) continue;
        const bull = side === "low";
        out.push({ name: bull ? "Double Bottom" : "Double Top",
          dir: bull ? "bull" : "bear", kind: "double",
          startIdx: a.idx, endIdx: b.idx,
          neckline: { price: extreme },
          target: bull ? b.price + depth : b.price - depth,
          height: depth, confidence: 68,
          label: bull ? "DOUBLE BOTTOM" : "DOUBLE TOP" });
      }
    }
    return out.slice(0, 2);
  }

  function detectPatterns(candles, pivots, atrVal) {
    const all = [
      ...detectTriangles(candles, pivots, atrVal),
      ...detectWedges(candles, pivots, atrVal),
      ...detectHeadShoulders(pivots, atrVal),
      ...detectDouble(candles, pivots, atrVal),
    ];
    // prefer recent + higher confidence
    const lastIdx = candles.length - 1;
    all.sort((a, b) => (b.confidence - Math.max(0, (lastIdx - b.endIdx)) * 0.05) -
                       (a.confidence - Math.max(0, (lastIdx - a.endIdx)) * 0.05));
    return all.slice(0, 4);
  }

  /* ================= BREAKOUTS + TRADE MATH =================
   * Breakout: last CLOSED bar closes beyond a trendline/zone/pattern boundary
   * by more than 0.15*ATR (filters wick fakeouts). Entry = close of breakout
   * bar. SL = beyond the broken level by 0.3*ATR. TP = measured move (pattern
   * height) else 2R. */

  function detectBreakouts(candles, trendlines, zones, patterns, atrVal) {
    const out = [];
    if (!(atrVal > 0) || candles.length < 3) return out;
    const n = candles.length;
    const last = candles[n - 1], prev = candles[n - 2];
    const buf = 0.15 * atrVal;

    function plan(dir, entry, refPrice, label, kind) {
      const sl = dir === "bull" ? refPrice - 0.3 * atrVal : refPrice + 0.3 * atrVal;
      if (dir === "bull" ? sl >= entry : sl <= entry) return null;
      const risk = Math.abs(entry - sl);
      return { type: "breakout", kind, dir, label,
        entry, sl, tp1: dir === "bull" ? entry + risk : entry - risk,
        tp2: dir === "bull" ? entry + 2 * risk : entry - 2 * risk,
        risk, time: last.time, barIdx: n - 1, fresh: true };
    }

    // --- trendline breaks (check last 3 closed bars for freshness) ---
    for (const tl of trendlines) {
      for (let b = n - 3; b < n; b++) {
        if (b < 0) continue;
        const c = candles[b];
        const lv = lineValue(tl.p1, tl.p2, b);
        const pc = candles[b - 1] ? candles[b - 1].close : c.close;
        if (tl.type === "resistance" && c.close > lv + buf && pc <= lineValue(tl.p1, tl.p2, b - 1) + buf) {
          const p = plan("bull", c.close, lv, `⚡ BREAKOUT: resistance trendline ×${tl.touches}`, "trendline");
          if (p) { p.barIdx = b; p.fresh = b === n - 1; out.push(p); }
        } else if (tl.type === "support" && c.close < lv - buf && pc >= lineValue(tl.p1, tl.p2, b - 1) - buf) {
          const p = plan("bear", c.close, lv, `⚡ BREAKOUT: support trendline ×${tl.touches}`, "trendline");
          if (p) { p.barIdx = b; p.fresh = b === n - 1; out.push(p); }
        }
      }
    }

    // --- S/R zone breaks ---
    for (const z of zones) {
      for (let b = n - 3; b < n; b++) {
        if (b < 0) continue;
        const c = candles[b], pc = candles[b - 1] ? candles[b - 1].close : c.close;
        if (z.dir === "resistance" && c.close > z.top + buf && pc <= z.top + buf) {
          const p = plan("bull", c.close, z.top, `⚡ BREAKOUT: resistance zone ×${z.touches}`, "zone");
          if (p) { p.barIdx = b; p.fresh = b === n - 1; out.push(p); }
        } else if (z.dir === "support" && c.close < z.bottom - buf && pc >= z.bottom - buf) {
          const p = plan("bear", c.close, z.bottom, `⚡ BREAKOUT: support zone ×${z.touches}`, "zone");
          if (p) { p.barIdx = b; p.fresh = b === n - 1; out.push(p); }
        }
      }
    }

    // --- pattern breakouts (neckline / boundary) with measured-move TP ---
    for (const pt of patterns) {
      if (pt.kind === "hs" && pt.neckline) {
        const nl = pt.neckline.price;
        const broke = pt.dir === "bull" ? last.close > nl + buf : last.close < nl - buf;
        const wasIn = pt.dir === "bull" ? prev.close <= nl + buf : prev.close >= nl - buf;
        if (broke && wasIn) {
          const entry = last.close;
          const sl = pt.dir === "bull" ? nl - 0.3 * atrVal : nl + 0.3 * atrVal;
          const risk = Math.abs(entry - sl);
          out.push({ type: "breakout", kind: "pattern", dir: pt.dir,
            label: `⚡ ${pt.name.toUpperCase()} BREAKOUT`,
            entry, sl, tp1: pt.target,
            tp2: pt.dir === "bull" ? entry + 2 * risk : entry - 2 * risk,
            risk, time: last.time, barIdx: n - 1, fresh: true, pattern: pt.name });
        }
      } else if ((pt.kind === "triangle" || pt.kind === "wedge") && pt.upper) {
        const bIdx = n - 1;
        const upV = lineValue(pt.upper[0], pt.upper[1], bIdx);
        const loV = lineValue(pt.lower[0], pt.lower[1], bIdx);
        const upPrev = lineValue(pt.upper[0], pt.upper[1], bIdx - 1);
        const loPrev = lineValue(pt.lower[0], pt.lower[1], bIdx - 1);
        if (last.close > upV + buf && prev.close <= upPrev + buf) {
          const p = plan("bull", last.close, upV, `⚡ ${pt.label} BREAKOUT ↑`, "pattern");
          if (p) { if (pt.target) p.tp1 = pt.target; p.pattern = pt.name; out.push(p); }
        } else if (last.close < loV - buf && prev.close >= loPrev - buf) {
          const p = plan("bear", last.close, loV, `⚡ ${pt.label} BREAKOUT ↓`, "pattern");
          if (p) { if (pt.target) p.tp1 = pt.target; p.pattern = pt.name; out.push(p); }
        }
      } else if (pt.kind === "double" && pt.neckline) {
        const nl = pt.neckline.price;
        const broke = pt.dir === "bull" ? last.close > nl + buf : last.close < nl - buf;
        const wasIn = pt.dir === "bull" ? prev.close <= nl + buf : prev.close >= nl - buf;
        if (broke && wasIn) {
          const entry = last.close;
          const sl = pt.dir === "bull" ? nl - 0.3 * atrVal : nl + 0.3 * atrVal;
          const risk = Math.abs(entry - sl);
          out.push({ type: "breakout", kind: "pattern", dir: pt.dir,
            label: `⚡ ${pt.label} BREAKOUT`,
            entry, sl, tp1: pt.target,
            tp2: pt.dir === "bull" ? entry + 2 * risk : entry - 2 * risk,
            risk, time: last.time, barIdx: n - 1, fresh: true, pattern: pt.name });
        }
      }
    }

    // newest first, dedupe same-bar same-dir
    out.sort((a, b) => b.barIdx - a.barIdx);
    const seenB = new Set();
    return out.filter((b) => {
      const k = b.barIdx + ":" + b.dir;
      if (seenB.has(k)) return false;
      seenB.add(k); return true;
    }).slice(0, 4);
  }

  /* Retest taps: price wicked into a zone/trendline and closed back —
   * shown in commentary as "↩ RETEST HELD". */
  function detectTaps(candles, trendlines, zones, atrVal) {
    const out = [];
    if (!(atrVal > 0) || candles.length < 2) return out;
    const n = candles.length, last = candles[n - 1];
    const tol = 0.2 * atrVal;
    for (const tl of trendlines) {
      const lv = lineValue(tl.p1, tl.p2, n - 1);
      if (tl.type === "support" && last.low <= lv + tol && last.close > lv + tol &&
          last.close > last.open && (Math.min(last.open, last.close) - last.low) > 0.3 * atrVal) {
        out.push({ type: "tap", dir: "bull", label: `↩ SUPPORT TL TAP ×${tl.touches}`, price: lv, time: last.time, barIdx: n - 1 });
      } else if (tl.type === "resistance" && last.high >= lv - tol && last.close < lv - tol &&
          last.close < last.open && (last.high - Math.max(last.open, last.close)) > 0.3 * atrVal) {
        out.push({ type: "tap", dir: "bear", label: `↩ RESISTANCE TL REJECT ×${tl.touches}`, price: lv, time: last.time, barIdx: n - 1 });
      }
    }
    for (const z of zones.slice(0, 4)) {
      if (z.dir === "support" && last.low <= z.top && last.close > z.top &&
          (Math.min(last.open, last.close) - last.low) > 0.25 * atrVal) {
        out.push({ type: "tap", dir: "bull", label: `↩ SUPPORT ZONE TAP ×${z.touches}`, price: z.mid, time: last.time, barIdx: n - 1 });
      } else if (z.dir === "resistance" && last.high >= z.bottom && last.close < z.bottom &&
          (last.high - Math.max(last.open, last.close)) > 0.25 * atrVal) {
        out.push({ type: "tap", dir: "bear", label: `↩ RESISTANCE ZONE REJECT ×${z.touches}`, price: z.mid, time: last.time, barIdx: n - 1 });
      }
    }
    return out.slice(0, 3);
  }

  /* ================= MASTER ANALYZE ================= */
  function analyze(candles) {
    if (!candles || candles.length < 60) return null;
    const atrVal = calcATR(candles, 14);
    const pivots = findPivots(candles, 2);
    const trendlines = buildTrendlines(candles, pivots, atrVal);
    const zones = buildZones(pivots, atrVal, candles.length - 1);
    const patterns = detectPatterns(candles, pivots, atrVal);
    const breakouts = detectBreakouts(candles, trendlines, zones, patterns, atrVal);
    const taps = detectTaps(candles, trendlines, zones, atrVal);
    const out = { atr: atrVal, pivots, trendlines, zones, patterns, breakouts, taps, n: candles.length };
    out._candles = candles; // for marker anchoring in render
    return out;
  }

  /* Signal evaluator for the confluence engine (same shape as other methods). */
  function evaluate(ctx, analysis) {
    if (!analysis || !analysis.breakouts.length) return null;
    const b = analysis.breakouts.find((x) => x.fresh) || analysis.breakouts[0];
    const fmt = (p) => p.toFixed(2);
    return {
      method: "autodraw", direction: b.dir, entry: b.entry, sl: b.sl, tp1: b.tp1, tp2: b.tp2,
      confidence: b.kind === "pattern" ? 74 : 70,
      reasons: [`${b.label} — Entry ${fmt(b.entry)} / TP ${fmt(b.tp1)}`],
      barIdx: b.barIdx, barTime: b.time, tag: "Auto-Draw",
    };
  }

  /* ================= RENDER (via method-ui rc) ================= */
  function render(rc, analysis, settings, t0, t1, set) {
    if (!analysis) return;
    const BULL = "rgba(38,166,154,0.95)", BEAR = "rgba(239,83,80,0.95)";

    if (set.trendlines !== false) {
      for (const tl of analysis.trendlines) {
        const c = tl.type === "support" ? BULL : BEAR;
        const pts = [
          { time: tl.p1.time, price: tl.p1.price },
          { time: tl.p2.time, price: tl.p2.price },
          { time: t1, price: lineValue(tl.p1, tl.p2, analysis.n - 1) + (tl.slope * 12) },
        ];
        rc.line(pts, { color: c, lineWidth: 1, lineStyle: 0,
          title: `${tl.type} TL ×${tl.touches}` });
      }
    }

    if (set.zones !== false) {
      for (const z of analysis.zones) {
        const c = z.dir === "support" ? "rgba(38,166,154,0.75)" : "rgba(239,83,80,0.75)";
        rc.line([{ time: t0, price: z.top }, { time: t1, price: z.top }],
          { color: c, lineWidth: 1, lineStyle: 0, title: `${z.dir} ×${z.touches}` });
        rc.line([{ time: t0, price: z.bottom }, { time: t1, price: z.bottom }],
          { color: c, lineWidth: 1, lineStyle: 0, title: "" });
      }
    }

    if (set.patterns !== false) {
      for (const pt of analysis.patterns) {
        const c = pt.dir === "bull" ? BULL : pt.dir === "bear" ? BEAR : "#d4a94e";
        if (pt.upper) {
          rc.line([{ time: pt.upper[0].time, price: pt.upper[0].price },
                   { time: pt.upper[1].time, price: pt.upper[1].price },
                   { time: t1, price: lineValue(pt.upper[0], pt.upper[1], analysis.n - 1) }],
            { color: c, lineWidth: 2, lineStyle: 0, title: pt.label });
          rc.line([{ time: pt.lower[0].time, price: pt.lower[0].price },
                   { time: pt.lower[1].time, price: pt.lower[1].price },
                   { time: t1, price: lineValue(pt.lower[0], pt.lower[1], analysis.n - 1) }],
            { color: c, lineWidth: 2, lineStyle: 0, title: "" });
        }
        if (pt.neckline && pt.neckline.p1) {
          rc.line([{ time: pt.neckline.p1.time, price: pt.neckline.price },
                   { time: t1, price: pt.neckline.price }],
            { color: "#d4a94e", lineWidth: 1, lineStyle: 2, title: "neckline" });
        } else if (pt.neckline) {
          rc.line([{ time: t0, price: pt.neckline.price }, { time: t1, price: pt.neckline.price }],
            { color: "#d4a94e", lineWidth: 1, lineStyle: 2, title: "neckline" });
        }
        if (pt.target) {
          rc.line([{ time: t1, price: pt.target }, { time: t1, price: pt.target }],
            { color: c, lineWidth: 1, lineStyle: 2, title: `target ${pt.target.toFixed(2)}` });
        }
        const midIdx = Math.floor((pt.startIdx + pt.endIdx) / 2);
        const midC = analysis._candles ? analysis._candles[midIdx] : null;
        rc.marker({ time: pt.upper ? pt.upper[1].time : (midC ? midC.time : t1),
          position: pt.dir === "bear" ? "aboveBar" : "belowBar",
          color: c, shape: "text", text: pt.label });
      }
    }

    if (set.breakouts !== false) {
      for (const b of analysis.breakouts) {
        const c = b.dir === "bull" ? "#26a69a" : "#ef5350";
        rc.marker({ time: b.time, position: b.dir === "bull" ? "belowBar" : "aboveBar",
          color: c, shape: "text", text: "⚡ BREAKOUT" });
        // entry + TP price lines (short, near the break)
        rc.line([{ time: b.time, price: b.entry }, { time: t1, price: b.entry }],
          { color: c, lineWidth: 1, lineStyle: 2, title: `Entry ${b.entry.toFixed(2)}` });
        rc.line([{ time: b.time, price: b.tp1 }, { time: t1, price: b.tp1 }],
          { color: c, lineWidth: 1, lineStyle: 2, title: `TP ${b.tp1.toFixed(2)}` });
      }
      for (const t of analysis.taps) {
        rc.marker({ time: t.time, position: t.dir === "bull" ? "belowBar" : "aboveBar",
          color: t.dir === "bull" ? BULL : BEAR, shape: "text", text: t.type === "tap" ? "TAP" : "TAP" });
      }
    }
  }

  /* ================= LIVE ON-CHART COMMENTARY =================
   * A floating HTML card pinned near the live candle. Positioned every
   * render via timeToCoordinate()/priceToCoordinate() — it tracks the
   * candle as the chart pans/zooms. NOT a side panel. */
  const OV = { el: null, chart: null, series: null, visible: false, lastKey: "" };

  function fmtP(p) {
    if (!num(p)) return "—";
    return p >= 1000 ? p.toLocaleString("en-US", { maximumFractionDigits: 2 })
                     : p >= 1 ? p.toFixed(2) : p.toFixed(4);
  }

  function ensureOverlay(container) {
    if (OV.el) return OV.el;
    if (!container || !container.appendChild) return null;
    const el = document.createElement("div");
    el.id = "adCommentary";
    el.style.cssText = [
      "position:absolute", "z-index:30", "pointer-events:none",
      "max-width:230px", "padding:8px 10px", "border-radius:10px",
      "background:rgba(10,13,22,0.88)", "border:1px solid rgba(212,169,78,0.55)",
      "box-shadow:0 4px 18px rgba(0,0,0,0.55),0 0 14px rgba(212,169,78,0.12)",
      "font-size:11.5px", "line-height:1.5", "color:#d1d4dc",
      "backdrop-filter:blur(6px)", "display:none",
      "font-family:-apple-system,BlinkMacSystemFont,'Trebuchet MS',Roboto,sans-serif",
    ].join(";");
    container.appendChild(el);
    OV.el = el;
    return el;
  }

  function commentaryHTML(analysis) {
    const b = analysis.breakouts.find((x) => x.fresh) || analysis.breakouts[0];
    const tap = !b && analysis.taps[0];
    const pt = !b && !tap && analysis.patterns[0];
    if (b) {
      const bull = b.dir === "bull";
      const col = bull ? "#26a69a" : "#ef5350";
      const rr = b.risk > 0 ? (Math.abs(b.tp1 - b.entry) / b.risk).toFixed(1) : "—";
      return `<div style="font-weight:800;color:${col};font-size:12.5px;margin-bottom:2px">${b.label}</div>` +
        `<div>Entry: <b style="color:#fff">${fmtP(b.entry)}</b></div>` +
        `<div>SL: <span style="color:#ef5350">${fmtP(b.sl)}</span> &nbsp; TP: <b style="color:${col}">${fmtP(b.tp1)}</b></div>` +
        `<div style="color:#787b86;font-size:10.5px">R:R 1:${rr} · ${b.kind}${b.pattern ? " · " + b.pattern : ""}</div>`;
    }
    if (tap) {
      const col = tap.dir === "bull" ? "#26a69a" : "#ef5350";
      return `<div style="font-weight:800;color:${col};font-size:12.5px">${tap.label}</div>` +
        `<div style="color:#787b86;font-size:10.5px">Level holding — watching for confirmation</div>`;
    }
    if (pt) {
      return `<div style="font-weight:700;color:#d4a94e;font-size:12px">◈ ${pt.name.toUpperCase()} FORMING</div>` +
        `<div style="color:#787b86;font-size:10.5px">Bias: ${pt.dir === "both" ? "awaiting break" : pt.dir} · ` +
        (pt.target ? `measured target ${fmtP(pt.target)}` : "target on breakout") + `</div>`;
    }
    // idle: structure summary
    const nTL = analysis.trendlines.length, nZ = analysis.zones.length;
    return `<div style="color:#787b86;font-size:11px">◈ AUTO-DRAW ACTIVE</div>` +
      `<div style="color:#787b86;font-size:10.5px">${nTL} trendlines · ${nZ} S/R zones · no fresh break</div>`;
  }

  function placeOverlay(analysis, candles) {
    if (!OV.el || !OV.chart || !OV.series || !candles.length) return;
    const last = candles[candles.length - 1];
    let x = null, y = null;
    try {
      x = OV.chart.timeScale().timeToCoordinate(last.time);
      y = OV.series.priceToCoordinate(last.close);
    } catch (_e) { return; }
    if (x == null || y == null) { OV.el.style.display = "none"; return; }
    const box = OV.el.parentElement.getBoundingClientRect();
    // anchor: above-right of the live candle, clamped inside the chart
    const elW = 230, elH = OV.el.offsetHeight || 110;
    let left = x + 14, top = y - elH - 14;
    if (left + elW > box.width - 8) left = x - elW - 14;
    if (top < 8) top = y + 18;
    OV.el.style.left = Math.max(8, left) + "px";
    OV.el.style.top = Math.max(8, top) + "px";
  }

  /* Called from method-ui renderAll after analysis. */
  function updateCommentary(chart, series, container, analysis, candles, enabled) {
    if (!enabled) {
      if (OV.el) OV.el.style.display = "none";
      OV.visible = false; return;
    }
    if (!analysis) return;
    OV.chart = chart; OV.series = series;
    const el = ensureOverlay(container);
    if (!el) return;
    const key = (analysis.breakouts[0] ? "b" + analysis.breakouts[0].barIdx + analysis.breakouts[0].dir : "") +
                "|t" + (analysis.taps[0] ? analysis.taps[0].barIdx : "") +
                "|p" + (analysis.patterns[0] ? analysis.patterns[0].label + analysis.patterns[0].endIdx : "");
    if (key !== OV.lastKey) { el.innerHTML = commentaryHTML(analysis); OV.lastKey = key; }
    // freshness pulse on new breakout
    const fresh = analysis.breakouts.some((x) => x.fresh);
    el.style.borderColor = fresh ? "rgba(38,166,154,0.9)" : "rgba(212,169,78,0.55)";
    el.style.display = "block";
    OV.visible = true;
    placeOverlay(analysis, candles);
    // voice alert on brand-new breakout (reuses TG voice if present)
    if (fresh && !OV._voicedKey) { OV._voicedKey = key; speakBreakout(analysis.breakouts.find((x) => x.fresh)); }
    if (!fresh) OV._voicedKey = null;
  }

  function speakBreakout(b) {
    if (!b) return;
    try {
      if (window.TGVoice && window.TGVoice.speak) { window.TGVoice.speak(
        `${b.dir === "bull" ? "Bullish" : "Bearish"} breakout. Entry ${fmtP(b.entry)}. Target ${fmtP(b.tp1)}.`); return; }
      if ("speechSynthesis" in window) {
        const u = new SpeechSynthesisUtterance(
          `${b.dir === "bull" ? "Bullish" : "Bearish"} breakout detected. Entry ${fmtP(b.entry)}, take profit ${fmtP(b.tp1)}.`);
        u.rate = 1.05; window.speechSynthesis.cancel(); window.speechSynthesis.speak(u);
      }
      if (navigator.vibrate) navigator.vibrate([40, 30, 40]);
    } catch (_e) {}
  }

  /* Keep the overlay glued while the user pans/zooms. */
  function bindReposition(chart) {
    if (!chart || OV._bound) return;
    try {
      chart.timeScale().subscribeVisibleLogicalRangeChange(() => {
        if (OV.visible && OV._candles) placeOverlay(null, OV._candles);
      });
      OV._bound = true;
    } catch (_e) {}
  }

  return {
    analyze, render, evaluate, updateCommentary, bindReposition,
    _setCandles: (c) => { OV._candles = c; },
  };
})();
