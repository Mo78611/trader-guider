"use strict";
// Minimal Binance REST client (spot + USDⓈ-M futures).
// TESTNET (default): free public testnets — no real money can move.
// MAINNET: real funds. Server-side gated by BINANCE_LIVE_ENABLED=true
// (default "false" — mainnet orders are rejected unless explicitly armed).
//
// Public market data (klines etc.) needs NO key and hits the main public API.

const crypto = require("crypto");

const SPOT_TESTNET = process.env.BINANCE_SPOT_TESTNET || "https://testnet.binance.vision";
const FUTURES_TESTNET = process.env.BINANCE_FUTURES_TESTNET || "https://testnet.binancefuture.com";
const SPOT_MAINNET = "https://api.binance.com";
const FUTURES_MAINNET = "https://fapi.binance.com";
const PUBLIC_API = "https://api.binance.com";

// Real-money orders are blocked server-side unless explicitly armed.
const LIVE_ENABLED = process.env.BINANCE_LIVE_ENABLED === "true";

function sign(queryString, secret) {
  return crypto.createHmac("sha256", secret).update(queryString).digest("hex");
}

async function signedRequest({ base, path, method = "GET", params = {}, apiKey, apiSecret }) {
  const qs = new URLSearchParams({ ...params, timestamp: Date.now(), recvWindow: 5000 });
  const query = qs.toString();
  const signature = sign(query, apiSecret);
  const url = `${base}${path}?${query}&signature=${signature}`;
  const res = await fetch(url, {
    method,
    headers: { "X-MBX-APIKEY": apiKey },
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`Binance ${res.status}: ${data.msg || text.slice(0, 200)}`);
    err.status = res.status; err.data = data;
    throw err;
  }
  return data;
}

const spot = {
  base: SPOT_TESTNET,
  account: (creds) => signedRequest({ base: SPOT_TESTNET, path: "/api/v3/account", ...creds }),
  order: (creds, orderParams) =>
    signedRequest({ base: SPOT_TESTNET, path: "/api/v3/order", method: "POST", params: orderParams, ...creds }),
  openOrders: (creds, symbol) =>
    signedRequest({ base: SPOT_TESTNET, path: "/api/v3/openOrders", params: symbol ? { symbol } : {}, ...creds }),
};

const futures = {
  base: FUTURES_TESTNET,
  account: (creds) => signedRequest({ base: FUTURES_TESTNET, path: "/fapi/v2/account", ...creds }),
  positions: (creds) => signedRequest({ base: FUTURES_TESTNET, path: "/fapi/v2/positionRisk", ...creds }),
  order: (creds, orderParams) =>
    signedRequest({ base: FUTURES_TESTNET, path: "/fapi/v1/order", method: "POST", params: orderParams, ...creds }),
};

// Mainnet (REAL money) clients — same endpoints, real bases.
const spotMain = {
  base: SPOT_MAINNET,
  account: (creds) => signedRequest({ base: SPOT_MAINNET, path: "/api/v3/account", ...creds }),
  order: (creds, orderParams) =>
    signedRequest({ base: SPOT_MAINNET, path: "/api/v3/order", method: "POST", params: orderParams, ...creds }),
  openOrders: (creds, symbol) =>
    signedRequest({ base: SPOT_MAINNET, path: "/api/v3/openOrders", params: symbol ? { symbol } : {}, ...creds }),
};

const futuresMain = {
  base: FUTURES_MAINNET,
  account: (creds) => signedRequest({ base: FUTURES_MAINNET, path: "/fapi/v2/account", ...creds }),
  positions: (creds) => signedRequest({ base: FUTURES_MAINNET, path: "/fapi/v2/positionRisk", ...creds }),
  order: (creds, orderParams) =>
    signedRequest({ base: FUTURES_MAINNET, path: "/fapi/v1/order", method: "POST", params: orderParams, ...creds }),
};

// venue -> {client, mainnet}. Used by routes to pick client + enforce gates.
const VENUES = {
  binance_spot: { client: spot, mainnet: false },
  binance_futures: { client: futures, mainnet: false },
  binance_spot_main: { client: spotMain, mainnet: true },
  binance_futures_main: { client: futuresMain, mainnet: true },
};

async function publicKlines(symbol, interval, limit = 500) {
  const url = `${PUBLIC_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const rows = await res.json();
  return rows.map((r) => ({
    time: Math.floor(r[0] / 1000),
    open: parseFloat(r[1]),
    high: parseFloat(r[2]),
    low: parseFloat(r[3]),
    close: parseFloat(r[4]),
    volume: parseFloat(r[5]),
  }));
}

async function publicTicker24h(symbol) {
  const url = `${PUBLIC_API}/api/v3/ticker/24hr?symbol=${encodeURIComponent(symbol)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`ticker ${res.status}`);
  return res.json();
}

module.exports = { spot, futures, spotMain, futuresMain, VENUES, LIVE_ENABLED, publicKlines, publicTicker24h, SPOT_TESTNET, FUTURES_TESTNET };
