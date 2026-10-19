"use strict";
/* Indicator math — pure functions over candle arrays.
   Candle: {time, open, high, low, close, volume} */

function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) continue;
    if (i === period - 1) {
      let s = 0;
      for (let j = 0; j < period; j++) s += values[i - j];
      prev = s / period;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < period + 1) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signal = 9) {
  const ef = ema(closes, fast), es = ema(closes, slow);
  const line = ef.map((v, i) => (v == null || es[i] == null ? null : v - es[i]));
  const valid = line.map((v) => (v == null ? 0 : v));
  // signal EMA over the valid portion only
  const sigRaw = ema(valid, signal);
  const startIdx = line.findIndex((v) => v != null);
  const sig = sigRaw.map((v, i) => (i < startIdx + signal - 1 ? null : v));
  const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
  return { line, sig, hist };
}

function bollinger(closes, period = 20, mult = 2) {
  const basis = sma(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = period - 1; i < closes.length; i++) {
    let s = 0;
    for (let j = 0; j < period; j++) s += closes[i - j];
    const mean = s / period;
    let v = 0;
    for (let j = 0; j < period; j++) v += (closes[i - j] - mean) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = mean + mult * sd;
    lower[i] = mean - mult * sd;
  }
  return { basis, upper, lower };
}

function atr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  if (candles.length < period + 1) return out;
  const trs = [0];
  for (let i = 1; i < candles.length; i++) {
    const h = candles[i].high, l = candles[i].low, pc = candles[i - 1].close;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  let prev = trs.slice(1, period + 1).reduce((a, b) => a + b, 0) / period;
  out[period] = prev;
  for (let i = period + 1; i < candles.length; i++) {
    prev = (prev * (period - 1) + trs[i]) / period;
    out[i] = prev;
  }
  return out;
}

// zip indicator values with candle times -> [{time, value}] skipping nulls
function toSeries(candles, values) {
  const pts = [];
  for (let i = 0; i < candles.length; i++) {
    if (values[i] != null && isFinite(values[i])) pts.push({ time: candles[i].time, value: values[i] });
  }
  return pts;
}

// zip indicator values with candle times -> [{time, value}] skipping nulls
function toSeries(candles, values) {
  const pts = [];
  for (let i = 0; i < candles.length; i++) {
    if (values[i] != null && isFinite(values[i])) pts.push({ time: candles[i].time, value: values[i] });
  }
  return pts;
}

function stochastic(candles, kPeriod, dPeriod) {
  kPeriod = kPeriod || 14; dPeriod = dPeriod || 3;
  const K = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < kPeriod; j++) {
      const c = candles[i - j];
      if (c.high > hh) hh = c.high;
      if (c.low < ll) ll = c.low;
    }
    K[i] = hh === ll ? 50 : ((candles[i].close - ll) / (hh - ll)) * 100;
  }
  const D = new Array(candles.length).fill(null);
  for (let i = kPeriod - 1 + dPeriod - 1; i < candles.length; i++) {
    let s = 0;
    for (let j = 0; j < dPeriod; j++) s += K[i - j];
    D[i] = s / dPeriod;
  }
  return { k: K, d: D };
}

function vwap(candles) {
  // session (UTC day) anchored VWAP
  const out = new Array(candles.length).fill(null);
  let pv = 0, vv = 0, day = -1;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = new Date(c.time * 1000).getUTCDate();
    if (d !== day) { day = d; pv = 0; vv = 0; }
    const tp = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += tp * v; vv += v;
    out[i] = vv > 0 ? pv / vv : null;
  }
  return out;
}

function supertrend(candles, period, mult) {
  period = period || 10; mult = mult || 3;
  const a = atr(candles, period);
  const n = candles.length;
  const line = new Array(n).fill(null);
  const dir = new Array(n).fill(0);
  let prevUpper = 0, prevLower = 0, prevDir = 1;
  for (let i = 1; i < n; i++) {
    if (a[i] == null) continue;
    const hl2 = (candles[i].high + candles[i].low) / 2;
    let upper = hl2 + mult * a[i];
    let lower = hl2 - mult * a[i];
    if (candles[i - 1].close > prevUpper) upper = Math.min(upper, prevUpper);
    if (candles[i - 1].close < prevLower) lower = Math.max(lower, prevLower);
    let d = prevDir;
    if (candles[i].close > prevUpper) d = 1;
    else if (candles[i].close < prevLower) d = -1;
    line[i] = d === 1 ? lower : upper;
    dir[i] = d;
    prevUpper = upper; prevLower = lower; prevDir = d;
  }
  return { line, dir };
}

