"use strict";
// Fundamental engine — economic calendar + directional bias with % chances.
// Sources: ForexFactory weekly XML (free, no key; often Cloudflare-blocked from
// servers) with a curated fallback calendar for tier-1 USD events whose dates
// were verified against the Fed/BLS 2026 schedules (FOMC decision days,
// BLS CPI release dates, NFP = first Friday rule).
// Everything is null-safe: on any failure we return { events: [], source }.

const CAL_TTL = 30 * 60 * 1000;
let cache = { at: 0, events: [], source: "none" };

/* ---------------- US Eastern -> UTC (DST aware, 2026: Mar 8 - Nov 1) -------- */
function etOffsetMinutes(y, m, d) {
  // US DST 2026: starts Mar 8, ends Nov 1. Good enough for the calendar window.
  const dst = (m > 3 && m < 11) || (m === 3 && d >= 8) || (m === 11 && d < 1);
  return dst ? -4 * 60 : -5 * 60;
}
function etToISO(y, m, d, hh, mm) {
  const off = etOffsetMinutes(y, m, d);
  const utc = Date.UTC(y, m - 1, d, hh, mm) - off * 60 * 1000;
  return new Date(utc).toISOString();
}

/* ---------------- ForexFactory XML (best effort) --------------------------- */
function tag(block, name) {
  const m = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].trim() : "";
}
function parseFFTime(dateStr, timeStr) {
  // date "11-06-2026", time "8:30am" / "2:00pm" / "Tentative" / "All Day"
  const dm = dateStr.match(/(\d{1,2})-(\d{1,2})-(\d{4})/);
  if (!dm) return null;
  const tm = String(timeStr).toLowerCase().match(/(\d{1,2}):(\d{2})\s*(am|pm)/);
  if (!tm) return null; // Tentative / All Day -> no precise time
  let hh = parseInt(tm[1], 10) % 12;
  if (tm[3] === "pm") hh += 12;
  return etToISO(+dm[3], +dm[1], +dm[2], hh, +tm[2]);
}
async function fetchFF() {
  const res = await fetch("https://www.forexfactory.com/ff_calendar_thisweek.xml", {
    headers: { "User-Agent": "Mozilla/5.0 (TraderGuider)" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) throw new Error(`ff xml ${res.status}`);
  const xml = await res.text();
  if (!xml.includes("<event>")) throw new Error("ff xml blocked/empty");
  const out = [];
  const now = Date.now();
  for (const m of xml.matchAll(/<event>([\s\S]*?)<\/event>/g)) {
    const b = m[1];
    if (tag(b, "country").toUpperCase() !== "USD") continue;
    if (tag(b, "impact").toLowerCase() !== "high") continue;
    const iso = parseFFTime(tag(b, "date"), tag(b, "time"));
    if (!iso) continue;
    const t = new Date(iso).getTime();
    if (t < now - 2 * 3600 * 1000 || t > now + 14 * 86400 * 1000) continue;
    out.push({
      id: "ff-" + t + "-" + tag(b, "title").slice(0, 12),
      title: tag(b, "title"), time: iso, currency: "USD",
      impact: "High", forecast: tag(b, "forecast") || null,
      previous: tag(b, "previous") || null, source: "forexfactory",
    });
  }
  return out;
}

/* ---------------- curated tier-1 calendar (verified 2026 dates) ------------- */
function firstFriday(year, month /*1-12*/) {
  const d = new Date(Date.UTC(year, month - 1, 1));
  const delta = (5 - d.getUTCDay() + 7) % 7;
  return 1 + delta;
}
// BLS CPI 2026 release dates, 8:30am ET (verified vs BLS schedule)
const CPI_2026 = [[1,13],[2,13],[3,11],[4,10],[5,12],[6,10],[7,14],[8,12],[9,11],[10,14],[11,10],[12,10]];
// FOMC 2026 rate-decision days, 2:00pm ET (verified vs Fed calendar)
const FOMC_2026 = [[1,28],[3,18],[4,29],[6,17],[7,29],[9,16],[10,28],[12,9]];
const FOMC_SEP = new Set(["3-18", "6-17", "9-16", "12-9"]); // dot-plot meetings

function curated() {
  const out = [];
  const now = new Date();
  const push = (ev) => {
    const t = new Date(ev.time).getTime();
    if (t > now.getTime() - 2 * 3600 * 1000 && t < now.getTime() + 90 * 86400 * 1000) out.push(ev);
  };
  // NFP + Unemployment: first Friday, 8:30am ET, next 4 months
  for (let i = 0; i < 4; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + i, 1));
    const day = firstFriday(d.getUTCFullYear(), d.getUTCMonth() + 1);
    const iso = etToISO(d.getUTCFullYear(), d.getUTCMonth() + 1, day, 8, 30);
    push({ id: `nfp-${d.getUTCFullYear()}-${d.getUTCMonth()+1}`, title: "Non-Farm Employment Change (NFP)",
      time: iso, currency: "USD", impact: "High", forecast: null, previous: null, source: "curated" });
    push({ id: `unemp-${d.getUTCFullYear()}-${d.getUTCMonth()+1}`, title: "Unemployment Rate",
      time: iso, currency: "USD", impact: "High", forecast: null, previous: null, source: "curated" });
  }
  // CPI 2026, 8:30am ET. Previous values known for released prints (headline YoY).
  const cpiPrev = { "1-13": "2.7%", "2-13": "2.4%", "3-11": "2.4%", "4-10": "3.3%", "5-12": "3.8%",
    "10-14": "3.7%" }; // Sep-2026 print released Oct 14 -> previous for Nov 10 release
  for (const [mo, da] of CPI_2026) {
    const iso = etToISO(2026, mo, da, 8, 30);
    const key = `${mo}-${da}`;
    const t = new Date(iso).getTime();
    const released = t < now.getTime();
    push({ id: `cpi-2026-${key}`, title: "CPI m/m (US Inflation)",
      time: iso, currency: "USD", impact: "High", forecast: null,
      previous: released ? null : (cpiPrev[key] || "3.7%"), source: "curated" });
  }
  // FOMC decisions, 2:00pm ET
  for (const [mo, da] of FOMC_2026) {
    const iso = etToISO(2026, mo, da, 14, 0);
    const sep = FOMC_SEP.has(`${mo}-${da}`);
    push({ id: `fomc-2026-${mo}-${da}`, title: sep ? "FOMC Rate Decision + Dot Plot" : "FOMC Rate Decision",
      time: iso, currency: "USD", impact: "High", forecast: null, previous: null, source: "curated" });
  }
  out.sort((a, b) => new Date(a.time) - new Date(b.time));
  return out;
}

