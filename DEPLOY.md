# Deploying Trader Guider (free tiers)

The app is 12-factor and cloud-ready: it reads `PORT`/`HOST` from env, uses
`DATABASE_URL` for Postgres when set (SQLite otherwise), serves the frontend
from the same origin (no hardcoded localhost URLs), and reads the Firebase web
config from env with compiled-in fallbacks.

## Option A — Render (free) + Supabase Postgres (free)

### 1. Database — Supabase (free tier: 500 MB Postgres)

1. Go to https://supabase.com → sign up → **New project** (free plan).
2. Wait for provisioning → **Project Settings → Database**.
3. Copy the **Connection string** (URI format). It looks like:
   `postgresql://postgres:<password>@db.<project-ref>.supabase.co:5432/postgres`
   (replace `<password>` with the database password you set at project creation).
4. Keep this string — it becomes `DATABASE_URL` on Render.

### 2. Web service — Render (free tier)

1. Push this folder to a GitHub repo (see note below about `.env`).
2. Go to https://render.com → **New → Web Service** → connect the repo.
3. Settings:
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. **Environment variables** (Environment tab → Add):
   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Supabase connection string from step 1 |
   | `JWT_SECRET` | a long random string (generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
   | `ENCRYPTION_KEY` | 64 hex chars (same generator) |
   | `DRY_RUN` | `true` (keep it — safe default) |
   | `COOKIE_SECURE` | `true` (Render serves HTTPS) |
   | `FIREBASE_APP_ID` | your Firebase web appId (optional; activates Firebase auth) |
   | `MT5_BRIDGE_URL` | leave unset (see MT5 note below) |
5. Deploy. The schema is created automatically on first boot
   (`db.ensureSchema()` runs before the server listens).

### 3. Keep it awake — free-tier sleep

Render's free tier **spins down after ~15 minutes of inactivity**; the first
request after sleep takes ~30–60s to wake the service. To keep it warm:

1. Sign up free at https://uptimerobot.com (50 monitors on the free plan).
2. **Add monitor → HTTP(s)**, friendly name "Trader Guider",
   URL `https://<your-app>.onrender.com/api/health`, interval **5 minutes**.
3. The `/api/health` endpoint is lightweight (one `SELECT 1`) and returns
   `{ok, service, database, dryRun}` — perfect for uptime checks.

### 4. MT5 bridge in cloud mode

The MT5 bridge (`mt5-bridge/`) is a program for **your own Windows PC** — it
talks to the MT5 terminal on the same machine. A cloud server cannot reach
your PC's `127.0.0.1`, so in cloud mode the execution panel shows
"MT5 bridge not connected — it runs on your own PC."

If you want MT5 execution from the cloud deployment, you must expose the
bridge yourself (e.g. Tailscale, Cloudflare Tunnel, or ngrok) and set
`MT5_BRIDGE_URL` to that public URL. **Think twice before doing this** —
you'd be putting order execution on the public internet; at minimum use the
tunnel's access controls and keep `DRY_RUN=true` until you're sure.

## Notes

- **Never commit `.env`** or `data/*.db`. The repo should only ever contain
  `.env.example`. Render env vars are set in the dashboard, not in git.
- Node version: Render picks a recent LTS automatically. The app needs
  Node ≥ 18 (uses native `fetch`).
- Supabase free tier pauses after 7 days of inactivity — the UptimeRobot
  pings against `/api/health` (which hits the DB) also keep the database warm.
- Binance market data and testnet trading work from Render's network, subject
  to Binance's own availability in that region (the app falls back to Kraken
  public data automatically if Binance is unreachable).
