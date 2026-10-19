"use strict";
/* Trader Guider terminal — chart, indicators, drawings, execution panel. */

const $ = (s) => document.querySelector(s);
const TIMEFRAMES = ["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"];
const POPULAR = ["BTCUSDT","ETHUSDT","BNBUSDT","SOLUSDT","XRPUSDT","DOGEUSDT","ADAUSDT","AVAXUSDT","LINKUSDT","PAXGUSDT","ARBUSDT","NEARUSDT","APTUSDT","OPUSDT"];
// Forex majors/minors + metals (Yahoo feed) and popular US stocks — always in the search list
const FOREX_LIST = ["EURUSD","GBPUSD","USDJPY","USDCHF","AUDUSD","USDCAD","NZDUSD","EURGBP","EURJPY","GBPJPY","EURAUD","EURCAD","GBPCHF","AUDJPY","CADJPY","CHFJPY","NZDJPY","AUDCAD","AUDCHF","EURCHF","GBPCAD","GBPAUD","XAUUSD","XAGUSD"];
const STOCK_LIST = ["AAPL","TSLA","NVDA","MSFT","AMZN","META","GOOGL","GOOG","AMD","NFLX","AVGO","INTC","BA","DIS","PYPL","COIN","MSTR","PLTR","SOFI","NIO","BABA","TSM","JPM","V","WMT","XOM","PFE","KO","NKE","MRNA","ZM","SHOP","UBER","SNAP","RBLX","HOOD","DKNG","LCID","RIVN","F","GM","T","VZ","IBM","ORCL","CRM","ADBE","QCOM","TXN","SPY","QQQ","DIA","IWM"];

const state = {
  user: null, symbol: "BTCUSDT", timeframe: "1h", chartType: "candles",
  candles: [], indicators: [], // [{id,type,period,...}]
  chart: null, candleSeries: null, altSeries: null, drawings: null,
  indSeries: [], // [{id, list:[series]}]
};
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveState, 800);
}
async function saveState() {
  try {
    await fetch("/api/chart/state", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        symbol: state.symbol, timeframe: state.timeframe, chartType: state.chartType,
        indicators: state.indicators,
        drawings: state.drawings ? state.drawings.get() : [],
        layout: {
          methodologies: window.TGMethodUI ? window.TGMethodUI.getState() : {},
        },
      }),
    });
  } catch (_e) {}
}

/* ---------- chart setup ---------- */
function initChart() {
  const el = $("#chart");
  state.chart = LightweightCharts.createChart(el, {
    layout: { background: { color: "#131722" }, textColor: "#787b86", fontSize: 11,
      fontFamily: "-apple-system,BlinkMacSystemFont,'Trebuchet MS',Roboto,Ubuntu,sans-serif" },
    grid: { vertLines: { color: "rgba(42, 46, 57, 0.5)" }, horzLines: { color: "rgba(42, 46, 57, 0.5)" } },
    rightPriceScale: { borderColor: "#2a2e39" },
    timeScale: { borderColor: "#2a2e39", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  });
  state.chart.priceScale("right").applyOptions({ scaleMargins: { top: 0.06, bottom: 0.30 } });
  state.chart.priceScale("osc").applyOptions({ scaleMargins: { top: 0.80, bottom: 0.02 } });
  state.candleSeries = state.chart.addCandlestickSeries({
    upColor: "#26a69a", downColor: "#ef5350",
    wickUpColor: "#26a69a", wickDownColor: "#ef5350", borderVisible: false,
  });
  state.drawings = TGDrawings.create(state.chart, state.candleSeries, () => state.candles, scheduleSave);
  new ResizeObserver(() => {
    const m = $(".main");
    state.chart.resize(m.clientWidth, m.clientHeight);
  }).observe($(".main"));
  // bar-replay: a click on the chart while armed sets the replay cutoff
  state.chart.subscribeClick((p) => { if (window.TGReplay) window.TGReplay.onChartClick(p); });
}

/* ---------- replay-aware candle view ----------
 * state.candles ALWAYS holds the full dataset. During bar replay the
 * *visible* slice is candles with time <= cutoff. Drawings keep using the
 * full array (absolute times — never corrupted). */
function viewCandles() {
  if (window.TGReplay && window.TGReplay.active()) return window.TGReplay.visible();
  return state.candles;
}
/* ---------- chart types (candles / bars / heikin ashi / line / area) ----------
 * The candlestick series stays the master reference for all modules
 * (drawings, methodologies, priceToCoordinate). For bars/line/area we hide
 * it and show a visual-only alt series. Indicators always use real candles. */
function heikinAshi(candles) {
  const out = [];
  let haO = 0, haC = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (!c || !isFinite(c.open) || !isFinite(c.high) || !isFinite(c.low) || !isFinite(c.close) || !isFinite(c.time)) continue;
    haC = (c.open + c.high + c.low + c.close) / 4;
    haO = out.length === 0 ? (c.open + c.close) / 2 : (haO + haC) / 2;
    out.push({ time: c.time,
      open: haO, high: Math.max(c.high, haO, haC),
      low: Math.min(c.low, haO, haC), close: haC });
  }
  return out;
}

function cleanCandles(C) {
  return (C || []).filter((c) => c && isFinite(c.time) && isFinite(c.open) &&
    isFinite(c.high) && isFinite(c.low) && isFinite(c.close));
}