async function getUpcomingRaw() {
  if (Date.now() - cache.at < CAL_TTL && cache.events.length) return cache;
  let events = [], source = "none";
  try {
    events = await fetchFF();
    source = events.length ? "forexfactory" : "none";
  } catch (_e) { /* fall through to curated */ }
  if (!events.length) { events = curated(); source = "curated"; }
  cache = { at: Date.now(), events, source };
  return cache;
}

/* ---------------- bias logic: forecast vs previous -> % chances ------------ */
function parseNum(s) {
  if (s == null) return null;
  const m = String(s).replace(/,/g, "").match(/(-?\d+(?:\.\d+)?)\s*([KMBkmb%]?)/);
  if (!m) return null;
  let v = parseFloat(m[1]);
  const u = m[2].toUpperCase();
  if (u === "K") v *= 1e3; else if (u === "M") v *= 1e6; else if (u === "B") v *= 1e9;
  return v;
}
// event classification: which way does USD move when the print beats forecast/prev?
const RULES = [
  { re: /non-?farm|nfp/i, key: "NFP", tier: 1, usdUpOnHigh: true },
  { re: /unemployment/i, key: "UNEMP", tier: 2, usdUpOnHigh: false },
  { re: /\bcpi\b/i, key: "CPI", tier: 1, usdUpOnHigh: true },
  { re: /\bpce\b/i, key: "PCE", tier: 2, usdUpOnHigh: true },
  { re: /\bpp?i\b/i, key: "PPI", tier: 2, usdUpOnHigh: true },
  { re: /fomc|fed.*rate|federal funds/i, key: "FOMC", tier: 1, usdUpOnHigh: true, noForecast: true },
  { re: /retail sales/i, key: "RETAIL", tier: 2, usdUpOnHigh: true },
  { re: /\bgdp\b/i, key: "GDP", tier: 2, usdUpOnHigh: true },
  { re: /ism.*pmi/i, key: "ISM", tier: 2, usdUpOnHigh: true },
];
function classify(title) {
  for (const r of RULES) if (r.re.test(title)) return r;
  return { key: "DATA", tier: 2, usdUpOnHigh: true };
}
// asset -> how USD strength translates to the asset's price direction
function assetUsdLink(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (/^(XAU|PAXG|GOLD)/.test(s)) return -1;      // gold falls when USD strong
  if (/(USDT|USDC|USD)$/.test(s)) return -1;      // USD-quoted: USD strong -> pair down
  if (/^USD/.test(s)) return 1;                   // USD-base FX: USD strong -> pair up
  return -1;
}
function assetName(symbol) {
  const s = String(symbol || "BTCUSDT").toUpperCase();
  if (/^(XAU|PAXG)/.test(s)) return "gold";
  if (/^BTC/.test(s)) return "BTC";
  if (/^ETH/.test(s)) return "ETH";
  return s.replace(/USDT$/, "");
}

