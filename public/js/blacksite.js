"use strict";
/* ============================================================================
 * Trader Guider — ◤ THE BLACKSITE ◢  (experimental lab, own section)
 * ----------------------------------------------------------------------------
 * 4 novel tools, visually and structurally SEPARATE from the ◈ Methodologies
 * menu and standard panels (user rule 2026-10-19):
 *   👻 Ghost Trades   — log every emitted signal plan, score what you skipped
 *   💥 Fracture Radar — news-bias % vs price structure disagreement
 *   🔁 Echo Mapper    — historical shape-rhymes on the same symbol
 *   🌀 Spring-Load    — compression energy % + directional lean gauge
 *
 * ZERO CHART CLUTTER: nothing draws on the chart unless its own BLACKSITE
 * toggle is ON. All strings are simple English. Everything here is an
 * experimental estimate — never a guarantee, never financial advice.
 * ========================================================================== */
window.TGBlacksit = (function () {
  "use strict";

  const S = {
    chart: null, getCandles: null, getSymbol: null, getTimeframe: null,
    open: false, tab: "ghosts", lastGhostKey: "",
    badgeOn: false, badgeSeries: null,
    springTimer: null, fracTimer: null,
  };

  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }
  function num(x) { return typeof x === "number" && isFinite(x); }

  /* ---------------- ghost logging (called from signal render path) -------- */
  function onSignal(symbol, timeframe, signal) {
    try {
      if (!signal || !num(signal.entry) || !num(signal.sl) || !num(signal.barTime)) return;
      if (!symbol) return;
      const key = [symbol, timeframe, signal.barTime, signal.direction, signal.entry].join("|");
      if (key === S.lastGhostKey) return; // same signal re-rendered — skip
      S.lastGhostKey = key;
      fetch("/api/blacksite/ghost", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol, timeframe: timeframe || "1h",
          direction: signal.direction, entry: signal.entry, sl: signal.sl,
          tp1: signal.tp1, tp2: signal.tp2,
          tag: signal.tag || "", bar_time: signal.barTime,
        }),
      }).catch(() => {});
    } catch (_e) {}
  }

  /* ---------------- drawer shell ---------------- */
  function fmtTime(iso) {
    try {
      const d = new Date(iso);
      return d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    } catch (_e) { return "—"; }
  }

  function open() {
    const d = $("blacksiteDrawer");
    if (!d) return;
    d.classList.add("open");
    S.open = true;
    refreshTab();
  }
  function close() {
    const d = $("blacksiteDrawer");
    if (d) d.classList.remove("open");
    S.open = false;
    stopTimers();
  }
  function stopTimers() {
    if (S.springTimer) { clearInterval(S.springTimer); S.springTimer = null; }
    if (S.fracTimer) { clearInterval(S.fracTimer); S.fracTimer = null; }
  }

  function setTab(t) {
    S.tab = t;
    document.querySelectorAll(".blacksite-tab").forEach((el) =>
      el.classList.toggle("active", el.dataset.tab === t));
    document.querySelectorAll(".blacksite-pane").forEach((el) =>
      el.style.display = el.dataset.pane === t ? "block" : "none");
    refreshTab();
  }

  function refreshTab() {
    stopTimers();
    if (!S.open) return;
    if (S.tab === "ghosts") loadGhosts();
    else if (S.tab === "fractures") { loadFracture(); S.fracTimer = setInterval(loadFracture, 120000); }
    else if (S.tab === "spring") { renderSpring(); S.springTimer = setInterval(renderSpring, 60000); }
    // echo tab loads on button click only
  }

  /* ---------------- 👻 Ghosts ---------------- */
  async function loadGhosts() {
    const box = $("bsGhosts");
    if (!box) return;
    box.innerHTML = `<div class="blacksite-dim">Loading ghost signals…</div>`;
    try {
      const j = await fetch("/api/blacksite/ghosts?days=7").then((r) => r.json());
      if (j.error) throw new Error(j.error);
      const s = j.summary || { signals: 0, missedR: 0 };
      const rows = (j.signals || []).slice(0, 60);
      const chip = (r) => {
        if (r.outcome === "tp2") return `<span class="blacksite-chip win">TP2 +${r.r}R</span>`;
        if (r.outcome === "tp1") return `<span class="blacksite-chip win1">TP1 +${r.r}R</span>`;
        if (r.outcome === "sl") return `<span class="blacksite-chip loss">SL −1R</span>`;
        if (r.outcome === "expired") return `<span class="blacksite-chip flat">expired</span>`;
        return `<span class="blacksite-chip flat">open…</span>`;
      };
      box.innerHTML = `
        <div class="blacksite-card">
          <div class="blacksite-big">${s.missedR >= 0 ? "+" : ""}${s.missedR}R</div>
          <div class="blacksite-dim">missed in last 7 days · ${s.signals} closed signals</div>
          <div class="blacksite-note">Plans the engine gave but you never took. Profit left on the table.</div>
        </div>
        ${rows.length ? `<table class="mini blacksite-table">
          <tr><th>Time</th><th>Symbol</th><th>Dir</th><th>Entry</th><th>Result</th></tr>
          ${rows.map((r) => `<tr>
            <td>${esc(fmtTime(r.time))}</td>
            <td>${esc(r.symbol)}</td>
            <td style="color:${r.direction === "buy" ? "#26a69a" : "#ef5350"};font-weight:700">${r.direction === "buy" ? "BUY" : "SELL"}</td>
            <td>${esc(String(r.entry))}</td>
            <td>${chip(r)}</td>
          </tr>`).join("")}
        </table>` : `<div class="blacksite-dim">No signals logged yet. Enable a methodology and wait for a fresh signal.</div>`}
        <div class="blacksite-note">Experimental estimate. Past ghosts do not predict future signals.</div>`;
    } catch (e) {
      box.innerHTML = `<div class="blacksite-dim">Could not load ghosts (${esc(e.message)}).</div>`;
    }
  }

  /* ---------------- 💥 Fractures ---------------- */
  async function loadFracture() {
    const box = $("bsFractures");
    if (!box) return;
    const sym = S.getSymbol ? S.getSymbol() : "BTCUSDT";
    box.innerHTML = `<div class="blacksite-dim">Scanning news vs structure for ${esc(sym)}…</div>`;
    try {
      const j = await fetch(`/api/blacksite/fracture?symbol=${encodeURIComponent(sym)}`).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      const ev = j.event;
      box.innerHTML = `
        <div class="blacksite-card ${j.fracture ? "blacksite-alert" : ""}">
          <div style="font-size:14px;font-weight:700;margin-bottom:6px">${j.fracture ? "⚡ FRACTURE DETECTED" : "No fracture"}</div>
          ${ev ? `
            <div><b>${esc(ev.title)}</b> <span class="blacksite-dim">· in ${esc(ev.in)}</span></div>
            <div class="blacksite-dim" style="margin-top:4px">Forecast ${esc(ev.forecast || "—")} vs last ${esc(ev.previous || "—")}</div>
            <div style="margin-top:6px">${esc(j.bias.text)}</div>` : ""}
          <div style="margin-top:6px">Price structure: <b>${esc(j.trend || "unknown")}</b></div>
          <div class="blacksite-note" style="margin-top:8px">${esc(j.message)}</div>
        </div>
        <label class="blacksite-check"><input type="checkbox" id="bsFracBadge" ${S.badgeOn ? "checked" : ""}>
          Show ⚡ badge on chart when fracture is live</label>
        <div class="blacksite-note">Disagreement between news bias and structure often comes before sharp moves. Not a signal.</div>`;
      const cb = $("bsFracBadge");
      if (cb) cb.onchange = () => setBadge(cb.checked, j.fracture);
      // keep badge in sync if toggle already on
      if (S.badgeOn) setBadge(true, j.fracture);
    } catch (e) {
      box.innerHTML = `<div class="blacksite-dim">Fracture scan failed (${esc(e.message)}).</div>`;
    }
  }

  function setBadge(on, fracture) {
    S.badgeOn = !!on;
    try { localStorage.setItem("tg_blacksite_badge", on ? "1" : "0"); } catch (_e) {}
    try {
      if (S.badgeSeries) { S.chart.removeSeries(S.badgeSeries); S.badgeSeries = null; }
      if (on && fracture && S.chart) {
        S.badgeSeries = S.chart.addLineSeries({
          color: "rgba(0,0,0,0)", lineWidth: 1,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        });
        const C = S.getCandles ? S.getCandles() : [];
        const last = C[C.length - 1];
        if (last) {
          S.badgeSeries.setMarkers([{
            time: last.time, position: "aboveBar",
            color: "#f0b429", shape: "text", text: "⚡ FRACTURE",
          }]);
        }
      }
    } catch (_e) {}
  }

  /* ---------------- 🔁 Echo ---------------- */
  async function runEcho() {
    const box = $("bsEchoOut");
    if (!box) return;
    const sym = S.getSymbol ? S.getSymbol() : "BTCUSDT";
    box.innerHTML = `<div class="blacksite-dim">Scanning ${esc(sym)} history for rhymes…</div>`;
    try {
      const j = await fetch("/api/blacksite/echo", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: sym }),
      }).then((r) => r.json());
      if (j.error) throw new Error(j.error);
      const rows = j.matches || [];
      box.innerHTML = `
        <div class="blacksite-card">
          <div style="font-weight:700;margin-bottom:4px">🔁 ${esc(j.summary)}</div>
          <div class="blacksite-note">${esc(j.note)}</div>
        </div>
        ${rows.length ? `<table class="mini blacksite-table">
          <tr><th>When</th><th>Match</th><th>Next 10 bars</th></tr>
          ${rows.map((m) => `<tr>
            <td>${esc(fmtTime(m.time))}</td>
            <td>r = ${esc(String(m.r))}</td>
            <td style="color:${m.next10Pct >= 0 ? "#26a69a" : "#ef5350"};font-weight:700">${m.next10Pct >= 0 ? "+" : ""}${esc(String(m.next10Pct))}%</td>
          </tr>`).join("")}
        </table>` : ""}`;
    } catch (e) {
      box.innerHTML = `<div class="blacksite-dim">Echo scan failed (${esc(e.message)}).</div>`;
    }
  }

  /* ---------------- 🌀 Spring ---------------- */
  function atr(arr, period) {
    if (!arr || arr.length < period + 1) return null;
    const trs = [];
    for (let i = 1; i < arr.length; i++) {
      const c = arr[i], p = arr[i - 1];
      if (!num(c.high) || !num(c.low) || !num(c.close) || !num(p.close)) continue;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
    }
    if (trs.length < period) return null;
    const w = trs.slice(-period);
    return w.reduce((a, b) => a + b, 0) / w.length;
  }

  function renderSpring() {
    const box = $("bsSpring");
    if (!box) return;
    const C = S.getCandles ? S.getCandles() : [];
    const a14 = atr(C, 14), a50 = atr(C, 50);
    if (a14 == null || a50 == null || !(a50 > 0)) {
      box.innerHTML = `<div class="blacksite-dim">Need more candles to measure the spring.</div>`;
      return;
    }
    const energy = Math.max(0, Math.min(100, (1 - a14 / a50) * 100));
    const tail = C.slice(-20);
    let leanSum = 0, leanN = 0;
    for (const c of tail) {
      const rng = c.high - c.low;
      if (num(c.close) && num(c.low) && rng > 0) { leanSum += (c.close - c.low) / rng; leanN++; }
    }
    const lean = leanN ? leanSum / leanN - 0.5 : 0;
    const leanTxt = lean > 0.08 ? "UP" : lean < -0.08 ? "DOWN" : "FLAT";
    const leanColor = leanTxt === "UP" ? "#26a69a" : leanTxt === "DOWN" ? "#ef5350" : "#8b94a7";
    const hot = energy >= 70;
    box.innerHTML = `
      <div class="blacksite-card ${hot ? "blacksite-alert" : ""}">
        <div style="display:flex;align-items:baseline;gap:10px">
          <div class="blacksite-big">🌀 ${energy.toFixed(0)}%</div>
          <div style="font-weight:700;color:${leanColor}">lean: ${leanTxt}</div>
        </div>
        <div class="blacksite-meter"><div class="blacksite-fill" style="width:${energy.toFixed(0)}%"></div></div>
        <div class="blacksite-note" style="margin-top:6px">
          ${hot ? "Spring loaded — release near. Watch the lean side." : "Spring not loaded yet. Wait for compression."}
          Updates every minute. Experimental.
        </div>
      </div>`;
  }

  /* ---------------- init ---------------- */
  function init(opts) {
    S.chart = opts.chart;
    S.getCandles = opts.getCandles;
    S.getSymbol = opts.getSymbol;
    S.getTimeframe = opts.getTimeframe;
    try { S.badgeOn = localStorage.getItem("tg_blacksite_badge") === "1"; } catch (_e) {}

    const btn = $("blacksiteBtn");
    if (btn) btn.onclick = () => (S.open ? close() : open());
    const x = $("blacksiteClose");
    if (x) x.onclick = close;
    document.querySelectorAll(".blacksite-tab").forEach((el) => {
      el.onclick = () => setTab(el.dataset.tab);
    });
    const echoBtn = $("bsEchoBtn");
    if (echoBtn) echoBtn.onclick = runEcho;
  }

  return { init, onSignal, open, close, setTab };
})();