function applyPriceData() {
  const C = cleanCandles(viewCandles());
  const cs = state.candleSeries;
  if (!cs || !C.length) return;
  // remove old alt series
  if (state.altSeries) { try { state.chart.removeSeries(state.altSeries); } catch (_e) {} state.altSeries = null; }
  const t = state.chartType || "candles";
  if (t === "heikin") {
    cs.applyOptions({ visible: true });
    cs.setData(heikinAshi(C));
  } else if (t === "bars") {
    cs.applyOptions({ visible: false });
    state.altSeries = state.chart.addBarSeries({
      upColor: "#26a69a", downColor: "#ef5350",
      priceLineVisible: false, lastValueVisible: true,
    });
    state.altSeries.setData(C);
  } else if (t === "line") {
    cs.applyOptions({ visible: false });
    state.altSeries = state.chart.addLineSeries({
      color: "#2962ff", lineWidth: 2,
      priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: true,
    });
    state.altSeries.setData(C.map((c) => ({ time: c.time, value: c.close })));
  } else if (t === "area") {
    cs.applyOptions({ visible: false });
    state.altSeries = state.chart.addAreaSeries({
      lineColor: "#2962ff", lineWidth: 2,
      topColor: "rgba(41,98,255,0.35)", bottomColor: "rgba(41,98,255,0.00)",
      priceLineVisible: false, lastValueVisible: true,
    });
    state.altSeries.setData(C.map((c) => ({ time: c.time, value: c.close })));
  } else { // candles
    cs.applyOptions({ visible: true });
    cs.setData(C);
  }
}

function setChartType(t) {
  if (!t) t = "candles";
  state.chartType = t;
  const sel = $("#ctSel");
  if (sel) sel.value = t;
  applyPriceData();
  scheduleSave();
}

function renderView() {
  applyPriceData();
  applyIndicators();
  if (state.drawings) state.drawings.render();
  if (window.TGMethodUI) window.TGMethodUI.onData();
}

/* ---------- data ---------- */
async function loadData() {
  const r = await fetch(`/api/market/klines?symbol=${state.symbol}&interval=${state.timeframe}&limit=500`);
  if (!r.ok) { setHint("Market data unavailable — check connection."); return; }
  const j = await r.json();
  state.candles = j.candles;
  renderView();
  if (!(window.TGReplay && window.TGReplay.active())) {
    state.chart.timeScale().scrollToRealTime();
  }
  scheduleSave();
  const t = await fetch(`/api/market/ticker?symbol=${state.symbol}`).then((x) => x.json()).catch(() => null);
  const replaying = window.TGReplay && window.TGReplay.active();
  if (replaying) {
    const C = viewCandles();
    const last = C.length ? C[C.length - 1].close : 0;
    $("#tickerInfo").textContent = `${state.symbol}  $${Number(last).toLocaleString()}  · REPLAY`;
  } else if (t && t.lastPrice) {
    const chg = t.priceChangePercent != null ? `  24h ${Number(t.priceChangePercent).toFixed(2)}%` : "";
    const kindTag = j.kind ? ` · ${j.kind}` : "";
    $("#tickerInfo").textContent = `${state.symbol}  $${Number(t.lastPrice).toLocaleString()}${chg}  · ${t.source || ""}${kindTag}`;
  }
  if (window.TGRisk) window.TGRisk.recalc(); // entry price moved -> resize the lot
  if (window.TGKZ) window.TGKZ.onData(); // killzone boxes / midnight line follow new data
  if (window.TGDisplacement) window.TGDisplacement.onData();
  if (window.TGMagnets) window.TGMagnets.onData();
}

function setHint(t) { const h = $("#chartHint"); if (h) h.textContent = t; }

/* trend of loaded candles: 'up' | 'down' | 'flat' (for news bias confluence) */
function currentTrend() {
  const C = state.candles;
  if (!C || C.length < 60) return null;
  const a = C[C.length - 51].close, b = C[C.length - 1].close;
  if (!(a > 0)) return null;
  const chg = (b - a) / a;
  if (chg > 0.005) return "up";
  if (chg < -0.005) return "down";
  return "flat";
}

/* ---------- indicators ---------- */
const IND_DEFS = {
  sma:  { label: "SMA",  pane: "main", color: "#4f7cff" },
  ema:  { label: "EMA",  pane: "main", color: "#d4a94e" },
  rsi:  { label: "RSI",  pane: "osc",  color: "#b48cf2" },
  macd: { label: "MACD", pane: "osc",  color: "#4f7cff" },
  bb:   { label: "Bollinger", pane: "main", color: "#8b94a7" },
  atr:  { label: "ATR",  pane: "osc",  color: "#26a69a" },
  stoch:{ label: "Stochastic", pane: "osc", color: "#4f7cff" },
  vwap: { label: "VWAP", pane: "main", color: "#d4a94e" },
  supertrend: { label: "Supertrend", pane: "main", color: "#26a69a" },
  ichimoku: { label: "Ichimoku", pane: "main", color: "#b48cf2" },
  cci:  { label: "CCI",  pane: "osc",  color: "#ef5350" },
  willr:{ label: "Williams %R", pane: "osc", color: "#26a69a" },
  obv:  { label: "OBV",  pane: "osc",  color: "#8b94a7" },
  psar: { label: "Parabolic SAR", pane: "main", color: "#d4a94e" },
};
const IND = window.TGIndicators;