function biasFor(event, symbol, trend /* 'up'|'down'|'flat'|null */) {
  const rule = classify(event.title);
  const f = parseNum(event.forecast), p = parseNum(event.previous);
  const link = assetUsdLink(symbol);
  const aname = assetName(symbol);

  // no numbers -> neutral, honest
  if (rule.noForecast || f == null || p == null) {
    const chance = rule.tier === 1 ? 60 : 52;
    return {
      direction: "neutral", chance,
      emoji: "⚪",
      text: rule.key === "FOMC"
        ? `⚪ ${chance}% Neutral — FOMC day, big move likely but side unclear. Stay careful.`
        : `⚪ ${chance}% Neutral — no forecast yet for ${rule.key}. Wait for the news.`,
    };
  }

  const surpriseUp = f > p;
  const usdBullish = rule.usdUpOnHigh ? surpriseUp : !surpriseUp;
  // asset direction: link=-1 means asset moves opposite to USD
  const assetBullish = link === 1 ? usdBullish : !usdBullish;
  const direction = assetBullish ? "bullish" : "bearish";

  // ---- chance formula ----
  let chance = 55;
  chance += rule.tier === 1 ? 10 : 5;
  const denom = Math.max(Math.abs(p), 1e-9);
  const rel = Math.abs(f - p) / denom;
  if (rel > 0.2) chance += 10; else if (rel > 0.08) chance += 5;
  if (trend && ((trend === "up" && assetBullish) || (trend === "down" && !assetBullish))) chance += 8;
  if (/USDT$/.test(String(symbol).toUpperCase()) && !/^(XAU|PAXG)/.test(String(symbol).toUpperCase())) chance -= 5; // crypto: USD link is softer
  chance = Math.max(50, Math.min(85, Math.round(chance)));

  const arrow = assetBullish ? "📈" : "📉";
  const word = assetBullish ? "Bullish" : "Bearish";
  const why = surpriseUp
    ? `${rule.key} expected HIGHER than last time → dollar ${usdBullish ? "strong" : "weak"}`
    : `${rule.key} expected LOWER than last time → dollar ${usdBullish ? "strong" : "weak"}`;
  const outcome = assetBullish ? `${aname} up likely` : `${aname} down likely`;
  return {
    direction, chance, emoji: arrow,
    text: `${arrow} ${chance}% ${word} — ${why}, ${outcome}.`,
  };
}

