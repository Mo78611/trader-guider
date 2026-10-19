"use strict";
// Trader Guider — trading terminal, localhost-first, cloud-ready.
//   Local:  npm install && npm start  ->  http://localhost:3000   (SQLite, zero config)
//   Cloud:  set DATABASE_URL (Postgres) — see DEPLOY.md
//
// Everything defaults to demo/testnet/dry-run. See README.md before
// connecting anything real.

const path = require("path");
const fs = require("fs");
const express = require("express");
const cookieParser = require("cookie-parser");

// tiny dotenv loader without a dependency: reads .env if present
(function loadEnv() {
  try {
    const p = path.join(__dirname, ".env");
    if (!fs.existsSync(p)) return;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  } catch { /* ignore */ }
})();

const db = require("./db");
const { isFirebaseConfigured } = require("./lib/firebase-auth-adapter");

const app = express();
const PORT = parseInt(process.env.PORT || "3000", 10);
const HOST = process.env.HOST || "0.0.0.0";

// Behind Render/Heroku-style proxies so `secure` cookies work over HTTPS.
app.set("trust proxy", 1);

app.use(express.json({ limit: "4mb" })); // analyses can carry a PNG dataURL
app.use(cookieParser());

// API routes
app.use("/api/auth", require("./routes/auth"));
app.use("/api/chart", require("./routes/chart"));
app.use("/api/market", require("./routes/market"));
app.use("/api/binance", require("./routes/binance"));
app.use("/api/execute", require("./routes/execute"));
app.use("/api/analysis", require("./routes/analysis"));
app.use("/api/news", require("./routes/news"));

app.get("/api/health", async (_req, res) => {
  let database = "unknown";
  try { database = await db.ping(); } catch (e) { database = "error: " + String(e.message).slice(0, 80); }
  res.json({
    ok: true,
    service: "trader-guider",
    database,
    dryRun: process.env.DRY_RUN !== "false",
    time: new Date().toISOString(),
  });
});

// Static frontend
app.use(express.static(path.join(__dirname, "public")));

// SPA-ish fallbacks
app.get("/terminal", (_req, res) => res.sendFile(path.join(__dirname, "public", "terminal.html")));
app.get("/hub", (_req, res) => res.sendFile(path.join(__dirname, "public", "analysis.html")));

async function main() {
  try {
    await db.ensureSchema();
  } catch (e) {
    console.error("[db] FATAL: could not connect or migrate database.");
    console.error("[db] " + String(e.message).slice(0, 300));
    console.error("[db] SQLite mode needs no config. Postgres mode needs a valid DATABASE_URL.");
    process.exit(1);
  }

  if (!isFirebaseConfigured()) {
    console.warn("[auth] Firebase appId not set (lib/firebase-auth-adapter.js or FIREBASE_APP_ID env) — using local email+password auth. See README to add it.");
  } else {
    console.log("[auth] Firebase Email/Password auth wired.");
  }

  app.listen(PORT, HOST, () => {
    console.log(`\n  Trader Guider on port ${PORT}  (db: ${db.isPostgres ? "postgres" : "sqlite"})`);
    console.log(`  DRY_RUN=${process.env.DRY_RUN !== "false" ? "true (safe: orders only logged)" : "FALSE (orders will actually send!)"}\n`);
  });
}

main();
