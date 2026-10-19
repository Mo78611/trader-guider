"use strict";
/* ============================================================================
 * Trader Guider — SMT (Smart Money Technique) divergence detector.
 * ----------------------------------------------------------------------------
 * ICT concept: when two correlated assets should move in sync but don't,
 * the failure is information. Classic case: XAUUSD prints a Higher High
 * while DXY fails to print the corresponding Lower Low (or vice versa).
 *
 * No free DXY feed exists on our market-data sources, so the engine is
 * generic: it compares ANY base symbol against ANY reference symbol the
 * user picks (default BTCUSDT). The math is direction-agnostic:
 *
 *   Bearish SMT: base makes a Higher High (h1 < h2) while the reference
 *                fails to make a Higher High in the same time window.
 *   Bullish SMT: base makes a Lower Low (l1 > l2) while the reference
 *                fails to make a Lower Low in the same time window.
 *
 * Pure functions, guarded against empty/misaligned input. No I/O here.
 * ========================================================================== */

function num(x) { return typeof x === "number" && isFinite(x); }
function okArr(c) { return Array.isArray(c) && c.length > 0; }

/** Fractal swing pivots (strength bars each side). Server-side copy of the
 *  client methodology so /api/smt needs no browser. */
function fractalSwings(candles, strength) {
  strength = strength || 3;
  const out = [];
  if (!okArr(candles) || candles.length < strength * 2 + 1) return out;
  for (let i = strength; i < candles.length - strength; i++) {
    const c = candles[i];
    if (!c || !num(c.high) || !num(c.low) || !num(c.time)) continue;
    let isHigh = true, isLow = true;
    for (let j = 1; j <= strength; j++) {
      const l = candles[i - j], r = candles[i + j];
      if (!l || !r || !num(l.high) || !num(r.high) || !num(l.low) || !num(r.low)) {
        isHigh = isLow = false; break;
      }
      if (l.high >= c.high || r.high >= c.high) isHigh = false;
      if (l.low <= c.low || r.low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) out.push({ idx: i, time: c.time, price: c.high, type: "high" });
    else if (isLow) out.push({ idx: i, time: c.time, price: c.low, type: "low" });
  }
  return out;
}

function maxHigh(candles) {
  let m = -Infinity;
  for (const c of candles) if (c && num(c.high) && c.high > m) m = c.high;
  return m === -Infinity ? null : m;
}
function minLow(candles) {
  let m = Infinity;
  for (const c of candles) if (c && num(c.low) && c.low < m) m = c.low;
  return m === Infinity ? null : m;
}

/**
 * Detect SMT divergences of `base` against `ref`.
 * Returns [{time, type: 'bearish'|'bullish', basePrice, note}].
 */
function detectSMT(baseCandles, refCandles, opts) {
  opts = opts || {};
  const strength = opts.strength || 3;
  const out = [];
  try {
    if (!okArr(baseCandles) || !okArr(refCandles)) return out;
    // work on the recent window only
    const lookback = opts.lookback || 120;
    const base = baseCandles.slice(-lookback);
    if (base.length < strength * 2 + 5) return out;

    const swB = fractalSwings(base, strength);
    const highs = swB.filter((s) => s.type === "high");
    const lows = swB.filter((s) => s.type === "low");

    // ---- bearish SMT: base HH, ref fails HH ----
    if (highs.length >= 2) {
      const h1 = highs[highs.length - 2], h2 = highs[highs.length - 1];
      if (h2.price > h1.price) {
        const t1 = h1.time, t2 = h2.time, mid = (t1 + t2) / 2;
        const pad = Math.max(3600, (t2 - t1) * 0.25);
        const win = refCandles.filter((c) => c && num(c.time) && c.time >= t1 - pad && c.time <= t2);
        const first = win.filter((c) => c.time < mid);
        const second = win.filter((c) => c.time >= mid);
        const m1 = maxHigh(first), m2 = maxHigh(second);
        // tolerance: the ref must beat its prior high by more than 5% of the
        // base's proportional move (scaled to the ref's price level) to count
        // as confirmation — pure noise wiggle is not confirmation.
        const eps = Math.max(1e-9, (h2.price - h1.price) * 0.05 * (m1 / h1.price));
        if (m1 != null && m2 != null && !(m2 > m1 + eps)) {
          out.push({
            time: h2.time, type: "bearish", basePrice: h2.price,
            note: `Base HH ${fmtShort(h1.price)}→${fmtShort(h2.price)}, ref failed to follow`,
          });
        }
      }
    }
    // ---- bullish SMT: base LL, ref fails LL ----
    if (lows.length >= 2) {
      const l1 = lows[lows.length - 2], l2 = lows[lows.length - 1];
      if (l2.price < l1.price) {
        const t1 = l1.time, t2 = l2.time, mid = (t1 + t2) / 2;
        const pad = Math.max(3600, (t2 - t1) * 0.25);
        const win = refCandles.filter((c) => c && num(c.time) && c.time >= t1 - pad && c.time <= t2);
        const first = win.filter((c) => c.time < mid);
        const second = win.filter((c) => c.time >= mid);
        const m1 = minLow(first), m2 = minLow(second);
        // same noise tolerance as the bearish leg (mirrored)
        const eps = Math.max(1e-9, (l1.price - l2.price) * 0.05 * (m1 / l1.price));
        if (m1 != null && m2 != null && !(m2 < m1 - eps)) {
          out.push({
            time: l2.time, type: "bullish", basePrice: l2.price,
            note: `Base LL ${fmtShort(l1.price)}→${fmtShort(l2.price)}, ref failed to follow`,
          });
        }
      }
    }
  } catch (_e) { /* never throw on market data */ }
  return out.slice(-3);
}

function fmtShort(p) {
  if (!num(p)) return "—";
  const a = Math.abs(p);
  if (a >= 1000) return p.toLocaleString("en-US", { maximumFractionDigits: 1 });
  if (a >= 100) return p.toFixed(2);
  return p.toFixed(4);
}

module.exports = { fractalSwings, detectSMT };
