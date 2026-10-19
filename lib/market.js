"use strict";
// Market data with automatic fallback.
// Primary: Binance public REST (free, no key). Fallback: Kraken public REST
// (free, no key) — used when Binance is unreachable or geo-blocked (HTTP 451)
// from the machine running this server. Responses are normalized to:
//   {time (sec), open, high, low, close, volume}

const KRAKEN_MAP = {
  BTCUSDT: "XBTUSD", ETHUSDT: "ETHUSD", BNBUSDT: "BNBUSD", SOLUSDT: "SOLUSD",
  XRPUSDT: "XRPUSD", DOGEUSDT: "DOGEUSD", ADAUSDT: "ADAUSD", AVAXUSDT: "AVAXUSD",
  LINKUSDT: "LINKUSD", PAXGUSDT: "PAXGUSD", ARBUSDT: "ARBUSD", NEARUSDT: "NEARUSD",
  APTUSDT: "APTUSD", OPUSDT: "OPUSD",
};
const KRAKEN_TF = { "1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60, "2h": 120,
  "4h": 240, "6h": 360, "8h": 480, "12h": 720, "1d": 1440, "3d": 4320, "1w": 10080, "1M": 21600 };

async function binanceKlines(symbol, interval, limit) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`binance klines ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000), open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5],
  }));
}

async function krakenKlines(symbol, interval, limit) {
  const pair = KRAKEN_MAP[symbol];
  if (!pair) throw new Error(`kraken: no mapping for ${symbol}`);
  const tf = KRAKEN_TF[interval] || 60;
  const url = `https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${tf}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`kraken ohlc ${res.status}`);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error(`kraken: ${j.error.join("; ")}`);
  const key = Object.keys(j.result).find((k) => k !== "last");
  const rows = j.result[key].slice(-limit);
  return rows.map((r) => ({
    time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6],
  }));
}

async function getKlines(symbol, interval, limit) {
  try {
    return { source: "binance", candles: await binanceKlines(symbol, interval, limit) };
  } catch (e1) {
    try {
      return { source: "kraken", candles: await krakenKlines(symbol, interval, limit) };
    } catch (e2) {
      throw new Error(`market_data_unavailable (binance: ${e1.message}; kraken: ${e2.message})`);
    }
  }
}

async function binanceTicker(symbol) {
  const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${symbol}`);
  if (!res.ok) throw new Error(`binance ticker ${res.status}`);
  const t = await res.json();
  return { lastPrice: t.lastPrice, priceChangePercent: t.priceChangePercent,
           highPrice: t.highPrice, lowPrice: t.lowPrice, volume: t.volume, source: "binance" };
}

async function krakenTicker(symbol) {
  const pair = KRAKEN_MAP[symbol];
  if (!pair) throw new Error(`kraken: no mapping for ${symbol}`);
  const res = await fetch(`https://api.kraken.com/0/public/Ticker?pair=${pair}`);
  if (!res.ok) throw new Error(`kraken ticker ${res.status}`);
  const j = await res.json();
  if (j.error && j.error.length) throw new Error(`kraken: ${j.error.join("; ")}`);
  const key = Object.keys(j.result)[0];
  const t = j.result[key];
  const last = parseFloat(t.c[0]), open24 = parseFloat(t.o);
  return { lastPrice: String(last),
           priceChangePercent: open24 ? String(((last - open24) / open24) * 100) : null,
           highPrice: t.h[1], lowPrice: t.l[1], volume: t.v[1], source: "kraken" };
}

async function getTicker(symbol) {
  try { return await binanceTicker(symbol); }
  catch (e1) {
    try { return await krakenTicker(symbol); }
    catch (e2) { throw new Error(`ticker_unavailable (binance: ${e1.message}; kraken: ${e2.message})`); }
  }
}

module.exports = { getKlines, getTicker, KRAKEN_MAP };