function clearIndSeries() {
  for (const e of state.indSeries) for (const s of e.list) {
    try { state.chart.removeSeries(s); } catch (_e) {}
  }
  state.indSeries = [];
}
function mkLine(pane, color, width, title) {
  return state.chart.addLineSeries({
    color, lineWidth: width || 1, priceScaleId: pane === "osc" ? "osc" : "",
    priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, title: title || "",
  });
}
function applyIndicators() {
  clearIndSeries();
  const C = viewCandles(); // replay-aware: indicators recompute on the visible slice
  if (!C.length) return;
  const closes = C.map((c) => c.close);
  for (const ind of state.indicators) {
    const list = [];
    try {
      if (ind.type === "sma" || ind.type === "ema") {
        const fn = ind.type === "sma" ? IND.sma : IND.ema;
        const s = mkLine("main", ind.color || IND_DEFS[ind.type].color, 2, `${ind.type.toUpperCase()} ${ind.period}`);
        s.setData(IND.toSeries(C, fn(closes, ind.period)));
        list.push(s);
      } else if (ind.type === "rsi") {
        const s = mkLine("osc", ind.color || "#b48cf2", 1, `RSI ${ind.period}`);
        s.setData(IND.toSeries(C, IND.rsi(closes, ind.period)));
        list.push(s);
        for (const lvl of [70, 30]) {
          const g = mkLine("osc", "#3a4358", 1, "");
          g.applyOptions({ lineStyle: 2 });
          g.setData([{ time: C[0].time, value: lvl }, { time: C[C.length - 1].time, value: lvl }]);
          list.push(g);
        }
      } else if (ind.type === "macd") {
        const m = IND.macd(closes, ind.fast || 12, ind.slow || 26, ind.signal || 9);
        const h = state.chart.addHistogramSeries({
          priceScaleId: "osc", priceLineVisible: false, lastValueVisible: false,
          crosshairMarkerVisible: false, title: "MACD hist",
        });
        h.setData(C.map((c, i) => ({ time: c.time, value: m.hist[i] || 0,
          color: (m.hist[i] || 0) >= 0 ? "#26a69a" : "#ef5350" })));
        list.push(h);
        const l = mkLine("osc", "#4f7cff", 1, "MACD"); l.setData(IND.toSeries(C, m.line)); list.push(l);
        const sg = mkLine("osc", "#d4a94e", 1, "Signal"); sg.setData(IND.toSeries(C, m.sig)); list.push(sg);
      } else if (ind.type === "bb") {
        const b = IND.bollinger(closes, ind.period || 20, ind.mult || 2);
        const cols = ["#8b94a7", "#4f7cff", "#4f7cff"];
        [["basis", b.basis], ["upper", b.upper], ["lower", b.lower]].forEach(([n, v], i) => {
          const s = mkLine("main", cols[i], 1, `BB ${n}`); s.setData(IND.toSeries(C, v)); list.push(s);
        });
      } else if (ind.type === "atr") {
        const s = mkLine("osc", "#26a69a", 1, `ATR ${ind.period}`);
        s.setData(IND.toSeries(C, IND.atr(C, ind.period)));
        list.push(s);
      } else if (ind.type === "stoch") {
        const st = IND.stochastic(C, ind.period || 14, 3);
        const k = mkLine("osc", "#4f7cff", 1, `Stoch %K ${ind.period || 14}`);
        k.setData(IND.toSeries(C, st.k)); list.push(k);
        const d = mkLine("osc", "#d4a94e", 1, "Stoch %D");
        d.setData(IND.toSeries(C, st.d)); list.push(d);
        for (const lvl of [80, 20]) {
          const g = mkLine("osc", "#3a4358", 1, "");
          g.applyOptions({ lineStyle: 2 });
          g.setData([{ time: C[0].time, value: lvl }, { time: C[C.length - 1].time, value: lvl }]);
          list.push(g);
        }
      } else if (ind.type === "vwap") {
        const s = mkLine("main", ind.color || "#d4a94e", 2, "VWAP");
        s.setData(IND.toSeries(C, IND.vwap(C)));
        list.push(s);
      } else if (ind.type === "supertrend") {
        const st = IND.supertrend(C, ind.period || 10, ind.mult || 3);
        // split into up/down segments for green/red coloring
        let seg = [], segDir = 0;
        const flush = () => {
          if (seg.length > 1) {
            const s = mkLine("main", segDir === 1 ? "#26a69a" : "#ef5350", 2,
              `Supertrend ${ind.period || 10},${ind.mult || 3}`);
            s.setData(seg); list.push(s);
          }
          seg = [];
        };
        for (let i = 0; i < C.length; i++) {
          if (st.line[i] == null) continue;
          if (segDir !== st.dir[i] && seg.length) flush();
          segDir = st.dir[i];
          seg.push({ time: C[i].time, value: st.line[i] });
        }
        flush();
      } else if (ind.type === "ichimoku") {
        const ic = IND.ichimoku(C);
        const cols = { tenkan: "#ef5350", kijun: "#4f7cff", senkouA: "#26a69a", senkouB: "#ef5350", chikou: "#8b94a7" };
        for (const [n, v] of [["tenkan", ic.tenkan], ["kijun", ic.kijun], ["senkouA", ic.senkouA],
                              ["senkouB", ic.senkouB], ["chikou", ic.chikou]]) {
          const s = mkLine("main", cols[n], n === "tenkan" || n === "kijun" ? 1 : 1, `Ichimoku ${n}`);
          if (n === "senkouA" || n === "senkouB") s.applyOptions({ lineStyle: 2 });
          s.setData(IND.toSeries(C, v)); list.push(s);
        }
      } else if (ind.type === "cci") {
        const s = mkLine("osc", "#ef5350", 1, `CCI ${ind.period || 20}`);
        s.setData(IND.toSeries(C, IND.cci(C, ind.period || 20)));
        list.push(s);
        for (const lvl of [100, -100]) {
          const g = mkLine("osc", "#3a4358", 1, "");
          g.applyOptions({ lineStyle: 2 });
          g.setData([{ time: C[0].time, value: lvl }, { time: C[C.length - 1].time, value: lvl }]);
          list.push(g);
        }
      } else if (ind.type === "willr") {
        const s = mkLine("osc", "#26a69a", 1, `Williams %R ${ind.period || 14}`);
        s.setData(IND.toSeries(C, IND.williamsR(C, ind.period || 14)));
        list.push(s);
        for (const lvl of [-20, -80]) {
          const g = mkLine("osc", "#3a4358", 1, "");
          g.applyOptions({ lineStyle: 2 });
          g.setData([{ time: C[0].time, value: lvl }, { time: C[C.length - 1].time, value: lvl }]);
          list.push(g);
        }
      } else if (ind.type === "obv") {
        const s = mkLine("osc", "#8b94a7", 1, "OBV");
        s.setData(IND.toSeries(C, IND.obv(C)));
        list.push(s);
      } else if (ind.type === "psar") {
        const s = mkLine("main", "#d4a94e", 2, "Parabolic SAR");
        s.applyOptions({ lineStyle: 1 }); // dotted
        s.setData(IND.toSeries(C, IND.psar(C)));
        list.push(s);
      }
    } catch (_e) { /* skip broken indicator */ }
    state.indSeries.push({ id: ind.id, list });
  }
  renderIndList();
}
function indLabel(ind) {
  const d = IND_DEFS[ind.type] || {};
  let p = "";
  if (ind.type === "macd") p = ` ${ind.fast},${ind.slow},${ind.signal}`;
  else if (ind.type === "bb") p = ` ${ind.period},${ind.mult}`;
  else if (ind.type === "supertrend") p = ` ${ind.period},${ind.mult}`;
  else if (ind.period) p = ` ${ind.period}`;
  return `${d.label || ind.type}${p}`;
}
function renderIndList() {
  const box = $("#indList");
  box.innerHTML = "";
  for (const ind of state.indicators) {
    const div = document.createElement("div");
    div.className = "ind-item";
    div.innerHTML = `<span style="color:${ind.color || "#8b94a7"}">●</span><span></span>`;
    div.querySelector("span:last-child").textContent = indLabel(ind);
    const x = document.createElement("button");
    x.className = "x"; x.textContent = "×"; x.title = "Remove";
    x.onclick = () => {
      state.indicators = state.indicators.filter((i) => i.id !== ind.id);
      applyIndicators(); scheduleSave();
    };
    div.appendChild(x);
    box.appendChild(div);
  }
  if (!state.indicators.length) box.innerHTML = `<div style="color:var(--dim);font-size:12px">No indicators. Add one below.</div>`;
}
function addIndicator(type) {
  const base = { id: "i" + Date.now().toString(36), type, color: IND_DEFS[type].color };
  if (type === "sma") base.period = 20;
  if (type === "ema") base.period = 50;
  if (type === "rsi") base.period = 14;
  if (type === "macd") { base.fast = 12; base.slow = 26; base.signal = 9; }
  if (type === "bb") { base.period = 20; base.mult = 2; }
  if (type === "atr") base.period = 14;
  if (type === "stoch") base.period = 14;
  if (type === "vwap") base.period = 0; // session-anchored, no period
  if (type === "supertrend") { base.period = 10; base.mult = 3; }
  if (type === "ichimoku") base.period = 0; // fixed 9/26/52
  if (type === "cci") base.period = 20;
  if (type === "willr") base.period = 14;
  if (type === "obv") base.period = 0; // no period
  if (type === "psar") base.period = 0; // fixed 0.02/0.2
  if (base.period > 0 || type === "macd" || type === "supertrend") {
    const p = prompt(`Period for ${IND_DEFS[type].label} (default ${base.period || `${base.fast},${base.slow},${base.signal}`}) :`, base.period || "");
    if (p === null) return;
    const n = parseInt(p, 10);
    if (n > 0) base.period = n;
  }
  state.indicators.push(base);
  applyIndicators(); scheduleSave();
}