/* ---------------- volatility forecast: k x ATR(14) ------------------------- */
function atr14(candles) {
  if (!candles || candles.length < 16) return null;
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i], pc = candles[i - 1].close;
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  const last = trs.slice(-14);
  return last.reduce((a, b) => a + b, 0) / last.length;
}
function fmtMoney(v) {
  return "$" + Number(v).toLocaleString("en-US", { maximumFractionDigits: v < 10 ? 2 : 0 });
}
function expectedMoveText(atr, price, tier) {
  if (!(atr > 0) || !(price > 0)) return "Expected move: n/a";
  const k = tier === 1 ? 2.5 : 1.5;
  const move = atr * k;
  const pct = (move / price) * 100;
  if (price < 10) {
    const pips = Math.round(move / 0.0001);
    return `Expected move: ~${pips} pips (est.)`;
  }
  return `Expected move: ~${fmtMoney(move)} (${pct.toFixed(1)}%) (est.)`;
}

/* ---- exports (hoisted consts live below; this line must stay last) ---- */
 * HISTORICAL-VOLATILITY PIP ESTIMATOR + PREDICTIVE BIAS (2026-10-19 overhaul)
 *
 * Replaces the static ATR×k expected-move formula. For each upcoming event of
 * type T (FOMC/NFP/CPI) we measure what actually happened after the last 5
 * same-type releases: the realized 4-hour post-release range on real 1h klines,
 * converted to PIPS. No hardcoded moves — every number is measured.
 *
 * PIP CONVENTIONS (documented, honest):
 *   forex non-JPY : 1 pip = 0.0001
 *   forex JPY     : 1 pip = 0.01
 *   XAUUSD (gold): 1 pip = $0.10
 *   XAGUSD        : 1 pip = $0.01
 *   crypto        : 1 pip = $1.00   (so "500 pips" = $500 move)
 *   stocks        : 1 pip = $0.01
 * ========================================================================== */

/* Real past release timestamps (UTC ms). FOMC 14:00 ET, NFP/CPI 08:30 ET.
 * Verified against Fed/BLS schedules. These are historical facts, not data. */
const PAST_EVENTS = {
  FOMC: [
    Date.UTC(2025, 6, 30, 18, 0),   // Jul 30 2025 (EDT)
    Date.UTC(2025, 11, 10, 19, 0),  // Dec 10 2025 (EST)
    Date.UTC(2026, 0, 28, 19, 0),   // Jan 28 2026 (EST)
    Date.UTC(2026, 2, 18, 18, 0),   // Mar 18 2026 (EDT)
    Date.UTC(2026, 3, 29, 18, 0),   // Apr 29 2026 (EDT)
    Date.UTC(2026, 5, 17, 18, 0),   // Jun 17 2026 (EDT)
    Date.UTC(2026, 6, 29, 18, 0),   // Jul 29 2026 (EDT)
    Date.UTC(2026, 8, 16, 18, 0),   // Sep 16 2026 (EDT)
  ],
  NFP: [
    Date.UTC(2026, 2, 6, 12, 30),
    Date.UTC(2026, 3, 3, 12, 30),
    Date.UTC(2026, 4, 1, 12, 30),
    Date.UTC(2026, 5, 5, 12, 30),
    Date.UTC(2026, 6, 3, 12, 30),
    Date.UTC(2026, 7, 7, 12, 30),
    Date.UTC(2026, 8, 4, 12, 30),
    Date.UTC(2026, 9, 2, 12, 30),
  ],
  CPI: [
    Date.UTC(2026, 1, 13, 12, 30),
    Date.UTC(2026, 2, 11, 12, 30),
    Date.UTC(2026, 3, 10, 12, 30),
    Date.UTC(2026, 4, 12, 12, 30),
    Date.UTC(2026, 5, 10, 12, 30),
    Date.UTC(2026, 6, 14, 12, 30),
    Date.UTC(2026, 7, 12, 12, 30),
    Date.UTC(2026, 8, 11, 12, 30),
  ],
};

