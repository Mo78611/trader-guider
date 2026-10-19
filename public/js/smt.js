"use strict";
/* ============================================================================
 * Trader Guider — SMT divergence scanner (ICT concept).
 * ----------------------------------------------------------------------------
 * Polls /api/smt?base=<chart symbol>&ref=<reference symbol> every 60s and
 * drops elegant "⚠️ SMT" markers on the candles where the base printed an
 * extreme the reference failed to confirm.
 *
 * Own invisible line series for markers (same pattern as method-ui), so it
 * never fights indicator/drawing series. Toggle + ref symbol live in the
 * ◈ Methodologies menu ("SMT Divergence"), wired through method-ui.
 * ========================================================================== */
window.TGSMT = (function () {
  "use strict";

  const S = {
    chart: null, markerSeries: null, getSymbol: null, getTimeframe: null,
    getCandles: null,
    enabled: false, refSymbol: "BTCUSDT", timer: null, busy: false,
  };

  function num(x) { return typeof x === "number" && isFinite(x); }

  function ensureSeries() {
    if (S.markerSeries || !S.chart) return;
    try {
      S.markerSeries = S.chart.addLineSeries({
        color: "rgba(0,0,0,0)", lineWidth: 1,
        priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    } catch (_e) { S.markerSeries = null; }
  }

  function clear() {
    try { if (S.markerSeries) S.markerSeries.setMarkers([]); } catch (_e) {}
    const p = document.getElementById("smtPanel");
    if (p) p.style.display = "none";
  }

  function fmtTime(t) {
    try {
      const d = new Date(t * 1000);
      return d.toISOString().slice(5, 16).replace("T", " ");
    } catch (_e) { return ""; }
  }

  async function poll() {
    if (!S.enabled || S.busy) return;
    const base = S.getSymbol ? S.getSymbol() : null;
    const ref = (S.refSymbol || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const tf = S.getTimeframe ? S.getTimeframe() : "1h";
    if (!base || !ref || base === ref) { clear(); return; }
    S.busy = true;
    try {
      const j = await fetch(
        `/api/smt?base=${encodeURIComponent(base)}&ref=${encodeURIComponent(ref)}&interval=${encodeURIComponent(tf)}`
      ).then((r) => r.json());
      const divs = Array.isArray(j.divergences) ? j.divergences : [];
      ensureSeries();
      if (S.markerSeries && divs.length) {
        // anchor the invisible series at the last close so markers have a
        // price context WITHOUT distorting the chart's price scale
        try {
          const cs = S.getCandles ? S.getCandles() : [];
          const last = cs.length ? cs[cs.length - 1] : null;
          const px = last && num(last.close) ? last.close : null;
          const t0 = divs[0].time;
          if (px != null) {
            S.markerSeries.setData([
              { time: t0 - 3600, value: px },
              { time: t0, value: px },
            ]);
          }
        } catch (_e) {}
        try {
          S.markerSeries.setMarkers(divs.map((d) => ({
            time: d.time,
            position: d.type === "bearish" ? "aboveBar" : "belowBar",
            color: "#f0b429",
            shape: "text",
            text: "⚠️ SMT",
          })));
        } catch (_e) {}
      } else {
        clear();
        if (S.markerSeries) { try { S.markerSeries.setMarkers([]); } catch (_e) {} }
      }
      renderPanel(divs, base, ref);
    } catch (_e) {
      // keep old markers on transient failure
    } finally {
      S.busy = false;
    }
  }

  function renderPanel(divs, base, ref) {
    let p = document.getElementById("smtPanel");
    if (!p) {
      p = document.createElement("div");
      p.id = "smtPanel";
      p.className = "smt-panel";
      const main = document.querySelector(".main");
      if (main) main.appendChild(p);
    }
    if (!divs.length) { p.style.display = "none"; return; }
    p.style.display = "block";
    p.innerHTML = `<div class="smt-head">⚡ SMT ${esc(base)} vs ${esc(ref)}</div>` +
      divs.slice(-3).reverse().map((d) =>
        `<div class="smt-row"><span class="smt-type ${d.type}">${d.type === "bearish" ? "▼" : "▲"}</span>` +
        `<span>${fmtTime(d.time)}</span><span class="smt-note">${esc(d.note || "")}</span></div>`
      ).join("");
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  }

  /** Called by method-ui when the SMT checkbox / settings change. */
  function apply(enabled, settings) {
    S.enabled = !!enabled;
    const ref = settings && settings.refSymbol;
    if (typeof ref === "string" && ref.trim()) {
      S.refSymbol = ref.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 20) || S.refSymbol;
    }
    clearInterval(S.timer);
    S.timer = null;
    if (!S.enabled) { clear(); return; }
    poll();
    S.timer = setInterval(poll, 60000);
  }

  function onSymbolChange() {
    if (S.enabled) poll();
  }

  function init(opts) {
    S.chart = opts.chart;
    S.getSymbol = opts.getSymbol;
    S.getTimeframe = opts.getTimeframe;
    S.getCandles = opts.getCandles || null;
    ensureSeries();
  }

  return { init, apply, onSymbolChange, poll };
})();