/* ---------- execution panel ---------- */
function mt5Symbol(s) {
  if (s === "PAXGUSDT") return "XAUUSD";
  return s.replace(/USDT$/, "USD").replace(/USDC$/, "USD");
}

function binanceVenue() {
  // returns venue key from target select + mode toggle
  const t = $("#execTarget").value;
  if (t !== "bin_fut" && t !== "bin_spot") return null;
  const main = $("#binMode") && $("#binMode").value === "mainnet";
  const base = t === "bin_spot" ? "binance_spot" : "binance_futures";
  return main ? base + "_main" : base;
}

function syncExecUI() {
  const v = $("#execTarget").value;
  const isMt5 = v === "mt5";
  const isBin = v === "bin_fut" || v === "bin_spot";
  $("#mt5Box").style.display = isMt5 ? "block" : "none";
  $("#binModeRow").style.display = isBin ? "flex" : "none";
  const main = $("#binMode") && $("#binMode").value === "mainnet";
  $("#mainnetWarn").style.display = isBin && main ? "block" : "none";
  $("#execVol").value = isMt5 ? "0.01" : "0.001";
}

async function refreshExecStatus() {
  try {
    const j = await fetch("/api/execute/status").then((r) => r.json());
    const mt5 = $("#mt5Status"), bn = $("#binStatus");
    const loggedIn = j.mt5.status && j.mt5.status.logged_in;
    mt5.textContent = j.mt5.reachable
      ? `MT5 bridge: ${loggedIn ? "connected ✓" : "running, not logged in"}${j.dryRun ? " (dry-run)" : ""}`
      : "MT5 bridge: not running";
    mt5.className = "pill " + (j.mt5.reachable && loggedIn ? "ok" : j.mt5.reachable ? "" : "bad");
    const keys = [];
    if (j.binance.spot_keys) keys.push("spot");
    if (j.binance.futures_keys) keys.push("futures");
    if (j.binance.spot_main_keys) keys.push("spot-MAIN");
    if (j.binance.futures_main_keys) keys.push("fut-MAIN");
    bn.textContent = keys.length ? `Binance keys: ${keys.join(" ")}` : "Binance: no keys saved";
    bn.className = "pill " + (keys.length ? "ok" : "bad");
    const note = $("#dryRunNote");
    note.textContent = (j.dryRun
      ? "DRY_RUN is ON — orders are logged only, nothing is sent."
      : "DRY_RUN is OFF — orders WILL be sent!")
      + (j.mt5Hint ? " " + j.mt5Hint : "");
    note.style.color = j.dryRun ? "var(--dim)" : "var(--red)";
  } catch (_e) {}
}

