"use strict";
/* Node harness: runs public/js/backtest-worker.js core logic on 100k synthetic
 * candles. Stubs the Worker globals (self, importScripts, postMessage). */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.join(__dirname);
const workerSrc = fs.readFileSync(path.join(ROOT, "public", "js", "backtest-worker.js"), "utf8");
const methodSrc = fs.readFileSync(path.join(ROOT, "public", "js", "methodology.js"), "utf8");

const messages = [];
const sandbox = {
  console,
  // importScripts stub: eval methodology.js in this context
  importScripts: (p) => {
    if (!/methodology\.js$/.test(p)) throw new Error("unexpected import: " + p);
    vm.runInContext(methodSrc, sandbox, { filename: "methodology.js" });
  },
};
sandbox.self = sandbox;
sandbox.window = sandbox; // the worker sets self.window = self itself
sandbox.postMessage = (m) => messages.push(m);
sandbox.onmessage = null;
vm.createContext(sandbox);
vm.runInContext(workerSrc, sandbox, { filename: "backtest-worker.js" });

if (!sandbox.onmessage) { console.error("FAIL: worker did not set onmessage"); process.exit(1); }
if (!sandbox.TGMethodology) { console.error("FAIL: TGMethodology not loaded"); process.exit(1); }
console.log("worker boot OK, TGMethodology loaded");

// ---- 100k synthetic candles: trending random walk with realistic noise ----
const N = 100000;
const time = new Float64Array(N), open = new Float64Array(N),
  high = new Float64Array(N), low = new Float64Array(N),
  close = new Float64Array(N), volume = new Float64Array(N);
let px = 50000, t = 1609459200;
let seed = 12345;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
for (let i = 0; i < N; i++) {
  const drift = Math.sin(i / 800) * 40; // slow regime swings -> structure forms
  const o = px;
  const c = o + (rnd() - 0.5) * 300 + drift * 0.02;
  const h = Math.max(o, c) + rnd() * 120;
  const l = Math.min(o, c) - rnd() * 120;
  time[i] = t; open[i] = o; high[i] = h; low[i] = l; close[i] = c;
  volume[i] = 50 + rnd() * 200;
  px = c; t += 3600;
}
console.log(`synthetic candles: ${N}`);

// quick unit checks on typed indicators via __BT
const BT = sandbox.__BT;
const rsi = BT.taRSI(close, 14);
const atr = BT.taATR(high, low, close, 14);
console.log("taRSI[100] =", rsi[100].toFixed(2), "| taATR[100] =", atr[100].toFixed(2));
if (!(rsi[100] >= 0 && rsi[100] <= 100)) { console.error("FAIL: RSI out of range"); process.exit(1); }
const sw = BT.taSwings(high, low, 3);
console.log("taSwings found:", sw.idx.length);
if (sw.idx.length < 100) { console.error("FAIL: too few swings"); process.exit(1); }
const macd = BT.taMACD(close);
console.log("taMACD ok, last hist =", macd.hist[N - 1].toFixed(2));

// ---- full backtest run ----
const t0 = Date.now();
sandbox.onmessage({ data: {
  type: "run", id: "test1",
  buf: { time, open, high, low, close, volume },
  conditions: ["sweep", "fvg_tap", "bos", "vsa_climax"],
  logic: "OR",
} });

const ms = Date.now() - t0;
const prog = messages.filter((m) => m.type === "progress");
const done = messages.find((m) => m.type === "done");
const err = messages.find((m) => m.type === "error");
if (err) { console.error("FAIL: worker error:", err.message); process.exit(1); }
if (!done) { console.error("FAIL: no done message"); process.exit(1); }
const r = done.result;
console.log(`done in ${(ms / 1000).toFixed(1)}s | progress msgs: ${prog.length}`);
console.log(`trades=${r.trades} wins=${r.wins} winRate=${r.winRate}% avgR=${r.avgR} maxDD=${r.maxDD}R`);
console.log(`equity pts=${r.equity.length} (cap 2000) | recentTrades=${r.recentTrades.length} (cap 500) | sample=${r.sample.length}`);
console.log(`perCondition:`, r.perCondition.map((c) => `${c.condition}:${c.fired}`).join(" "));

// ---- assertions ----
const fails = [];
if (ms > 10000) fails.push(`too slow: ${(ms / 1000).toFixed(1)}s > 10s (100k bars)`);
if (!(r.trades > 10)) fails.push(`too few trades: ${r.trades}`);
if (!(r.trades < 20000)) fails.push(`suspicious trade count: ${r.trades}`);
if (r.equity.length > 2000) fails.push(`equity not downsampled: ${r.equity.length}`);
if (r.recentTrades.length > 500) fails.push(`recentTrades not capped: ${r.recentTrades.length}`);
if (!r.perCondition.every((c) => c.fired >= 0)) fails.push("bad perCondition");
if (!(r.winRate >= 0 && r.winRate <= 100)) fails.push("bad winRate");
if (prog.length < 3) fails.push(`too few progress updates: ${prog.length}`);
if (fails.length) { console.error("FAIL:\n - " + fails.join("\n - ")); process.exit(1); }
console.log("ALL HARNESS CHECKS PASSED");