function donchianMid(candles, i, period) {
  let hh = -Infinity, ll = Infinity;
  for (let j = 0; j < period && i - j >= 0; j++) {
    const c = candles[i - j];
    if (c.high > hh) hh = c.high;
    if (c.low < ll) ll = c.low;
  }
  return (hh + ll) / 2;
}

function ichimoku(candles, tenkan, kijun, senkouB) {
  tenkan = tenkan || 9; kijun = kijun || 26; senkouB = senkouB || 52;
  const n = candles.length;
  const tk = new Array(n).fill(null), kj = new Array(n).fill(null);
  const sa = new Array(n).fill(null), sb = new Array(n).fill(null), ch = new Array(n).fill(null);
  for (let i = 0; i < n; i++) {
    if (i >= tenkan - 1) tk[i] = donchianMid(candles, i, tenkan);
    if (i >= kijun - 1) kj[i] = donchianMid(candles, i, kijun);
  }
  for (let i = 0; i < n; i++) {
    if (tk[i] != null && kj[i] != null && i + kijun < n) sa[i + kijun] = (tk[i] + kj[i]) / 2;
    if (i >= senkouB - 1 && i + kijun < n) sb[i + kijun] = donchianMid(candles, i, senkouB);
    if (i + kijun < n) ch[i] = candles[i + kijun].close; // chikou: close shifted back
  }
  return { tenkan: tk, kijun: kj, senkouA: sa, senkouB: sb, chikou: ch };
}

function cci(candles, period) {
  period = period || 20;
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let sum = 0;
    const tps = [];
    for (let j = 0; j < period; j++) {
      const c = candles[i - j];
      const tp = (c.high + c.low + c.close) / 3;
      tps.push(tp); sum += tp;
    }
    const mean = sum / period;
    let md = 0;
    for (const tp of tps) md += Math.abs(tp - mean);
    md /= period;
    out[i] = md === 0 ? 0 : (tps[0] - mean) / (0.015 * md);
  }
  return out;
}

function williamsR(candles, period) {
  period = period || 14;
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    let hh = -Infinity, ll = Infinity;
    for (let j = 0; j < period; j++) {
      const c = candles[i - j];
      if (c.high > hh) hh = c.high;
      if (c.low < ll) ll = c.low;
    }
    out[i] = hh === ll ? 0 : ((hh - candles[i].close) / (hh - ll)) * -100;
  }
  return out;
}

function obv(candles) {
  const out = new Array(candles.length).fill(null);
  let v = 0;
  for (let i = 0; i < candles.length; i++) {
    if (i > 0) {
      if (candles[i].close > candles[i - 1].close) v += candles[i].volume || 0;
      else if (candles[i].close < candles[i - 1].close) v -= candles[i].volume || 0;
    }
    out[i] = v;
  }
  return out;
}

function psar(candles, step, maxStep) {
  step = step || 0.02; maxStep = maxStep || 0.2;
  const n = candles.length;
  const out = new Array(n).fill(null);
  if (n < 2) return out;
  let up = true, af = step;
  let ep = candles[0].high, sar = candles[0].low;
  out[0] = sar;
  for (let i = 1; i < n; i++) {
    const h = candles[i].high, l = candles[i].low;
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, candles[i - 1].low, l);
      if (h > ep) { ep = h; af = Math.min(af + step, maxStep); }
      if (l < sar) { up = false; sar = ep; ep = l; af = step; }
    } else {
      sar = Math.max(sar, candles[i - 1].high, h);
      if (l < ep) { ep = l; af = Math.min(af + step, maxStep); }
      if (h > sar) { up = true; sar = ep; ep = h; af = step; }
    }
    out[i] = sar;
  }
  return out;
}

window.TGIndicators = { sma, ema, rsi, macd, bollinger, atr, toSeries,
  stochastic, vwap, supertrend, ichimoku, cci, williamsR, obv, psar };