/* ----- MT5 credentials ----- */
async function loadMt5Creds() {
  try {
    const j = await fetch("/api/execute/mt5/credentials").then((r) => r.json());
    if (j && j.saved) {
      const sel = $("#mt5Server");
      const known = Array.from(sel.options).some((o) => o.value === j.server);
      sel.value = known ? j.server : "custom";
      $("#mt5CustomRow").style.display = known ? "none" : "flex";
      if (!known) $("#mt5ServerCustom").value = j.server;
      $("#mt5Acct").value = j.accountId || "";
      setMt5Conn("Credentials saved on server ✓ (password hidden)", false);
    }
  } catch (_e) {}
}
function setMt5Conn(msg, isErr) {
  const el = $("#mt5ConnStatus");
  el.textContent = msg || "";
  el.className = "status-line" + (isErr ? " err" : " okk");
}
async function saveMt5Creds() {
  const sel = $("#mt5Server").value;
  const server = sel === "custom" ? $("#mt5ServerCustom").value.trim() : sel;
  const accountId = $("#mt5Acct").value.trim();
  const password = $("#mt5Pass").value;
  if (!server || !accountId || !password) { setMt5Conn("Server, Account ID and Password are all required.", true); return; }
  setMt5Conn("Saving…", false);
  try {
    const j = await fetch("/api/execute/mt5/credentials", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ server, accountId, password }),
    }).then((r) => r.json());
    if (j.ok) {
      setMt5Conn("Saved (encrypted) ✓ — password never leaves the server unencrypted.", false);
      $("#mt5Pass").value = ""; // never keep the password in the page
      refreshExecStatus();
    } else setMt5Conn("Save failed: " + (j.error || "unknown"), true);
  } catch (e) { setMt5Conn("Save failed: " + e.message, true); }
}
async function connectMt5() {
  const sel = $("#mt5Server").value;
  const server = sel === "custom" ? $("#mt5ServerCustom").value.trim() : sel;
  const accountId = $("#mt5Acct").value.trim();
  const password = $("#mt5Pass").value;
  setMt5Conn("Connecting…", false);
  try {
    const body = password ? { server, accountId, password } : {};
    const j = await fetch("/api/execute/mt5/connect", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => r.json());
    $("#mt5Pass").value = "";
    if (j.error) setMt5Conn("Connect failed: " + (j.detail || j.error), true);
    else if (j.account) {
      const a = j.account;
      setMt5Conn(`Connected ✓ ${a.login} @ ${a.server} — balance ${a.balance} ${a.currency}${a.trade_mode === 2 ? " (REAL account)" : " (demo)"}`, false);
      // auto-fill the risk calculator balance from the real account
      try {
        const bal = parseFloat(a.balance);
        if (bal > 0 && $("#acctBal")) { $("#acctBal").value = bal; if (window.TGRisk) window.TGRisk.recalc(); }
      } catch (_e) {}
    } else setMt5Conn("Bridge replied, unexpected response.", true);
    refreshExecStatus();
  } catch (e) { setMt5Conn("Connect failed: " + e.message, true); }
}