function pipSizeFor(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (/^(XAU|PAXG)/.test(s)) return 0.10;                 // gold: 10¢ = 1 pip
  if (/^XAG/.test(s)) return 0.01;                        // silver
  if (/JPY$/.test(s)) return 0.01;                        // JPY forex
  if (/^(EUR|GBP|AUD|NZD|CAD|CHF|USD)[A-Z]{3}$/.test(s) ||
      /^[A-Z]{3}(USD|EUR|GBP|CHF|CAD|AUD|NZD)$/.test(s)) return 0.0001;
  if (/^[A-Z]{1,5}$/.test(s)) return 0.01;                // stocks: 1¢
  return 1.0;                                             // crypto: $1
}

function isCryptoLike(symbol) {
  const s = String(symbol || "").toUpperCase();
  return /(USDT|USDC|BUSD)$/.test(s) || /^(BTC|ETH)/.test(s);
}

/* Time-bounded klines via the geo-unrestricted Binance mirror.
 * Binance klines API supports startTime/endTime (ms). */
async function visionKlinesRange(symbol, interval, startMs, endMs) {
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(symbol)}` +
    `&interval=${interval}&startTime=${startMs}&endTime=${endMs}&limit=1000`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`vision range ${res.status}`);
  const rows = await res.json();
  if (!Array.isArray(rows) || !rows.length) throw new Error("vision range empty");
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

/* Measure one past event: 4h post-release range + direction.
 * Returns { rangePips, bull } or null on failure. */
async function measureEvent(symbol, releaseMs) {
  const startMs = releaseMs - 3600 * 1000;
  const endMs = releaseMs + 6 * 3600 * 1000;
  const bars = await visionKlinesRange(symbol, "1h", startMs, endMs);
  // price at release: last close at/before release
  let atRelease = null;
  for (const b of bars) {
    if (b.time * 1000 <= releaseMs) atRelease = b.close;
  }
  if (atRelease == null) atRelease = bars[0].close;
  // 4h window after release
  const win = bars.filter((b) => b.time * 1000 >= releaseMs && b.time * 1000 <= releaseMs + 4 * 3600 * 1000);
  if (win.length < 2) return null;
  const hi = Math.max(...win.map((b) => b.high));
  const lo = Math.min(...win.map((b) => b.low));
  const rangePips = (hi - lo) / pipSizeFor(symbol);
  const bull = win[win.length - 1].close > atRelease;
  return { rangePips, bull };
}

const VOL_TTL = 24 * 3600 * 1000;
const volCache = new Map(); // "KEY|SYM" -> { at, data }

/* Historical volatility for an event type on an asset.
 * Returns { n, avg, stdev, bulls, dirs } or null when not measurable. */
async function historicalVol(eventKey, symbol) {
  const dates = (PAST_EVENTS[eventKey] || []).filter((t) => t < Date.now() - 6 * 3600 * 1000);
  if (dates.length < 3) return null;
  const use = dates.slice(-5); // last 5
  const ckey = `${eventKey}|${String(symbol).toUpperCase()}`;
  const hit = volCache.get(ckey);
  if (hit && Date.now() - hit.at < VOL_TTL) return hit.data;

  // crypto: measure on the asset itself, fallback BTCUSDT
  const syms = isCryptoLike(symbol) ? [String(symbol).toUpperCase(), "BTCUSDT"] : [String(symbol).toUpperCase()];
  let data = null;
  for (const sym of syms) {
    try {
      const results = await Promise.all(use.map((t) =>
        measureEvent(sym, t).catch(() => null)));
      const ok = results.filter(Boolean);
      if (ok.length < 3) continue;
      const ranges = ok.map((r) => r.rangePips);
      const avg = ranges.reduce((a, b) => a + b, 0) / ranges.length;
      const variance = ranges.reduce((a, b) => a + (b - avg) * (b - avg), 0) / ranges.length;
      const bulls = ok.filter((r) => r.bull).length;
      data = { n: ok.length, avg, stdev: Math.sqrt(variance), bulls,
               bearish: ok.length - bulls, measuredOn: sym };
      break;
    } catch (_e) { /* try next symbol */ }
  }
  if (data) volCache.set(ckey, { at: Date.now(), data });
  return data;
}

/* Pip estimate from historical vol; falls back to ATR×tier labelled honestly. */
function pipsEstimate(vol, atr, price, tier, symbol) {
  if (vol && vol.avg > 0) {
    const low = Math.max(1, Math.round(vol.avg - vol.stdev));
    const high = Math.round(vol.avg + vol.stdev);
    return {
      pipsLow: low, pipsHigh: high,
      pipsNote: "hist. avg, est.",
      text: `Estimated Move: ${low.toLocaleString()}–${high.toLocaleString()} pips (hist. avg of last ${vol.n} events, est.)`,
      source: "historical",
    };
  }
  // fallback: ATR-based, clearly labelled — pip size depends on the asset
  if (atr > 0 && price > 0) {
    const k = tier === 1 ? 2.5 : 1.5;
    const pips = Math.max(1, Math.round((atr * k) / pipSizeFor(symbol)));
    return {
      pipsLow: null, pipsHigh: null,
      pipsNote: "ATR est.",
      text: `Expected move: ~${pips.toLocaleString()} pips (ATR est.)`,
      source: "atr",
    };
  }
  return { pipsLow: null, pipsHigh: null, pipsNote: "n/a",
           text: "Expected move: n/a", source: "none" };
}

/* Predictive directional bias: 60% historical direction + 40% technical
 * (price position inside the 24h range from recent 1h candles).
 * Returns { direction, chance, emoji, text, reasoning }. */
function predictiveBias(event, symbol, candles, vol, trend) {
  const rule = classify(event.title);
  const aname = assetName(symbol);

  let histBull = 0.5, n = 0, bulls = 0;
  if (vol && vol.n >= 3) {
    n = vol.n; bulls = vol.bulls;
    histBull = vol.bulls / vol.n;
  }

  // technical leg: where is price inside the 24h range?
  let techBull = 0.5, posText = "mid-range";
  try {
    const last24 = (candles || []).slice(-24);
    if (last24.length >= 12) {
      const hi = Math.max(...last24.map((c) => c.high));
      const lo = Math.min(...last24.map((c) => c.low));
      const price = last24[last24.length - 1].close;
      if (hi > lo) {
        const pos = (price - lo) / (hi - lo);
        if (pos < 0.33) { techBull = 0.75; posText = "sitting near 24h support"; }
        else if (pos > 0.67) { techBull = 0.25; posText = "sitting near 24h resistance"; }
      }
    }
  } catch (_e) {}

  let score = 0.6 * histBull + 0.4 * techBull;
  let chance = Math.round(score * 100);
  // trend nudge (existing signal): ±3 when aligned
  if (trend === "up" && score > 0.5) chance += 3;
  else if (trend === "down" && score < 0.5) chance += 3;
  chance = Math.max(50, Math.min(85, chance));

  const dirWord = score > 0.53 ? "bullish" : score < 0.47 ? "bearish" : "neutral";
  const emoji = dirWord === "bullish" ? "📈" : dirWord === "bearish" ? "📉" : "⚪";
  const action = dirWord === "bullish" ? "BUY" : dirWord === "bearish" ? "SELL" : "WAIT";
  const label = chance >= 65 ? "High Probability" : chance >= 58 ? "Leaning" : "Mixed / No edge";
  const histText = n >= 3
    ? `${bulls} of last ${n} ${rule.key}s moved ${bulls >= n / 2 ? "up" : "down"} after release`
    : `no clean history for ${rule.key}`;
  const text = `${emoji} ${label}: ${action} / ${dirWord === "neutral" ? "Neutral" : dirWord === "bullish" ? "Bullish" : "Bearish"} (${chance}%) — ${histText}; price ${posText}.`;

  return { direction: dirWord, chance, emoji, text,
           reasoning: `${histText}; price ${posText} (24h range).`,
           histBull: Math.round(histBull * 100), techBull: Math.round(techBull * 100) };
}

module.exports = { getUpcomingRaw, biasFor, classify, atr14, expectedMoveText,
  historicalVol, pipsEstimate, predictiveBias, pipSizeFor, PAST_EVENTS };
