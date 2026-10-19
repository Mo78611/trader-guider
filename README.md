# Trader Guider

A free, localhost-first trading terminal: pro charting (TradingView Lightweight
Charts), auto-saving workspaces, an MT5 bridge for broker execution, Binance
testnet trading, persistent multi-user login, and an Analysis Hub for sharing
chart breakdowns. **100% free stack — no paid APIs, no signups required to run
locally.**

## Quick start (localhost)

```bash
cd trader-guider
cp .env.example .env
# edit .env: set JWT_SECRET and ENCRYPTION_KEY
#   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
npm install
npm start
```

Open **http://localhost:3000** → the landing page → **Launch Terminal** → create an account → the terminal loads.

### Going public (free)

The app is cloud-ready: set `DATABASE_URL` (Supabase free Postgres) and it
runs on Postgres instead of SQLite — same code, zero changes. See
**[DEPLOY.md](DEPLOY.md)** for exact Render + Supabase free-tier steps
(build `npm install`, start `npm start`), the env var list, the free-tier
sleep behavior, and a free UptimeRobot keep-awake recipe.

### What you get

| Module | How it works (free) |
|---|---|
| Charting | Lightweight Charts (MIT) candlesticks, 8 timeframes, any Binance spot symbol |
| Indicators | SMA, EMA, RSI, MACD, Bollinger Bands, ATR — add unlimited, with params |
| Drawings | Trendline, horizontal line, Fibonacci retracement, text label, eraser |
| Persistence | Every change auto-saves (debounced) to local SQLite; reopening restores symbol, timeframe, indicators, drawings exactly |
| Auth | Email + password — Firebase Auth when configured, local bcrypt fallback; JWT in httpOnly cookie, **30-day persistent** — closing the tab never logs you out |
| MT5 execution | Python bridge on your Windows PC (see `mt5-bridge/`); one-click Buy/Sell with broker-side SL/TP |
| Binance | Free **testnet** spot + futures (USDⓈ-M); keys encrypted in local DB |
| Analysis Hub | Snapshot the chart → write a breakdown → public gallery + "load into my terminal" |

## Safety defaults (read this)

- `DRY_RUN=true` (default): **every** order — MT5 or Binance — is validated and
  *logged only*. Nothing reaches any broker. This is the safe default.
- The MT5 bridge additionally requires `LIVE_TRADING=true` **and** blocks
  real-money accounts unless `ALLOW_REAL_ACCOUNT=true`. Demo accounts only
  until you consciously change it.
- Binance uses **testnet** endpoints only. Keys are AES-256-GCM encrypted at
  rest, but this is **localhost-grade** security — fine on your own machine,
  not for a public server. Never commit `.env` or `data/*.db`.
- MT5 bridge runs on **your Windows PC** (the MetaTrader5 Python package is
  Windows-only and talks to the MT5 terminal on the same machine). It cannot
  be tested on Linux — see `mt5-bridge/`.

## MT5 bridge

```bash
cd mt5-bridge
pip install -r requirements.txt
copy .env.example .env   # Windows: use `copy`; edit values
python app.py            # -> http://127.0.0.1:5001
```

The terminal's execution panel auto-detects the bridge. In **cloud mode** the
server can't reach your PC's bridge, so the panel shows "MT5 bridge not
connected" with a pointer to this README — see DEPLOY.md if you want to expose
the bridge yourself (tunnel + access controls, keep DRY_RUN=true until sure).

Endpoints:
`GET /api/mt5/health`, `GET /api/mt5/account`, `GET /api/mt5/positions`,
`POST /api/mt5/order {symbol, action, volume, sl, tp}` (sl/tp **required**),
`POST /api/mt5/close {ticket}`.

## Project layout

```
server.js            Express app (API + static frontend). 12-factor: PORT/HOST
                     from env, binds 0.0.0.0, trust-proxy for secure cookies.
db.js                Dual-dialect DB: Postgres via DATABASE_URL, else SQLite.
                     Async helpers (get/all/run/exec); `?` placeholders and
                     datetime('now') translated for Postgres automatically.
lib/auth.js          JWT sessions, httpOnly cookies
lib/crypto-util.js   AES-256-GCM for stored API keys
lib/market.js        Market data: Binance public → Kraken fallback
lib/binance.js       Binance testnet REST client (signed)
lib/firebase-auth-adapter.js   Firebase Email/Password wiring (config + token
                               verify); falls back to local auth if appId unset;
                               phone OTP stays a commented stub
routes/              auth, chart, market, binance, execute, analysis
public/              landing (index.html), terminal (terminal.html),
                     login, analysis hub, css/js, assets/founder.jpg
public/css/brand.css Premium brand layer: gold/emerald theme, glassmorphism,
                     animated SVG logo mark, hero animations
mt5-bridge/          Flask + MetaTrader5 bridge (Windows)
```

## Firebase Auth (Email/Password — wired)

The Firebase project **trader-guider** is wired in. Config lives in
`lib/firebase-auth-adapter.js` (single source of truth).

**One step left — add the appId** (2 minutes, in the Firebase console):
1. Firebase console → Project Settings → General → "Your apps"
2. Open **"Trader Guider Web"** → copy the **App ID** (`1:788004774099:web:…`)
3. Paste it into `lib/firebase-auth-adapter.js` replacing `APP_ID_HERE`
4. Restart: `npm start`

How it works: the login page signs in with the Firebase JS SDK, sends the ID
token to `POST /api/auth/firebase-session`, the backend verifies it with
Google and mints the app's normal local JWT session cookie — chart state,
analyses and API keys all keep working unchanged. A Firebase user with the
same email as an existing local account is linked automatically.

**Fallback:** while the appId is still the placeholder, the app runs 100% on
local auth and logs a console warning — nothing crashes, nothing is blocked.
Phone OTP is **not** enabled in the console and stays a commented stub in the
adapter (see the file). The browser `apiKey` in the config is public-by-design
for Firebase web apps; restrict it by domain in the console if you go online.

## Free-tier deployment (later, optional, manual)

When you want it online instead of localhost, each needs ~10 min of **your own**
clicks (account creation = accepting Terms of Service, which only you should do):

1. **Vercel** (free hobby): frontend + serverless API. `vercel.com` → import repo.
2. **Render** (free tier): keep the Node backend always-on-ish. `render.com`.
3. **Supabase** (free Postgres 500 MB): replace SQLite with Postgres later.
4. **MongoDB Atlas M0** (free 512 MB): alternative document store.

The localhost build here needs none of that.

## Known limits (honest)

- MT5 bridge is **untestable on Linux** — code is written clean and reviewed,
  but first real run must be on your Windows PC with MT5 installed.
- Binance market data covers **crypto spot symbols**; FX/metals need another
  feed (PAXGUSDT works as a gold proxy on the chart).
- Mobile/email **OTP login is NOT included** — Firebase Email/Password is wired
  (see above); phone OTP stays an optional stub until enabled in the console.
  Token verification uses Google's tokeninfo endpoint (localhost-grade —
  production should use firebase-admin with a service account).
- One user = one machine here; multi-user works but shares the same box.