async function oneClick(action) {
  try { if (navigator.vibrate) navigator.vibrate(15); } catch (_e) {} // haptic tap
  const target = $("#execTarget").value;
  const line = $("#execStatus");
  // TILT-LOCK: frozen panel blocks here too (server also returns 423).
  if (window.TGTilt && window.TGTilt.isLocked()) {
    line.className = "status-line err";
    line.textContent = "🔒 Tilt-Lock active — trading frozen to protect capital. See 🛡 Tilt-Lock.";
    return;
  }
  const sl = parseFloat($("#execSL").value) || 0;
  const tp = parseFloat($("#execTP").value) || 0;
  // Auto-lot calculator: when Auto lot is on, volume comes from risk % × SL distance.
  const vol = (window.TGRisk && $("#autoLot") && $("#autoLot").checked)
    ? window.TGRisk.effectiveVolume()
    : (parseFloat($("#execVol").value) || 0.01);
  const venue = binanceVenue();
  const isMainnet = venue && venue.endsWith("_main");
  // Trade copier: fan out to selected slave accounts.
  const copyN = window.TGCopier ? window.TGCopier.copyCount(target === "mt5" ? "mt5" : "binance") : 0;
  const copySuffix = copyN > 0 ? ` (+ copy to ${copyN} account${copyN > 1 ? "s" : ""})` : "";

  // safety confirmations
  if (isMainnet) {
    if (!confirm("⚠ REAL MONEY order on Binance MAINNET — confirm?")) return;
  } else if (target === "mt5") {
    if (!confirm(`Send ${action.toUpperCase()} ${( $("#mt5Sym").value.trim() || mt5Symbol(state.symbol))} via MT5 bridge?${copySuffix}`)) return;
  } else if (copyN > 0) {
    if (!confirm(`Send ${action.toUpperCase()} ${state.symbol} on ${venue}?${copySuffix}`)) return;
  }

  const body = target === "mt5"
    ? { target, action, symbol: $("#mt5Sym").value.trim() || mt5Symbol(state.symbol), volume: vol, sl, tp }
    : { target, action, symbol: state.symbol, quantity: vol, venue };
  body.target = target === "mt5" ? "mt5" : "binance";
  if (copyN > 0) body.copy = true;
  line.className = "status-line"; line.textContent = "Sending…";
  try {
    const r = await fetch("/api/execute", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) {
      line.className = "status-line err";
      if (r.status === 423 || j.error === "tilt_locked") {
        line.textContent = `🔒 Tilt-Lock: ${j.detail || "trading frozen"}`;
        if (window.TGTilt) window.TGTilt.refresh();
      } else {
        line.textContent = "Error: " + (j.detail || j.error);
      }
    }
    else {
      line.className = "status-line okk";
      const ticket = (j.bridge && (j.bridge.ticket || j.bridge.deal)) || (j.result && j.result.orderId);
      const copies = Array.isArray(j.copies) ? j.copies : [];
      const okCopies = copies.filter((c) => c.ok || c.dryRun).length;
      const copyTxt = copies.length ? ` · copies ${okCopies}/${copies.length} ok` : "";
      line.textContent = j.dryRun
        ? `Dry-run logged ✓ (${action.toUpperCase()} ${body.symbol})${copyTxt} — tracked below`
        : `Sent ✓ ${ticket ? "ticket: " + ticket : ""}${copyTxt} — tracked below`;
      // register with the Auto Trade Manager
      if (window.TGTradeMgr) {
        let lastPrice = 0;
        if (window.TGReplay && window.TGReplay.active()) {
          lastPrice = window.TGReplay.lastClose(); // paper price = last VISIBLE bar
        } else {
          lastPrice = await fetch(`/api/market/ticker?symbol=${encodeURIComponent(body.symbol)}`)
            .then((r) => r.json()).then((t) => parseFloat(t.lastPrice)).catch(() => null);
        }
        await window.TGTradeMgr.track({
          symbol: body.symbol, side: action,
          entry: lastPrice > 0 ? lastPrice : 0,
          sl, tp, qty: vol,
          auto_be: $("#autoBE").checked, auto_partial: $("#autoPartial").checked,
          bridge_ticket: target === "mt5" && !j.dryRun ? ticket : null,
          target: j.dryRun ? "paper" : target,
        });
      }
    }
  } catch (e) { line.className = "status-line err"; line.textContent = "Request failed: " + e.message; }
  refreshPositions();
}
async function refreshPositions() {
  try {
    const j = await fetch("/api/execute/status").then((r) => r.json());
    let html = "";
    if (j.mt5.reachable) {
      const p = await fetch("/api/execute/mt5/positions").then((r) => r.json()).catch(() => null);
      if (p && p.positions && p.positions.length) {
        html += `<div style="color:var(--dim);font-size:12px;margin:6px 0">MT5 positions</div><table class="mini"><tr><th>Symbol</th><th>Vol</th><th>P/L</th><th></th></tr>`;
        for (const x of p.positions) {
          html += `<tr><td>${x.symbol}</td><td>${x.volume}</td><td>${Number(x.profit).toFixed(2)}</td><td><button class="btn" data-t="${x.ticket}" onclick="closeMt5(${x.ticket})">close</button></td></tr>`;
        }
        html += "</table>";
      }
    }
    const hasFut = j.binance.futures_keys;
    if (hasFut) {
      const p = await fetch("/api/binance/positions?venue=binance_futures").then((r) => r.json()).catch(() => null);
      if (p && p.positions && p.positions.length) {
        html += `<div style="color:var(--dim);font-size:12px;margin:6px 0">Binance futures (testnet)</div><table class="mini"><tr><th>Symbol</th><th>Amt</th><th>uPnL</th></tr>`;
        for (const x of p.positions) html += `<tr><td>${x.symbol}</td><td>${x.positionAmt}</td><td>${Number(x.unRealizedProfit).toFixed(2)}</td></tr>`;
        html += "</table>";
      }
    }
    $("#positionsBox").innerHTML = html || `<div style="color:var(--dim);font-size:12px">No open positions.</div>`;
  } catch (_e) {}
}
window.closeMt5 = async function (ticket) {
  if (!confirm("Close position #" + ticket + "?")) return;
  await fetch("/api/execute/mt5/close", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket }),
  }).catch(() => {});
  refreshPositions();
};

/* ---------- analysis hub ---------- */
function currentWorkspace() {
  return {
    symbol: state.symbol, timeframe: state.timeframe,
    indicators: state.indicators, drawings: state.drawings ? state.drawings.get() : [],
  };
}
function openAnalysisModal() {
  $("#anTitle").value = `${state.symbol} ${state.timeframe} — analysis`;
  $("#anBody").value = "";
  if (window.TGVoice) window.TGVoice.reset();
  $("#analysisModal").classList.add("open");
}
async function saveAnalysis() {
  const title = $("#anTitle").value.trim();
  const body = $("#anBody").value.trim();
  if (!title) { alert("Title is required."); return; }
  let snapshot = null;
  try { snapshot = state.chart.takeScreenshot().toDataURL("image/png"); } catch (_e) {}
  const r = await fetch("/api/analysis", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      title, body, symbol: state.symbol, timeframe: state.timeframe,
      chart_state: currentWorkspace(), snapshot,
      is_public: $("#anPublic").checked,
      tags: window.TGVoice ? window.TGVoice.tags : [],
    }),
  });
  const j = await r.json();
  if (j.ok) { $("#analysisModal").classList.remove("open"); alert("Analysis saved to the Hub ✓"); }
  else alert("Save failed: " + (j.error || "unknown"));
}

