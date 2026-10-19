"use strict";
// Market sentiment — all FREE, no API keys.
//  - Binance futures global long/short account ratio (public REST)
//  - Fear & Greed index (alternative.me, public)
// Null-safe everywhere; 5-minute cache.

const TTL = 5 * 60 * 1000;
let cache = {}; // symbol -> { at, data }

function cleanSymbol(s) {
  return String(s || "BTCUSDT").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || "BTCUSDT";
}

async function binanceLS(symbol) {
  const url = `https://fapi.binance.com/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`binance ls ${res.status}`);
  const rows = await res.json();
  const r = rows && rows[0];
  if (!r || r.code === 0) throw new Error("binance ls blocked/empty");
  const longPct = parseFloat(r.longAccount) * 100;
  const shortPct = parseFloat(r.shortAccount) * 100;
  if (!(longPct >= 0) || !(shortPct >= 0)) throw new Error("binance ls bad numbers");
  return { longPct: +longPct.toFixed(1), shortPct: +shortPct.toFixed(1),
           ratio: r.longShortRatio != null ? +parseFloat(r.longShortRatio).toFixed(2) : null,
           venue: "Binance" };
}

// OKX long/short account ratio (public, no key) — fallback when Binance geo-blocks.
async function okxLS(symbol) {
  const ccy = String(symbol).toUpperCase().replace(/(USDT|USDC|USD)$/, "") || "BTC";
  const end = Date.now(), begin = end - 2 * 3600 * 1000;
  const url = `https://www.okx.com/api/v5/rubik/stat/contracts/long-short-account-ratio?ccy=${ccy}&begin=${begin}&end=${end}&period=5m`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`okx ls ${res.status}`);
  const j = await res.json();
  const rows = j && j.data;
  if (!rows || !rows.length || j.code !== "0") throw new Error("okx ls empty");
  const ratio = parseFloat(rows[rows.length - 1][1]);
  if (!(ratio > 0)) throw new Error("okx ls bad numbers");
  const longPct = (ratio / (1 + ratio)) * 100;
  return { longPct: +longPct.toFixed(1), shortPct: +(100 - longPct).toFixed(1),
           ratio: +ratio.toFixed(2), venue: "OKX" };
}

async function longShort(symbol) {
  try { return await binanceLS(symbol); }
  catch (_e1) {
    try { return await okxLS(symbol); }
    catch (_e2) { throw new Error("longshort_unavailable"); }
  }
}

async function fearGreed() {
  const res = await fetch("https://api.alternative.me/fng/?limit=1", {
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`fng ${res.status}`);
  const j = await res.json();
  const d = j && j.data && j.data[0];
  if (!d || d.value == null) throw new Error("fng empty");
  return { value: parseInt(d.value, 10), label: String(d.value_classification || "") };
}

function smartMoneyNote(longPct) {
  if (longPct == null) return "No sentiment data right now.";
  if (longPct >= 75) return `Retail ${longPct}% long — crowded, squeeze DOWN risk.`;
  if (longPct <= 25) return `Retail ${100 - longPct}% short — crowded, squeeze UP risk.`;
  if (longPct >= 60) return `Retail leaning long (${longPct}%) — mild crowd risk.`;
  if (longPct <= 40) return `Retail leaning short (${100 - longPct}%) — mild crowd risk.`;
  return "Balanced — no crowd risk.";
}

async function getSentiment(symbolRaw) {
  const symbol = cleanSymbol(symbolRaw);
  const hit = cache[symbol];
  if (hit && Date.now() - hit.at < TTL) return hit.data;
  const [ls, fg] = await Promise.allSettled([longShort(symbol), fearGreed()]);
  const lsV = ls.status === "fulfilled" ? ls.value : null;
  const fgV = fg.status === "fulfilled" ? fg.value : null;
  const longPct = lsV ? lsV.longPct : null;
  const data = {
    symbol,
    longPct, shortPct: lsV ? lsV.shortPct : null,
    ratio: lsV ? lsV.ratio : null,
    venue: lsV ? lsV.venue : null,
    fearGreed: fgV,
    retailBias: longPct == null ? null : (longPct >= 55 ? "long" : longPct <= 45 ? "short" : "flat"),
    smartMoneyNote: smartMoneyNote(longPct),
    sources: { longShort: lsV ? lsV.venue : null, fearGreed: !!fgV },
    at: new Date().toISOString(),
  };
  cache[symbol] = { at: Date.now(), data };
  return data;
}

module.exports = { getSentiment, cleanSymbol };