/* ---------- settings (API keys) ---------- */
async function saveKeys() {
  const venue = $("#keyVenue").value;
  const apiKey = $("#keyKey").value.trim(), apiSecret = $("#keySec").value.trim();
  if (!apiKey || !apiSecret) { alert("Paste both key and secret."); return; }
  if (venue.endsWith("_main") && !confirm("⚠ This is a MAINNET venue — keys can move REAL money. Save?")) return;
  const r = await fetch("/api/auth/credentials", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ venue, apiKey, apiSecret, label: venue.endsWith("_main") ? "mainnet" : "testnet" }),
  });
  const j = await r.json();
  if (j.ok) { alert("Keys saved (encrypted) ✓"); $("#keyKey").value = ""; $("#keySec").value = ""; refreshExecStatus(); }
  else alert("Failed: " + (j.error || "unknown"));
}

/* ---------- boot ---------- */
async function boot() {
  const me = await fetch("/api/auth/me").then((r) => r.json()).catch(() => ({ user: null }));
  if (!me.user) { location.href = "/login.html"; return; }
  state.user = me.user;
  $("#userName").textContent = me.user.name || me.user.email;

  // Hard rule: an optional module must NEVER kill the chart. Every module
  // init below runs inside safeInit — a UI bug in one widget (e.g. the
  // 2026-10-19 news-button insertBefore crash that blanked the whole chart)
  // is logged and skipped, boot continues to loadData().
  const safeInit = (name, fn) => {
    try { fn(); }
    catch (e) {
      console.error("[boot] module init failed:", name, e && e.message);
    }
  };

  initChart();

  // methodology & signal engine (dropdown, settings, signal panel)
  safeInit("TGMethodUI", () => {
  if (window.TGMethodUI) {
    window.TGMethodUI.init({
      chart: state.chart,
      candleSeries: state.candleSeries,
      getCandles: () => viewCandles(), // replay-aware slice
      getTimeframe: () => state.timeframe,
      getSymbol: () => state.symbol,
      onChange: scheduleSave,
    });
  }
  });

  // ◤ THE BLACKSITE ◢ — exclusive experimental section (own drawer, own toggles)
  safeInit("TGBlacksit", () => {
  if (window.TGBlacksit) {
    window.TGBlacksit.init({
      chart: state.chart,
      getCandles: () => viewCandles(),
      getSymbol: () => state.symbol,
      getTimeframe: () => state.timeframe,
    });
  }
  });

  // live strategy estimator (reads ticked methodologies, shows freq/win/strictness)
  safeInit("TGEstimator", () => {
  if (window.TGEstimator) {
    window.TGEstimator.init({
      getState: () => (window.TGMethodUI ? window.TGMethodUI.getState() : null),
    });
  }
  });

  // news radar + sentiment widget
  safeInit("TGNews", () => {
  if (window.TGNews) {
    window.TGNews.init({
      getSymbol: () => state.symbol,
      getTrend: currentTrend,
    });
  }
  });

  // institutional batch: SMT scanner, liquidity heatmap, killzone sessions,
  // tilt-lock blocker, multi-account copier
  safeInit("TGSMT", () => {
  if (window.TGSMT) {
    window.TGSMT.init({
      chart: state.chart,
      getSymbol: () => state.symbol,
      getTimeframe: () => state.timeframe,
      getCandles: () => viewCandles(),
    });
  }
  });
  safeInit("TGLiq", () => {
  if (window.TGLiq) {
    window.TGLiq.init({
      chart: state.chart,
      candleSeries: state.candleSeries,
      getSymbol: () => state.symbol,
    });
  }
  });
  safeInit("TGKZ", () => {
  if (window.TGKZ) {
    window.TGKZ.init({
      chart: state.chart,
      candleSeries: state.candleSeries,
      getCandles: () => viewCandles(),
    });
  }
  });
  safeInit("TGTilt", () => { if (window.TGTilt) window.TGTilt.init(); });
  safeInit("TGCopier", () => { if (window.TGCopier) window.TGCopier.init(); });

  // tinkerer batch: displacement radar, sweep magnets, footprints
  safeInit("TGDisplacement", () => {
  if (window.TGDisplacement) {
    window.TGDisplacement.init({
      chart: state.chart,
      getCandles: () => viewCandles(),
    });
  }
  });
  safeInit("TGMagnets", () => {
  if (window.TGMagnets) {
    window.TGMagnets.init({
      chart: state.chart,
      getCandles: () => viewCandles(),
    });
  }
  });
  safeInit("TGFootprints", () => {
  if (window.TGFootprints) {
    window.TGFootprints.init({
      getSymbol: () => state.symbol,
      getTimeframe: () => state.timeframe,
      getLastClose: () => {
        const cs = viewCandles();
        return cs.length ? cs[cs.length - 1].close : 0;
      },
      getLastTime: () => {
        const cs = viewCandles();
        return cs.length ? cs[cs.length - 1].time : Math.floor(Date.now() / 1000);
      },
    });
  }
  }); // end safeInit TGFootprints

  // symbol datalist — POPULAR crypto first, then forex + stocks, then the full Binance list (500+ coins)
  const dl = $("#symList");
  const seen = new Set();
  const addOpt = (s) => { if (seen.has(s)) return; seen.add(s);
    const o = document.createElement("option"); o.value = s; dl.appendChild(o); };
  POPULAR.forEach(addOpt);
  FOREX_LIST.forEach(addOpt);
  STOCK_LIST.forEach(addOpt);
  fetch("/api/market/symbols").then((r) => r.json()).then((j) => {
    (j.symbols || []).forEach(addOpt);
  }).catch(() => {});

  // timeframe buttons
  const tfb = $("#tfBar");
  TIMEFRAMES.forEach((t) => {
    const b = document.createElement("button");
    b.className = "tf-btn"; b.textContent = t; b.dataset.tf = t;
    b.onclick = () => {
      if (window.TGReplay && window.TGReplay.active()) window.TGReplay.exit();
      state.timeframe = t; syncTf(); loadData();
      if (window.TGSMT) window.TGSMT.onSymbolChange(); // re-scan on new timeframe
    };
    tfb.appendChild(b);
  });

  // restore saved workspace
  try {
    const s = await fetch("/api/chart/state").then((r) => r.json());
    if (s.state) {
      state.symbol = s.state.symbol || "BTCUSDT";
      state.timeframe = s.state.timeframe || "1h";
      state.chartType = s.state.chartType || "candles";
      state.indicators = s.state.indicators || [];
      if (state.drawings) state.drawings.load(s.state.drawings || []);
      if (window.TGMethodUI && s.state.layout && s.state.layout.methodologies) {
        window.TGMethodUI.setState(s.state.layout.methodologies);
      }
    }
  } catch (_e) {}

  $("#symInput").value = state.symbol;
  syncTf();
  // chart type selector
  const ctSel = $("#ctSel");
  if (ctSel) {
    ctSel.value = state.chartType || "candles";
    ctSel.onchange = () => setChartType(ctSel.value);
  }
  await loadData();

  // toolbar
  document.querySelectorAll(".tool").forEach((el) => {
    el.onclick = () => {
      const t = el.dataset.tool;
      if (t === "clear") { if (confirm("Delete ALL drawings?")) state.drawings.clear(); return; }
      state.drawings.setTool(state.drawings.tool === t ? "cursor" : t);
    };
  });

  // indicator add
  $("#addInd").onclick = () => {
    const t = $("#indType").value;
    if (t) addIndicator(t);
  };

  // execution
  $("#buyBtn").onclick = () => oneClick("buy");
  $("#sellBtn").onclick = () => oneClick("sell");
  $("#execTarget").onchange = syncExecUI;
  $("#binMode").onchange = syncExecUI;
  syncExecUI();
  $("#mt5Server").onchange = () => {
    $("#mt5CustomRow").style.display = $("#mt5Server").value === "custom" ? "flex" : "none";
  };
  $("#mt5SaveBtn").onclick = saveMt5Creds;
  $("#mt5ConnBtn").onclick = connectMt5;
  loadMt5Creds();
  $("#refreshPos").onclick = refreshPositions;
  $("#saveKeysBtn").onclick = saveKeys;
  $("#keyVenue").onchange = () => {
    $("#mainnetKeyWarn").style.display = $("#keyVenue").value.endsWith("_main") ? "block" : "none";
  };

  // MTF heatmap + auto trade manager
  safeInit("TGMTF", () => {
    if (window.TGMTF) window.TGMTF.init({ getSymbol: () => state.symbol });
  });
  safeInit("TGTradeMgr", () => {
    if (window.TGTradeMgr) window.TGTradeMgr.init();
  });

  // auto-lot risk calculator (reads live price as entry for SL distance)
  safeInit("TGRisk", () => {
  if (window.TGRisk) {
    window.TGRisk.init({
      getEntry: () => { const C = viewCandles(); return C.length ? C[C.length - 1].close : 0; },
      getSymbol: () => $("#execTarget").value === "mt5" ? ($("#mt5Sym").value.trim() || mt5Symbol(state.symbol)) : state.symbol,
      getTarget: () => $("#execTarget").value === "mt5" ? "mt5" : "binance",
    });
  }
  });

  // bar replay / backtest mode
  safeInit("TGReplay", () => {
  if (window.TGReplay) {
    window.TGReplay.init({
      getFull: () => state.candles,
      onRender: () => renderView(),
      getHint: () => $("#chartHint"),
    });
  }
  });

  // analysis
  $("#saveAnalysisBtn").onclick = openAnalysisModal;
  $("#doSaveAnalysis").onclick = saveAnalysis;
  safeInit("TGVoice", () => {
    if (window.TGVoice) window.TGVoice.init({ getSymbol: () => state.symbol });
  });

  // user
  $("#logoutBtn").onclick = async () => { await fetch("/api/auth/logout", { method: "POST" }); location.href = "/login.html"; };

  // modal close on backdrop click
  document.querySelectorAll(".modal-back").forEach((m) => {
    m.addEventListener("click", (e) => { if (e.target === m) m.classList.remove("open"); });
  });

  $("#symInput").addEventListener("change", (e) => {
    const v = e.target.value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (v) {
      if (window.TGReplay && window.TGReplay.active()) window.TGReplay.exit();
      state.symbol = v; loadData(); if (window.TGMTF) window.TGMTF.onSymbolChange(); if (window.TGNews) window.TGNews.onSymbolChange();
      if (window.TGSMT) window.TGSMT.onSymbolChange();
      if (window.TGLiq) window.TGLiq.onSymbolChange();
    }
  });

  refreshExecStatus();
  refreshPositions();
  setInterval(refreshPositions, 30000);
  setHint("Restored your last workspace. Click a tool on the left to draw.");
}
function syncTf() {
  document.querySelectorAll("#tfBar .tf-btn").forEach((b) => b.classList.toggle("active", b.dataset.tf === state.timeframe));
}
document.addEventListener("DOMContentLoaded", boot);
